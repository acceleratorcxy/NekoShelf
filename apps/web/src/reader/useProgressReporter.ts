import { useCallback, useEffect, useMemo, useRef } from "react";
import { api, saveProgressBeacon } from "../api";

const DEFAULT_THROTTLE_MS = 2000;

export interface ProgressReporter {
  /** 上报当前页；throttleMs 内的多次调用只发最后一次。 */
  report: (page: number) => void;
  /** 把服务端已有的进度标记为「已同步」，避免刚打开就白写一次。 */
  markSynced: (page: number) => void;
  /** 立即发出挂起中的进度。 */
  flush: () => void;
}

/**
 * PUT /api/works/:id/progress 的节流上报。
 * - 距上次发送超过 throttleMs 就立即发，否则合并到定时器里发最新页。
 * - 页面隐藏 / 关闭时补发一次（keepalive），离开阅读器时 flush。
 */
export function useProgressReporter(
  workId: string,
  throttleMs: number = DEFAULT_THROTTLE_MS,
): ProgressReporter {
  const lastSentAt = useRef(0);
  const lastSentPage = useRef<number | null>(null);
  const pendingPage = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const workIdRef = useRef(workId);
  workIdRef.current = workId;

  const send = useCallback((page: number) => {
    const id = workIdRef.current;
    if (!id || page <= 0 || page === lastSentPage.current) return;
    lastSentPage.current = page;
    lastSentAt.current = Date.now();
    api.saveProgress(id, page).catch(() => {
      // 失败时允许下次重试同一页
      if (lastSentPage.current === page) lastSentPage.current = null;
    });
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const page = pendingPage.current;
    pendingPage.current = null;
    if (page !== null) send(page);
  }, [send]);

  const report = useCallback(
    (page: number) => {
      pendingPage.current = page;
      if (timer.current !== null) return;
      const elapsed = Date.now() - lastSentAt.current;
      if (elapsed >= throttleMs) {
        flush();
        return;
      }
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flush();
      }, throttleMs - elapsed);
    },
    [flush, throttleMs],
  );

  const markSynced = useCallback((page: number) => {
    lastSentPage.current = page;
  }, []);

  // 换作品时重置节流状态
  useEffect(() => {
    lastSentAt.current = 0;
    lastSentPage.current = null;
    pendingPage.current = null;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, [workId]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const handlePageHide = () => {
      const page = pendingPage.current;
      const id = workIdRef.current;
      if (page !== null && page > 0 && page !== lastSentPage.current) {
        saveProgressBeacon(id, page);
      }
      pendingPage.current = null;
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      flush();
    };
  }, [flush]);

  return useMemo(() => ({ report, markSynced, flush }), [report, markSynced, flush]);
}
