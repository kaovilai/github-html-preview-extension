import { getData, sendMessage, setData } from "../shared/chrome";
import { MessageType, StorageType } from "../shared/type";
import { buildViews, Views } from "../core/html-diff";
import { getStylesheetPaths, prepareDocument } from "../core/html-prepare";
import type { PrDiffInfo } from "../core/github-api";

type Mode = "inline" | "split";

// No allow-scripts, so nothing in the previewed page can execute even though it shares this page's origin
// (same-origin only lets us read the frames for scroll sync and change navigation); nested frames inherit the sandbox.
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const CHANGE_SELECTOR = "[data-hp-added], [data-hp-removed], [data-hp-modified], hp-del";

const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const owner = params.get("owner")!;
const repo = params.get("repo")!;
const pr = Number(params.get("pr"));
const path = params.get("path")!;
const range = params.get("range") || undefined;

document.body.setAttribute("data-theme", params.get("theme") === "dark" ? "dark" : "light");

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const call = async <T>(action: MessageType, payload: any): Promise<T> => {
    const response = await sendMessage(action, payload);
    if (!response) throw new Error("No response from the extension background worker.");
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
}

const fetchText = (filePath: string, ref: string) => call<string>(MessageType.FETCH_FILE_CONTENT, { owner, repo, path: filePath, ref });

const loadSheets = async (html: string, filePath: string, ref: string): Promise<Map<string, string>> => {
    const sheets = new Map<string, string>();
    const paths = getStylesheetPaths(new DOMParser().parseFromString(html, "text/html"), filePath);
    await Promise.all(paths.map(async sheetPath => {
        try {
            sheets.set(sheetPath, await fetchText(sheetPath, ref));
        } catch (ignore) {}
    }));
    return sheets;
}

const makeFrame = (html: string): HTMLIFrameElement => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", SANDBOX);
    frame.srcdoc = html;
    return frame;
}

const makePane = (title: string, content: HTMLElement): HTMLElement => {
    const pane = document.createElement("section");
    pane.className = "pane";
    const heading = document.createElement("div");
    heading.className = "pane-title";
    heading.textContent = title;
    pane.append(heading, content);
    return pane;
}

const placeholder = (text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "placeholder";
    el.textContent = text;
    return el;
}

const shortSha = (sha: string | null) => sha ? sha.slice(0, 7) : "none";

const showNotice = (text: string) => {
    const notice = byId("notice");
    notice.textContent = text;
    notice.hidden = false;
}

const showError = (message: string) => {
    const status = byId("status");
    status.className = "error";
    status.textContent = message;
}

const scrollRatioSync = (from: HTMLIFrameElement, to: HTMLIFrameElement, ignoreUntil: { [key: string]: number }, key: string, otherKey: string) => {
    const source = from.contentWindow!, target = to.contentWindow!;
    source.addEventListener("scroll", () => {
        if (Date.now() < ignoreUntil[key]) return;
        const sourceMax = source.document.documentElement.scrollHeight - source.innerHeight;
        const targetMax = target.document.documentElement.scrollHeight - target.innerHeight;
        if (sourceMax <= 0 || targetMax <= 0) return;
        ignoreUntil[otherKey] = Date.now() + 120;
        target.scrollTo(0, (source.scrollY / sourceMax) * targetMax);
    });
}

