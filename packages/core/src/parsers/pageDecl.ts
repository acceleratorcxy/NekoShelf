import type { PageDeclaration } from "./types.js";

/**
 * 页数/体积声明。
 *
 * 覆盖真实样本里的全部写法：
 *   [57P-795MB] [23P-164MB]   → 页数 + 体积
 *   [463P+67P]                → 两段页数（合计 530）
 *   [108P+7V]                 → 页数 + 视频数
 *   [108P+7V-1.23GB]          → 页数 + 视频数 + 体积
 */
const DECLARATION_RE =
  /\[(\d{1,5})P(?:[+-](\d{1,5})P)?(?:[+-](\d{1,5})V)?(?:[-\s]?([\d.]+)\s*(MB|GB))?\]/i;

const UNITS: Record<string, number> = { MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

/** 解析名称里第一个页数/体积声明；没有声明时返回 null。 */
export function parsePageDeclaration(name: string): PageDeclaration | null {
  const match = DECLARATION_RE.exec(name);
  if (!match) return null;

  const pages = Number.parseInt(match[1]!, 10);
  const pagesExtra = match[2] ? Number.parseInt(match[2], 10) : null;
  const videos = match[3] ? Number.parseInt(match[3], 10) : null;

  let bytes: number | null = null;
  if (match[4]) {
    const unit = (match[5] ?? "").toUpperCase();
    const value = Number.parseFloat(match[4]);
    const scale = UNITS[unit];
    if (Number.isFinite(value) && scale !== undefined) {
      bytes = Math.round(value * scale);
    }
  }

  return {
    pages,
    pagesExtra,
    totalPages: pages + (pagesExtra ?? 0),
    videos,
    bytes,
    raw: match[0],
  };
}
