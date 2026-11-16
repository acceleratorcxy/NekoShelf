/**
 * 浏览类页面：作者、系列、文件树。
 * 目标是「按作者/系列找东西」与「看磁盘上到底怎么放的」两种视角。
 */
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  describeError,
  libraryFileUrl,
  type PersonSummary,
  type SeriesSummary,
  type TreeEntry,
  type TreePageData,
  type WorkCard,
} from "../api";
import { WorkCardTile } from "../components/WorkCard";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";

function useDebouncedQuery(initial: string): [string, string, (value: string) => void] {
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  return [draft, query, setDraft];
}

/** 作者列表（/authors）。 */
export function AuthorsPage() {
  const [params] = useSearchParams();
  const [draft, query, setDraft] = useDebouncedQuery(params.get("q") ?? "");
  const [items, setItems] = useState<PersonSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    api
      .listPeople({ q: query || undefined, limit: 200 })
      .then((result) => setItems(result.items))
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [query]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>作者</h1>
          <p className="muted">按 ComicInfo 的作者/画师与目录名前缀统计；点进去看该作者的作品。</p>
        </div>
        <Link className="button button--small" to="/">← 返回书库</Link>
      </header>
      <div className="toolbar">
        <div className="toolbar__field toolbar__field--grow">
          <label className="sr-only" htmlFor="author-search">
            搜索作者
          </label>
          <input
            id="author-search"
            className="input"
            placeholder="搜索作者 / 画师…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Link className="btn" to="/series">
          看系列
        </Link>
        <Link className="btn" to="/tree">
          文件树
        </Link>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {!error && items === null ? <GridSkeleton count={12} /> : null}
      {items && items.length === 0 ? (
        <EmptyState title="还没有作者信息" description="扫描带 ComicInfo.xml 的漫画后，作者会自动出现在这里。" />
      ) : null}
      {items && items.length > 0 ? (
        <div className="chip-grid">
          {items.map((person) => (
            <Link key={person.id} className="chip chip--large" to={`/authors/${person.id}`}>
              {person.name} <span className="muted">×{person.count}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 单个作者的作品（/authors/:id）。 */
export function AuthorPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ name: string; items: WorkCard[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    api
      .getPerson(Number(id), 1, 200)
      .then((result) =>
        setData({ name: result.person.name, items: result.items, total: result.total }),
      )
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [id]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="muted">
            <Link to="/authors">作者</Link> / {data?.name ?? "…"}
          </p>
          <h1>{data?.name ?? "作者"}</h1>
          {data ? <p className="muted">共 {data.total} 部作品</p> : null}
        </div>
      </header>
      {error ? <ErrorState message={error} /> : null}
      {!data && !error ? <GridSkeleton count={12} /> : null}
      {data && data.items.length === 0 ? <EmptyState title="这位作者名下还没有作品" /> : null}
      {data && data.items.length > 0 ? (
        <div className="work-grid">
          {data.items.map((item) => (
            <WorkCardTile key={item.id} work={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 系列列表（/series）。 */
export function SeriesListPage() {
  const [params] = useSearchParams();
  const [draft, query, setDraft] = useDebouncedQuery(params.get("q") ?? "");
  const [items, setItems] = useState<SeriesSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    api
      .listSeries({ q: query || undefined, limit: 200 })
      .then((result) => setItems(result.items))
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [query]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>系列</h1>
          <p className="muted">来自 ComicInfo 的 Series 字段；同一系列的作品会自动归在一起。</p>
        </div>
        <Link className="button button--small" to="/">← 返回书库</Link>
      </header>
      <div className="toolbar">
        <div className="toolbar__field toolbar__field--grow">
          <label className="sr-only" htmlFor="series-search">
            搜索系列
          </label>
          <input
            id="series-search"
            className="input"
            placeholder="搜索系列名…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Link className="btn" to="/authors">
          看作者
        </Link>
        <Link className="btn" to="/tree">
          文件树
        </Link>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {!error && items === null ? <GridSkeleton count={8} /> : null}
      {items && items.length === 0 ? (
        <EmptyState title="还没有系列信息" description="带 Series 字段的 ComicInfo 扫描后会出现。" />
      ) : null}
      {items && items.length > 0 ? (
        <div className="chip-grid">
          {items.map((series) => (
            <Link key={series.id} className="chip chip--large" to={`/series/${series.id}`}>
              {series.name} <span className="muted">×{series.count}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 单个系列的作品（/series/:id）。 */
export function SeriesPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ name: string; items: WorkCard[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    api
      .getSeries(Number(id), 1, 200)
      .then((result) =>
        setData({ name: result.series.name, items: result.items, total: result.total }),
      )
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [id]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="muted">
            <Link to="/series">系列</Link> / {data?.name ?? "…"}
          </p>
          <h1>{data?.name ?? "系列"}</h1>
          {data ? <p className="muted">共 {data.total} 部作品</p> : null}
        </div>
      </header>
      {error ? <ErrorState message={error} /> : null}
      {!data && !error ? <GridSkeleton count={12} /> : null}
      {data && data.items.length === 0 ? <EmptyState title="这个系列还没有作品" /> : null}
      {data && data.items.length > 0 ? (
        <div className="work-grid">
          {data.items.map((item) => (
            <WorkCardTile key={item.id} work={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function formatSize(size?: number): string {
  if (size === undefined) return "";
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

/** 文件树浏览（/tree）：按磁盘真实结构看作品。 */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".jxl"]);
const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".flv", ".ts", ".rmvb", ".wmv"]);

type MediaItem = { name: string; rel: string; kind: "image" | "video" };

function fileExt(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

/** 目录内媒体的连续查看器：左右键/按钮切换，Esc 关闭，视频直接播放。 */
function MediaViewer({
  libraryId,
  items,
  index,
  onIndex,
  onClose,
}: {
  libraryId: string;
  items: MediaItem[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") onIndex(Math.min(items.length - 1, index + 1));
      if (event.key === "ArrowLeft") onIndex(Math.max(0, index - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onIndex]);

  if (!item) return null;
  return (
    <div className="media-viewer" role="dialog" aria-modal="true" aria-label={item.name}>
      <header className="media-viewer__bar">
        <span className="media-viewer__name" title={item.name}>
          {item.name}
        </span>
        <span className="media-viewer__counter muted">
          {index + 1} / {items.length}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <button
        type="button"
        className="media-viewer__nav media-viewer__nav--prev"
        onClick={() => onIndex(Math.max(0, index - 1))}
        disabled={index === 0}
        aria-label="上一项"
      >
        ‹
      </button>
      <div className="media-viewer__body">
        {item.kind === "video" ? (
          <video
            key={item.rel}
            className="media-viewer__video"
            src={libraryFileUrl(libraryId, item.rel)}
            controls
            autoPlay
            preload="metadata"
          />
        ) : (
          <img
            key={item.rel}
            className="media-viewer__image"
            src={libraryFileUrl(libraryId, item.rel)}
            alt={item.name}
          />
        )}
      </div>
      <button
        type="button"
        className="media-viewer__nav media-viewer__nav--next"
        onClick={() => onIndex(Math.min(items.length - 1, index + 1))}
        disabled={index === items.length - 1}
        aria-label="下一项"
      >
        ›
      </button>
    </div>
  );
}

export function TreePage() {
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [libraryId, setLibraryId] = useState<string>("");
  const [path, setPath] = useState<string>("");
  const [data, setData] = useState<TreePageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    api
      .listLibraries()
      .then((result) => {
        setLibraries(result.items.map((item) => ({ id: item.id, name: item.name })));
        if (!libraryId && result.items.length > 0) setLibraryId(result.items[0]!.id);
      })
      .catch((reason: unknown) => setError(describeError(reason)));
    // 只加载一次库列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!libraryId) return;
    setData(null);
    setError(null);
    setViewerIndex(null);
    api
      .getTree(libraryId, path)
      .then(setData)
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [libraryId, path]);

  const crumbs = path === "" ? [] : path.split("/");

  const media: MediaItem[] = (data?.entries ?? [])
    .filter((entry) => entry.type === "file")
    .filter((entry) => IMAGE_EXTS.has(fileExt(entry.name)) || VIDEO_EXTS.has(fileExt(entry.name)))
    .map((entry) => ({
      name: entry.name,
      rel: joinPath(path, entry.name),
      kind: (VIDEO_EXTS.has(fileExt(entry.name)) ? "video" : "image") as "image" | "video",
    }));

  const entryLink = (entry: TreeEntry): string | null => {
    if (entry.workId) return `/works/${entry.workId}`;
    return null;
  };

  const openMedia = (entry: TreeEntry) => {
    const index = media.findIndex((item) => item.name === entry.name);
    if (index >= 0) setViewerIndex(index);
  };

  const isMediaEntry = (entry: TreeEntry): boolean =>
    entry.type === "file" &&
    (IMAGE_EXTS.has(fileExt(entry.name)) || VIDEO_EXTS.has(fileExt(entry.name)));

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>文件树</h1>
          <p className="muted">按磁盘真实结构浏览（只读）：图片与视频可直接预览，按目录连续查看。</p>
        </div>
        <Link className="button button--small" to="/">
          ← 返回书库
        </Link>
      </header>
      <div className="toolbar">
        <div className="toolbar__field">
          <label className="sr-only" htmlFor="tree-library">
            选择媒体库
          </label>
          <select
            id="tree-library"
            className="input"
            value={libraryId}
            onChange={(event) => {
              setLibraryId(event.target.value);
              setPath("");
            }}
          >
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar__field toolbar__field--grow">
          <nav className="breadcrumbs" aria-label="路径">
            <button type="button" className="breadcrumb" onClick={() => setPath("")}>
              {data?.libraryName ?? "根目录"}
            </button>
            {crumbs.map((part, index) => (
              <button
                key={`${part}-${index}`}
                type="button"
                className="breadcrumb"
                onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
              >
                / {part}
              </button>
            ))}
          </nav>
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {!data && !error ? <GridSkeleton count={6} /> : null}

      {data && media.length > 0 ? (
        <section className="tree-media" aria-label="本目录媒体">
          <header className="tree-media__header">
            <h2 className="section-title">本目录媒体（{media.length}）</h2>
            <button type="button" className="btn btn--small" onClick={() => setViewerIndex(0)}>
              从第一个开始连续查看
            </button>
          </header>
          <div className="tree-media__grid">
            {media.map((item, index) => (
              <button
                type="button"
                key={item.rel}
                className="tree-media__tile"
                onClick={() => setViewerIndex(index)}
                title={item.name}
              >
                {item.kind === "image" ? (
                  <img
                    className="tree-media__thumb"
                    src={libraryFileUrl(libraryId, item.rel, { thumb: true, width: 360 })}
                    alt={item.name}
                    loading="lazy"
                  />
                ) : (
                  <span className="tree-media__video" aria-hidden="true">
                    ▶
                  </span>
                )}
                <span className="tree-media__label">{item.name}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {data && data.entries.length === 0 ? <EmptyState title="这个目录是空的" /> : null}
      {data && data.entries.length > 0 ? (
        <ul className="tree-list">
          {data.entries.map((entry) => {
            const link = entryLink(entry);
            return (
              <li key={`${entry.type}-${entry.name}`} className="tree-row">
                {entry.type === "dir" ? (
                  entry.workId ? (
                    <>
                      <Link className="tree-row__name tree-row__name--dir" to={`/works/${entry.workId}`}>
                        📁 {entry.name}
                      </Link>
                      <button
                        type="button"
                        className="btn btn--sm tree-row__browse"
                        onClick={() => setPath(joinPath(path, entry.name))}
                      >
                        浏览
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="tree-row__name tree-row__name--dir"
                      onClick={() => setPath(joinPath(path, entry.name))}
                    >
                      📁 {entry.name}
                    </button>
                  )
                ) : link ? (
                  <Link className="tree-row__name" to={link}>
                    📄 {entry.name}
                  </Link>
                ) : isMediaEntry(entry) ? (
                  <button
                    type="button"
                    className="tree-row__name tree-row__name--media"
                    onClick={() => openMedia(entry)}
                  >
                    {VIDEO_EXTS.has(fileExt(entry.name)) ? "🎬" : "🖼"} {entry.name}
                  </button>
                ) : (
                  <span className="tree-row__name">📄 {entry.name}</span>
                )}
                <span className="tree-row__meta muted">
                  {entry.type === "dir" && entry.workCount !== undefined
                    ? `${entry.workCount} 个作品`
                    : ""}
                  {entry.type === "file" && entry.pageCount !== undefined
                    ? `${entry.pageCount} 页`
                    : ""}
                </span>
                <span className="tree-row__size muted">{formatSize(entry.size)}</span>
                {entry.workTitle ? <span className="tree-row__title">{entry.workTitle}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {viewerIndex !== null && media.length > 0 ? (
        <MediaViewer
          libraryId={libraryId}
          items={media}
          index={Math.min(viewerIndex, media.length - 1)}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </section>
  );
}

function joinPath(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}
