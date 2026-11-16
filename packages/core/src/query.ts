/**
 * 作品列表的搜索查询语法。
 *
 * 语法（空白分隔，`,` 等价于空格）：
 *   keyword          普通关键词（AND，走 FTS 标题索引）
 *   keyword1,keyword2 逗号 = AND
 *   -keyword         排除（标题不含）
 *   $title           精确标题（不区分大小写）
 *   wild?card*       支持 ? * % 通配（? = 单字符，* / % = 任意字符）
 *   tag:name         按标签名过滤（含 namespace 时写 tag:namespace:name）
 *   pages:>20        页数过滤（支持 > < >= <= = N，或 pages:20-30 区间）
 *   read:<=30        阅读进度过滤（0–100，未读按 0 算；支持区间 read:0-10）
 *
 * 本文件只做「解析 + 编译为 SQL 片段」，不碰数据库连接，便于单测。
 */
export interface SearchTagFilter {
  namespace?: string;
  name: string;
  exclude: boolean;
}

export interface SearchFilters {
  raw: string;
  terms: string[];
  excludes: string[];
  exact: string[];
  wildcards: string[];
  tags: SearchTagFilter[];
  pageMin?: number;
  pageMax?: number;
  readMin?: number;
  readMax?: number;
}

/** 每次返回全新对象，避免调用方 push 污染共享数组。 */
function emptyFilters(): SearchFilters {
  return { raw: "", terms: [], excludes: [], exact: [], wildcards: [], tags: [] };
}

function parseRange(value: string): { min?: number; max?: number } {
  const text = value.trim();
  if (!text) return {};
  let m = /^(\d+)-(\d+)$/.exec(text);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = /^(>=|<=|>|<|=)(\d+)$/.exec(text);
  if (m) {
    const n = Number(m[2]);
    switch (m[1]) {
      case ">=":
        return { min: n };
      case ">":
        return { min: n + 1 };
      case "<=":
        return { max: n };
      case "<":
        return { max: n - 1 };
      default:
        return { min: n, max: n };
    }
  }
  const single = Number(text);
  if (Number.isFinite(single)) return { min: single, max: single };
  return {};
}

function mergeRange(
  current: { min?: number; max?: number },
  next: { min?: number; max?: number },
): void {
  if (next.min !== undefined) {
    current.min = current.min === undefined ? next.min : Math.max(current.min, next.min);
  }
  if (next.max !== undefined) {
    current.max = current.max === undefined ? next.max : Math.min(current.max, next.max);
  }
}

/** 解析用户输入的搜索串；空串返回空过滤器。 */
export function parseSearchQuery(input: string | undefined | null): SearchFilters {
  const raw = (input ?? "").trim();
  if (!raw) return emptyFilters();
  const filters: SearchFilters = { ...emptyFilters(), raw };
  const page: { min?: number; max?: number } = {};
  const read: { min?: number; max?: number } = {};

  for (const token of raw.split(/[\s,]+/)) {
    if (!token) continue;
    if (token.startsWith("-") && token.length > 1) {
      const value = token.slice(1);
      if (value.startsWith("tag:")) {
        const tag = parseTagFilter(value.slice(4));
        if (tag) filters.tags.push({ ...tag, exclude: true });
      } else {
        filters.excludes.push(value);
      }
      continue;
    }
    const field = /^([a-z_]+):(.*)$/.exec(token);
    if (field) {
      const [, key, value] = field as unknown as [string, string, string];
      if (key === "tag") {
        const tag = parseTagFilter(value);
        if (tag) filters.tags.push({ ...tag, exclude: false });
        continue;
      }
      if (key === "pages") {
        mergeRange(page, parseRange(value));
        continue;
      }
      if (key === "read") {
        mergeRange(read, parseRange(value));
        continue;
      }
    }
    if (token.startsWith("$") && token.length > 1) {
      filters.exact.push(token.slice(1));
    } else if (/[?*%]/.test(token)) {
      filters.wildcards.push(token);
    } else {
      filters.terms.push(token);
    }
  }

  if (page.min !== undefined) filters.pageMin = page.min;
  if (page.max !== undefined) filters.pageMax = page.max;
  if (read.min !== undefined) filters.readMin = Math.max(0, read.min);
  if (read.max !== undefined) filters.readMax = Math.min(100, read.max);
  return filters;
}

