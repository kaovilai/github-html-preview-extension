// Structural diff of two HTML documents' <body> trees.
//
// The "before" view highlights removed nodes red, the "after" view highlights added
// nodes green, and the "inline" view is the "after" document with a clickable red
// bubble at every place something was removed. Elements that kept their children
// but changed their own attributes are outlined amber.

export interface DiffStats {
    added: number;
    removed: number;
    modified: number;
}

export interface Views {
    before: string;
    after: string;
    inline: string;
    stats: DiffStats;
}

export type Side = "before" | "after";

interface Options {
    markOld: boolean;
    bubbles: boolean;
    pageCss: string;
    // URL-rewrites nodes copied out of the "before" document into a removal bubble
    rewriteOld: (node: Node) => void;
}

interface Op {
    t: "same" | "pair" | "del" | "add";
    a?: Node;
    b?: Node;
}

interface AlignOp {
    t: "m" | "d" | "a";
    i: number;
    j: number;
}

const MAX_DP_CELLS = 4_000_000;
const MAX_BUBBLE_CSS_BYTES = 60_000;
// children of these are text payloads, wrapping them in markup would break them
const LEAF_TAGS = new Set(["STYLE", "TEXTAREA", "SCRIPT", "TITLE", "OPTION"]);
const PRESERVE_WHITESPACE = "pre, textarea, listing, plaintext";
// whitespace between two of these is a visible space; between blocks it is just formatting
const INLINE_TAGS = new Set(["A", "ABBR", "B", "BDI", "BDO", "BIG", "BR", "BUTTON", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "IMG", "INPUT", "INS", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SELECT", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "SVG", "TEXTAREA", "TIME", "TT", "U", "VAR", "WBR"]);
// parents whose children the HTML parser would reject or relocate if they were an unknown element
const TABLE_SECTIONS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT"]);
const NO_CUSTOM_CHILDREN = new Set(["SELECT", "OPTGROUP", "DATALIST", "COLGROUP"]);

const MARK_CSS = `
[data-hp-added]{outline:2px solid #1a7f37!important;outline-offset:-2px;background-image:linear-gradient(rgba(46,160,67,.22),rgba(46,160,67,.22))!important}
[data-hp-removed]{outline:2px solid #cf222e!important;outline-offset:-2px;background-image:linear-gradient(rgba(248,81,73,.22),rgba(248,81,73,.22))!important}
[data-hp-modified]{outline:2px dashed #bf8700!important;outline-offset:-2px}
[data-hp-text][data-hp-added]{outline:none!important;background-image:none!important;background-color:rgba(46,160,67,.30)!important}
[data-hp-text][data-hp-removed]{outline:none!important;background-image:none!important;background-color:rgba(248,81,73,.30)!important;text-decoration:line-through}
[data-hp-focus]{animation:hp-pulse 1.2s ease-out}
@keyframes hp-pulse{0%{box-shadow:0 0 0 0 rgba(9,105,218,.8)}100%{box-shadow:0 0 0 14px rgba(9,105,218,0)}}
hp-del{display:inline-block;vertical-align:middle;margin:0 2px}
`;

const BUBBLE_CSS = `
:host{display:inline-block;vertical-align:middle;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328}
summary{list-style:none;cursor:pointer;display:inline-block;width:18px;height:18px;border-radius:50%;background:#cf222e;color:#fff;text-align:center;line-height:18px;font-weight:700;user-select:none;box-shadow:0 0 0 2px #fff}
summary::-webkit-details-marker{display:none}
details[open]>summary{background:#82071e}
/* host stays static so left/right resolve against the page (not the bubble) and the popover never overflows the right edge; top:auto keeps it under the bubble */
.pop{position:absolute;z-index:2147483647;left:12px;right:12px;max-width:640px;max-height:60vh;margin-top:6px;overflow:auto;background:#fff;border:1px solid #cf222e;border-radius:8px;box-shadow:0 8px 24px rgba(140,149,159,.4)}
.head{padding:6px 10px;background:#ffebe9;color:#82071e;font-weight:600;border-bottom:1px solid #ffcecb}
.render{padding:8px 10px;background:#fff5f5;color:initial;overflow:auto}
.src{border-top:1px solid #ffcecb}
.src>summary{all:unset;display:block;cursor:pointer;padding:6px 10px;color:#57606a}
pre{margin:0;padding:8px 10px;overflow:auto;background:#f6f8fa;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
`;

const sigCache = new WeakMap<Node, string>();

const isPreserved = (node: Node): boolean => !!node.parentElement?.closest(PRESERVE_WHITESPACE);

const isInlineNode = (node: Node | null): boolean => {
    return !!node && (node.nodeType === 3 || (node.nodeType === 1 && INLINE_TAGS.has((node as Element).tagName.toUpperCase())));
}

const isMeaningful = (node: Node): boolean => {
    if (node.nodeType === 1) return true;
    if (node.nodeType !== 3) return false;
    if ((node.textContent || "").trim() !== "") return true;
    // whitespace-only text is formatting, unless it renders (inside <pre>, or a space between inline content)
    return isPreserved(node) || (isInlineNode(node.previousSibling) && isInlineNode(node.nextSibling));
}

// Text compares the way it renders: runs of whitespace collapse, but a leading/trailing
// space that separates inline content (and everything inside <pre>) still counts.
const textSignature = (node: Node): string => {
    const text = node.textContent || "";
    if (isPreserved(node)) return "#" + text;

    let collapsed = text.replace(/\s+/g, " ");
    const parent = node.parentElement;
    if (parent && !INLINE_TAGS.has(parent.tagName.toUpperCase())) {
        if (!node.previousSibling) collapsed = collapsed.replace(/^ /, "");
        if (!node.nextSibling) collapsed = collapsed.replace(/ $/, "");
    }
    return "#" + collapsed;
}

const meaningfulChildren = (parent: Node): Node[] => Array.from(parent.childNodes).filter(isMeaningful);

const sig = (node: Node): string => {
    let value = sigCache.get(node);
    if (value === undefined) {
        value = node.nodeType === 1
            ? (node as Element).outerHTML
            : textSignature(node);
        sigCache.set(node, value);
    }
    return value;
}

const looseKey = (node: Node): string => {
    if (node.nodeType !== 1) return "#text";
    const el = node as Element;
    return el.tagName + (el.id ? "#" + el.id : "");
}

const attributeSignature = (el: Element): string => {
    return Array.from(el.attributes)
        .filter(attr => attr.name.indexOf("data-hp-") !== 0)
        .map(attr => `${attr.name}=${attr.value}`)
        .sort()
        .join("\n");
}

const align = (a: string[], b: string[]): AlignOp[] => {
    const ops: AlignOp[] = [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        ops.push({ t: "m", i: start, j: start });
        start++;
    }

    let endA = a.length, endB = b.length;
    const tail: AlignOp[] = [];
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--; endB--;
        tail.push({ t: "m", i: endA, j: endB });
    }
    tail.reverse();

    const n = endA - start, m = endB - start;
    if (n === 0 || m === 0 || n * m > MAX_DP_CELLS) {
        for (let i = start; i < endA; i++) ops.push({ t: "d", i, j: -1 });
        for (let j = start; j < endB; j++) ops.push({ t: "a", i: -1, j });
    } else {
        const width = m + 1;
        const lcs = new Uint32Array((n + 1) * width);
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                lcs[i * width + j] = a[start + i - 1] === b[start + j - 1]
                    ? lcs[(i - 1) * width + j - 1] + 1
                    : Math.max(lcs[(i - 1) * width + j], lcs[i * width + j - 1]);
            }
        }

        const reversed: AlignOp[] = [];
        let i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[start + i - 1] === b[start + j - 1]) {
                reversed.push({ t: "m", i: start + i - 1, j: start + j - 1 });
                i--; j--;
            } else if (j > 0 && (i === 0 || lcs[i * width + j - 1] >= lcs[(i - 1) * width + j])) {
                reversed.push({ t: "a", i: -1, j: start + j - 1 });
                j--;
            } else {
                reversed.push({ t: "d", i: start + i - 1, j: -1 });
                i--;
            }
        }
        reversed.reverse();
        ops.push(...reversed);
    }

    ops.push(...tail);
    return ops;
}

