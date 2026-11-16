/**
 * 类型化 API 客户端。
 *
 * 契约来源：docs/api-contract.md
 * - 所有请求都带 Cookie（credentials: "include"）。
 * - 错误统一为 {error:{code,message}}，这里翻译成可读中文。
 */

export type Role = "admin" | "member" | "guest";

export interface User {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

export type LibraryKind = "comic" | "video" | "mixed";

export interface Library {
  id: string;
  name: string;
  rootPath: string;
  kind: LibraryKind;
  workCount: number;
  lastScanAt: string | null;
}

export type WorkKind = "comic" | "image-set" | "video";

export interface WorkProgress {
  page: number;
  pageCount: number;
}

export interface WorkCard {
  id: string;
  title: string;
  /** 中文标题（人工或 LLM 翻译），无则为 null。 */
  titleZh?: string | null;
  kind: WorkKind;
  pageCount: number;
  coverUrl: string | null;
  tags: string[];
  progress?: WorkProgress;
  libraryId: string;
  updatedAt: string;
}

export interface WorkAuthor {
  id?: number;
  role: "artist" | "writer" | "group" | "series";
  name: string;
}

export interface TreeEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  workId?: number;
  workTitle?: string;
  workKind?: string;
  pageCount?: number;
  workCount?: number;
}

export interface TreePageData {
  libraryId: string;
  libraryName: string;
  path: string;
  parent: string | null;
  entries: TreeEntry[];
}

export interface PersonSummary {
  id: number;
  name: string;
  count: number;
}

export interface SeriesSummary {
  id: number;
  name: string;
  count: number;
}

export interface PeoplePageData {
  person: { id: number; name: string };
  total: number;
  page: number;
  pageSize: number;
  items: WorkCard[];
}

export interface SeriesPageData {
  series: { id: number; name: string };
  total: number;
  page: number;
  pageSize: number;
  items: WorkCard[];
}

export interface WorkChapter {
  index: number;
  title: string;
  startPage: number;
  pageCount: number;
}

export interface WorkDetail extends WorkCard {
  chapters?: WorkChapter[];
  sourceKind: "directory" | "archive";
  archivePath?: string;
  editions?: string[];
  authors?: WorkAuthor[];
  series?: string | null;
  seriesId?: number | null;
  gid?: number | null;
  hasComicInfo?: boolean;
  rating?: number | null;
}

/* ── E-H 刮削 ─────────────────────────────────── */

export interface ScraperState {
  enabled: boolean;
  envGate: boolean;
  hasCredential: boolean;
  intervalMs: number;
  candidateCount: number;
}

export interface EhCookieInput {
  ipbMemberId: string;
  ipbPassHash: string;
  igneous: string;
  cfClearance?: string;
  userAgent?: string;
}

export interface UpdateScraperInput {
  enabled?: boolean;
  cookie?: EhCookieInput;
  minIntervalMs?: number;
}

export interface ScrapeApplied {
  workId: number;
  title: string;
  pageCount: number | null;
  tagCount: number;
  sourceUrl: string | null;
  cached: boolean;
}

