/**
 * 作品详情的扩展区块：作者/系列标签、AI 动作（翻译标题 / AI 分类）、相关作品推荐。
 * 独立成文件，避免 WorkPage 继续膨胀。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, describeError, type RelatedGroups, type WorkCard, type WorkDetail } from "../api";
import { WorkCardTile } from "./WorkCard";

const ROLE_LABEL: Record<string, string> = {
  writer: "作者",
  artist: "画师",
  group: "社团",
  series: "系列",
};

export function AuthorChips({ work }: { work: WorkDetail }) {
  const authors = (work.authors ?? []).filter((person) => person.name !== "");
  const series = work.series ?? null;
  if (authors.length === 0 && !series) return null;
  const unique = [...new Map(authors.map((person) => [person.name, person])).values()];
  return (
    <p className="author-line">
      {series ? (
        <>
          <span className="author-line__label">系列：</span>
          <Link
            to={
              typeof work.seriesId === "number"
                ? `/series/${work.seriesId}`
                : `/series?q=${encodeURIComponent(series)}`
            }
          >
            {series}
          </Link>
          {unique.length > 0 ? "、" : null}
        </>
      ) : null}
      {unique.length > 0 ? (
        <>
          <span className="author-line__label">作者：</span>
          {unique.map((person, index) => (
            <span key={person.name}>
              <Link
                to={
                  typeof person.id === "number"
                    ? `/authors/${person.id}`
                    : `/authors?q=${encodeURIComponent(person.name)}`
                }
                title="查看该作者的全部作品"
              >
                {person.name}
              </Link>
              {index < unique.length - 1 ? "、" : null}
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}

interface AiActionState {
  busy: boolean;
  message: string | null;
  error: string | null;
}

export function AiWorkActions({ work }: { work: WorkDetail }) {
  const [translate, setTranslate] = useState<AiActionState>({ busy: false, message: null, error: null });
  const [classify, setClassify] = useState<AiActionState>({ busy: false, message: null, error: null });

  const run = async (
    setState: (state: AiActionState) => void,
    action: () => Promise<string>,
  ): Promise<void> => {
    setState({ busy: true, message: null, error: null });
    try {
      const message = await action();
      setState({ busy: false, message, error: null });
    } catch (reason) {
      setState({ busy: false, message: null, error: describeError(reason) });
    }
  };

  return (
    <div className="ai-work-actions">
      <button
        type="button"
        className="btn btn--ghost"
        disabled={translate.busy}
        onClick={() =>
          void run(setTranslate, async () => {
            const result = await api.translateTitle(work.id);
            return `已翻译为中文标题：${result.titleZh}（刷新后生效）`;
          })
        }
      >
        {translate.busy ? "翻译中…" : "翻译标题为中文"}
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={classify.busy}
        onClick={() =>
          void run(setClassify, async () => {
            const result = await api.classifyWork(work.id);
            return `AI 判定类型：${result.previousKind} → ${result.kind}（刷新后生效）`;
          })
        }
      >
        {classify.busy ? "分类中…" : "AI 重新分类"}
      </button>
      {translate.message ? <span className="muted">{translate.message}</span> : null}
      {classify.message ? <span className="muted">{classify.message}</span> : null}
      {translate.error ? <span className="inline-error">{translate.error}</span> : null}
      {classify.error ? <span className="inline-error">{classify.error}</span> : null}
      {translate.error || classify.error ? (
        <Link className="tag tag--link" to="/settings">
          去设置页检查 AI 开关与环境变量
        </Link>
      ) : null}
    </div>
  );
}

const GROUPS: Array<{ key: keyof RelatedGroups; title: string }> = [
  { key: "series", title: "同系列" },
  { key: "authors", title: "同作者" },
  { key: "tags", title: "同标签" },
  { key: "name", title: "相似名称 / 目录" },
];

export function RelatedSection({ workId }: { workId: string }) {
  const [groups, setGroups] = useState<RelatedGroups | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getRelated(workId)
      .then((result) => {
        if (!cancelled) setGroups(result.groups);
      })
      .catch(() => {
        if (!cancelled) setGroups(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workId]);

  if (!groups) return null;
  const sections = GROUPS.filter((group) => (groups[group.key] ?? []).length > 0);
  if (sections.length === 0) return null;

  return (
    <section className="work-pages" aria-labelledby="work-related-title">
      <h2 id="work-related-title" className="section-title">
        相关推荐
      </h2>
      {sections.map((group) => (
        <div key={group.key} className="related-group">
          <h3 className="related-group__title">{group.title}</h3>
          <div className="work-grid">
            {(groups[group.key] ?? []).map((item: WorkCard) => (
              <WorkCardTile key={`${group.key}-${item.id}`} work={item} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
