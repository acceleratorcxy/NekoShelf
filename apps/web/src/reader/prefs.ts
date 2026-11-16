import { DEFAULT_READER_MODE, isReaderMode, type ReaderMode } from "./mode";

/** 阅读方向：从左往右（西文/国漫）或从右往左（日漫装订） */
export type ReaderDirection = "ltr" | "rtl";
/** 图片适配：适高 / 适宽 / 原始尺寸（可滚动平移） */
export type ReaderFit = "height" | "width" | "original";

export interface ReaderSettings {
  mode: ReaderMode;
  direction: ReaderDirection;
  fit: ReaderFit;
  /** 缩放档位，1 表示不缩放 */
  zoom: number;
}

export const READER_DIRECTIONS: readonly ReaderDirection[] = ["ltr", "rtl"];
export const READER_FITS: readonly ReaderFit[] = ["height", "width", "original"];
export const ZOOM_STEPS: readonly number[] = [1, 1.25, 1.5, 2];

export const DIRECTION_LABEL: Record<ReaderDirection, string> = {
  ltr: "从左往右",
  rtl: "从右往左",
};

export const FIT_LABEL: Record<ReaderFit, string> = {
  height: "适高",
  width: "适宽",
  original: "原始",
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  mode: DEFAULT_READER_MODE,
  direction: "ltr",
  fit: "height",
  zoom: 1,
};

/** 全局默认：设置页可改；作品级设置缺失时回落到这里 */
export const READER_DEFAULT_STORAGE_KEY = "nekoshelf.reader.default";
/** 作品级：nekoshelf.reader.<workId> */
export function readerWorkStorageKey(workId: string): string {
  return `nekoshelf.reader.${workId}`;
}
/** 键位提示只显示一次 */
export const READER_KEYS_HINT_KEY = "nekoshelf.reader.keysHint";

function isDirection(value: unknown): value is ReaderDirection {
  return value === "ltr" || value === "rtl";
}

function isFit(value: unknown): value is ReaderFit {
  return value === "height" || value === "width" || value === "original";
}

function normalizeZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  const clamped = Math.min(4, Math.max(1, parsed));
  // 归一到最近的档位，避免脏数据写出奇怪比例
  return ZOOM_STEPS.reduce(
    (best, step) => (Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best),
    ZOOM_STEPS[0] ?? 1,
  );
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式 / 配额满：忽略，内存里的状态仍然生效
  }
}

/** 只保留认识的字段，防止旧版本/手改的脏数据把 UI 搞坏 */
export function sanitizeSettings(
  input: Record<string, unknown> | null,
  base: ReaderSettings = DEFAULT_READER_SETTINGS,
): ReaderSettings {
  if (!input) return { ...base };
  const mode = typeof input["mode"] === "string" && isReaderMode(input["mode"]) ? input["mode"] : base.mode;
  return {
    mode,
    direction: isDirection(input["direction"]) ? input["direction"] : base.direction,
    fit: isFit(input["fit"]) ? input["fit"] : base.fit,
    zoom: input["zoom"] === undefined ? base.zoom : normalizeZoom(input["zoom"]),
  };
}

export function readDefaultSettings(): ReaderSettings {
  return sanitizeSettings(readJson(READER_DEFAULT_STORAGE_KEY));
}

export function saveDefaultSettings(settings: ReaderSettings): void {
  writeJson(READER_DEFAULT_STORAGE_KEY, settings);
}

/** 作品级设置；没存过返回 null（好让调用方知道"未自定义"） */
export function readWorkSettings(workId: string): ReaderSettings | null {
  const raw = readJson(readerWorkStorageKey(workId));
  if (!raw) return null;
  return sanitizeSettings(raw);
}

export function saveWorkSettings(workId: string, settings: ReaderSettings): void {
  writeJson(readerWorkStorageKey(workId), settings);
}

/** 打开作品时用：作品级 > 全局默认 > 内置默认 */
export function resolveReaderSettings(workId: string): ReaderSettings {
  return readWorkSettings(workId) ?? readDefaultSettings();
}

export function nextOf<T>(list: readonly T[], current: T): T {
  const index = list.indexOf(current);
  if (index < 0) return list[0] as T;
  return list[(index + 1) % list.length] as T;
}

export function hasSeenKeysHint(): boolean {
  try {
    return localStorage.getItem(READER_KEYS_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markKeysHintSeen(): void {
  try {
    localStorage.setItem(READER_KEYS_HINT_KEY, "1");
  } catch {
    // 忽略
  }
}
