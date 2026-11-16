/**
 * 双语包 / 多语言版本页配对。
 *
 * 实测样本：`[MANA]叶瞬光1-6` 共 181 条目 = 99 jpg + 82 png，同页存在
 * `YeShunguang01_A.png` 与 `YeShunguang01_A_CN.jpg` 两个语言版本。
 * 配对思路：去掉扩展名与语言后缀得到 pairKey，同 key 的不同语言即为一对。
 */

import { extname } from "node:path";

interface LanguageRule {
  pattern: RegExp;
  lang: string;
}

const LANGUAGE_RULES: LanguageRule[] = [
  { pattern: /[._\-\s](chs|sc|zh|cn|chinese|simplified|简体|简中)$/i, lang: "zh" },
  { pattern: /[._\-\s](cht|tc|tw|traditional|繁體|繁体)$/i, lang: "zh-Hant" },
  { pattern: /[._\-\s](eng|en|english)$/i, lang: "en" },
  { pattern: /[._\-\s](jp|ja|jpn|japanese)$/i, lang: "ja" },
];

function stripExtension(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function normaliseSlashes(name: string): string {
  return name.replace(/\\/g, "/");
}

/** 目录内/包内路径的语言标记；无标记返回空串（视为原文版本）。 */
export function languageOf(name: string): string {
  const base = stripExtension(normaliseSlashes(name));
  for (const rule of LANGUAGE_RULES) {
    if (rule.pattern.test(base)) return rule.lang;
  }
  return "";
}

/** 去掉扩展名与语言后缀后的配对键（含目录前缀）。 */
export function pairKeyOf(name: string): string {
  const normalised = normaliseSlashes(name);
  const slash = normalised.lastIndexOf("/");
  const dir = slash >= 0 ? normalised.slice(0, slash + 1) : "";
  let base = stripExtension(normalised.slice(dir.length));
  for (const rule of LANGUAGE_RULES) base = base.replace(rule.pattern, "");
  return `${dir}${base.toLowerCase()}`;
}

export interface AnnotatedPage {
  name: string;
  size?: number;
  lang: string;
  pairKey: string;
}

/** 给页名补上语言与配对键。 */
export function annotatePages(
  entries: Array<{ name: string; size?: number }>,
): AnnotatedPage[] {
  return entries.map((entry) => ({
    name: entry.name,
    size: entry.size,
    lang: languageOf(entry.name),
    pairKey: pairKeyOf(entry.name),
  }));
}

export interface PagePairGroup {
  key: string;
  /** 同配对键的页名（保持原顺序）。 */
  names: string[];
  languages: string[];
}

/** 找出真正的多语言配对组（同 key 至少两个不同语言）。 */
export function groupPagePairs(pages: Array<{ name: string }>): PagePairGroup[] {
  const byKey = new Map<string, PagePairGroup>();
  for (const page of pages) {
    const key = pairKeyOf(page.name);
    const lang = languageOf(page.name);
    const group = byKey.get(key) ?? { key, names: [], languages: [] };
    group.names.push(page.name);
    group.languages.push(lang);
    byKey.set(key, group);
  }
  return [...byKey.values()].filter(
    (group) => group.names.length > 1 && new Set(group.languages).size > 1,
  );
}

/** 给定页名，返回同配对键的另一个语言版本页名（找不到返回 undefined）。 */
export function findCounterpart(
  pages: Array<{ name: string }>,
  name: string,
  preferLang = "zh",
): string | undefined {
  const key = pairKeyOf(name);
  const currentLang = languageOf(name);
  const candidates = pages.filter((page) => pairKeyOf(page.name) === key);
  const preferred = candidates.find((page) => languageOf(page.name).startsWith(preferLang));
  if (preferred && preferred.name !== name) return preferred.name;
  return candidates.find((page) => languageOf(page.name) !== currentLang && page.name !== name)?.name;
}
