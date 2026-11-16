import { useEffect, useState } from "react";
import { api, describeError, type Job } from "../api";

/**
 * 轮询一个扫描任务直到 queued/running 结束。
 * jobId 为 null 时清空状态。
 */
export function useJob(jobId: string | null): { job: Job | null; error: string | null } {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await api.getJob(jobId);
        if (cancelled) return;
        setJob(next);
        setError(null);
        if (next.state === "queued" || next.state === "running") {
          timer = window.setTimeout(() => void tick(), 1500);
        }
      } catch (reason) {
        if (cancelled) return;
        setError(describeError(reason));
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId]);

  return { job, error };
}
