// Prepares HTML documents from a repository for safe, self-contained rendering.
//
// Two separate steps, so the diff can compare documents that have NOT had their URLs
// rewritten (rewriting embeds each side's commit SHA, which would make every untouched
// <img src="logo.png"> look changed):
//   1. sanitizeDocument: strips anything that executes and inlines repo-relative stylesheets.
//   2. rewriteUrls: points repo-relative URLs at GitHub instead of the extension page.

export interface PrepareContext {
    owner: string;
    repo: string;
    ref: string;
    // repo path of the HTML file being rendered
    path: string;
}

type FetchText = (path: string) => Promise<string>;

const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
const IMPORT_RULE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;
const MAX_STYLESHEETS = 8;
const MAX_STYLESHEET_FETCHES = 16;
const MAX_IMPORT_DEPTH = 3;
const URL_ATTRIBUTES = ["src", "poster", "data"];

const dirOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

// the "?query#fragment" tail of a URL, which repository lookups ignore but rendering needs
const suffixOf = (href: string): string => /[?#].*$/.exec(href.trim())?.[0] ?? "";

export const resolveRepoPath = (fromFile: string, href: string): string | null => {
    const clean = href.trim().split("#")[0].split("?")[0];
    if (!clean || ABSOLUTE_URL.test(clean)) return null;
    const dir = dirOf(fromFile);
    try {
        const resolved = new URL(clean, `https://repo.invalid/${dir}${dir ? "/" : ""}`);
        return decodeURIComponent(resolved.pathname.replace(/^\//, ""));
    } catch (ignore) {
        return null;
    }
}

const rawUrl = (ctx: PrepareContext, fromFile: string, href: string): string => {
    const path = resolveRepoPath(fromFile, href);
    if (path === null) return href;
    return `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/${ctx.ref}/${encodePath(path)}${suffixOf(href)}`;
}

const blobUrl = (ctx: PrepareContext, href: string): string => {
    const path = resolveRepoPath(ctx.path, href);
    if (path === null) return href;
    return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.ref}/${encodePath(path)}${suffixOf(href)}`;
}

const rewriteCssUrls = (css: string, ctx: PrepareContext, fromFile: string): string => {
    return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
        if (ABSOLUTE_URL.test(url.trim())) return match;
        return `url(${quote}${rawUrl(ctx, fromFile, url)}${quote})`;
    });
}

// srcset candidates are "<url> <descriptor>, ..." but a URL may itself contain commas
// (data: URLs), so split by the spec's rules rather than on every comma.
const rewriteSrcset = (srcset: string, rewrite: (url: string) => string): string => {
    const candidates: string[] = [];
    let i = 0;
    while (i < srcset.length) {
        while (i < srcset.length && (/\s/.test(srcset[i]) || srcset[i] === ",")) i++;
        const start = i;
        while (i < srcset.length && !/\s/.test(srcset[i])) i++;
        let url = srcset.slice(start, i);
        if (!url) break;

        const trailingCommas = /,+$/.exec(url);
        if (trailingCommas) {
            candidates.push(rewrite(url.slice(0, -trailingCommas[0].length)));
            continue;
        }

        const descriptorStart = i;
        let depth = 0;
        while (i < srcset.length && !(srcset[i] === "," && depth === 0)) {
            if (srcset[i] === "(") depth++;
            else if (srcset[i] === ")") depth--;
            i++;
        }
        candidates.push(rewrite(url) + srcset.slice(descriptorStart, i).replace(/\s+$/, ""));
    }
    return candidates.join(", ");
}

const linkedStylesheets = (doc: Document): HTMLLinkElement[] => {
    return Array.from(doc.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]"))
        .filter(link => !ABSOLUTE_URL.test(link.getAttribute("href")!.trim()));
}

// Repo paths of the relative stylesheets sanitizeDocument will try to inline.
export const getStylesheetPaths = (doc: Document, filePath: string): string[] => {
    const paths: string[] = [];
    for (const link of linkedStylesheets(doc)) {
        const path = resolveRepoPath(filePath, link.getAttribute("href")!);
        if (path !== null && paths.indexOf(path) < 0) paths.push(path);
    }
    return paths.slice(0, MAX_STYLESHEETS);
}

// Fetches stylesheets with their relative @import rules inlined (bounded depth, no cycles).
// url() references inside each sheet are rewritten against that sheet's own location, so the
// result is self-contained.
export const loadStylesheets = async (ctx: Omit<PrepareContext, "path">, paths: string[], fetchText: FetchText): Promise<Map<string, string>> => {
    const sheets = new Map<string, string>();
    let fetches = 0;

    const load = async (path: string, depth: number, ancestors: string[]): Promise<string | undefined> => {
        if (fetches >= MAX_STYLESHEET_FETCHES) return undefined;
        fetches++;

        let css: string;
        try {
            css = await fetchText(path);
        } catch (ignore) {
            return undefined;
        }

        const chain = [...ancestors, path];
        let out = "";
        let last = 0;
        for (const match of Array.from(css.matchAll(IMPORT_RULE))) {
            out += css.slice(last, match.index!);
            last = match.index! + match[0].length;

            const [rule, , url, media] = match;
            const importPath = ABSOLUTE_URL.test(url) ? null : resolveRepoPath(path, url);
            const inlined = importPath !== null && depth < MAX_IMPORT_DEPTH && chain.indexOf(importPath) < 0
                ? await load(importPath, depth + 1, chain)
                : undefined;

            if (inlined === undefined) out += rule;
            else out += media.trim() ? `@media ${media.trim()}{${inlined}}` : inlined;
        }
        out += css.slice(last);
        return rewriteCssUrls(out, { ...ctx, path }, path);
    }

    await Promise.all(paths.map(async path => {
        const css = await load(path, 0, []);
        if (css !== undefined) sheets.set(path, css);
    }));
    return sheets;
}

export const sanitizeDocument = (doc: Document, filePath: string, sheets: Map<string, string>) => {
    doc.querySelectorAll("script, noscript, base, meta[http-equiv], object, embed, iframe[srcdoc]").forEach(el => el.remove());

    for (const link of linkedStylesheets(doc)) {
        const path = resolveRepoPath(filePath, link.getAttribute("href")!);
        const css = path === null ? undefined : sheets.get(path);
        if (css === undefined) continue;

        const style = doc.createElement("style");
        style.setAttribute("data-hp-sheet", path!);
        const media = link.getAttribute("media");
        if (media) style.setAttribute("media", media);
        style.textContent = css;
        link.replaceWith(style);
    }

    doc.querySelectorAll("*").forEach(el => {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on") || name === "srcdoc") {
                el.removeAttribute(attr.name);
            } else if (/^\s*javascript:/i.test(attr.value) && (name === "href" || name === "src" || name === "action" || name === "formaction" || name === "xlink:href")) {
                el.removeAttribute(attr.name);
            }
        }
    });
}

const rewriteElement = (el: Element, ctx: PrepareContext) => {
    const tag = el.tagName.toLowerCase();

    // inlined stylesheets are already rewritten relative to their own file
    if (tag === "style" && !el.hasAttribute("data-hp-sheet")) {
        el.textContent = rewriteCssUrls(el.textContent || "", ctx, ctx.path);
    }

    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", rewriteCssUrls(style, ctx, ctx.path));

    for (const name of URL_ATTRIBUTES) {
        const value = el.getAttribute(name);
        if (value && !ABSOLUTE_URL.test(value.trim())) el.setAttribute(name, rawUrl(ctx, ctx.path, value));
    }

    const srcset = el.getAttribute("srcset");
    if (srcset) {
        el.setAttribute("srcset", rewriteSrcset(srcset, url => ABSOLUTE_URL.test(url) ? url : rawUrl(ctx, ctx.path, url)));
    }

    if (tag === "link") {
        const href = el.getAttribute("href");
        if (href && !ABSOLUTE_URL.test(href.trim())) el.setAttribute("href", rawUrl(ctx, ctx.path, href));
    } else if (tag === "a" || tag === "area") {
        const href = el.getAttribute("href");
        if (href && !href.trim().startsWith("#")) {
            el.setAttribute("href", ABSOLUTE_URL.test(href.trim()) ? href : blobUrl(ctx, href));
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
        }
    }
}

// Rewrites repo-relative URLs under `root` (a document, fragment or element) in place.
export const rewriteUrls = (root: Node, ctx: PrepareContext) => {
    if (root.nodeType === 1) rewriteElement(root as Element, ctx);
    if (root.nodeType === 1 || root.nodeType === 9 || root.nodeType === 11) {
        (root as ParentNode).querySelectorAll("*").forEach(el => rewriteElement(el, ctx));
    }
}