const buildOps = (olds: Node[], news: Node[]): Op[] => {
    const out: Op[] = [];
    let dels: number[] = [];
    let adds: number[] = [];

    // Anything not identical is paired up by tag/id so nested edits are reported
    // granularly instead of as a whole-element replacement.
    const flush = () => {
        if (!dels.length && !adds.length) return;
        const loose = align(dels.map(i => looseKey(olds[i])), adds.map(j => looseKey(news[j])));
        for (const op of loose) {
            const a = op.i >= 0 ? olds[dels[op.i]] : undefined;
            const b = op.j >= 0 ? news[adds[op.j]] : undefined;
            if (op.t === "m" && a!.nodeType === 1) {
                out.push({ t: "pair", a, b });
            } else if (op.t === "m") {
                out.push({ t: "del", a });
                out.push({ t: "add", b });
            } else if (op.t === "d") {
                out.push({ t: "del", a });
            } else {
                out.push({ t: "add", b });
            }
        }
        dels = [];
        adds = [];
    };

    for (const op of align(olds.map(sig), news.map(sig))) {
        if (op.t === "m") {
            flush();
            out.push({ t: "same", a: olds[op.i], b: news[op.j] });
        } else if (op.t === "d") {
            dels.push(op.i);
        } else {
            adds.push(op.j);
        }
    }
    flush();
    return out;
}

