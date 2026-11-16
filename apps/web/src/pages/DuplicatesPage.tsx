import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, describeError, type DuplicateGroup, type MergePlan } from "../api";
import { EmptyState, ErrorState, FullPageLoading } from "../components/States";

function formatDate(): string {
  return new Date().toLocaleString();
}

export function DuplicatesPage() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keepByKey, setKeepByKey] = useState<Record<string, number>>({});
  const [plan, setPlan] = useState<{ key: string; plan: MergePlan; writebackEnabled: boolean } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api.listDuplicates();
      if (signal.aborted) return;
      setGroups(result.groups);
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
  }, [load]);

  const preview = async (group: DuplicateGroup) => {
    const keepId = keepByKey[group.key] ?? group.works[0]?.id;
    if (!keepId) return;
    setLoading(true);
    setPlanError(null);
    try {
      const result = await api.previewMerge(keepId);
      setPlan({ key: group.key, plan: result.plan, writebackEnabled: result.writebackEnabled });
    } catch (reason) {
      setPlanError(describeError(reason));
    } finally {
      setLoading(false);
    }
  };

  const executeMerge = async () => {
    if (!plan) return;
    if (!window.confirm(`合并会隐藏 ${plan.plan.dropIds.length} 份副本（只改索引，不动源文件），确定执行？`)) return;
    setLoading(true);
    setMergeError(null);
    try {
      const result = await api.mergeWorks(plan.plan.keepId);
      setMergeMessage(`已合并 ${result.merged} 份副本（保留 #${result.keepId}），可在设置页 journal 撤销`);
      setPlan(null);
      await load(new AbortController().signal);
    } catch (reason) {
      setMergeError(describeError(reason));
    } finally {
      setLoading(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load(new AbortController().signal)} />;
  if (!groups) return <FullPageLoading label="查找疑似重复…" />;

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">疑似重复</h1>
          <p className="muted">
            按标题归一化键汇总（{formatDate()}）。合并只生成预览计划，不会改动任何文件。
          </p>
        </div>
        <div className="page__actions">
          <Link className="btn btn--ghost" to="/">
            回到书库
          </Link>
        </div>
      </header>

      {groups.length === 0 ? (
        <EmptyState title="没有发现重复" description="当前库内标题归一化后没有出现多份相同作品。" />
      ) : (
        <div className="dup-list">
          {groups.map((group) => (
            <article className="dup-group" key={group.key}>
              <header className="dup-group__head">
                <h2>同标题组 · {group.count} 份</h2>
                <span className="muted">归一化键：{group.key || "（空）"}</span>
              </header>
              <ul className="dup-group__items">
                {group.works.map((work) => (
                  <li key={work.id}>
                    <label className="dup-option">
                      <input
                        type="radio"
                        name={`keep-${group.key}`}
                        checked={(keepByKey[group.key] ?? group.works[0]?.id) === work.id}
                        onChange={() => setKeepByKey((current) => ({ ...current, [group.key]: work.id }))}
                      />
                      <span className="dup-option__title">{work.title}</span>
                      <span className="muted">
                        {work.pageCount} 页 · {work.path}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="dup-group__actions">
                <button type="button" className="btn" onClick={() => void preview(group)} disabled={loading}>
                  预览合并
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {planError ? <p className="form-error">{planError}</p> : null}

      {plan ? (
        <section className="dup-plan" aria-label="合并预览">
          <h2>合并预览</h2>
          <p className="muted">
            保留 #{plan.plan.keepId}，合并 {plan.plan.dropIds.length} 份副本；标签取并集（
            {plan.plan.mergedTags.length} 个），页数以保留版本为准（{plan.plan.totalPages} 页）。
          </p>
          {plan.plan.mergedTags.length > 0 ? (
            <div className="chip-row">
              {plan.plan.mergedTags.map((tag) => (
                <span className="chip chip--static" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">两边都没有标签。</p>
          )}
          {plan.plan.warnings.length > 0 ? (
            <ul className="dup-plan__warnings">
              {plan.plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <div className="form form--inline">
            <button type="button" className="btn btn--danger" onClick={() => void executeMerge()} disabled={loading}>
              执行合并（只改索引）
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setPlan(null)} disabled={loading}>
              取消
            </button>
          </div>
          <p className="muted">
            合并只隐藏副本并记录指向，源文件不动；之后可在「设置 → 整理与元数据 → 写回记录」里撤销。
          </p>
        </section>
      ) : null}

      {mergeMessage ? <p className="kv__note">{mergeMessage}</p> : null}
      {mergeError ? <p className="form-error">{mergeError}</p> : null}
    </section>
  );
}
