import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, describeError, type ChapterDetail } from "../api";
import { FullPageLoading, ErrorState } from "../components/States";

/** 合集/多话作品的单章详情页（/works/:id/chapters/:index）。 */
export function ChapterPage() {
  const { id = "", index = "0" } = useParams();
  const chapterIndex = Number.parseInt(index, 10);
  const navigate = useNavigate();
  const [data, setData] = useState<ChapterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .getChapter(id, chapterIndex)
      .then(setData)
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [id, chapterIndex]);

  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <FullPageLoading label="正在加载章节…" />;

  const { work, chapter } = data;
  const title = work.titleZh?.trim() ? work.titleZh : work.title;
  const startPage = chapter.startPage;

  return (
    <section className="page chapter-page">
      <header className="page-header">
        <div>
          <p className="muted">
            <Link to="/">书库</Link> / <Link to={`/works/${work.id}`}>{title}</Link> / {chapter.title}
          </p>
          <h1>{chapter.title}</h1>
          <p className="muted">
            {work.kind === "video" ? "视频" : "漫画"} · {chapter.pageCount} 页
            {work.authors.length > 0 ? ` · ${work.authors.map((item) => item.name).join(" / ")}` : ""}
          </p>
        </div>
      </header>

      <div className="chapter-detail">
        <Link className="chapter-detail__cover" to={`/works/${work.id}/chapters/${chapter.index}`}>
          <img src={data.coverThumbUrl} alt={`${chapter.title} 封面`} loading="lazy" />
        </Link>
        <div className="chapter-detail__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              navigate(
                work.kind === "video"
                  ? `/watch/${work.id}?chapter=${chapter.index}`
                  : `/reader/${work.id}?page=${startPage}`,
              )
            }
          >
            {work.kind === "video" ? "播放这一章" : "开始阅读"}
          </button>
          <Link className="btn" to={`/works/${work.id}`}>
            返回作品
          </Link>
        </div>
      </div>

      <nav className="chapter-nav" aria-label="章节切换">
        {data.prevIndex !== null ? (
          <Link className="btn" to={`/works/${work.id}/chapters/${data.prevIndex}`}>
            ← 上一章
          </Link>
        ) : (
          <span className="btn btn--disabled">← 上一章</span>
        )}
        {data.nextIndex !== null ? (
          <Link className="btn" to={`/works/${work.id}/chapters/${data.nextIndex}`}>
            下一章 →
          </Link>
        ) : (
          <span className="btn btn--disabled">下一章 →</span>
        )}
      </nav>
    </section>
  );
}
