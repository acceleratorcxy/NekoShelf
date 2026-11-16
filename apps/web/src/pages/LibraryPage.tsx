import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  describeError,
  isAbortError,
  type AiQueryResult,
  type AiState,
  type Library,
  type WorkCard,
  type WorkSort,
  type WorksPage,
} from "../api";
import { EmptyState, ErrorState, GridSkeleton } from "../components/States";
import { WorkCardTile } from "../components/WorkCard";
import { LIBRARY_KIND_LABEL } from "../format";

const PAGE_SIZE = 24;

const SORT_OPTIONS: ReadonlyArray<{ value: WorkSort; label: string }> = [
  { value: "recent", label: "最近更新" },
  { value: "title", label: "标题" },
  { value: "rating", label: "评分" },
];

const SORT_KEY = "nekoshelf.library.sort";
const KIND_KEY = "nekoshelf.library.kind";

const KIND_FILTERS = [
  { value: "", label: "全部" },
  { value: "comic", label: "漫画" },
  { value: "image-set", label: "图集" },
  { value: "video", label: "视频" },
] as const;

type KindFilter = (typeof KIND_FILTERS)[number]["value"];

function readStoredKind(): KindFilter {
  try {
    const value = window.localStorage.getItem(KIND_KEY);
    if (KIND_FILTERS.some((item) => item.value === value)) return value as KindFilter;
  } catch {
    /* localStorage 不可用时使用默认值 */
  }
  return "";
}
const LIBRARY_KEY = "nekoshelf.library.filter";

function readStoredSort(): WorkSort {
  try {
    const value = window.localStorage.getItem(SORT_KEY);
    if (value === "recent" || value === "title" || value === "rating") return value;
  } catch {
    /* localStorage 不可用时使用默认值 */
  }
  return "recent";
}

