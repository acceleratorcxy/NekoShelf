/**
 * 数据库 schema。v1 一次性建表，后续靠 migrations 表增量升级。
 * 只使用 SQLite 内置能力（WAL、FTS5、触发器）；不引入扩展。
 */

export const SCHEMA_VERSION = 5;

export const DDL_V1 = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','member','guest')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes     TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE libraries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  root_path    TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'mixed' CHECK (kind IN ('comic','video','mixed')),
  created_at   TEXT NOT NULL,
  last_scan_at TEXT
);

CREATE TABLE works (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id   INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  path_hash    TEXT NOT NULL,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('comic','image-set','video')),
  source_kind  TEXT NOT NULL DEFAULT 'directory' CHECK (source_kind IN ('directory','archive','video')),
  gid          INTEGER,
  page_count   INTEGER NOT NULL DEFAULT 0,
  rating       REAL,
  mtime        INTEGER,
  size_bytes   INTEGER,
  fingerprint  TEXT,
  has_comicinfo INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (library_id, path_hash)
);
CREATE INDEX idx_works_library ON works(library_id);
CREATE INDEX idx_works_kind ON works(kind);
CREATE INDEX idx_works_gid ON works(gid);

CREATE TABLE work_editions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  path       TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (work_id, path)
);

CREATE TABLE pages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id  INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  name     TEXT NOT NULL,
  subpath  TEXT,
  size_bytes INTEGER,
  width    INTEGER,
  height   INTEGER,
  UNIQUE (work_id, ordinal)
);

CREATE TABLE people (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE work_people (
  work_id   INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('artist','writer','group','series')),
  PRIMARY KEY (work_id, person_id, role)
);

CREATE TABLE tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL,
  name_zh   TEXT,
  UNIQUE (namespace, name)
);

CREATE TABLE work_tags (
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source  TEXT NOT NULL DEFAULT 'filename',
  PRIMARY KEY (work_id, tag_id)
);

CREATE TABLE series (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart')),
  query_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, work_id)
);

CREATE TABLE progress (
  work_id      INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL DEFAULT 0,
  page_count   INTEGER NOT NULL DEFAULT 0,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  page       INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  page       INTEGER,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  library_id  INTEGER,
  payload     TEXT,
  progress    TEXT,
  message     TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state);

CREATE TABLE job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level   TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX idx_job_logs_job ON job_logs(job_id);

CREATE TABLE skip_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TABLE ad_files (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  path    TEXT NOT NULL,
  reason  TEXT NOT NULL
);

CREATE TABLE scrape_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE backup_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE INDEX idx_audit_at ON audit_logs(at);

CREATE TABLE source_credentials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source)
);

-- 运行期设置（刮削开关、节奏等），键值对保持简单可审计
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE works_fts USING fts5(
  title, tags, content='works', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER works_ai AFTER INSERT ON works BEGIN
  INSERT INTO works_fts(rowid, title, tags) VALUES (new.id, new.title, '');
END;
CREATE TRIGGER works_ad AFTER DELETE ON works BEGIN
  INSERT INTO works_fts(works_fts, rowid, title, tags) VALUES ('delete', old.id, old.title, '');
END;
CREATE TRIGGER works_au AFTER UPDATE ON works BEGIN
  INSERT INTO works_fts(works_fts, rowid, title, tags) VALUES ('delete', old.id, old.title, '');
  INSERT INTO works_fts(rowid, title, tags) VALUES (new.id, new.title, '');
END;

PRAGMA user_version = 1;
`;

/**
 * v2：双语页配对 + 重复作品提示键。
 * - pages.lang / pages.pair_key：识别 `_CN` / `_EN` 等语言版本并配对。
 * - works.dup_key：标题归一化后用于「疑似重复」提示。
 */
export const DDL_V2 = `
ALTER TABLE pages ADD COLUMN lang TEXT;
ALTER TABLE pages ADD COLUMN pair_key TEXT;
CREATE INDEX IF NOT EXISTS idx_pages_pair ON pages(work_id, pair_key);
ALTER TABLE works ADD COLUMN dup_key TEXT;
CREATE INDEX IF NOT EXISTS idx_works_dup ON works(library_id, dup_key);
`;

/**
 * v3：重复合并写回（索引层）。
 * - works.merged_into：被合并副本指向保留作品（NULL 表示未合并）。
 * - works.hidden：合并后副本不再出现在书库/列表，但保留行以便撤销。
 * 源文件完全不动；撤销 = 清空这两列。
 */
export const DDL_V3 = `
ALTER TABLE works ADD COLUMN merged_into INTEGER;
ALTER TABLE works ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_works_merged ON works(merged_into);
`;

/**
 * v4：作者/系列与中文标题。
 * - works.series_id：所属系列（series.id）。
 * - works.title_zh：人工或 LLM 翻译后的中文标题（NULL 表示未翻译）。
 * 作者与系列通过既有的 people/work_people 表写入，不改列。
 */
export const DDL_V5 = `
CREATE TABLE IF NOT EXISTS work_chapters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  start_page INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  sort       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON work_chapters(work_id, sort);
`;

export const DDL_V4 = `
ALTER TABLE works ADD COLUMN title_zh TEXT;
ALTER TABLE works ADD COLUMN series_id INTEGER REFERENCES series(id);
CREATE INDEX IF NOT EXISTS idx_works_series ON works(series_id);
`;
