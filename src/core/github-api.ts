import { getData } from "../shared/chrome";
import { StorageType } from "../shared/type";

const API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const CACHE_TTL_MS = 60 * 1000;

export interface DiffInfoRequest {
    owner: string;
    repo: string;
    pr: number;
    // undefined = whole PR, "<sha>" = single commit, "<from>..<to>" = commit range
    range?: string;
}

export interface FileContentRequest {
    owner: string;
    repo: string;
    path: string;
    ref: string;
}

export interface FileChange {
    status: string;
    previous?: string;
}

export interface PrDiffInfo {
    before: string | null;
    after: string;
    files: { [path: string]: FileChange };
}

export interface ApiResponse<T> {
    ok: boolean;
    data?: T;
    error?: string;
}

// These values originate from a URL hash and end up in a token-bearing API path, so they are validated, not just encoded.
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;

const assertValid = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`Invalid ${what}.`);
}

const validateRepo = (owner: string, repo: string) => {
    assertValid(NAME.test(owner) && NAME.test(repo), "repository");
}

const getTokens = async (): Promise<string[]> => {
    const data = await getData([StorageType.GITHUB_OAUTH_TOKEN, StorageType.INPUT_TOKEN]);
    return [data[StorageType.GITHUB_OAUTH_TOKEN], data[StorageType.INPUT_TOKEN]].filter(token => !!token);
}

const describeFailure = (status: number): string => {
    if (status === 404) return "Not found. If this is a private repository, add a GitHub token in the extension popup.";
    if (status === 401 || status === 403) return "GitHub denied the request (rate limit or missing access). Log in or add a GitHub token in the extension popup.";
    return `GitHub API request failed (HTTP ${status}).`;
}

const request = async (path: string, accept: string): Promise<Response> => {
    const attempts: (string | null)[] = [...await getTokens(), null];
    let lastStatus = 0;
    for (const token of attempts) {
        const headers: { [name: string]: string } = {
            "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28"
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const response = await fetch(`${API}${path}`, { headers });
        if (response.ok) return response;

        lastStatus = response.status;
        // a bad/insufficient token falls through to the next token, then to anonymous access
        if (lastStatus !== 401 && lastStatus !== 403 && lastStatus !== 404) break;
    }
    throw new Error(describeFailure(lastStatus));
}

const getJson = async (path: string): Promise<any> => {
    return (await request(path, "application/vnd.github+json")).json();
}

// `first` is page 1 when the caller already fetched it, so it is not requested twice.
const listFiles = async (path: string, pick: (json: any) => any[], first?: any): Promise<any[]> => {
    const files: any[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
        const json = page === 1 && first !== undefined ? first : await getJson(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
        const items = pick(json) || [];
        files.push(...items);
        if (items.length < PAGE_SIZE) break;
    }
    return files;
}

const toFileMap = (files: any[]): { [path: string]: FileChange } => {
    const map: { [path: string]: FileChange } = {};
    for (const file of files) {
        map[file.filename] = { status: file.status, previous: file.previous_filename };
    }
    return map;
}

const loadPrDiffInfo = async ({ owner, repo, pr, range }: DiffInfoRequest): Promise<PrDiffInfo> => {
    validateRepo(owner, repo);
    assertValid(Number.isInteger(pr) && pr > 0, "pull request number");
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    if (range && /\.{2,3}/.test(range)) {
        const [from, to] = range.split(/\.{2,3}/);
        assertValid(SHA.test(from) && SHA.test(to), "commit range");
        const comparePath = `${repoPath}/compare/${from}...${to}`;
        const first = await getJson(`${comparePath}?per_page=${PAGE_SIZE}&page=1`);
        const files = await listFiles(comparePath, json => json.files, first);
        // the file list is a three-dot compare, so "before" must be the merge base for the two to agree
        return { before: first.merge_base_commit?.sha ?? from, after: to, files: toFileMap(files) };
    }

    if (range) {
        assertValid(SHA.test(range), "commit");
        const commitPath = `${repoPath}/commits/${range}`;
        const commit = await getJson(`${commitPath}?per_page=${PAGE_SIZE}&page=1`);
        const files = await listFiles(commitPath, json => json.files, commit);
        return { before: commit.parents?.[0]?.sha ?? null, after: commit.sha, files: toFileMap(files) };
    }

    const pull = await getJson(`${repoPath}/pulls/${pr}`);
    const baseSha: string = pull.base.sha;
    const headSha: string = pull.head.sha;
    const [comparison, files] = await Promise.all([
        getJson(`${repoPath}/compare/${baseSha}...${headSha}?per_page=1`),
        listFiles(`${repoPath}/pulls/${pr}/files`, json => json)
    ]);
    // GitHub's PR diff is taken against the merge base, not the base branch tip
    return { before: comparison.merge_base_commit?.sha ?? baseSha, after: headSha, files: toFileMap(files) };
}

const infoCache = new Map<string, { at: number, info: Promise<PrDiffInfo> }>();

export const getPrDiffInfo = (req: DiffInfoRequest): Promise<PrDiffInfo> => {
    const key = `${req.owner}/${req.repo}#${req.pr}@${req.range ?? ""}`;
    const cached = infoCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info;

    const info = loadPrDiffInfo(req);
    infoCache.set(key, { at: Date.now(), info });
    info.catch(() => infoCache.delete(key));
    return info;
}

export const getFileContent = async ({ owner, repo, path, ref }: FileContentRequest): Promise<string> => {
    validateRepo(owner, repo);
    assertValid(SHA.test(ref), "ref");
    const segments = path.split("/");
    assertValid(segments.every(segment => segment !== "" && segment !== "." && segment !== ".."), "file path");

    const encodedPath = segments.map(encodeURIComponent).join("/");
    const response = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${ref}`, "application/vnd.github.raw+json");
    return response.text();
}

export const toResponse = async <T>(work: () => Promise<T>): Promise<ApiResponse<T>> => {
    try {
        return { ok: true, data: await work() };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
