export type ReaderMode = "single" | "double" | "webtoon";

const MODE_STORAGE_KEY = "nekoshelf.reader.mode";

export const READER_MODES: readonly ReaderMode[] = ["single", "double", "webtoon"];

/** 没有任何存储时的默认模式（与需求里「缺省按单页」一致） */
export const DEFAULT_READER_MODE: ReaderMode = "single";

export function isReaderMode(value: string | null): value is ReaderMode {
  return value !== null && (READER_MODES as readonly string[]).includes(value);
}

export function readStoredMode(): ReaderMode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    return isReaderMode(stored) ? stored : DEFAULT_READER_MODE;
  } catch {
    return DEFAULT_READER_MODE;
  }
}

export function storeMode(mode: ReaderMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式下忽略
  }
}

export const MODE_LABEL: Record<ReaderMode, string> = {
  single: "单页",
  double: "双页",
  webtoon: "纵向连续",
};

export const MODE_HINT: Record<ReaderMode, string> = {
  single: "← / → 翻页 · 空格下一页 · 点左/右 1/3 翻页 · 点中间隐藏菜单",
  double: "← / → 一次翻两页 · 空格下一页 · 点左/右 1/3 翻页 · 点中间隐藏菜单",
  webtoon: "空格 / PageDown 下滚一屏 · 左右滑动上下滚动 · 点左/右 1/3 滚动 · 点中间隐藏菜单",
};
