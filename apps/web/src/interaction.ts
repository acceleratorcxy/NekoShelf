import { useEffect, useSyncExternalStore } from "react";

/**
 * 交互模式（触摸 / 鼠标）。
 *
 * 用户可以在设置页手动指定，也可以保持"自动"：按设备的指针能力
 * （(pointer: coarse) / 无 hover）判断。选择保存在 localStorage，
 * 结果写到 <html data-input="touch|mouse"> 上，样式与交互逻辑都以它为准，
 * 因此手动切换会立即影响阅读器的翻页方式与按钮尺寸。
 */

export type InteractionPreference = "auto" | "touch" | "mouse";
export type ResolvedInput = "touch" | "mouse";

export const INTERACTION_STORAGE_KEY = "nekoshelf.interaction-mode";

export const INTERACTION_MODES: readonly InteractionPreference[] = ["auto", "touch", "mouse"];

export const INTERACTION_LABEL: Record<InteractionPreference, string> = {
  auto: "自动检测",
  touch: "触摸",
  mouse: "鼠标",
};

export const INPUT_LABEL: Record<ResolvedInput, string> = {
  touch: "触摸",
  mouse: "鼠标",
};

export interface InteractionSnapshot {
  preference: InteractionPreference;
  input: ResolvedInput;
}

function isPreference(value: unknown): value is InteractionPreference {
  return value === "auto" || value === "touch" || value === "mouse";
}

export function readStoredInteractionPreference(): InteractionPreference {
  try {
    const stored = window.localStorage.getItem(INTERACTION_STORAGE_KEY);
    return isPreference(stored) ? stored : "auto";
  } catch {
    // 隐私模式等场景 localStorage 不可用，退回自动
    return "auto";
  }
}

export function detectCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(pointer: coarse)").matches) return true;
    return window.matchMedia("(hover: none)").matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

function detectHover(): boolean {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return true;
  }
}

export function resolveInput(preference: InteractionPreference): ResolvedInput {
  if (preference === "auto") return detectCoarsePointer() ? "touch" : "mouse";
  return preference;
}

let snapshot: InteractionSnapshot = { preference: "auto", input: "mouse" };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** 把结果写回 <html>，让 CSS 的 [data-input] 选择器立即生效。 */
export function applyInteractionPreference(preference?: InteractionPreference): InteractionSnapshot {
  const next = preference ?? readStoredInteractionPreference();
  const input = resolveInput(next);
  snapshot = { preference: next, input };
  const root = document.documentElement;
  root.dataset["input"] = input;
  root.dataset["inputPref"] = next;
  root.dataset["hover"] = detectHover() ? "yes" : "no";
  emit();
  return snapshot;
}

export function setInteractionPreference(preference: InteractionPreference): InteractionSnapshot {
  try {
    window.localStorage.setItem(INTERACTION_STORAGE_KEY, preference);
  } catch {
    // 存不下也不影响本次会话
  }
  return applyInteractionPreference(preference);
}

export function nextInteractionPreference(current: InteractionPreference): InteractionPreference {
  switch (current) {
    case "auto":
      return "touch";
    case "touch":
      return "mouse";
    default:
      return "auto";
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): InteractionSnapshot {
  return snapshot;
}

/** 读取当前交互模式；"自动"时监听指针能力变化并即时重算。 */
export function useInteraction(): InteractionSnapshot & { setPreference: (next: InteractionPreference) => InteractionSnapshot } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const onChange = () => {
      if (snapshot.preference === "auto") applyInteractionPreference("auto");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return { ...state, setPreference: setInteractionPreference };
}