const mark = (node: Node, attribute: string): Node => {
    if (node.nodeType === 1) {
        (node as Element).setAttribute(attribute, "");
        return node;
    }
    const wrapper = node.ownerDocument!.createElement("span");
    wrapper.setAttribute(attribute, "");
    wrapper.setAttribute("data-hp-text", "");
    node.parentNode!.replaceChild(wrapper, node);
    wrapper.appendChild(node);
    return wrapper;
}

const serialize = (node: Node): string => {
    return node.nodeType === 1 ? (node as Element).outerHTML : (node.textContent || "").trim();
}

const createBubble = (doc: Document, removed: Node[], opts: Options): HTMLElement => {
    const host = doc.createElement("hp-del");
    const template = doc.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    const root = template.content;

    const style = doc.createElement("style");
    style.textContent = BUBBLE_CSS;
    root.appendChild(style);

    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = "−";
    summary.setAttribute("title", "Removed content - click to view");
    details.appendChild(summary);

    const pop = doc.createElement("div");
    pop.className = "pop";
    const head = doc.createElement("div");
    head.className = "head";
    head.textContent = removed.length === 1 ? "Removed" : `Removed (${removed.length} nodes)`;
    pop.appendChild(head);

    // The removed content (and the page's own CSS) lives in a nested shadow root, so page
    // rules like `summary{display:none}` can't reach the bubble's controls above it.
    const render = doc.createElement("div");
    render.className = "render";
    const renderRoot = doc.createElement("template");
    renderRoot.setAttribute("shadowrootmode", "open");
    if (opts.pageCss) {
        const pageStyle = doc.createElement("style");
        pageStyle.textContent = opts.pageCss;
        opts.rewriteOld(pageStyle);
        renderRoot.content.appendChild(pageStyle);
    }
    removed.forEach(node => {
        const copy = node.cloneNode(true);
        opts.rewriteOld(copy);
        renderRoot.content.appendChild(copy);
    });
    render.appendChild(renderRoot);
    pop.appendChild(render);

    const source = doc.createElement("details");
    source.className = "src";
    const sourceSummary = doc.createElement("summary");
    sourceSummary.textContent = "HTML source";
    const pre = doc.createElement("pre");
    pre.textContent = removed.map(serialize).join("\n");
    source.appendChild(sourceSummary);
    source.appendChild(pre);
    pop.appendChild(source);

    details.appendChild(pop);
    root.appendChild(details);
    host.appendChild(template);
    return host;
}

// Inserts the bubble somewhere the HTML parser will keep it: parsing the serialized
// document would otherwise move it out of tables or drop it from option lists.
const placeBubble = (parent: Element, before: Node | null, bubble: HTMLElement) => {
    const doc = parent.ownerDocument!;
    const tag = parent.tagName.toUpperCase();
    const wrapInCell = (): HTMLElement => {
        const cell = doc.createElement("td");
        cell.setAttribute("style", "padding:0;border:0");
        cell.appendChild(bubble);
        return cell;
    };

    if (TABLE_SECTIONS.has(tag)) {
        const row = doc.createElement("tr");
        const cell = wrapInCell();
        cell.setAttribute("colspan", "1000");
        row.appendChild(cell);
        parent.insertBefore(row, before);
    } else if (tag === "TR") {
        parent.insertBefore(wrapInCell(), before);
    } else if (NO_CUSTOM_CHILDREN.has(tag)) {
        // show it next to the whole control instead
        let target: Element = tag === "COLGROUP" ? parent.closest("table") || parent : parent;
        while (target.parentElement && NO_CUSTOM_CHILDREN.has(target.parentElement.tagName.toUpperCase())) target = target.parentElement;
        target.parentNode!.insertBefore(bubble, target);
    } else {
        parent.insertBefore(bubble, before);
    }
}