function readStoredLibrary(): string {
  try {
    return window.localStorage.getItem(LIBRARY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function LibraryPage() {
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [draft, setDraft] = useState(urlQuery);
  const [query, setQuery] = useState(urlQuery);
  const [sort, setSort] = useState<WorkSort>(() => readStoredSort());
  const [libraryId, setLibraryId] = useState(() => readStoredLibrary());
  const [pageNumber, setPageNumber] = useState(1);
  const [kind, setKind] = useState<KindFilter>(() => readStoredKind());

  const [data, setData] = useState<WorksPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [libraries, setLibraries] = useState<Library[]>([]);
  const [librariesError, setLibrariesError] = useState<string | null>(null);

  // 记住排序与媒体库筛选（刷新/返回后保持）
  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_KEY, sort);
      window.localStorage.setItem(LIBRARY_KEY, libraryId);
    } catch {
      /* ignore */
    }
  }, [sort, libraryId]);

  const [aiState, setAiState] = useState<AiState | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiResult, setAiResult] = useState<AiQueryResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const aiAvailable = Boolean(aiState?.enabled && aiState.configured);

  // 搜索输入防抖 300ms（AI 模式下由「描述搜索」接管，不触发普通搜索）
  useEffect(() => {
    if (aiMode) return;
    const timer = window.setTimeout(() => {
      setQuery(draft.trim());
      setPageNumber(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, aiMode]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getAi()
      .then((result) => {
        if (controller.signal.aborted) return;
        setAiState(result.ai);
      })
      .catch(() => {
        // AI 状态拿不到不影响书库浏览
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listLibraries()
      .then((result) => {
        if (controller.signal.aborted) return;
        setLibraries(result.items);
        setLibrariesError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLibrariesError(describeError(reason));
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .listWorks(
        {
          q: query === "" ? undefined : query,
          libraryId: libraryId === "" ? undefined : libraryId,
          kind: kind === "" ? undefined : kind,
          sort,
          page: pageNumber,
          pageSize: PAGE_SIZE,
        },
        controller.signal,
      )
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
  }, [query, sort, libraryId, kind, pageNumber, reloadToken]);

  useEffect(() => {
    setQuery(urlQuery);
    setPageNumber(1);
    // 只在 URL 查询变化时同步；输入框改动不写回 URL
  }, [urlQuery]);

  const changeKind = useCallback((next: KindFilter) => {
    setKind(next);
    setPageNumber(1);
    try {
      window.localStorage.setItem(KIND_KEY, next);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, []);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  const askAi = useCallback(() => {
    const question = aiQuestion.trim();
    if (!question || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    const controller = new AbortController();
    api
      .aiQuery(question, controller.signal)
      .then((result) => {
        setAiResult(result);
        setAiLoading(false);
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        setAiError(describeError(reason));
        setAiLoading(false);
      });
  }, [aiQuestion, aiLoading]);

  const exitAiMode = useCallback(() => {
    setAiMode(false);
    setAiResult(null);
    setAiError(null);
  }, []);

  const aiCards: WorkCard[] = (aiResult?.items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    pageCount: item.pageCount,
    coverUrl: item.coverUrl,
    tags: item.tags,
    libraryId: "",
    updatedAt: "",
  }));

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = data?.items ?? [];
  const hasFilters = query !== "" || libraryId !== "" || kind !== "";

  return (
    <div className="page page--library">
      <header className="page__head">
        <div>
          <h1 className="page__title">书库</h1>
          <p className="page__subtitle">
            {data ? `共 ${total} 部作品` : "正在读取作品列表…"}
            {hasFilters ? "（已应用筛选条件）" : ""}
          </p>
        </div>
      </header>

      <div className="kind-tabs" role="tablist" aria-label="作品类型">
        {KIND_FILTERS.map((item) => (
          <button
            key={item.value || "all"}
            type="button"
            role="tab"
            aria-selected={kind === item.value}
            className={kind === item.value ? "kind-tab is-active" : "kind-tab"}
            onClick={() => changeKind(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <nav className="browse-links" aria-label="浏览">
        <Link className="browse-link" to="/authors">
          按作者浏览
        </Link>
        <Link className="browse-link" to="/series">
          按系列浏览
        </Link>
        <Link className="browse-link" to="/tree">
          文件树
        </Link>
      </nav>

      <div className="toolbar" role="search">
        {aiMode ? (
          <div className="toolbar__field toolbar__field--grow ai-search">
            <input
              className="input"
              type="search"
              placeholder="用一句话描述想找什么，例如「最近更新的猫娘同人，中文」"
              value={aiQuestion}
              onChange={(event) => setAiQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") askAi();
              }}
              aria-label="自然语言描述"
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={askAi}
              disabled={aiLoading || aiQuestion.trim() === ""}
            >
              {aiLoading ? "思考中…" : "搜索"}
            </button>
            <button type="button" className="btn" onClick={exitAiMode}>
              退出 AI
            </button>
          </div>
        ) : (
          <div className="toolbar__field toolbar__field--grow">
            <label className="sr-only" htmlFor="library-search">
              搜索作品标题
            </label>
            <input
              id="library-search"
              className="input"
              type="search"
              placeholder="搜索标题…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        )}

        {aiAvailable && !aiMode ? (
          <button
            type="button"
            className="btn btn--ai"
            onClick={() => setAiMode(true)}
            title="用自然语言描述要找的作品"
          >
            ✨ AI 描述搜索
          </button>
        ) : null}

        <div className="toolbar__field">
          <label className="sr-only" htmlFor="library-sort">
            排序方式
          </label>
          <select
            id="library-sort"
            className="input"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as WorkSort);
              setPageNumber(1);
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar__field">
          <label className="sr-only" htmlFor="library-filter">
            按媒体库筛选
          </label>
          <select
            id="library-filter"
            className="input"
            value={libraryId}
            onChange={(event) => {
              setLibraryId(event.target.value);
              setPageNumber(1);
            }}
          >
            <option value="">全部媒体库</option>
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}（{LIBRARY_KIND_LABEL[library.kind]}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {librariesError ? (
        <p className="inline-error" role="status">
          媒体库列表加载失败：{librariesError}
        </p>
      ) : null}

      {aiMode ? (
        <section className="ai-results" aria-live="polite">
          {aiError ? (
            <p className="inline-error" role="alert">
              {aiError}
            </p>
          ) : null}

          {aiLoading ? <p className="ai-hint">AI 正在理解你的描述…</p> : null}

          {!aiLoading && !aiResult && !aiError ? (
            <EmptyState
              title="用一句话找作品"
              description="例如「最近更新的、带猫娘标签的中文同人志」「评分高的长篇」。AI 会把它翻译成检索条件，你可以看到实际用到的语句。"
            />
          ) : null}

          {aiResult ? (
            <>
              <div className="ai-banner">
                <p className="ai-banner__line">{aiResult.explanation ?? "已翻译为检索条件"}</p>
                <p className="ai-banner__query">
                  检索语句：<code>{aiResult.query || "（空条件，按最近更新）"}</code>
                  <span className="ai-banner__count">共 {aiResult.total} 部</span>
                </p>
                {aiResult.facets.length > 0 ? (
                  <p className="ai-banner__facets">
                    {aiResult.facets.map((facet) => (
                      <span key={facet.name} className="chip chip--static">
                        {facet.name} ×{facet.count}
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
              {aiCards.length === 0 ? (
                <EmptyState title="没有匹配的作品" description="换个说法，或者补充标签、页数等条件再试。" />
              ) : (
                <div className="work-grid">
                  {aiCards.map((work) => (
                    <WorkCardTile key={work.id} work={work} />
                  ))}
                </div>
              )}
            </>
          ) : null}
        </section>
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : loading && data === null ? (
        <GridSkeleton count={12} />
      ) : items.length === 0 ? (
        <EmptyState
          title={hasFilters ? "没有匹配的作品" : "书库还是空的"}
          description={
            hasFilters
              ? "换个关键词，或者清空筛选条件再看看。"
              : "先添加一个媒体库并触发扫描，作品就会出现在这里。"
          }
        >
          {hasFilters ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft("");
                setQuery("");
                setLibraryId("");
                setPageNumber(1);
              }}
            >
              清空筛选
            </button>
          ) : (
            <Link className="btn btn--primary" to="/settings">
              去设置页添加媒体库
            </Link>
          )}
        </EmptyState>
      ) : (
        <>
          <div className={loading ? "work-grid is-loading" : "work-grid"}>
            {items.map((work) => (
              <WorkCardTile key={work.id} work={work} />
            ))}
          </div>

          {totalPages > 1 ? (
            <nav className="pager" aria-label="分页">
              <button
                type="button"
                className="btn"
                onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
                disabled={pageNumber <= 1 || loading}
              >
                上一页
              </button>
              <span className="pager__info">
                第 {pageNumber} / {totalPages} 页
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setPageNumber((current) => Math.min(totalPages, current + 1))}
                disabled={pageNumber >= totalPages || loading}
              >
                下一页
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
