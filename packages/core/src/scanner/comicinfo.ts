/**
 * ComicInfo.xml 解析（EhViewer / Komga / Kavita 等下载器常见的元数据文件）。
 *
 * 使用场景：扫描时把本地元数据（标题、系列、作者、标签、语言）写入索引，
 * 让「用本地/已有元数据搜索」开箱可用，不需要联网刮削。
 *
 * 解析策略：ComicInfo 是简单 XML，这里不引入 XML 依赖，用受限正则逐个字段取值；
 * 对 CDATA、常见实体（&amp; &lt; &gt; &quot; &apos; &#NN;）做处理。
 */

export interface ComicInfoMeta {
  title?: string;
  series?: string;
  number?: string;
  summary?: string;
  writer?: string;
  penciller?: string;
  genres: string[];
  tags: string[];
  language?: string;
  pageCount?: number;
  year?: number;
  publisher?: string;
  web?: string;
}

/** 写入索引的标签（namespace 与 E-H 标签体系对齐：tag / artist / language / series）。 */
export interface ComicInfoTag {
  namespace: string;
  name: string;
}

const MAX_TAGS = 80;

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function extractField(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  let value = match[1] ?? "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(value);
  if (cdata) value = cdata[1] ?? "";
  value = decodeEntities(value).replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : undefined;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,，;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析 ComicInfo.xml 文本；字段缺失时返回空数组/undefined。 */
export function parseComicInfo(xml: string): ComicInfoMeta {
  const text = xml.replace(/^\uFEFF/, "");
  const meta: ComicInfoMeta = {
    genres: splitList(extractField(text, "Genre")),
    tags: splitList(extractField(text, "Tags")),
  };
  const title = extractField(text, "Title");
  if (title) meta.title = title;
  const series = extractField(text, "Series");
  if (series) meta.series = series;
  const number = extractField(text, "Number");
  if (number) meta.number = number;
  const summary = extractField(text, "Summary");
  if (summary) meta.summary = summary;
  const writer = extractField(text, "Writer");
  if (writer) meta.writer = writer;
  const penciller = extractField(text, "Penciller");
  if (penciller) meta.penciller = penciller;
  const language = extractField(text, "LanguageISO");
  if (language) meta.language = language;
  const pageCount = toPositiveInt(extractField(text, "PageCount"));
  if (pageCount !== undefined) meta.pageCount = pageCount;
  const year = toPositiveInt(extractField(text, "Year"));
  if (year !== undefined) meta.year = year;
  const publisher = extractField(text, "Publisher");
  if (publisher) meta.publisher = publisher;
  const web = extractField(text, "Web");
  if (web) meta.web = web;
  return meta;
}

/** 把 ComicInfo 元数据转换成待写入 tags 表的标签（去重、限量）。 */
export function comicInfoToTags(meta: ComicInfoMeta): ComicInfoTag[] {
  const out: ComicInfoTag[] = [];
  const seen = new Set<string>();
  const push = (namespace: string, name: string | undefined): void => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) return;
    const key = `${namespace}:${trimmed.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ namespace, name: trimmed });
  };

  for (const genre of meta.genres) push("tag", genre);
  for (const tag of meta.tags) push("tag", tag);
  push("artist", meta.writer);
  push("artist", meta.penciller);
  push("series", meta.series);
  push("language", meta.language);
  return out.slice(0, MAX_TAGS);
}
