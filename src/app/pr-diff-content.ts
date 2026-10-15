import { getExtensionUrl } from '../shared/chrome';

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:(?:files|changes)(?:\/([^/]+))?|commits\/([0-9a-f]{7,40}))\/?$/;
const HTML_FILE = /\.html?$/i;
const NEW_DIFF_LABEL = "Diff for: ";
const BUTTON_ATTR = "data-hp-preview-button";
const PANEL_ATTR = "data-hp-preview-panel";

interface PrContext {
    owner: string;
    repo: string;
    pr: string;
    range?: string;
}

interface FileDiff {
    path: string;
    // the new layout carries the diff table, the classic layout carries the .file container
    diff: Element;
    insertButton: (button: HTMLElement) => void;
    insertPanel: (panel: HTMLElement) => void;
    buttonClass: string;
}

const getPrContext = (): PrContext | null => {
    const match = PR_PATH.exec(location.pathname);
    if (!match) return null;
    return { owner: match[1], repo: match[2], pr: match[3], range: match[4] || match[5] };
}

const isDarkTheme = (): boolean => {
    const mode = document.documentElement.getAttribute("data-color-mode");
    return mode === "dark" || (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

const styled = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
}

const BUTTON_CSS = [
    "height:28px", "padding:0 10px", "margin-right:4px", "font-size:12px", "font-weight:500", "cursor:pointer",
    "border:1px solid var(--button-default-borderColor-rest, var(--borderColor-default, #d1d9e0))",
    "border-radius:6px",
    "background:var(--button-default-bgColor-rest, var(--bgColor-muted, #f6f8fa))",
    "color:var(--fgColor-default, #1f2328)"
].join(";");

const findNewLayoutFiles = (): FileDiff[] => {
    const files: FileDiff[] = [];
    document.querySelectorAll(`[role="grid"][aria-label^="${NEW_DIFF_LABEL}"]`).forEach(grid => {
        const path = grid.getAttribute("aria-label")!.slice(NEW_DIFF_LABEL.length);

        // the file container is the nearest ancestor that also holds the file header
        let container: Element | null = grid.parentElement;
        while (container && container !== document.body && !container.querySelector("h3")) container = container.parentElement;
        if (!container || container === document.body) return;

        const expand = container.querySelector(`button[data-file-path="${CSS.escape(path)}"]`);
        const viewed = container.querySelector('button[aria-pressed][aria-label$="Viewed"]');
        const anchor = expand || viewed;

        files.push({
            path,
            diff: grid,
            buttonClass: "",
            insertButton: button => {
                if (anchor) {
                    anchor.insertAdjacentElement("beforebegin", button);
                } else {
                    const bar = styled("div", "display:flex;justify-content:flex-end;padding:4px 8px");
                    bar.appendChild(button);
                    grid.insertAdjacentElement("beforebegin", bar);
                }
            },
            insertPanel: panel => grid.insertAdjacentElement("beforebegin", panel)
        });
    });
    return files;
}

const findClassicLayoutFiles = (): FileDiff[] => {
    const files: FileDiff[] = [];
    document.querySelectorAll<HTMLElement>(".file[data-tagsearch-path]").forEach(file => {
        const actions = file.querySelector(".file-header .file-actions");
        const header = file.querySelector(".file-header");
        if (!actions || !header) return;
        files.push({
            path: file.getAttribute("data-tagsearch-path")!,
            diff: file,
            buttonClass: "btn btn-sm",
            insertButton: button => actions.insertAdjacentElement("afterbegin", button),
            insertPanel: panel => header.insertAdjacentElement("afterend", panel)
        });
    });
    return files;
}

const openPaths = new Set<string>();

const stateKey = (ctx: PrContext, path: string) => `${ctx.owner}/${ctx.repo}#${ctx.pr}@${ctx.range ?? ""}:${path}`;

const findPanel = (key: string): HTMLElement | undefined => {
    return Array.from(document.querySelectorAll<HTMLElement>(`[${PANEL_ATTR}]`)).find(panel => panel.getAttribute(PANEL_ATTR) === key);
}

const createPanel = (ctx: PrContext, path: string, key: string, onClose: () => void): HTMLElement => {
    const params = new URLSearchParams({ owner: ctx.owner, repo: ctx.repo, pr: ctx.pr, path, theme: isDarkTheme() ? "dark" : "light" });
    if (ctx.range) params.set("range", ctx.range);

    const border = "1px solid var(--borderColor-default, #d1d9e0)";
    const panel = styled("div", `display:flex;flex-direction:column;height:70vh;min-height:240px;margin:8px;border:${border};border-radius:6px;overflow:hidden;resize:vertical;background:var(--bgColor-default, #fff)`);
    panel.setAttribute(PANEL_ATTR, key);

    const bar = styled("div", `display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;border-bottom:${border};background:var(--bgColor-muted, #f6f8fa);color:var(--fgColor-default, #1f2328)`);
    const title = styled("strong", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `HTML diff preview · ${path}`);
    const fullscreen = styled("button", BUTTON_CSS, "Full screen");
    const close = styled("button", BUTTON_CSS, "Close");
    fullscreen.type = close.type = "button";
    bar.append(title, fullscreen, close);

    const frame = styled("iframe", "flex:1;width:100%;border:0");
    frame.src = `${getExtensionUrl("viewer/viewer.html")}#${params.toString()}`;
    frame.title = `HTML diff preview of ${path}`;

    const normalCss = panel.style.cssText;
    const setFullscreen = (on: boolean) => {
        panel.style.cssText = on
            ? `${normalCss};position:fixed;inset:0;z-index:2147483000;height:auto;margin:0;border-radius:0;resize:none`
            : normalCss;
        fullscreen.textContent = on ? "Exit full screen" : "Full screen";
    };
    let isFullscreen = false;
    fullscreen.onclick = () => { isFullscreen = !isFullscreen; setFullscreen(isFullscreen); };
    const onKey = (event: KeyboardEvent) => {
        if (!panel.isConnected) {
            // GitHub re-rendered the diff and dropped this panel
            document.removeEventListener("keydown", onKey);
        } else if (event.key === "Escape" && isFullscreen) {
            isFullscreen = false;
            setFullscreen(false);
        }
    };
    document.addEventListener("keydown", onKey);
    close.onclick = () => { document.removeEventListener("keydown", onKey); panel.remove(); onClose(); };

    panel.append(bar, frame);
    return panel;
}

const attributeValues = (attribute: string): Set<string> => {
    return new Set(Array.from(document.querySelectorAll(`[${attribute}]`)).map(el => el.getAttribute(attribute)!));
}

const scan = () => {
    const ctx = getPrContext();
    if (!ctx) return;

    // one document query per attribute per scan, not one per file
    const buttons = attributeValues(BUTTON_ATTR);
    const panels = attributeValues(PANEL_ATTR);

    for (const file of [...findNewLayoutFiles(), ...findClassicLayoutFiles()]) {
        if (!HTML_FILE.test(file.path)) continue;
        const key = stateKey(ctx, file.path);

        const open = () => {
            openPaths.add(key);
            if (!findPanel(key)) file.insertPanel(createPanel(ctx, file.path, key, () => openPaths.delete(key)));
        };

        if (!buttons.has(key)) {
            const button = styled("button", BUTTON_CSS, "Preview");
            button.type = "button";
            if (file.buttonClass) button.className = file.buttonClass;
            button.setAttribute(BUTTON_ATTR, key);
            button.title = "Preview this HTML file with added and removed parts highlighted";
            button.onclick = event => {
                event.preventDefault();
                event.stopPropagation();
                const panel = findPanel(key);
                if (panel) {
                    panel.remove();
                    openPaths.delete(key);
                } else {
                    open();
                }
            };
            file.insertButton(button);
        }

        // GitHub re-renders diffs; bring back panels the user left open
        if (openPaths.has(key) && !panels.has(key)) open();
    }
}

let scheduled = false;
const scheduleScan = () => {
    // the observer stays attached for SPA navigation, but non-PR pages should cost nothing
    if (scheduled || !getPrContext()) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        try { scan(); } catch (ignore) {}
    });
}

scheduleScan();
new MutationObserver(scheduleScan).observe(document, { childList: true, subtree: true });
