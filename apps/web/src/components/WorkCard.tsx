import { Link } from "react-router-dom";
import { coverSrc, type WorkCard as WorkCardModel } from "../api";
import { WORK_KIND_LABEL, percentOf } from "../format";
import { Cover } from "./Cover";
import { ProgressBar } from "./ProgressBar";

export function WorkCardTile({ work }: { work: WorkCardModel }) {
  const progress = work.progress;
  const pageCount = work.pageCount > 0 ? work.pageCount : (progress?.pageCount ?? 0);
  const percent = progress ? percentOf(progress.page, pageCount) : 0;
  const finished = percent >= 100;

  return (
    <Link className="work-card" to={`/works/${encodeURIComponent(work.id)}`}>
      <div className="work-card__cover">
        <Cover src={coverSrc(work)} alt={`${work.title} 封面`} />
        <span className="work-card__kind">{WORK_KIND_LABEL[work.kind]}</span>
        {finished ? <span className="work-card__badge">已读完</span> : null}
      </div>
      <div className="work-card__body">
        <h3 className="work-card__title" title={work.title}>
          {work.title}
        </h3>
        <p className="work-card__meta">{pageCount > 0 ? `${pageCount} 页` : "页数未知"}</p>
        {progress ? (
          <>
            <ProgressBar value={progress.page} max={pageCount} label={`${work.title} 阅读进度`} />
            <p className="work-card__progress">
              已读 {Math.min(progress.page, Math.max(pageCount, progress.page))} / {pageCount} 页
            </p>
          </>
        ) : (
          <p className="work-card__progress work-card__progress--muted">未开始</p>
        )}
      </div>
    </Link>
  );
}