export interface ScraperHealth {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface WorkEdition {
  id: string;
  label: string;
  path: string;
  pageCount: number;
}

export interface PageRef {
  index: number;
  width: number;
  height: number;
  thumbUrl: string;
  imageUrl: string;
}

export interface RelatedGroups {
  series: WorkCard[];
  authors: WorkCard[];
  tags: WorkCard[];
  /** 相似名称/目录（无 E-H 元数据时的兜底）。 */
  name?: WorkCard[];
}

/* ── 章节详情（合集/多话作品的单章） ─────────────────────── */

export interface ChapterDetail {
  work: {
    id: string;
    title: string;
    titleZh?: string | null;
    kind: WorkKind;
    pageCount: number;
    authors: WorkAuthor[];
    series: string | null;
  };
  chapter: WorkChapter;
  prevIndex: number | null;
  nextIndex: number | null;
  coverThumbUrl: string;
  coverImageUrl: string;
}

export async function getChapter(workId: string, index: number): Promise<ChapterDetail> {
  return request<ChapterDetail>(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(String(index))}`,
  );
}

export interface WorkDetailResponse {
  work: WorkDetail;
  editions: WorkEdition[];
  pages: PageRef[];
  chapters?: WorkChapter[];
  progress?: { page: number; updatedAt: string };
  /** 详情预览模式下，pages 只返回前 24 页，用 pageCount 表示全量页数。 */
  pageCount?: number;
}

/* ── AI 自然语言搜索 ──────────────────────────── */

export interface AiState {
  enabled: boolean;
  envGate: boolean;
  configured: boolean;
  apiKeyHint: string | null;
  classifyEnabled: boolean;
  model: string;
  baseUrl: string;
  explain: boolean;
  summarize: boolean;
  usage: { requests: number };
}

export interface UpdateAiInput {
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  explain?: boolean;
  summarize?: boolean;
  classify?: boolean;
}

export interface AiFacet {
  name: string;
  count: number;
}

export interface AiCard {
  id: string;
  title: string;
  kind: WorkKind;
  pageCount: number;
  rating?: number | null;
  gid?: number | null;
  tags: string[];
  coverUrl: string;
  thumbUrl: string;
  imageUrl: string;
}

export interface AiQueryResult {
  query: string;
  explanation: string | null;
  sort: WorkSort;
  total: number;
  items: AiCard[];
  facets: AiFacet[];
  effective: boolean;
}

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  type: string;
  state: JobState;
  progress: { done: number; total: number };
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorksPage {
  items: WorkCard[];
  total: number;
  page: number;
  pageSize: number;
}

export type WorkSort = "recent" | "title" | "rating";

export interface OrganizeState {
  enabled: boolean;
  writebackEnabled: boolean;
  pattern: string;
  nfoEnabled: boolean;
}

export interface UpdateOrganizeInput {
  enabled?: boolean;
  pattern?: string;
  nfo?: boolean;
}

export interface JournalEntry {
  id: string;
  type: string;
  at: string;
  detail: string;
}

export interface JournalUndoResult {
  ok: boolean;
  undone: number;
  rescanRequired: boolean;
  type: string;
}

export interface NfoWriteResult {
  ok: boolean;
  path: string;
  filename: string;
  journalId: string;
}

export interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface MaintenanceState {
  version: string;
  configDir: string;
  backupCount: number;
  backups: BackupEntry[];
}

export interface MergeResult {
  ok: boolean;
  keepId: number;
  merged: number;
  dropIds: number[];
  journalId: string;
}

export interface OrganizePreviewItem {
  workId: number;
  title: string;
  kind: string;
  pages: number;
  from: string;
  to: string;
  conflict: string | null;
}

export interface OrganizePreview {
  pattern: string;
  writebackEnabled: boolean;
  enabled: boolean;
  library: { id: number; rootPath: string };
  items: OrganizePreviewItem[];
  conflictCount: number;
}

export interface OrganizeApplyResult {
  applied: number;
  failed: number;
  journalPath: string;
  rescanRequired: boolean;
}

export interface DuplicateWork {
  id: number;
  title: string;
  path: string;
  pageCount: number;
}

export interface DuplicateGroup {
  key: string;
  count: number;
  works: DuplicateWork[];
}

export interface MergePlan {
  keepId: number;
  dropIds: number[];
  mergedTags: string[];
  totalPages: number;
  warnings: string[];
}

export interface WorksQuery {
  q?: string;
  libraryId?: string;
  kind?: WorkKind;
  sort?: WorkSort;
  page?: number;
  pageSize?: number;
}

export interface SetupStatus {
  initialized: boolean;
}

export interface CreateLibraryInput {
  name: string;
  rootPath: string;
  kind: LibraryKind;
}

export interface TagRef {
  namespace: string;
  name: string;
  count: number;
}

/** 契约里定义的错误码；网络失败是客户端额外加的一条。 */
export type ApiErrorCode =
  | "unauthorized"
  | "bad_credentials"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "forbidden"
  | "internal"
  | "network_error"
  | "ai_disabled"
  | "ai_not_configured"
  | "ai_llm_auth_failed"
  | "ai_llm_rate_limited"
  | "ai_llm_timeout"
  | "ai_llm_network"
  | "ai_llm_model_not_found"
  | "ai_bad_response"
  | "writeback_disabled"
  | "organize_disabled"
  | "confirm_required"
  | "invalid_pattern"
  | "not_duplicate"
  | "library_not_found"
  | "invalid_path"
  | "target_exists";

const FALLBACK_MESSAGES: Record<string, string> = {
  unauthorized: "登录状态已失效，请重新登录",
  bad_credentials: "用户名或密码不正确",
  not_found: "找不到请求的内容",
  validation_failed: "提交的内容不合法，请检查后重试",
  conflict: "操作冲突，请刷新页面后重试",
  forbidden: "没有权限执行这个操作",
  internal: "服务器内部错误，请稍后重试",
  network_error: "无法连接服务器，请确认后端已启动后重试",
  scraper_disabled: "刮削未开启（需容器环境变量 ENABLE_SCRAPER=1 且设置页开关打开）",
  no_credential: "尚未导入里站 Cookie，请先在设置页导入",
  credential_invalid: "里站 Cookie 已失效，请重新导入",
  already_scraped: "该作品已有元数据；如要覆盖请选择「强制重刮」",
  no_gid: "该作品没有 gid，无法在里站定位",
  cf_challenge: "里站被 Cloudflare 拦截，请更新 cf_clearance",
  rate_limited: "里站配额超限（509），请稍后再试",
  scrape_failed: "刮削失败，请稍后重试",
  ai_disabled: "AI 搜索未开启（需容器环境变量 ENABLE_LLM_SEARCH=1 且设置页开关打开）",
  ai_not_configured: "尚未配置 LLM API Key，请先在设置页填写",
  ai_llm_auth_failed: "LLM 鉴权失败：API Key 无效或已失效",
  ai_llm_rate_limited: "LLM 限流或余额不足，请稍后再试",
  ai_llm_timeout: "LLM 响应超时，请稍后重试",
  ai_llm_network: "无法连接 LLM 服务，请检查网络或 Base URL",
  ai_llm_model_not_found: "模型名不存在，请检查设置里的模型名",
  ai_bad_response: "模型回答无法解析成检索条件，换个说法试试",
  writeback_disabled: "整理写回需要容器以 DATA_MODE=writeback 启动",
  organize_disabled: "整理未开启，请先在设置页打开整理开关",
  confirm_required: "整理是写操作，需要再次确认",
  invalid_pattern: "整理模板不合法，请检查后重试",
  not_duplicate: "该作品没有疑似重复条目",
  library_not_found: "媒体库不存在，请刷新后重试",
  invalid_path: "目标路径越出媒体库根目录，已阻止",
  target_exists: "目标已存在同名文件，已跳过",
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }

  get isUnauthorized(): boolean {
    return this.code === "unauthorized" || this.status === 401;
  }
}

/** 把任意 catch 到的异常转成一句可读中文。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return `发生错误：${error.message}`;
  return "发生未知错误，请稍后重试";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, QueryValue>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

interface ErrorPayload {
  error: { code: string; message?: string };
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const outer = value as { error?: unknown };
  if (typeof outer.error !== "object" || outer.error === null) return false;
  const inner = outer.error as { code?: unknown; message?: unknown };
  return typeof inner.code === "string";
}

/** 从响应体里尽量抽出 {code,message}，抽不到就按 HTTP 状态兜底。 */
function toApiError(status: number, raw: string): ApiError {
  let code = status === 401 ? "unauthorized" : status === 404 ? "not_found" : "internal";
  let detail = "";
  try {
    const parsed: unknown = raw.trim() === "" ? null : JSON.parse(raw);
    if (isErrorPayload(parsed)) {
      code = parsed.error.code || code;
      detail = typeof parsed.error.message === "string" ? parsed.error.message.trim() : "";
    }
  } catch {
    // 非 JSON 响应体：保留状态码兜底
  }

  const fallback = FALLBACK_MESSAGES[code];
  if (fallback) {
    const message = detail !== "" && hasCjk(detail) && detail !== fallback ? `${fallback}：${detail}` : fallback;
    return new ApiError(code, message, status);
  }
  if (detail !== "") return new ApiError(code, detail, status);
  return new ApiError(code, `请求失败（HTTP ${status}）`, status);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, query } = options;

  let response: Response;
  try {
    const init: RequestInit = { method, credentials: "include" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    if (signal) init.signal = signal;
    response = await fetch(buildUrl(path, query), init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError("network_error", FALLBACK_MESSAGES["network_error"] ?? "网络请求失败", 0);
  }

  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }

  if (!response.ok) throw toApiError(response.status, raw);

  if (response.status === 204 || response.status === 205 || raw.trim() === "") {
    return undefined as unknown as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError("internal", "服务器返回的数据无法解析", response.status);
  }
}

/** 库内原始文件地址（文件树里预览图片/播放视频用）。 */
export function libraryFileUrl(
  libraryId: string,
  path: string,
  options: { thumb?: boolean; width?: number } = {},
): string {
  const params = new URLSearchParams({ path });
  if (options.thumb) params.set("thumb", "1");
  if (options.width) params.set("w", String(options.width));
  return `/api/libraries/${encodeURIComponent(libraryId)}/file?${params.toString()}`;
}

/** 封面地址：优先用接口给的 coverUrl，否则退回封面端点（404 时前端显示占位块）。 */
export function coverSrc(work: Pick<WorkCard, "id" | "coverUrl">): string {
  if (work.coverUrl) return work.coverUrl;
  return `/api/works/${encodeURIComponent(work.id)}/cover`;
}

export function pageImageSrc(workId: string, page: PageRef): string {
  if (page.imageUrl) return page.imageUrl;
  return `/api/works/${encodeURIComponent(workId)}/pages/${page.index}/image`;
}

/**
 * 页面缩略图地址。width 会在服务端缩放到指定宽度（80–800 之间生效），
 * 服务端未实现时该参数会被忽略，仍然返回默认缩略图。
 */
export function pageThumbSrc(workId: string, page: PageRef, width?: number): string {
  const base = page.thumbUrl || `/api/works/${encodeURIComponent(workId)}/pages/${page.index}/thumb`;
  if (!width || !Number.isFinite(width)) return base;
  const clamped = Math.min(800, Math.max(80, Math.round(width)));
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}w=${clamped}`;
}

/**
 * 页面关闭/切后台时补发一次进度。
 * PUT 不能用 sendBeacon，这里用 fetch 的 keepalive 让请求在卸载后继续。
 */
export function saveProgressBeacon(workId: string, page: number): void {
  if (!workId || page <= 0) return;
  try {
    void fetch(`/api/works/${encodeURIComponent(workId)}/progress`, {
      method: "PUT",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page }),
    }).catch(() => undefined);
  } catch {
    // 卸载过程中失败可以忽略，下次进入会重新同步
  }
}

