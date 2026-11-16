/**
 * 整理与元数据：纯逻辑，不做任何磁盘写入。
 *
 * - 重命名模板渲染与目标路径计算（dry-run 预览）
 * - NFO 文本生成（Kodi/Jellyfin 兼容的极简 movie/tvshow）
 * - 重复合并计划
 *
 * 写回动作由 server 层在「DATA_MODE=writeback + 设置页开关」双门禁下执行；
 * 本模块只负责生成计划与预览，必须可单测、零 IO。
 */

export interface TemplateVars {
  title?: string;
  author?: string;
  series?: string;
  year?: number | string;
  pages?: number;
  gid?: number;
  kind?: string;
  ext?: string;
}

export const DEFAULT_RENAME_PATTERN = "{author} - {title} [{pages}P]";
export const DEFAULT_NFO_TEMPLATE = "movie";

const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 清洗为安全的文件名片段：去非法字符、折叠空白、去尾随点/空格、规避 Windows 保留名。 */
export function sanitizeSegment(input: string, maxLength = 120): string {
  let out = input.replace(ILLEGAL_CHARS, " ").replace(/\s+/g, " ").trim();
  out = out.replace(/[. ]+$/g, "");
  if (RESERVED.has(out.toUpperCase())) out = `_${out}`;
  if (out.length > maxLength) out = out.slice(0, maxLength).trim();
  return out || "untitled";
}

/** 渲染模板：`{key}` 占位替换，未知占位替换为空；结果逐段清洗，空段直接丢弃。 */
export function renderTemplate(pattern: string, vars: TemplateVars): string {
  return pattern
    .split(/[\\/]/)
    .map((segment) =>
      segment.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = (vars as Record<string, unknown>)[key];
        if (value === undefined || value === null) return "";
        return String(value);
      }),
    )
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment))
    .join("/");
}

/** 计算 dry-run 的重命名目标；拒绝越出媒体库根目录的目标（防路径穿越）。 */
export function buildRenameTarget(
  fromPath: string,
  libraryRoot: string,
  pattern: string,
  vars: TemplateVars,
): { from: string; to: string; relative: string; conflict: string | null } {
  const root = libraryRoot.replace(/[\\/]+$/, "");
  const segments = pattern
    .split(/[\\/]/)
    .map((segment) =>
      segment.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = (vars as Record<string, unknown>)[key];
        return value === undefined || value === null ? "" : String(value);
      }),
    )
    .filter((segment) => segment.trim());
  const traversal = segments.some((segment) => {
    const trimmed = segment.trim();
    return trimmed === ".." || trimmed.startsWith("../") || trimmed.startsWith("..\\");
  });
  const relative = renderTemplate(pattern, vars);
  const to = `${root}/${relative}`;
  return {
    from: fromPath,
    to,
    relative,
    conflict: traversal ? "invalid_path" : null,
  };
}

export interface NfoWork {
  id: number;
  title: string;
  titleJpn?: string | null;
  kind: string;
  pageCount: number;
  gid?: number | null;
  rating?: number | null;
  tags?: string[];
  author?: string | null;
  series?: string | null;
  year?: number | null;
  plot?: string | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 生成 NFO 文本（movie 或 tvshow 根标签）。 */
export function buildNfo(work: NfoWork, options: { root?: "movie" | "tvshow" } = {}): string {
  const root = options.root ?? "movie";
  const title = escapeXml(work.title);
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  if (root === "tvshow") {
    lines.push("<tvshow>");
    lines.push(`  <title>${title}</title>`);
    if (work.titleJpn) lines.push(`  <originaltitle>${escapeXml(work.titleJpn)}</originaltitle>`);
    if (work.plot) lines.push(`  <plot>${escapeXml(work.plot)}</plot>`);
    for (const tag of work.tags ?? []) lines.push(`  <genre>${escapeXml(tag)}</genre>`);
    if (work.author) lines.push(`  <studio>${escapeXml(work.author)}</studio>`);
    if (work.gid) lines.push(`  <uniqueid type="eh" default="true">${work.gid}</uniqueid>`);
    lines.push("</tvshow>");
    return `${lines.join("\n")}\n`;
  }
  lines.push("<movie>");
  lines.push(`  <title>${title}</title>`);
  if (work.titleJpn) lines.push(`  <originaltitle>${escapeXml(work.titleJpn)}</originaltitle>`);
  if (work.plot) lines.push(`  <plot>${escapeXml(work.plot)}</plot>`);
  if (work.year) lines.push(`  <year>${work.year}</year>`);
  for (const tag of work.tags ?? []) lines.push(`  <genre>${escapeXml(tag)}</genre>`);
  if (work.series) lines.push(`  <set><name>${escapeXml(work.series)}</name></set>`);
  if (work.rating) lines.push(`  <rating>${work.rating}</rating>`);
  if (work.author) lines.push(`  <actor><name>${escapeXml(work.author)}</name><role>author</role></actor>`);
  if (work.kind === "comic") lines.push("  <type>comic</type>");
  lines.push(`  <pagecount>${work.pageCount}</pagecount>`);
  if (work.gid) lines.push(`  <uniqueid type="eh" default="true">${work.gid}</uniqueid>`);
  lines.push("</movie>");
  return `${lines.join("\n")}\n`;
}

/** NFO 文件名：`<sanitized-title>.nfo`。 */
export function nfoFileName(work: { title: string }): string {
  return `${sanitizeSegment(work.title)}.nfo`;
}

export interface MergeCandidate {
  id: number;
  title: string;
  path: string;
  pageCount: number;
  tags?: string[];
}

export interface MergePlan {
  keepId: number;
  dropIds: number[];
  mergedTags: string[];
  totalPages: number;
  warnings: string[];
}

/** 合并计划（dry-run）：保留 keepId，其余作为将被合并的副本；标签并集去重。 */
export function planMerge(works: MergeCandidate[], keepId: number): MergePlan {
  const keep = works.find((work) => work.id === keepId);
  if (!keep) throw new Error("keep_work_not_found");
  const drops = works.filter((work) => work.id !== keepId);
  const seen = new Set<string>();
  const mergedTags: string[] = [];
  for (const work of [keep, ...drops]) {
    for (const tag of work.tags ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        mergedTags.push(tag);
      }
    }
  }
  const warnings: string[] = [];
  if (drops.some((work) => work.pageCount !== keep.pageCount)) {
    warnings.push("页数不一致：合并后以保留版本为准，副本页序不会自动对齐");
  }
  if (new Set(works.map((work) => work.path)).size !== works.length) {
    warnings.push("存在相同路径条目，可能是扫描残留");
  }
  return {
    keepId,
    dropIds: drops.map((work) => work.id),
    mergedTags,
    totalPages: keep.pageCount,
    warnings,
  };
}
