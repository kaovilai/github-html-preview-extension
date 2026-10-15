// Prepares a parsed HTML document from a repository for safe, self-contained rendering:
// strips anything that executes, inlines repo-relative stylesheets, and rewrites
// repo-relative URLs so images/links resolve against GitHub instead of the extension.

export interface PrepareContext {
    owner: string;
    repo: string;
    ref: string;
    // repo path of the HTML file being rendered
    path: string;
    // repo path -> stylesheet text, see getStylesheetPaths
    sheets: Map<string, string>;
}

const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
const MAX_STYLESHEETS = 8;

const dirOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

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
    return `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/${ctx.ref}/${encodePath(path)}`;
}

const blobUrl = (ctx: PrepareContext, href: string): string => {
    const path = resolveRepoPath(ctx.path, href);
    if (path === null) return href;
    return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.ref}/${encodePath(path)}`;
}

const rewriteCssUrls = (css: string, ctx: PrepareContext, fromFile: string): string => {
    return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
        if (ABSOLUTE_URL.test(url.trim())) return match;
        return `url(${quote}${rawUrl(ctx, fromFile, url)}${quote})`;
    });
}

const linkedStylesheets = (doc: Document): HTMLLinkElement[] => {
    return Array.from(doc.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]"))
        .filter(link => !ABSOLUTE_URL.test(link.getAttribute("href")!.trim()));
}

// Repo paths of relative stylesheets that prepareDocument will try to inline.
export const getStylesheetPaths = (doc: Document, filePath: string): string[] => {
    const paths: string[] = [];
    for (const link of linkedStylesheets(doc)) {
        const path = resolveRepoPath(filePath, link.getAttribute("href")!);
        if (path !== null && paths.indexOf(path) < 0) paths.push(path);
    }
    return paths.slice(0, MAX_STYLESHEETS);
}

const REWRITTEN_ATTRIBUTES = ["src", "poster", "data"];

export const prepareDocument = (doc: Document, ctx: PrepareContext) => {
    doc.querySelectorAll("script, noscript, base, meta[http-equiv], object, embed, iframe[srcdoc]").forEach(el => el.remove());

    for (const link of linkedStylesheets(doc)) {
        const path = resolveRepoPath(ctx.path, link.getAttribute("href")!);
        const css = path === null ? undefined : ctx.sheets.get(path);
        if (css === undefined) {
            link.setAttribute("href", rawUrl(ctx, ctx.path, link.getAttribute("href")!));
            continue;
        }
        const style = doc.createElement("style");
        style.setAttribute("data-hp-sheet", path!);
        style.textContent = rewriteCssUrls(css, ctx, path!);
        link.replaceWith(style);
    }

    doc.querySelectorAll("style:not([data-hp-sheet])").forEach(style => {
        style.textContent = rewriteCssUrls(style.textContent || "", ctx, ctx.path);
    });

    doc.querySelectorAll("*").forEach(el => {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on") || name === "srcdoc") {
                el.removeAttribute(attr.name);
            } else if (/^\s*javascript:/i.test(attr.value) && (name === "href" || name === "src" || name === "action" || name === "formaction" || name === "xlink:href")) {
                el.removeAttribute(attr.name);
            }
        }

        for (const name of REWRITTEN_ATTRIBUTES) {
            const value = el.getAttribute(name);
            if (value && !ABSOLUTE_URL.test(value.trim())) el.setAttribute(name, rawUrl(ctx, ctx.path, value));
        }

        const srcset = el.getAttribute("srcset");
        if (srcset) {
            el.setAttribute("srcset", srcset.split(",").map(candidate => {
                const [url, ...descriptor] = candidate.trim().split(/\s+/);
                return [ABSOLUTE_URL.test(url) ? url : rawUrl(ctx, ctx.path, url), ...descriptor].join(" ");
            }).join(", "));
        }

        const tag = el.tagName.toLowerCase();
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
    });
}
