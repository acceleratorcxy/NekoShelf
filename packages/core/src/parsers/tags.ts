import { findTrailingGid } from "./gid.js";
import type { NameTags } from "./types.js";

/**
 * 名称标签抽取：活动、汉化组、语言、版本质量、尾部 gid。
 * 只做「命中即记录」，不在这里做评分或改写名称。
 */

const EVENT_RES = [
  /\((C\d{2,3})\)/,
  /(例大祭\s*\d+)/,
  /(COMIC1\s*[☆★]?\s*\d+)/i,
  /(COSPATIO\s*\d+)/i,
];

const LANGUAGE_RE = /(中国翻訳|中国翻译|中文|漢化|汉化|Chinese|CHS|CHT)/i;

const QUALITY_RES = [
  /(無修正|无修正)/,
  /(uncensored)/i,
  /(decensored)/i,
  /(AI\s*Generated)/i,
  /(DL版)/,
];

/** 这些括号段是「元信息」而不是组名（如 `[中国翻訳]`、`[無修正]`、`[DL版]`、`[AI Generated]`）。 */
const META_BRACKET_RE =
  /^(中国翻訳|中国翻译|中文|漢化|汉化|Chinese|CHS|CHT|無修正|无修正|uncensored|decensored|AI|AI\s*Generated|DL版|DL|数字版|\d{6,8}|[\d.P+VMBGB\-+ ]+)$/i;

const BRACKET_RE = /\[([^\]]+)\]/g;

export function parseNameTags(name: string): NameTags {
  const events: string[] = [];
  for (const re of EVENT_RES) {
    const match = re.exec(name);
    if (match) events.push(match[1]!.replace(/\s+/g, ""));
  }

  const languages: string[] = [];
  const languageMatch = LANGUAGE_RE.exec(name);
  if (languageMatch) languages.push(normalizeLanguage(languageMatch[1]!));

  const qualities: string[] = [];
  for (const re of QUALITY_RES) {
    const match = re.exec(name);
    if (match) qualities.push(normalizeQuality(match[1]!));
  }

  const groups: string[] = [];
  for (const match of name.matchAll(BRACKET_RE)) {
    const inner = match[1]!.trim();
    if (inner.length === 0) continue;
    if (META_BRACKET_RE.test(inner)) continue;
    if (EVENT_RES.some((re) => re.test(`(${inner})`))) continue;
    groups.push(inner);
  }

  return {
    events: dedupe(events),
    groups: dedupe(groups),
    languages: dedupe(languages),
    qualities: dedupe(qualities),
    trailingGid: findTrailingGid(name.replace(/\.[a-z0-9]{1,5}$/i, "")),
  };
}

function normalizeLanguage(value: string): string {
  const v = value.trim();
  if (/CHT/i.test(v)) return "zh-Hant";
  if (/中国翻訳|中国翻译|中文|漢化|汉化|CHS|Chinese/i.test(v)) return "zh";
  return v.toLowerCase();
}

function normalizeQuality(value: string): string {
  const v = value.trim();
  if (/無修正|无修正/.test(v)) return "uncensored";
  if (/uncensored|decensored/i.test(v)) return "uncensored";
  if (/AI/i.test(v)) return "AI Generated";
  if (/DL/i.test(v)) return "DL版";
  return v;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