export const api = {
  healthz: () =>
    request<{ ok: boolean; version: string; uptimeSec: number; db: string }>("/healthz"),

  setupStatus: () => request<SetupStatus>("/api/setup/status"),

  setup: (input: { username: string; password: string }) =>
    request<{ user: User }>("/api/setup", { method: "POST", body: input }),

  login: (input: { username: string; password: string }) =>
    request<{ user: User }>("/api/auth/login", { method: "POST", body: input }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  me: () => request<{ user: User }>("/api/auth/me"),

  listLibraries: () => request<{ items: Library[] }>("/api/libraries"),

  createLibrary: (input: CreateLibraryInput) =>
    request<{ library: Library }>("/api/libraries", { method: "POST", body: input }),

  scanLibrary: (libraryId: string) =>
    request<{ jobId: string }>(`/api/libraries/${encodeURIComponent(libraryId)}/scan`, {
      method: "POST",
    }),

  deleteLibrary: (libraryId: string) =>
    request<void>(`/api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" }),

  getJob: async (jobId: string, signal?: AbortSignal) => {
    const response = await request<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
    return response.job;
  },

  listWorks: (query: WorksQuery, signal?: AbortSignal) =>
    request<WorksPage>("/api/works", {
      signal,
      query: {
        q: query.q,
        libraryId: query.libraryId,
        kind: query.kind,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      },
    }),

  listPeople: (query: { q?: string; limit?: number } = {}) =>
    request<{ items: PersonSummary[] }>("/api/people", { query: { q: query.q, limit: query.limit } }),

  getPerson: (personId: number, page = 1, pageSize = 48) =>
    request<PeoplePageData>(`/api/people/${personId}`, { query: { page, pageSize } }),

  listSeries: (query: { q?: string; limit?: number } = {}) =>
    request<{ items: SeriesSummary[] }>("/api/series", { query: { q: query.q, limit: query.limit } }),

  getSeries: (seriesId: number, page = 1, pageSize = 48) =>
    request<SeriesPageData>(`/api/series/${seriesId}`, { query: { page, pageSize } }),

  getRelated: (workId: string) =>
    request<{ items: WorkCard[]; groups: RelatedGroups }>(
      `/api/works/${encodeURIComponent(workId)}/related`,
    ),

  translateTitle: (workId: string) =>
    request<{ id: number; title: string; titleZh: string }>(
      `/api/works/${encodeURIComponent(workId)}/translate-title`,
      { method: "POST" },
    ),

  classifyWork: (workId: string) =>
    request<{
      id: number;
      kind: WorkKind;
      previousKind?: WorkKind;
      cached: boolean;
      result: { kind: WorkKind; confidence: number; reason?: string };
    }>(`/api/works/${encodeURIComponent(workId)}/classify`, { method: "POST" }),

  getTree: (libraryId: string, path = "") =>
    request<TreePageData>(`/api/libraries/${encodeURIComponent(libraryId)}/tree`, {
      query: { path },
    }),

  getChapter: (workId: string, index: number) =>
    request<ChapterDetail>(`/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(String(index))}`),

  getWork: (workId: string, signal?: AbortSignal, options: { preview?: boolean } = {}) =>
    request<WorkDetailResponse>(`/api/works/${encodeURIComponent(workId)}`, {
      signal,
      query: options.preview ? { pages: "preview" } : undefined,
    }),

  saveProgress: (workId: string, page: number) =>
    request<void>(`/api/works/${encodeURIComponent(workId)}/progress`, {
      method: "PUT",
      body: { page },
    }),

  listTags: (query: { q?: string; limit?: number } = {}) =>
    request<{ items: TagRef[] }>("/api/tags", { query: { q: query.q, limit: query.limit } }),

  getScraper: () => request<{ scraper: ScraperState }>("/api/scraper"),

  updateScraper: (input: UpdateScraperInput) =>
    request<{ scraper: ScraperState }>("/api/scraper", { method: "PUT", body: input }),

  deleteScraperCookie: () =>
    request<{ scraper: ScraperState }>("/api/scraper/cookie", { method: "DELETE" }),

  scraperHealth: () =>
    request<{ health: ScraperHealth }>("/api/scraper/health", { method: "POST" }),

  scrapeWork: (workId: string, force = false) =>
    request<{ ok: boolean; applied: ScrapeApplied }>(
      `/api/scrape/works/${encodeURIComponent(workId)}`,
      { method: "POST", body: { force } },
    ),

  scrapeBatch: (input: { libraryId?: string; limit?: number; force?: boolean } = {}) =>
    request<{ jobId: string | null; candidates: number }>("/api/scrape/batch", {
      method: "POST",
      body: input,
    }),

  getAi: () => request<{ ai: AiState }>("/api/ai"),

  updateAi: (input: UpdateAiInput) =>
    request<{ ai: AiState }>("/api/ai", { method: "PUT", body: input }),

  deleteAiKey: () => request<{ ai: AiState }>("/api/ai/key", { method: "DELETE" }),

  aiHealth: () => request<{ health: ScraperHealth }>("/api/ai/health", { method: "POST" }),

  aiQuery: (q: string, signal?: AbortSignal) =>
    request<AiQueryResult>("/api/ai/query", { method: "POST", body: { q }, signal }),

  listJobs: (signal?: AbortSignal) => request<{ items: Job[] }>("/api/jobs", { signal }),

  getOrganize: () => request<{ organize: OrganizeState }>("/api/organize"),

  updateOrganize: (input: UpdateOrganizeInput) =>
    request<{ ok: boolean; writebackEnabled: boolean }>("/api/organize", { method: "PUT", body: input }),

  organizePreview: (query: { libraryId: string; pattern?: string; limit?: number }) =>
    request<OrganizePreview>("/api/organize/preview", {
      query: { libraryId: query.libraryId, pattern: query.pattern, limit: query.limit },
    }),

  organizeApply: (input: { libraryId: string; workIds?: number[] }) =>
    request<OrganizeApplyResult>("/api/organize/apply", {
      method: "POST",
      body: { ...input, confirm: true },
    }),

  workNfo: (workId: string) =>
    request<{ filename: string; content: string; writePath: string | null; writebackEnabled: boolean }>(
      `/api/works/${encodeURIComponent(workId)}/nfo`,
    ),

  writeNfo: (workId: string, force = false) =>
    request<NfoWriteResult>(`/api/works/${encodeURIComponent(workId)}/nfo`, {
      method: "POST",
      body: { confirm: true, force },
    }),

  listJournal: () => request<{ entries: JournalEntry[] }>("/api/organize/journal"),

  undoJournal: (id: string) =>
    request<JournalUndoResult>(`/api/organize/undo/${encodeURIComponent(id)}`, { method: "POST" }),

  getMaintenance: () => request<{ maintenance: MaintenanceState }>("/api/maintenance"),

  createBackup: () => request<{ backup: BackupEntry }>("/api/maintenance/backup", { method: "POST" }),

  mergeWorks: (keepId: number) =>
    request<MergeResult>("/api/works/merge", { method: "POST", body: { keepId, confirm: true } }),

  listDuplicates: () => request<{ groups: DuplicateGroup[] }>("/api/duplicates"),

  previewMerge: (keepId: number) =>
    request<{ plan: MergePlan; writebackEnabled: boolean }>("/api/duplicates/preview-merge", {
      method: "POST",
      body: { keepId },
    }),
};
