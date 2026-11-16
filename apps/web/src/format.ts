import type { LibraryKind, Role, WorkKind } from "./api";

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  comic: "漫画",
  "image-set": "图集",
  video: "视频",
};

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  comic: "漫画",
  video: "视频",
  mixed: "混合",
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  member: "成员",
  guest: "访客",
};

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(clamp((value / total) * 100, 0, 100));
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "—";
  return dateFormatter.format(time);
}

/** 把秒数说成人话，用于任务耗时展示。 */
export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${rest} 秒`;
}
