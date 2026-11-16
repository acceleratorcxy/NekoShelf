import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  describeError,
  isAbortError,
  pageImageSrc,
  pageThumbSrc,
  type PageRef,
  type WorkDetailResponse,
} from "../api";
import { EmptyState, ErrorState, FullPageLoading } from "../components/States";
import { ProgressBar } from "../components/ProgressBar";
import { clamp } from "../format";
import { MODE_HINT, MODE_LABEL, READER_MODES, type ReaderMode } from "../reader/mode";
import {
  DEFAULT_READER_SETTINGS,
  DIRECTION_LABEL,
  FIT_LABEL,
  READER_DIRECTIONS,
  READER_FITS,
  ZOOM_STEPS,
  hasSeenKeysHint,
  markKeysHintSeen,
  nextOf,
  resolveReaderSettings,
  saveWorkSettings,
  type ReaderDirection,
  type ReaderFit,
  type ReaderSettings,
} from "../reader/prefs";
import {
  INPUT_LABEL,
  INTERACTION_LABEL,
  nextInteractionPreference,
  useInteraction,
} from "../interaction";
import { useProgressReporter } from "../reader/useProgressReporter";
import { isEditableTarget } from "../theme";

type LoadStatus = "loading" | "ready" | "error";

const SCROLL_SUPPRESS_MS = 300;
// 双页模式在窄屏自动降级为单页；按视口宽度判断，横竖屏切换即时生效
const DOUBLE_MIN_WIDTH = 820;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function ReaderPage() {
  const { id } = useParams<{ id: string }>();
  const workId = id ?? "";
  const navigate = useNavigate();

  // 阅读偏好：作品级 > 全局默认 > 内置默认（单页 + 适高 + 从左往右）
  const [settings, setSettings] = useState<ReaderSettings>(() => resolveReaderSettings(workId));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mode = settings.mode;
  const direction = settings.direction;
  const fit = settings.fit;
  const zoom = settings.zoom;
  const rtl = direction === "rtl";

  const [data, setData] = useState<WorkDetailResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [initialPageApplied, setInitialPageApplied] = useState(false);

  const progress = useProgressReporter(workId);

  const { preference, input, setPreference } = useInteraction();
  const wideEnoughForSpread = useMediaQuery(`(min-width: ${DOUBLE_MIN_WIDTH}px)`);
  // 窄屏选了双页时按单页渲染，但不改写用户存的模式
  const doubleDegraded = mode === "double" && !wideEnoughForSpread;
  const effectiveMode: ReaderMode = doubleDegraded ? "single" : mode;
  const touchInput = input === "touch";

  const readerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    time: number;
    axis: "none" | "h" | "v";
  } | null>(null);
  const lastSwipeAtRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 沉浸阅读：点击中间 1/3 隐藏顶栏与底栏（再点一下恢复）
  const [chromeHidden, setChromeHidden] = useState(false);
  // 阅读设置面板 / 缩略条 / 首次键位提示
  const [showPanel, setShowPanel] = useState(false);
  const [showThumbs, setShowThumbs] = useState(false);
  const [showKeyHelp, setShowKeyHelp] = useState<boolean>(() => !hasSeenKeysHint());

  // 手势多指/长按连续滚动/双击缩放所需的临时状态
  const activePointersRef = useRef<Set<number>>(new Set());
  const pinchRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  const holdActiveRef = useRef(false);
  const pendingTapRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const preloadedRef = useRef(new Set<string>());
  const preloadImagesRef = useRef<HTMLImageElement[]>([]);

  const initializedRef = useRef(false);
  const pageRef = useRef(1);
  pageRef.current = page;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const suppressScrollSyncRef = useRef(false);

  const pages = useMemo(() => data?.pages ?? [], [data]);
  const total = pages.length;
  const title = data?.work.title ?? "";

  // 更新并持久化当前作品的阅读偏好（作品级存储）
  const updateSettings = useCallback(
    (patch: Partial<ReaderSettings>) => {
      const next: ReaderSettings = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      if (workId) saveWorkSettings(workId, next);
    },
    [workId],
  );

  const cycleMode = useCallback(() => {
    updateSettings({ mode: nextOf(READER_MODES, settingsRef.current.mode) as ReaderMode });
  }, [updateSettings]);

  const toggleDirection = useCallback(() => {
    updateSettings({ direction: (settingsRef.current.direction === "ltr" ? "rtl" : "ltr") as ReaderDirection });
  }, [updateSettings]);

  const cycleFit = useCallback(() => {
    updateSettings({ fit: nextOf(READER_FITS, settingsRef.current.fit) as ReaderFit });
  }, [updateSettings]);

  const dismissKeysHint = useCallback(() => {
    markKeysHintSeen();
    setShowKeyHelp(false);
  }, []);

  // 换作品：重置阅读状态
  useEffect(() => {
    initializedRef.current = false;
    pageElements.current.clear();
    preloadedRef.current.clear();
    preloadImagesRef.current = [];
    setPage(1);
    setData(null);
    setStatus("loading");
    setError("");
    setInitialPageApplied(false);
    setShowPanel(false);
    setShowThumbs(false);
    setSettings(resolveReaderSettings(workId));
  }, [workId]);

  // 拉取作品页信息
  useEffect(() => {
    if (!workId) {
      setStatus("error");
      setError("作品不存在");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    api
      .getWork(workId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        setError(describeError(reason));
        setStatus("error");
      });
    return () => controller.abort();
  }, [workId, reloadToken]);

  // 恢复进度：?page=N 优先，其次服务端记录，最后第 1 页
  useEffect(() => {
    if (status !== "ready" || data === null || initializedRef.current) return;
    initializedRef.current = true;
    const fromUrl = new URLSearchParams(window.location.search).get("page");
    const parsed = fromUrl === null ? Number.NaN : Number.parseInt(fromUrl, 10);
    const saved = data.progress?.page ?? 1;
    const requested = Number.isFinite(parsed) ? parsed : saved;
    const initial = clamp(requested, 1, Math.max(1, pages.length));
    setPage(initial);
    progress.markSynced(initial);
    setInitialPageApplied(true);
  }, [status, data, pages.length, progress]);

  // 双页模式对齐到奇数页（一屏两页的起始页）
  useEffect(() => {
    if (effectiveMode !== "double") return;
    setPage((current) => (current % 2 === 0 ? Math.max(1, current - 1) : current));
  }, [effectiveMode]);

  const clampPage = useCallback(
    (value: number) => clamp(value, 1, Math.max(1, total)),
    [total],
  );

  const scrollByScreen = useCallback((direction: 1 | -1) => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollBy({ top: direction * container.clientHeight * 0.9, behavior: "smooth" });
  }, []);

  const goToPage = useCallback(
    (target: number) => {
      const next = clampPage(target);
      setPage(next);
      if (effectiveMode === "webtoon") {
        const element = pageElements.current.get(next);
        const container = scrollRef.current;
        if (element && container) {
          container.scrollTo({ top: Math.max(0, element.offsetTop - 8), behavior: "smooth" });
        }
      }
    },
    [clampPage, effectiveMode],
  );

  const goNext = useCallback(() => {
    if (effectiveMode === "webtoon") {
      scrollByScreen(1);
      return;
    }
    setPage((current) => clampPage(current + (effectiveMode === "double" ? 2 : 1)));
  }, [clampPage, effectiveMode, scrollByScreen]);

  const goPrev = useCallback(() => {
    if (effectiveMode === "webtoon") {
      scrollByScreen(-1);
      return;
    }
    setPage((current) => clampPage(current - (effectiveMode === "double" ? 2 : 1)));
  }, [clampPage, effectiveMode, scrollByScreen]);

  // 键盘：RTL 下 ← 是下一页；Shift 跳首末；m/p/f/g/q/n/b
  useEffect(() => {
    if (status !== "ready") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditableTarget(event.target)) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea") {
          return;
        }
      }

      const leftward = event.key === "ArrowLeft";

      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          event.preventDefault();
          if (event.shiftKey) {
            // LTR：← 首页 / → 末页；RTL 语义反转
            const wantsLast = rtl ? leftward : !leftward;
            goToPage(wantsLast ? total : 1);
            break;
          }
          const forward = rtl ? leftward : !leftward;
          if (forward) goNext();
          else goPrev();
          break;
        }
        case "PageDown":
        case " ":
        case "Spacebar":
        case "n":
        case "N":
          event.preventDefault();
          goNext();
          break;
        case "PageUp":
        case "b":
        case "B":
          event.preventDefault();
          goPrev();
          break;
        case "Home":
          event.preventDefault();
          goToPage(1);
          break;
        case "End":
          event.preventDefault();
          goToPage(total);
          break;
        case "m":
        case "M":
          event.preventDefault();
          cycleMode();
          break;
        case "p":
        case "P":
          event.preventDefault();
          toggleDirection();
          break;
        case "f":
        case "F":
          event.preventDefault();
          cycleFit();
          break;
        case "g":
        case "G": {
          event.preventDefault();
          const answer = window.prompt(`跳到第几页？（1-${Math.max(1, total)}）`, String(pageRef.current));
          if (answer !== null) {
            const parsed = Number.parseInt(answer, 10);
            if (Number.isFinite(parsed)) goToPage(parsed);
          }
          break;
        }
        case "q":
        case "Q":
          event.preventDefault();
          navigate(`/works/${workId}`);
          break;
        case "Escape":
          if (showPanel || showKeyHelp) {
            event.preventDefault();
            setShowPanel(false);
            if (showKeyHelp) dismissKeysHint();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cycleFit,
    cycleMode,
    dismissKeysHint,
    goNext,
    goPrev,
    goToPage,
    navigate,
    rtl,
    showKeyHelp,
    showPanel,
    status,
    total,
    toggleDirection,
    workId,
  ]);

  // URL 上的 ?page=N 跟随当前页
  useEffect(() => {
    if (!initializedRef.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("page") === String(page)) return;
    url.searchParams.set("page", String(page));
    window.history.replaceState(window.history.state, "", url.toString());
  }, [page]);

  // 节流上报进度（等首屏恢复完成后再报，避免把恢复前的第 1 页写回去）
  useEffect(() => {
    if (status !== "ready" || !initializedRef.current || !initialPageApplied) return;
    progress.report(page);
  }, [initialPageApplied, page, progress, status]);

  // 纵向连续模式：用 IntersectionObserver 判断当前可见页
  useEffect(() => {
    if (effectiveMode !== "webtoon" || status !== "ready") return;
    const container = scrollRef.current;
    if (!container) return;
    const elements = Array.from(pageElements.current.values());
    if (elements.length === 0) return;

    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        if (suppressScrollSyncRef.current) return;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset["pageIndex"] ?? "0");
          if (!Number.isFinite(index) || index <= 0) continue;
          ratios.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestIndex = 0;
        let bestRatio = 0;
        for (const [index, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = index;
          }
        }
        if (bestIndex > 0) {
          setPage((current) => (current === bestIndex ? current : bestIndex));
        }
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [effectiveMode, status, pages.length]);

  // 进入纵向模式或页面加载完成时，滚到当前页
  useEffect(() => {
    if (effectiveMode !== "webtoon" || status !== "ready" || !initialPageApplied) return;
    suppressScrollSyncRef.current = true;
    const target = pageElements.current.get(pageRef.current);
    const container = scrollRef.current;
    if (target && container) {
      container.scrollTop = Math.max(0, target.offsetTop - 8);
    }
    const timer = window.setTimeout(() => {
      suppressScrollSyncRef.current = false;
    }, SCROLL_SUPPRESS_MS);
    return () => window.clearTimeout(timer);
  }, [effectiveMode, pages.length, initialPageApplied, status]);

  // 预加载：当前页前 1 页 + 后 2 页（双页模式按 2 页一批）；已预载的 URL 不重复建对象
  useEffect(() => {
    if (status !== "ready" || pages.length === 0) return;
    const batch = effectiveMode === "double" ? 2 : 1;
    const targets = [page - 1, page + batch, page + batch * 2];
    for (const index of targets) {
      const pageRefItem = pages[index - 1];
      if (!pageRefItem || index < 1 || index > pages.length) continue;
      const src = pageImageSrc(workId, pageRefItem);
      if (preloadedRef.current.has(src)) continue;
      preloadedRef.current.add(src);
      const image = new Image();
      image.decoding = "async";
      image.src = src;
      preloadImagesRef.current.push(image);
      if (preloadImagesRef.current.length > 12) preloadImagesRef.current.shift();
    }
  }, [effectiveMode, page, pages, status, workId]);

  // 双击缩放的待定单击计时器需要在卸载时清掉
  useEffect(
    () => () => {
      if (pendingTapRef.current !== null) window.clearTimeout(pendingTapRef.current);
    },
    [],
  );

  // 全屏状态跟随浏览器
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === readerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = readerRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void element.requestFullscreen().catch(() => undefined);
  }, []);

  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;
  const goPrevRef = useRef(goPrev);
  goPrevRef.current = goPrev;

  // 触摸：横滑翻页（RTL 反向）、单页纵向拖拽按视口高度阈值翻页、纵向连续长按连续滚动、双指缩放期间不翻页
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;

    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest("button, a, input, select, textarea, label, [data-no-gesture]"));

    const clearHoldTimer = () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };

    const stopAutoScroll = () => {
      if (autoScrollRef.current !== null) {
        window.cancelAnimationFrame(autoScrollRef.current);
        autoScrollRef.current = null;
      }
      holdActiveRef.current = false;
    };

    // 长按后连续滚动：速度从慢到快再稳定，松手即停
    const startAutoScroll = () => {
      const container = scrollRef.current;
      if (!container) return;
      holdActiveRef.current = true;
      let speed = 2;
      let last = performance.now();
      const step = (now: number) => {
        if (!holdActiveRef.current) return;
        const delta = now - last;
        last = now;
        speed = Math.min(26, speed + delta * 0.02);
        container.scrollTop += (speed * delta) / 16;
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 1) {
          stopAutoScroll();
          return;
        }
        autoScrollRef.current = window.requestAnimationFrame(step);
      };
      autoScrollRef.current = window.requestAnimationFrame(step);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      // 记录所有触摸指针（含非主指针），用于识别双指缩放
      if (event.pointerType === "touch") activePointersRef.current.add(event.pointerId);
      if (activePointersRef.current.size >= 2) {
        // 双指缩放进行中：取消一切翻页判定
        pinchRef.current = true;
        clearHoldTimer();
        stopAutoScroll();
        gestureRef.current = null;
        return;
      }
      if (!event.isPrimary || !touchInput || isInteractive(event.target)) return;
      gestureRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
        axis: "none",
      };
      clearHoldTimer();
      if (effectiveMode === "webtoon") {
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          startAutoScroll();
        }, 350);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (pinchRef.current) {
        clearHoldTimer();
        return;
      }
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (gesture.axis !== "none") return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      // 一旦开始移动就不再算长按，交给滑动/滚动
      clearHoldTimer();
      // 横向位移明显大于纵向才算滑动翻页，否则视为纵向滚动
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v";
    };

    const finishGesture = (event: PointerEvent, cancelled: boolean) => {
      activePointersRef.current.delete(event.pointerId);
      const gesture = gestureRef.current;
      gestureRef.current = null;
      clearHoldTimer();
      const heldDown = holdActiveRef.current;
      const wasPinching = pinchRef.current;
      if (activePointersRef.current.size === 0) pinchRef.current = false;
      stopAutoScroll();
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (heldDown || wasPinching || cancelled || !touchInput) return;
      if (event.timeStamp - gesture.time > 900) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const vh = window.innerHeight;

      if (gesture.axis === "h" && Math.abs(dx) >= 48 && Math.abs(dy) <= Math.abs(dx) * 0.85) {
        lastSwipeAtRef.current = Date.now();
        // 从左往右读：向左滑是下一页；从右往左读（RTL）语义相反
        const forward = rtl ? dx > 0 : dx < 0;
        if (forward) goNextRef.current();
        else goPrevRef.current();
        return;
      }
      // 单页/双页：上滑超过 13% 视口高度翻一屏，超过 40% 直接下一屏（同一动作）
      if (gesture.axis === "v" && effectiveMode !== "webtoon") {
        if (Math.abs(dy) >= vh * 0.13) {
          lastSwipeAtRef.current = Date.now();
          if (dy < 0) goNextRef.current();
          else goPrevRef.current();
        }
      }
    };

    const onPointerUp = (event: PointerEvent) => finishGesture(event, false);
    const onPointerCancel = (event: PointerEvent) => finishGesture(event, true);
    const onContextMenu = (event: Event) => {
      // 触摸时长按图片不弹系统菜单
      if (touchInput) event.preventDefault();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("contextmenu", onContextMenu);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
      element.removeEventListener("contextmenu", onContextMenu);
      clearHoldTimer();
      stopAutoScroll();
      pinchRef.current = false;
      activePointersRef.current.clear();
    };
  }, [effectiveMode, rtl, touchInput]);

  // 鼠标模式：滚轮翻页（连续模式让给正常滚动）
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      if (touchInput || effectiveMode === "webtoon") return;
      if (Math.abs(event.deltaY) < 6) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelAtRef.current < 450) return;
      lastWheelAtRef.current = now;
      if (event.deltaY > 0) goNextRef.current();
      else goPrevRef.current();
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [effectiveMode, touchInput]);

  const changeMode = useCallback(
    (next: ReaderMode) => {
      updateSettings({ mode: next });
    },
    [updateSettings],
  );

  const handleSingleTap = useCallback(
    (ratio: number) => {
      // 放大状态下单击不翻页，避免和拖动查看冲突
      if (ratio >= 1 / 3 && ratio <= 2 / 3) {
        setChromeHidden((hidden) => !hidden);
        return;
      }
      if (settingsRef.current.zoom > 1) return;
      const pressedLeft = ratio < 1 / 3;
      // RTL：点左侧是前进
      const forward = rtl ? pressedLeft : !pressedLeft;
      if (effectiveMode === "webtoon") {
        scrollByScreen(forward ? 1 : -1);
        return;
      }
      if (forward) goNext();
      else goPrev();
    },
    [effectiveMode, goNext, goPrev, rtl, scrollByScreen],
  );

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // 滑动手势结束后浏览器还会补发一次 click，忽略它以免翻两页
    if (Date.now() - lastSwipeAtRef.current < 500) return;
    if (window.getSelection()?.toString()) return;
    if (status !== "ready" || pages.length === 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, a, input, select, textarea, label, [data-no-gesture]")
    ) {
      return;
    }
    const now = Date.now();
    const lastTap = lastTapRef.current;
    // 双击缩放：260ms 内同一位置两次点击只算缩放，不触发翻页
    if (
      lastTap &&
      now - lastTap.time < 260 &&
      Math.abs(event.clientX - lastTap.x) < 30 &&
      Math.abs(event.clientY - lastTap.y) < 30
    ) {
      lastTapRef.current = null;
      if (pendingTapRef.current !== null) {
        window.clearTimeout(pendingTapRef.current);
        pendingTapRef.current = null;
      }
      const current = settingsRef.current.zoom;
      updateSettings({ zoom: current > 1 ? 1 : 2 });
      return;
    }
    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
    if (pendingTapRef.current !== null) window.clearTimeout(pendingTapRef.current);
    pendingTapRef.current = window.setTimeout(() => {
      pendingTapRef.current = null;
      lastTapRef.current = null;
      handleSingleTap(ratio);
    }, 260);
  };

  const currentPage = pages[page - 1];
  const spreadPages: PageRef[] = [];
  // 跨页判定：宽 > 高的页面（跨页大图 / 横版单页）单独成页，不与其他页强行配对
  const isWidePage = (ref: PageRef | undefined) => Boolean(ref && ref.width > ref.height);
  if (effectiveMode === "double") {
    const first = pages[page - 1];
    if (first) spreadPages.push(first);
    const second = pages[page];
    if (second && !isWidePage(first)) spreadPages.push(second);
  }
  const secondSpreadPage =
    effectiveMode === "double" && spreadPages.length > 1 ? Math.min(page + 1, total) : page;

  let content: ReactNode;
  if (status === "loading") {
    content = (
      <div className="reader__state">
        <FullPageLoading label="正在加载页面…" />
      </div>
    );
  } else if (status === "error") {
    content = (
      <div className="reader__state">
        <ErrorState
          title="打不开这个作品"
          message={error || "加载失败"}
          onRetry={() => setReloadToken((token) => token + 1)}
        >
          <Link className="btn" to={`/works/${encodeURIComponent(workId)}`}>
            返回详情
          </Link>
        </ErrorState>
      </div>
    );
  } else if (pages.length === 0) {
    content = (
      <div className="reader__state">
        <EmptyState
          title="没有可阅读的页面"
          description="这个作品还没有解析出页面。回到设置页触发一次扫描后再试。"
        >
          <Link className="btn btn--primary" to={`/works/${encodeURIComponent(workId)}`}>
            返回详情
          </Link>
        </EmptyState>
      </div>
    );
  } else if (effectiveMode === "webtoon") {
    content = (
      <div
        className="reader__scroll"
        ref={scrollRef}
        onClick={handleSurfaceClick}
      >
        {pages.map((pageRefItem) => (
          <div
            key={pageRefItem.index}
            className="reader__scroll-page"
            data-page-index={pageRefItem.index}
            ref={(element) => {
              if (element) pageElements.current.set(pageRefItem.index, element);
              else pageElements.current.delete(pageRefItem.index);
            }}
          >
            <img
              src={pageImageSrc(workId, pageRefItem)}
              alt={`${title} 第 ${pageRefItem.index} 页`}
              loading="lazy"
              decoding="async"
              draggable={false}
              style={
                pageRefItem.width > 0 && pageRefItem.height > 0
                  ? { aspectRatio: `${pageRefItem.width} / ${pageRefItem.height}` }
                  : undefined
              }
            />
          </div>
        ))}
      </div>
    );
  } else {
    const pagedImages = effectiveMode === "double" ? spreadPages : currentPage ? [currentPage] : [];
    content = (
      <div
        className={`reader__paged${effectiveMode === "double" ? " reader__paged--double" : ""}${
          rtl ? " reader__paged--rtl" : ""
        }${zoom > 1 ? " is-zoomed" : ""}`}
        style={{ "--reader-zoom": zoom } as CSSProperties}
        onClick={handleSurfaceClick}
      >
        {pagedImages.length === 0 ? (
          <p className="reader__empty">这一页没有图片</p>
        ) : (
          pagedImages.map((pageRefItem) => (
            <img
              key={pageRefItem.index}
              className="reader__image"
              src={pageImageSrc(workId, pageRefItem)}
              alt={`${title} 第 ${pageRefItem.index} 页`}
              loading={pageRefItem.index === page ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
            />
          ))
        )}
      </div>
    );
  }

  const modeHint = doubleDegraded
    ? `窄屏已自动从双页降为单页 · ${MODE_HINT.single}`
    : MODE_HINT[effectiveMode];
  const inputHint = touchInput
    ? "左右滑动或点左/右 1/3 翻页 · 点中间隐藏菜单"
    : "滚轮／方向键／点左/右 1/3 翻页 · 点中间隐藏菜单";
  const interactionBadge =
    preference === "auto" ? `自动·${INPUT_LABEL[input]}` : INTERACTION_LABEL[preference];
  const settingsBadge = `${MODE_LABEL[mode]} · ${DIRECTION_LABEL[direction]} · ${FIT_LABEL[fit]}${
    zoom !== 1 ? ` · ${zoom}×` : ""
  }`;

  return (
    <div
      className={`reader${chromeHidden ? " reader--immersive" : ""}${showThumbs ? " reader--thumbs" : ""}`}
      ref={readerRef}
      data-input={input}
      data-mode={effectiveMode}
      data-direction={direction}
      data-fit={fit}
      data-zoomed={zoom > 1 ? "true" : "false"}
      style={{ "--reader-zoom": zoom } as CSSProperties}
    >
      <header className="reader__bar">
        <Link
          className="reader__back"
          to={`/works/${encodeURIComponent(workId)}`}
          aria-label="返回作品详情"
          title="返回作品详情"
        >
          ←
        </Link>

        <h1 className="reader__title" title={title}>
          {title || "阅读器"}
        </h1>

        <div className="reader__modes" role="group" aria-label="阅读模式">
          {READER_MODES.map((item) => (
            <button
              key={item}
              type="button"
              className={item === mode ? "reader__mode is-active" : "reader__mode"}
              aria-pressed={item === mode}
              title={item === "double" && !wideEnoughForSpread ? "当前屏幕较窄，双页会自动按单页显示" : undefined}
              onClick={() => changeMode(item)}
            >
              {MODE_LABEL[item]}
            </button>
          ))}
        </div>

        <div className="reader__pager">
          <button
            type="button"
            className="reader__pager-btn"
            onClick={goPrev}
            aria-label="上一页"
            disabled={effectiveMode !== "webtoon" && page <= 1}
          >
            ‹
          </button>
          <span className="reader__page-label">
            {effectiveMode === "double" && total > 1 ? `${page}–${secondSpreadPage}` : page} /{" "}
            {total > 0 ? total : "?"}
          </span>
          <button
            type="button"
            className="reader__pager-btn"
            onClick={goNext}
            aria-label="下一页"
            disabled={effectiveMode !== "webtoon" && page >= total}
          >
            ›
          </button>
        </div>

        {doubleDegraded ? (
          <p className="reader__notice" role="status">
            屏幕较窄：双页已自动按单页显示
          </p>
        ) : null}
      </header>

      <div className="reader__body" ref={bodyRef}>
        {content}
      </div>

      {showThumbs && status === "ready" && pages.length > 0 ? (
        <div className="reader__thumbs" role="group" aria-label="页面缩略图">
          {pages.map((item) => (
            <button
              key={item.index}
              type="button"
              className={item.index === page ? "reader__thumb is-active" : "reader__thumb"}
              aria-pressed={item.index === page}
              aria-label={`跳到第 ${item.index} 页`}
              title={`第 ${item.index} 页`}
              onClick={() => goToPage(item.index)}
            >
              <img src={pageThumbSrc(workId, item, 120)} alt="" loading="lazy" decoding="async" />
              <span className="reader__thumb-index">{item.index}</span>
            </button>
          ))}
        </div>
      ) : null}

      {showPanel ? (
        <div className="reader__panel" role="dialog" aria-label="阅读设置">
          <div className="reader__panel-row">
            <span className="reader__panel-label">方向</span>
            <div className="reader__seg">
              {READER_DIRECTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={item === direction ? "reader__seg-item is-active" : "reader__seg-item"}
                  aria-pressed={item === direction}
                  onClick={() => updateSettings({ direction: item })}
                >
                  {DIRECTION_LABEL[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="reader__panel-row">
            <span className="reader__panel-label">适配</span>
            <div className="reader__seg">
              {READER_FITS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={item === fit ? "reader__seg-item is-active" : "reader__seg-item"}
                  aria-pressed={item === fit}
                  onClick={() => updateSettings({ fit: item })}
                >
                  {FIT_LABEL[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="reader__panel-row">
            <span className="reader__panel-label">缩放</span>
            <div className="reader__seg">
              {ZOOM_STEPS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={item === zoom ? "reader__seg-item is-active" : "reader__seg-item"}
                  aria-pressed={item === zoom}
                  onClick={() => updateSettings({ zoom: item })}
                >
                  {item}×
                </button>
              ))}
            </div>
          </div>
          <div className="reader__panel-row">
            <span className="reader__panel-label">缩略条</span>
            <button
              type="button"
              className={showThumbs ? "btn btn--primary btn--sm" : "btn btn--sm"}
              aria-pressed={showThumbs}
              onClick={() => setShowThumbs((visible) => !visible)}
            >
              {showThumbs ? "隐藏缩略条" : "显示缩略条"}
            </button>
          </div>
          <p className="reader__panel-hint">
            当前：{settingsBadge} · 快捷键 m 模式 / p 方向 / f 适配 / g 跳页 / q 退出
          </p>
        </div>
      ) : null}

      {showKeyHelp && status === "ready" ? (
        <div className="reader__keys" role="dialog" aria-label="阅读器快捷键">
          <div className="reader__keys-card">
            <h2 className="reader__keys-title">阅读器快捷键</h2>
            <dl className="reader__keys-list">
              <div>
                <dt>← / →</dt>
                <dd>上一页 / 下一页（从右往左阅读时方向相反）</dd>
              </div>
              <div>
                <dt>Shift + ← / →</dt>
                <dd>跳到首页 / 末页</dd>
              </div>
              <div>
                <dt>空格 / PageDown</dt>
                <dd>下一页</dd>
              </div>
              <div>
                <dt>PageUp</dt>
                <dd>上一页</dd>
              </div>
              <div>
                <dt>m</dt>
                <dd>切换阅读模式（单页 / 双页 / 纵向连续）</dd>
              </div>
              <div>
                <dt>p</dt>
                <dd>切换阅读方向（从左往右 / 从右往左）</dd>
              </div>
              <div>
                <dt>f</dt>
                <dd>切换适配方式（适高 / 适宽 / 原始）</dd>
              </div>
              <div>
                <dt>g</dt>
                <dd>输入页码跳转</dd>
              </div>
              <div>
                <dt>q</dt>
                <dd>退出阅读器</dd>
              </div>
            </dl>
            <div className="reader__keys-actions">
              <button type="button" className="btn btn--primary" onClick={dismissKeysHint}>
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="reader__footer">
        <ProgressBar
          value={page}
          max={Math.max(1, total)}
          label="阅读进度"
          className="reader__progress"
        />
        <p className="reader__hint">
          <span className="reader__state">{settingsBadge}</span> · {modeHint} · {inputHint}
        </p>
        <div className="reader__tools">
          <button
            type="button"
            className="reader__tool"
            onClick={() => setPreference(nextInteractionPreference(preference))}
            title={`交互模式：${preference === "auto" ? `自动检测（当前${INPUT_LABEL[input]}）` : INTERACTION_LABEL[preference]}，点击切换`}
            aria-label={`当前交互模式 ${interactionBadge}，点击切换`}
          >
            <span className="reader__tool-icon" aria-hidden="true">
              {input === "touch" ? "☝" : "🖱"}
            </span>
            <span className="reader__tool-text">{interactionBadge}</span>
          </button>
          <button
            type="button"
            className="reader__tool reader__tool--icon"
            onClick={() => setShowPanel((visible) => !visible)}
            aria-expanded={showPanel}
            aria-label="阅读设置"
            title="阅读设置（方向 / 适配 / 缩放 / 缩略条）"
          >
            ⚙
          </button>
          <button
            type="button"
            className="reader__tool reader__tool--icon"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "退出全屏" : "进入全屏"}
            title={isFullscreen ? "退出全屏" : "进入全屏"}
          >
            {isFullscreen ? "⤡" : "⛶"}
          </button>
        </div>
      </footer>

      {chromeHidden ? (
        <button
          type="button"
          className="reader__reveal"
          onClick={() => setChromeHidden(false)}
          aria-label="显示阅读器菜单"
          title="显示菜单"
        >
          ⋯
        </button>
      ) : null}
    </div>
  );
}