const run = async () => {
    const info = await call<PrDiffInfo>(MessageType.FETCH_PR_DIFF_INFO, { owner, repo, pr, range });
    const change = info.files[path];
    if (!change) throw new Error(`${path} is not part of this diff.`);

    const status = change.status;
    const beforePath = change.previous || path;
    const hasBefore = status !== "added" && !!info.before;
    const hasAfter = status !== "removed";

    const [beforeHtml, afterHtml] = await Promise.all([
        hasBefore ? fetchText(beforePath, info.before!) : Promise.resolve(""),
        hasAfter ? fetchText(path, info.after) : Promise.resolve("")
    ]);
    const [beforeSheets, afterSheets] = await Promise.all([
        loadSheets(beforeHtml, beforePath, info.before || ""),
        loadSheets(afterHtml, path, info.after)
    ]);

    const views: Views = buildViews(side => {
        const before = side === "before";
        const doc = new DOMParser().parseFromString(before ? beforeHtml : afterHtml, "text/html");
        prepareDocument(doc, {
            owner,
            repo,
            ref: before ? info.before || "" : info.after,
            path: before ? beforePath : path,
            sheets: before ? beforeSheets : afterSheets
        });
        return doc;
    });

    if (status === "added") showNotice("New file: everything is shown as added.");
    else if (status === "removed") showNotice("File deleted: its previous content is in the red bubble (inline) or left pane (side by side).");
    else if (change.previous) showNotice(`Renamed from ${change.previous}`);

    const { added, removed, modified } = views.stats;
    byId("stats").textContent = (added + removed + modified) === 0
        ? "No visible changes in <body>"
        : `+${added} added · −${removed} removed · ${modified} changed`;

    const inlineFrame = makeFrame(views.inline);
    const beforeFrame = hasBefore ? makeFrame(views.before) : null;
    const afterFrame = hasAfter ? makeFrame(views.after) : null;

    const inlinePane = makePane(`Inline · ${shortSha(info.after)}`, inlineFrame);
    const beforePane = makePane(`Before · ${shortSha(info.before)}`, beforeFrame || placeholder("File did not exist"));
    const afterPane = makePane(`After · ${shortSha(info.after)}`, afterFrame || placeholder("File was deleted"));
    inlinePane.style.flex = "1";

    const stage = byId("stage");
    stage.replaceChildren(inlinePane, beforePane, afterPane);

    if (beforeFrame && afterFrame) {
        const ignoreUntil: { [key: string]: number } = { before: 0, after: 0 };
        beforeFrame.addEventListener("load", () => scrollRatioSync(beforeFrame, afterFrame, ignoreUntil, "before", "after"));
        afterFrame.addEventListener("load", () => scrollRatioSync(afterFrame, beforeFrame, ignoreUntil, "after", "before"));
    }

    let mode: Mode = "inline";
    // index into the current frame's change list; reset whenever that list changes
    let cursor = -1;
    const applyMode = (next: Mode) => {
        mode = next;
        cursor = -1;
        inlinePane.hidden = mode !== "inline";
        beforePane.hidden = afterPane.hidden = mode !== "split";
        byId("mode-inline").classList.toggle("active", mode === "inline");
        byId("mode-split").classList.toggle("active", mode === "split");
        setData({ [StorageType.PR_DIFF_VIEW_MODE]: mode });
    };
    byId("mode-inline").onclick = () => applyMode("inline");
    byId("mode-split").onclick = () => applyMode("split");

    // side by side steps through the additions/edits on the right, then the removals on the left
    const step = (direction: number) => {
        const frames = mode === "inline" ? [inlineFrame] : [afterFrame, beforeFrame];
        const targets: HTMLElement[] = [];
        for (const frame of frames) {
            const doc = frame?.contentDocument;
            if (doc) targets.push(...Array.from(doc.querySelectorAll<HTMLElement>(CHANGE_SELECTOR)));
        }
        if (!targets.length) return;

        cursor = (cursor + direction + targets.length) % targets.length;
        const target = targets[cursor];
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.removeAttribute("data-hp-focus");
        void target.offsetWidth;
        target.setAttribute("data-hp-focus", "");
    };
    byId("prev").onclick = () => step(-1);
    byId("next").onclick = () => step(1);

    const saved = (await getData([StorageType.PR_DIFF_VIEW_MODE]))[StorageType.PR_DIFF_VIEW_MODE];
    applyMode(saved === "split" ? "split" : "inline");
};

run().catch(error => showError(error instanceof Error ? error.message : String(error)));