function parseTagFilter(value: string): { namespace?: string; name: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    return { namespace: trimmed.slice(0, colon).trim(), name: trimmed.slice(colon + 1).trim() };
  }
  return { name: trimmed };
}

/** FTS5 短语转义：整体加双引号，内部双引号翻倍。 */
function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

const LIKE_ESCAPE = "\\";

function likePattern(value: string, wildcards: boolean): string {
  const escaped = value.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
  if (wildcards) {
    // 通配符：? = 单字符、* 与 % = 任意字符
    return escaped.replace(/\?/g, "_").replace(/[*%]/g, "%");
  }
  return `%${escaped}%`;
}

export interface SqlFragment {
  where: string[];
  params: Array<string | number>;
}

/** 把解析结果编译成 works 表上的 WHERE 片段（表别名 w，可带 progress p 联查）。 */
export function searchFiltersToSql(filters: SearchFilters): SqlFragment {
  const where: string[] = [];
  const params: Array<string | number> = [];

  const terms = filters.terms.filter((term) => term.length > 0);
  // 中日文字符按子串匹配（unicode61 会把整段中文当一个 token，MATCH 搜不到半个词）；
  // 纯 ASCII 关键词仍走 FTS，兼顾速度与英文分词。
  const ftsTerms = terms.filter((term) => !/[^\u0000-\u007f]/.test(term));
  const cjkTerms = terms.filter((term) => /[^\u0000-\u007f]/.test(term));
  const tagClause =
    "EXISTS (SELECT 1 FROM work_tags wt JOIN tags t ON t.id = wt.tag_id " +
    "WHERE wt.work_id = w.id AND t.name LIKE ? ESCAPE '\\')";
  for (const term of ftsTerms) {
    where.push(`(w.id IN (SELECT rowid FROM works_fts WHERE works_fts MATCH ?) OR ${tagClause})`);
    params.push(ftsQuote(term), likePattern(term, false));
  }
  for (const term of cjkTerms) {
    where.push(`(w.title LIKE ? ESCAPE '\\' OR ${tagClause})`);
    params.push(likePattern(term, false), likePattern(term, false));
  }
  for (const value of filters.excludes) {
    where.push("w.title NOT LIKE ? ESCAPE '\\'");
    params.push(likePattern(value, false));
  }
  for (const value of filters.exact) {
    where.push("w.title = ? COLLATE NOCASE");
    params.push(value);
  }
  for (const value of filters.wildcards) {
    where.push("w.title LIKE ? ESCAPE '\\'");
    params.push(likePattern(value, true));
  }
  for (const tag of filters.tags) {
    const sub = [
      "SELECT wt.work_id FROM work_tags wt JOIN tags t ON t.id = wt.tag_id WHERE t.name = ? COLLATE NOCASE",
    ];
    const subParams: Array<string | number> = [tag.name];
    if (tag.namespace) {
      sub.push("AND t.namespace = ? COLLATE NOCASE");
      subParams.push(tag.namespace);
    }
    where.push(`w.id ${tag.exclude ? "NOT IN" : "IN"} (${sub.join(" ")})`);
    params.push(...subParams);
  }
  if (filters.pageMin !== undefined) {
    where.push("w.page_count >= ?");
    params.push(filters.pageMin);
  }
  if (filters.pageMax !== undefined) {
    where.push("w.page_count <= ?");
    params.push(filters.pageMax);
  }
  if (filters.readMin !== undefined) {
    where.push(
      "COALESCE(CAST(p.page AS REAL) * 100.0 / NULLIF(w.page_count, 0), 0) >= ?",
    );
    params.push(filters.readMin);
  }
  if (filters.readMax !== undefined) {
    where.push(
      "COALESCE(CAST(p.page AS REAL) * 100.0 / NULLIF(w.page_count, 0), 0) <= ?",
    );
    params.push(filters.readMax);
  }
  return { where, params };
}

/** 是否含「进度」条件（需要 LEFT JOIN progress）。 */
export function needsProgressJoin(filters: SearchFilters): boolean {
  return filters.readMin !== undefined || filters.readMax !== undefined;
}
