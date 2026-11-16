import type { GidDirectory } from "./types.js";

/**
 * EhViewer 画廊目录名：`{gid}-{title}`。
 * gid 为 5–8 位数字；其余部分整体作为标题（可能含活动/汉化/无修正等标记，由 NameTags 解析）。
 */
const GID_DIRECTORY_RE = /^(\d{5,8})-(.+)$/;

export function parseGidDirectory(name: string): GidDirectory | null {
  const match = GID_DIRECTORY_RE.exec(name);
  if (!match) return null;
  const gid = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(gid) || gid <= 0) return null;
  const title = match[2]!.trim();
  if (title.length === 0) return null;
  return { gid, title };
}

/** 文件名尾部的 gid 候选：`...[4163459].zip`。 */
const TRAILING_GID_RE = /\[(\d{6,8})\]$/;

export function findTrailingGid(stem: string): number | null {
  const match = TRAILING_GID_RE.exec(stem.trim());
  if (!match) return null;
  const gid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(gid) && gid > 0 ? gid : null;
}
