import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  coverSrc,
  describeError,
  isAbortError,
  pageThumbSrc,
  type ScraperState,
  type WorkDetailResponse,
} from "../api";
import { AiWorkActions, RelatedSection } from "../components/WorkExtras";
import { Cover } from "../components/Cover";
import { ProgressBar } from "../components/ProgressBar";
import { ErrorState, FullPageLoading } from "../components/States";
import { WORK_KIND_LABEL, formatDateTime, percentOf } from "../format";

const THUMB_LIMIT = 12;

export function WorkPage() {
  const { id } = useParams<{ id: string }>();
  const workId = id ?? "";

  const [data, setData] = useState<WorkDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [scraper, setScraper] = useState<ScraperState | null>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeMessage, setScrapeMessage] = useState<string | null>(null);
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [nfo, setNfo] = useState<{ filename: string; content: string; writePath: string | null; writebackEnabled: boolean } | null>(null);
  const [nfoBusy, setNfoBusy] = useState(false);
  const [nfoError, setNfoError] = useState<string | null>(null);
  const [nfoMessage, setNfoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!workId) {
      setError("作品不存在");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getWork(workId, controller.signal, { preview: true })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        setError(describeError(reason));
        setLoading(false);
      });
    return () => controller.abort();
  }, [workId, reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);
  const chapters = data?.chapters ?? [];

  useEffect(() => {
    // 刮削开关/凭据状态：只影响「刮削」按钮是否可用
    let cancelled = false;
    api
      .getScraper()
      .then((result) => {
        if (!cancelled) setScraper(result.scraper);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleScrape = async (force: boolean) => {
    if (scraping) return;
    setScraping(true);
    setScrapeError(null);
    setScrapeMessage(null);
    try {
      const result = await api.scrapeWork(workId, force);
      setScrapeMessage(
        `已从里站刮削：${result.applied.tagCount} 个标签${result.applied.cached ? "（缓存）" : ""}`,
      );
      retry();
    } catch (reason) {
      setScrapeError(describeError(reason));
    } finally {
      setScraping(false);
    }
  };

  if (loading && data === null) return <FullPageLoading label="正在读取作品详情…" />;

  if (error !== null || data === null) {
    return (
      <div className="page">
        <ErrorState
          title="读不到这个作品"
          message={error ?? "作品不存在或已被移除"}
          onRetry={retry}
        >
          <Link className="btn" to="/">
            返回书库
          </Link>
        </ErrorState>
      </div>
    );
  }

  const { work, editions, pages } = data;
  const progress = data.progress;
  const totalPages = data.pageCount ?? pages.length;
  const savedPage = progress ? Math.min(progress.page, Math.max(1, totalPages)) : 1;
  const resumePage = totalPages > 0 ? savedPage : 1;
  const openNfo = async (workId: string) => {
    setNfoBusy(true);
    setNfoError(null);
    setNfoMessage(null);
    try {
      const result = await api.workNfo(workId);
      setNfo(result);
    } catch (reason) {
      setNfoError(describeError(reason));
    } finally {
      setNfoBusy(false);
    }
  };

  const handleWriteNfo = async () => {
    if (!nfo) return;
    if (!window.confirm("确认把 NFO 写入媒体目录？同名文件存在时会要求确认覆盖。")) return;
    setNfoBusy(true);
    setNfoError(null);
    setNfoMessage(null);
    try {
      let result;
      try {
        result = await api.writeNfo(work.id, false);
      } catch (reason) {
        // 同名已存在：再次确认后强制覆盖
        const message = describeError(reason);
        if (!message.includes("已存在")) throw reason;
        if (!window.confirm("同名 NFO 已存在，覆盖？")) return;
        result = await api.writeNfo(work.id, true);
      }
      setNfoMessage(`已写入：${result.path}（可在设置页 journal 撤销）`);
      setNfo(null);
    } catch (reason) {
      setNfoError(describeError(reason));
    } finally {
      setNfoBusy(false);
    }
  };

  const percent = progress ? percentOf(progress.page, work.pageCount) : 0;
  const thumbnails = pages.slice(0, THUMB_LIMIT);

  const tagGroups: Array<[string, string[]]> = (() => {
    const groups = new Map<string, string[]>();
    for (const raw of work.tags) {
      const colon = raw.indexOf(":");
      const namespace = colon > 0 ? raw.slice(0, colon) : "tag";
      const name = colon > 0 ? raw.slice(colon + 1) : raw;
      const list = groups.get(namespace) ?? [];
      if (!list.includes(name)) list.push(name);
      groups.set(namespace, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();

  return (
    <div className="page page--work">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link to="/">书库</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{work.title}</span>
      </nav>

      <div className="work-detail">
        <div className="work-detail__cover">
          <Cover src={coverSrc(work)} alt={`${work.title} 封面`} eager />
        </div>

        <div className="work-detail__info">
          <h1 className="work-detail__title">{work.title}</h1>

          <div className="chips">
            <span className="chip">{WORK_KIND_LABEL[work.kind]}</span>
            <span className="chip">{work.pageCount} 页</span>
            <span className="chip">
              {work.sourceKind === "archive" ? "压缩包" : "目录"}
            </span>
            {typeof work.rating === "number" ? (
              <span className="chip chip--accent">评分 {work.rating.toFixed(1)}</span>
            ) : null}
          </div>

          {tagGroups.length > 0 ? (
            <div className="tag-lines" aria-label="标签">
              {tagGroups.map(([namespace, names]) => (
                <p className="tag-line" key={namespace}>
                  <span className="tag-line__ns">{namespace}：</span>
                  {names.map((name, index) => (
                    <span key={name}>
                      <Link
                        className="tag-line__link"
                        title="按该标签搜索"
                        to={`/?q=${encodeURIComponent(`tag:${namespace === "tag" ? name : `${namespace}:${name}`}`)}`}
                      >
                        {name}
                      </Link>
                      {index < names.length - 1 ? "、" : ""}
                    </span>
                  ))}
                </p>
              ))}
            </div>
          ) : null}

          <dl className="kv">
            <div className="kv__row">
              <dt>最近更新</dt>
              <dd>{formatDateTime(work.updatedAt)}</dd>
            </div>
            {work.archivePath ? (
              <div className="kv__row">
                <dt>压缩包</dt>
                <dd className="mono break-all">{work.archivePath}</dd>
              </div>
            ) : null}
            {editions.length > 0 ? (
              <div className="kv__row">
                <dt>版本</dt>
                <dd>
                  {editions.map((edition) => (
                    <div key={edition.id} className="edition">
                      <span>{edition.label}</span>
                      <span className="edition__meta">
                        {edition.pageCount} 页 · <span className="mono break-all">{edition.path}</span>
                      </span>
                    </div>
                  ))}
                </dd>
              </div>
            ) : null}
            {progress ? (
              <div className="kv__row">
                <dt>阅读进度</dt>
                <dd>
                  <ProgressBar
                    value={progress.page}
                    max={work.pageCount}
                    label={`${work.title} 阅读进度`}
                  />
                  <span className="kv__note">
                    已读 {progress.page} / {work.pageCount} 页（{percent}%），更新于{" "}
                    {formatDateTime(progress.updatedAt)}
                  </span>
                </dd>
              </div>
            ) : null}
          </dl>


          <div className="work-detail__actions">
            {totalPages > 0 ? (
              <>
                <Link className="btn btn--primary btn--lg" to={`/reader/${encodeURIComponent(work.id)}?page=${resumePage}`}>
                  {progress ? `继续阅读（第 ${progress.page} 页）` : "开始阅读"}
                </Link>
                {progress && progress.page > 1 ? (
                  <Link className="btn btn--lg" to={`/reader/${encodeURIComponent(work.id)}?page=1`}>
                    从头读
                  </Link>
                ) : null}
              </>
            ) : work.kind === "video" ? null : (
              <p className="inline-error" role="status">
                这个作品还没有可读取的页面。回到设置页触发一次扫描后再试。
              </p>
            )}
            {work.kind === "video" ? (
              <Link className="btn btn--primary btn--lg" to={`/watch/${encodeURIComponent(work.id)}`}>
                播放视频
              </Link>
            ) : null}
            <Link className="btn btn--ghost btn--lg" to="/">
              返回书库
            </Link>
            <button type="button" className="btn btn--ghost btn--lg" onClick={() => void openNfo(work.id)} disabled={nfoBusy}>
              {nfoBusy ? "生成 NFO…" : "NFO 预览"}
            </button>
          </div>

          <AiWorkActions work={work} />

          {work.gid !== null && work.gid !== undefined ? (
            <div className="scrape-box">
              <div className="scrape-box__head">
                <span className="chip chip--small">E-H 刮削</span>
                <span className="muted">gid {work.gid}</span>
              </div>
              <div className="scrape-box__actions">
                <button
                  type="button"
                  className="btn"
                  disabled={scraping || !scraper?.enabled || !scraper.hasCredential}
                  onClick={() => void handleScrape(work.hasComicInfo === true || work.tags.length > 0)}
                >
                  {scraping
                    ? "刮削中…"
                    : work.hasComicInfo === true || work.tags.length > 0
                      ? "强制重刮"
                      : "从 E-H 刮削"}
                </button>
              </div>
              {!scraper?.enabled ? (
                <p className="kv__note">
                  刮削已关闭：需容器环境变量 ENABLE_SCRAPER=1，并在设置页打开开关。
                </p>
              ) : !scraper.hasCredential ? (
                <p className="kv__note">尚未导入里站 Cookie，请到设置页导入。</p>
              ) : null}
              {scrapeMessage ? <p className="kv__note">{scrapeMessage}</p> : null}
              {scrapeError ? (
                <p className="form__error" role="alert">
                  {scrapeError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {thumbnails.length === 0 ? <RelatedSection workId={work.id} /> : null}

      {chapters.length > 1 ? (
        <section className="detail-chapters" aria-label="章节目录">
          <h2 className="detail-subtitle">章节目录（{chapters.length}）</h2>
          <div className="chapter-grid">
            {chapters.map((chapter) => (
              <Link
                key={chapter.index}
                className="chapter-item"
                to={
                  work.kind === "video"
                    ? `/watch/${work.id}?chapter=${chapter.index}`
                    : `/reader/${work.id}?page=${chapter.startPage}`
                }
              >
                <span className="chapter-item__title">{chapter.title}</span>
                <span className="muted">
                  {work.kind === "video" ? "播放" : `${chapter.pageCount} 页`}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {thumbnails.length > 0 ? (
        <section className="work-pages" aria-labelledby="work-pages-title">
          <h2 id="work-pages-title" className="section-title">
            页面预览（前 {thumbnails.length} 页）
          </h2>
          <div className="thumb-strip">
            {thumbnails.map((page) => (
              <Link
                key={page.index}
                className="thumb"
                to={`/reader/${encodeURIComponent(work.id)}?page=${page.index}`}
                aria-label={`阅读第 ${page.index} 页`}
              >
                <img
                  src={pageThumbSrc(work.id, page, 320)}
                  alt={`第 ${page.index} 页缩略图`}
                  width={320}
                  loading="lazy"
                  decoding="async"
                />
                <span className="thumb__index">{page.index}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {thumbnails.length > 0 ? <RelatedSection workId={work.id} /> : null}

      {nfoError ? (
        <p className="inline-error" role="alert">
          {nfoError}
        </p>
      ) : null}

      {nfo ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="NFO 预览">
          <div className="modal">
            <div className="modal__head">
              <h2>{nfo.filename}</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setNfo(null)}>
                关闭
              </button>
            </div>
            <p className="kv__note">
              {nfo.writePath
                ? `将写回：${nfo.writePath}`
                : nfo.writebackEnabled
                  ? "写回路径不可用（作品不在可写库内或未开启 NFO 写回）"
                  : "当前为只读模式：仅预览，不会写入媒体目录"}
            </p>
            <div className="form form--inline">
              <button
                type="button"
                className="btn"
                onClick={() => void handleWriteNfo()}
                disabled={!nfo.writePath || nfoBusy}
              >
                {nfoBusy ? "写入中…" : "写入媒体目录"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setNfo(null)} disabled={nfoBusy}>
                取消
              </button>
            </div>
            {nfoMessage ? <p className="kv__note">{nfoMessage}</p> : null}
            <pre className="nfo-preview">{nfo.content}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
