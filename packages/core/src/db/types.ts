/** 与数据库行一一对应的领域类型。 */

export type WorkKind = "comic" | "image-set" | "video";
export type SourceKind = "directory" | "archive" | "video";
export type LibraryKind = "comic" | "video" | "mixed";
export type Role = "admin" | "member" | "guest";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

export interface LibraryRow {
  id: number;
  name: string;
  root_path: string;
  kind: LibraryKind;
  created_at: string;
  last_scan_at: string | null;
}

export interface WorkChapter {
  id: number;
  work_id: number;
  /** 分部/套图标题（目录名）。 */
  title: string;
  /** 相对作品目录的路径。 */
  rel_path: string;
  /** 该分部第一页在作品页序列中的 1-based 位置。 */
  start_page: number;
  page_count: number;
  sort: number;
}

export interface WorkRow {
  id: number;
  library_id: number;
  path: string;
  path_hash: string;
  title: string;
  kind: WorkKind;
  source_kind: SourceKind;
  gid: number | null;
  page_count: number;
  rating: number | null;
  mtime: number | null;
  size_bytes: number | null;
  fingerprint: string | null;
  /** 目录内是否存在 ComicInfo.xml（用于「已有元数据不重刮」判定）。 */
  has_comicinfo: number;
  /** 标题归一化键，用于疑似重复提示。 */
  dup_key?: string | null;
  /** 被合并到的保留作品 id。 */
  merged_into?: number | null;
  /** 合并后副本隐藏，不再出现在书库列表。 */
  hidden?: number;
  /** 中文标题（人工或 LLM 翻译），NULL 表示未翻译。 */
  title_zh?: string | null;
  /** 所属系列 id。 */
  series_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: number;
  work_id: number;
  ordinal: number;
  name: string;
  subpath: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  /** 语言版本：'' = 原文/未知，zh / zh-Hant / en / ja。 */
  lang?: string | null;
  /** 配对键：同键不同语言即为对照页。 */
  pair_key?: string | null;
}

export interface ProgressRow {
  work_id: number;
  page: number;
  page_count: number;
  finished_at: string | null;
  updated_at: string;
}

export interface TagRow {
  id: number;
  namespace: string;
  name: string;
  name_zh: string | null;
}

export interface JobRow {
  id: string;
  type: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  library_id: number | null;
  payload: string | null;
  progress: string | null;
  message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkQuery {
  q?: string;
  libraryId?: number;
  kind?: WorkKind;
  personId?: number;
  seriesId?: number;
  sort?: "recent" | "title" | "rating";
  page?: number;
  pageSize?: number;
}
