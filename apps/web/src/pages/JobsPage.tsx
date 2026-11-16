import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, describeError, type Job } from "../api";
import { EmptyState, ErrorState, FullPageLoading } from "../components/States";

const JOB_LABEL: Record<string, string> = {
  scan: "扫描",
  scrape: "刮削",
  organize: "整理",
  merge: "合并",
};

const STATE_LABEL: Record<Job["state"], string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api.listJobs(signal);
      if (signal.aborted) return;
      setJobs(result.items);
      setError(null);
    } catch (reason) {
      if (signal.aborted) return;
      setError(describeError(reason));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const busy = Boolean(jobs?.some((job) => job.state === "queued" || job.state === "running"));

  // 有进行中的任务时自动轮询
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setReloadToken((token) => token + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [busy, jobs]);

  if (error) return <ErrorState message={error} onRetry={() => setReloadToken((token) => token + 1)} />;
  if (!jobs) return <FullPageLoading label="加载任务列表…" />;

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">任务</h1>
          <p className="muted">扫描、刮削与整理的后台任务记录（最近 50 条）。</p>
        </div>
        <div className="page__actions">
          <Link className="btn btn--ghost" to="/settings">
            去设置
          </Link>
          <button type="button" className="btn" onClick={() => setReloadToken((token) => token + 1)} disabled={busy}>
            刷新
          </button>
        </div>
      </header>

      {jobs.length === 0 ? (
        <EmptyState title="还没有任务" description="在设置页添加媒体库并扫描后，任务会出现在这里。" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>状态</th>
                <th>进度</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{JOB_LABEL[job.type] ?? job.type}</td>
                  <td>
                    <span className={`badge badge--${job.state}`}>{STATE_LABEL[job.state]}</span>
                  </td>
                  <td className="muted">
                    {job.state === "done"
                      ? "100%"
                      : job.progress.total > 0
                        ? `${job.progress.done}/${job.progress.total}`
                        : "—"}
                  </td>
                  <td className="muted">{formatTime(job.startedAt)}</td>
                  <td className="muted">{formatTime(job.finishedAt)}</td>
                  <td className="muted">{job.message || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