const diffChildren = (oldParent: Node, newParent: Node, opts: Options, stats: DiffStats) => {
    const ops = buildOps(meaningfulChildren(oldParent), meaningfulChildren(newParent));

    for (const op of ops) {
        if (op.t === "pair") {
            const oldEl = op.a as Element, newEl = op.b as Element;
            const leaf = LEAF_TAGS.has(newEl.tagName);
            if (leaf || attributeSignature(oldEl) !== attributeSignature(newEl)) {
                newEl.setAttribute("data-hp-modified", "");
                if (opts.markOld) oldEl.setAttribute("data-hp-modified", "");
                stats.modified++;
            }
            if (!leaf) diffChildren(oldEl, newEl, opts, stats);
        } else if (op.t === "add") {
            op.b = mark(op.b!, "data-hp-added");
            stats.added++;
        } else if (op.t === "del") {
            if (opts.markOld) op.a = mark(op.a!, "data-hp-removed");
            stats.removed++;
        }
    }

    if (!opts.bubbles) return;

    // one bubble per run of consecutive removals, placed where the run used to be
    let run: Node[] = [];
    const flushRun = (before: Node | null) => {
        if (!run.length) return;
        placeBubble(newParent as Element, before, createBubble(newParent.ownerDocument!, run, opts));
        run = [];
    };
    for (const op of ops) {
        if (op.t === "del") {
            run.push(op.a!);
        } else {
            flushRun(op.b!);
        }
    }
    flushRun(null);
}

const diffBodies = (oldBody: Element, newBody: Element, opts: Options, stats: DiffStats) => {
    if (attributeSignature(oldBody) !== attributeSignature(newBody)) {
        newBody.setAttribute("data-hp-modified", "");
        if (opts.markOld) oldBody.setAttribute("data-hp-modified", "");
        stats.modified++;
    }
    diffChildren(oldBody, newBody, opts, stats);
}

const collectPageCss = (doc: Document): string => {
    const css = Array.from(doc.querySelectorAll("style")).map(style => style.textContent || "").join("\n");
    return css.length > MAX_BUBBLE_CSS_BYTES ? "" : css;
}

const finalize = (doc: Document, side: Side, rewrite: (root: Node, side: Side) => void): string => {
    rewrite(doc, side);
    const style = doc.createElement("style");
    style.setAttribute("data-hp-style", "");
    style.textContent = MARK_CSS;
    (doc.head || doc.documentElement).appendChild(style);
    return "<!DOCTYPE html>" + doc.documentElement.outerHTML;
}

// `make` must return a fresh document on every call (the diff mutates them). The documents are
// compared as written; `rewrite` then makes each side's resource URLs renderable, so a relative
// URL that did not change in the source is not reported as changed.
export const buildViews = (make: (side: Side) => Document, rewrite: (root: Node, side: Side) => void): Views => {
    const stats: DiffStats = { added: 0, removed: 0, modified: 0 };

    const oldDoc = make("before"), newDoc = make("after");
    diffBodies(oldDoc.body, newDoc.body, { markOld: true, bubbles: false, pageCss: "", rewriteOld: () => {} }, stats);

    const inlineOld = make("before"), inlineNew = make("after");
    const pageCss = collectPageCss(inlineOld);
    diffBodies(inlineOld.body, inlineNew.body, { markOld: false, bubbles: true, pageCss, rewriteOld: node => rewrite(node, "before") }, { added: 0, removed: 0, modified: 0 });

    return {
        before: finalize(oldDoc, "before", rewrite),
        after: finalize(newDoc, "after", rewrite),
        inline: finalize(inlineNew, "after", rewrite),
        stats
    };
}
