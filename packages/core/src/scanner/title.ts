import { parseGidDirectory, findTrailingGid } from "../parsers/gid.js";

/** 从目录名推导作品标题：去 gid 前缀/后缀、去尾部页数声明，保留可读部分。 */
export function deriveTitleFromName(name: string): string {
  let title = name.trim();

  const gidDirectory = parseGidDirectory(title);
  if (gidDirectory) return gidDirectory.title;

  // 前缀 `1883030-title` / `1883030 title`
  const gidPrefix = /^\d{6,9}\s*[-_ ]+\s*/.exec(title);
  if (gidPrefix) title = title.slice(gidPrefix[0].length);

  // 尾部 `[1883030]` 形式的 gid
  title = title.replace(/\s*[[(]\s*\d{6,9}\s*[\])]\s*$/, "");

  // 尾部页数/体积声明 `[57P-795MB]` / `[463P+67P]`
  title = title.replace(/\s*\[[^\]]*\d+\s*P[^\]]*\]\s*$/, "");

  title = title.replace(/\s{2,}/g, " ").trim();
  return title.length > 0 ? title : name.trim();
}

/** 目录名里的 gid（EHViewer 常用 `{gid}-{title}`）。 */
export function deriveGidFromName(name: string): number | null {
  return parseGidDirectory(name)?.gid ?? findTrailingGid(name);
}

/** ComicInfo.xml 的 XML 转义解码（只处理常见实体，避免引入依赖）。 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 从 ComicInfo.xml 文本里取一个标签的文本值（缺失返回 undefined）。 */
export function pickComicInfoField(xml: string, field: string): string | undefined {
  const match = new RegExp(`<${field}\\b[^>]*>([\\s\\S]*?)</${field}>`, "i").exec(xml);
  if (!match?.[1]) return undefined;
  const value = decodeXmlEntities(match[1].trim());
  return value.length > 0 ? value : undefined;
}

/** 系列归并用的标题归一化：去掉括号分组、卷册标记、尾部序号，保留主体。 */
export function normalizeSeriesKey(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/【[^】]*】/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:vol\.?\s*\d+|volume\s*\d+)\b/gi, " ")
    .replace(/第\s*\d+\s*[卷話话回部篇集]/g, " ")
    .replace(/全\s*\d+\s*[卷話话]?/g, " ")
    .replace(/[\s\-_]*(上|下|前編|後編|前篇|后篇|完|総集編|总集编|新装版|完全版)\s*$/g, " ")
    .replace(/[\s\-_]*\d{1,3}\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 系列展示名：去掉括号分组与卷册标记后的标题。 */
export function deriveSeriesTitle(title: string): string {
  const cleaned = title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/【[^】]*】/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:vol\.?\s*\d+|volume\s*\d+)\b/gi, " ")
    .replace(/第\s*\d+\s*[卷話话回部篇集]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : title.trim();
}
