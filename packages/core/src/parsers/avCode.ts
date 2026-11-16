import type { AvFilename } from "./types.js";

/**
 * AV 文件名解析。
 *
 * 真实样本：
 *   ads.com@ABC-123.mp4
 *   XYZ-456_CH_SD.mp4
 *   （某合集、直播/交友等广告文件没有标准番号 → 由调用方按「无番号」处理，再走体积/关键词剔除规则）
 */

/** 广告站点前缀：`ads.com@`、`xxx.vip@`。 */
const SITE_PREFIX_RE = /^([a-z0-9-]+)\.(com|net|cc|vip|xyz)@/i;

/** 版本后缀：注意 CHC 必须排在 CH 之前，否则 `_CHC_` 会被切成 `_CH`。 */
const VERSION_TAG_RE = /[_.\-\s](CHC|CH|UC|C|SD|HD|FHD|4K|VR)(?=[_.\-\s]|$)/gi;

/** 标准番号：2–6 位大写字母 + `-` + 2–5 位数字。 */
const CODE_RE = /(?<![A-Z0-9])([A-Z]{2,6})-(\d{2,5})(?![0-9])/;

export function parseAvFilename(fileName: string): AvFilename | null {
  const cleanedBase = stripExtension(fileName);
  let cleanedName = cleanedBase;
  let sitePrefix: string | null = null;

  const prefixMatch = SITE_PREFIX_RE.exec(cleanedName);
  if (prefixMatch) {
    sitePrefix = prefixMatch[0];
    cleanedName = cleanedName.slice(prefixMatch[0].length);
  }

  // 番号匹配前先去掉版本后缀，避免 `XYZ-456_CH` 之类把后缀当番号边界
  const versionTags: string[] = [];
  const withoutVersions = cleanedName.replace(VERSION_TAG_RE, (whole, tag: string) => {
    versionTags.push(tag.toUpperCase());
    return whole.startsWith("_") || whole.startsWith("-") || whole.startsWith(".") ? "_" : " ";
  });

  const codeMatch = CODE_RE.exec(withoutVersions.toUpperCase());
  if (!codeMatch) return null;

  return {
    code: `${codeMatch[1]}-${codeMatch[2]}`,
    sitePrefix,
    versionTags: dedupe(versionTags),
    cleanedName: cleanedName.replace(/\s+/g, " ").trim(),
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
