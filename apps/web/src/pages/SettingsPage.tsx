import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  describeError,
  isAbortError,
  type AiState,
  type BackupEntry,
  type JournalEntry,
  type OrganizePreview,
  type OrganizeState,
  type CreateLibraryInput,
  type EhCookieInput,
  type Library,
  type LibraryKind,
  type ScraperHealth,
  type ScraperState,
} from "../api";
import { EmptyState, ErrorState, FullPageLoading } from "../components/States";
import { IndeterminateBar, ProgressBar } from "../components/ProgressBar";
import { LIBRARY_KIND_LABEL, formatDateTime, formatDuration } from "../format";
import { useJob } from "../hooks/useJob";
import {
  INPUT_LABEL,
  INTERACTION_LABEL,
  INTERACTION_MODES,
  useInteraction,
} from "../interaction";
import {
  DIRECTION_LABEL,
  FIT_LABEL,
  READER_DIRECTIONS,
  READER_FITS,
  ZOOM_STEPS,
  readDefaultSettings,
  saveDefaultSettings,
  type ReaderSettings,
} from "../reader/prefs";
import { MODE_LABEL, READER_MODES } from "../reader/mode";

const LIBRARY_KINDS: LibraryKind[] = ["comic", "video", "mixed"];

const JOB_STATE_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "扫描中",
  done: "已完成",
  failed: "失败",
};

interface JobEntry {
  key: string;
  jobId: string;
  libraryName: string;
}

function JobRow({
  entry,
  onFinished,
}: {
  entry: JobEntry;
  onFinished: (jobId: string) => void;
}) {
  const { job, error } = useJob(entry.jobId);
  const notified = useRef(false);

  useEffect(() => {
    if (!job) return;
    if (job.state !== "done" && job.state !== "failed") return;
    if (notified.current) return;
    notified.current = true;
    onFinished(entry.jobId);
  }, [job, onFinished, entry.jobId]);

  const total = job?.progress.total ?? 0;
  const state = job?.state ?? "queued";

  return (
    <li className="job">
      <div className="job__head">
        <span className="job__title">{entry.libraryName}</span>
        <span className={`badge badge--${state}`}>{JOB_STATE_LABEL[state] ?? state}</span>
        {job ? (
          <span className="job__count">
            {job.progress.done} / {total > 0 ? total : "?"}
          </span>
        ) : null}
      </div>

      {job && total > 0 ? (
        <ProgressBar value={job.progress.done} max={total} label={`${entry.libraryName} 扫描进度`} />
      ) : (
        <IndeterminateBar label={`${entry.libraryName} 扫描进度`} />
      )}

      {job?.message ? <p className="job__message">{job.message}</p> : null}
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
      {job?.startedAt ? (
        <p className="job__meta">
          开始于 {formatDateTime(job.startedAt)}
          {job.finishedAt ? ` · 耗时 ${formatDuration(job.startedAt, job.finishedAt)}` : " · 进行中"}
        </p>
      ) : null}
    </li>
  );
}

export function SettingsPage() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [kind, setKind] = useState<LibraryKind>("comic");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobEntry[]>([]);

  const [scraper, setScraper] = useState<ScraperState | null>(null);
  const [scraperError, setScraperError] = useState<string | null>(null);
  const [scraperBusy, setScraperBusy] = useState(false);
  const [scraperHealth, setScraperHealth] = useState<ScraperHealth | null>(null);
  const [cookie, setCookie] = useState<Required<Pick<EhCookieInput, "ipbMemberId" | "ipbPassHash" | "igneous">> & {
    cfClearance: string;
  }>({ ipbMemberId: "", ipbPassHash: "", igneous: "", cfClearance: "" });
  const [scrapeMessage, setScrapeMessage] = useState<string | null>(null);

  const [ai, setAi] = useState<AiState | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiHealth, setAiHealth] = useState<ScraperHealth | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);

  const [org, setOrg] = useState<OrganizeState | null>(null);
  const [orgLib, setOrgLib] = useState("");
  const [orgPattern, setOrgPattern] = useState("");
  const [orgPreview, setOrgPreview] = useState<OrganizePreview | null>(null);
  const [orgMessage, setOrgMessage] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [journalBusy, setJournalBusy] = useState<string | null>(null);
  const [journalMessage, setJournalMessage] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<{ version: string; configDir: string; backupCount: number; backups: BackupEntry[] } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  const { preference, input, setPreference } = useInteraction();
  const [interactionToast, setInteractionToast] = useState("");

  useEffect(() => {
    if (!interactionToast) return;
    const timer = window.setTimeout(() => setInteractionToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [interactionToast]);

  const chooseInteraction = (next: typeof preference) => {
    setPreference(next);
    setInteractionToast(`已切换到${INTERACTION_LABEL[next]}模式`);
  };

  // 阅读器全局默认值：每部作品仍会各自记住上次的设置
  const [readerDefaults, setReaderDefaults] = useState<ReaderSettings>(() => readDefaultSettings());
  const updateReaderDefaults = (patch: Partial<ReaderSettings>) => {
    setReaderDefaults((current) => {
      const next = { ...current, ...patch };
      saveDefaultSettings(next);
      return next;
    });
    setInteractionToast("阅读器默认值已更新");
  };

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    api
      .listLibraries()
      .then((result) => {
        if (cancelled) return;
        setLibraries(result.items);
        setError(null);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled || isAbortError(reason)) return;
        setError(describeError(reason));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadToken]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;
    const libraryName = name.trim();
    const path = rootPath.trim();
    if (!libraryName) {
      setFormError("请输入媒体库名称");
      return;
    }
    if (!path) {
      setFormError("请输入媒体库根路径");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const input: CreateLibraryInput = { name: libraryName, rootPath: path, kind };
      await api.createLibrary(input);
      setName("");
      setRootPath("");
      reload();
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setCreating(false);
    }
  };

  const handleScan = async (library: Library) => {
    if (busyId !== null) return;
    setBusyId(library.id);
    setFormError(null);
    try {
      const result = await api.scanLibrary(library.id);
      setJobs((current) => [
        { key: result.jobId, jobId: result.jobId, libraryName: library.name },
        ...current.filter((entry) => entry.jobId !== result.jobId),
      ].slice(0, 6));
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (library: Library) => {
    if (busyId !== null) return;
    setBusyId(library.id);
    setFormError(null);
    try {
      await api.deleteLibrary(library.id);
      setConfirmingId(null);
      reload();
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setBusyId(null);
    }
  };

  const handleJobFinished = useCallback(() => {
    // 扫描结束后刷新媒体库列表（作品数、上次扫描时间会变）
    reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    api
      .getOrganize()
      .then((result) => {
        if (cancelled) return;
        setOrg(result.organize);
        setOrgPattern(result.organize.pattern);
      })
      .catch(() => {
        if (cancelled) return;
        setOrg(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runOrganize = async (action: "toggle" | "save" | "preview" | "apply" | "nfo") => {
    if (!orgLib) {
      setOrgError("先选择一个媒体库");
      return;
    }
    setOrgBusy(true);
    setOrgError(null);
    try {
      if (action === "toggle") {
        await api.updateOrganize({ enabled: !org?.enabled });
        setOrg((current) => (current ? { ...current, enabled: !current.enabled } : current));
        setOrgMessage("整理开关已更新");
        return;
      }
      if (action === "nfo") {
        await api.updateOrganize({ nfo: !org?.nfoEnabled });
        setOrg((current) => (current ? { ...current, nfoEnabled: !current.nfoEnabled } : current));
        setOrgMessage("NFO 写回开关已更新");
        return;
      }
      if (action === "save") {
        await api.updateOrganize({ pattern: orgPattern });
        setOrg((current) => (current ? { ...current, pattern: orgPattern } : current));
        setOrgMessage("模板已保存");
        return;
      }
      if (action === "preview") {
        const result = await api.organizePreview({ libraryId: orgLib, pattern: orgPattern, limit: 20 });
        setOrgPreview(result);
        setOrgMessage(`预览 ${result.items.length} 条，冲突 ${result.conflictCount} 条`);
        return;
      }
      if (!window.confirm("整理会重命名并移动媒体文件，确定执行？")) return;
      const result = await api.organizeApply({ libraryId: orgLib });
      setOrgMessage(`已整理 ${result.applied} 项，失败 ${result.failed} 项；journal：${result.journalPath}`);
      setOrgPreview(null);
      loadJournal();
    } catch (reason) {
      setOrgError(describeError(reason));
    } finally {
      setOrgBusy(false);
    }
  };

  const loadJournal = useCallback(() => {
    api
      .listJournal()
      .then((result) => setJournal(result.entries))
      .catch(() => setJournal([]));
  }, []);

  useEffect(() => {
    loadJournal();
  }, [loadJournal]);

  const loadMaintenance = useCallback(() => {
    api
      .getMaintenance()
      .then((result) => setMaintenance(result.maintenance))
      .catch(() => setMaintenance(null));
  }, []);

  useEffect(() => {
    loadMaintenance();
  }, [loadMaintenance]);

  const handleBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupMessage(null);
    try {
      const result = await api.createBackup();
      setBackupMessage(`已生成快照 ${result.backup.name}（${(result.backup.bytes / 1024 / 1024).toFixed(1)} MB）`);
      loadMaintenance();
    } catch (reason) {
      setBackupMessage(describeError(reason));
    } finally {
      setBackupBusy(false);
    }
  };

  const handleUndo = async (id: string) => {
    if (journalBusy) return;
    setJournalBusy(id);
    setJournalMessage(null);
    try {
      const result = await api.undoJournal(id);
      setJournalMessage(
        `已撤销：${result.undone} 项${result.rescanRequired ? "（建议重新扫描以更新索引）" : ""}`,
      );
      loadJournal();
    } catch (reason) {
      setJournalMessage(describeError(reason));
    } finally {
      setJournalBusy(null);
    }
  };

  const loadScraper = useCallback(() => {
    api
      .getScraper()
      .then((result) => {
        setScraper(result.scraper);
        setScraperError(null);
      })
      .catch((reason: unknown) => setScraperError(describeError(reason)));
  }, []);

  useEffect(loadScraper, [loadScraper]);

  const scraperAction = async (action: () => Promise<void>) => {
    if (scraperBusy) return;
    setScraperBusy(true);
    setScraperError(null);
    try {
      await action();
    } catch (reason) {
      setScraperError(describeError(reason));
    } finally {
      setScraperBusy(false);
    }
  };

  const handleToggleScraper = (next: boolean) => {
    void scraperAction(async () => {
      const result = await api.updateScraper({ enabled: next });
      setScraper(result.scraper);
      setScrapeMessage(next ? "刮削已开启" : "刮削已关闭");
    });
  };

  const handleSaveCookie = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void scraperAction(async () => {
      const input: EhCookieInput = {
        ipbMemberId: cookie.ipbMemberId.trim(),
        ipbPassHash: cookie.ipbPassHash.trim(),
        igneous: cookie.igneous.trim(),
      };
      if (cookie.cfClearance.trim()) input.cfClearance = cookie.cfClearance.trim();
      const result = await api.updateScraper({ cookie: input });
      setScraper(result.scraper);
      setCookie({ ipbMemberId: "", ipbPassHash: "", igneous: "", cfClearance: "" });
      setScrapeMessage("Cookie 已加密保存");
    });
  };

  const handleHealth = () => {
    void scraperAction(async () => {
      const result = await api.scraperHealth();
      setScraperHealth(result.health);
    });
  };

  const handleBatchScrape = () => {
    void scraperAction(async () => {
      const result = await api.scrapeBatch({ limit: 10 });
      if (result.jobId) {
        setJobs((current) =>
          [
            { key: result.jobId as string, jobId: result.jobId as string, libraryName: "E-H 批量刮削" },
            ...current.filter((entry) => entry.jobId !== result.jobId),
          ].slice(0, 6),
        );
        setScrapeMessage(`已排队 ${result.candidates} 个作品`);
      } else {
        setScrapeMessage("没有需要刮削的作品（均已有元数据）");
      }
    });
  };

  const loadAi = useCallback(() => {
    api
      .getAi()
      .then((result) => {
        setAi(result.ai);
        setAiModel(result.ai.model);
        setAiBaseUrl(result.ai.baseUrl);
        setAiError(null);
      })
      .catch((reason: unknown) => setAiError(describeError(reason)));
  }, []);

  useEffect(loadAi, [loadAi]);

  const aiAction = async (action: () => Promise<void>) => {
    if (aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      await action();
    } catch (reason) {
      setAiError(describeError(reason));
    } finally {
      setAiBusy(false);
    }
  };

  const handleToggleAi = (next: boolean) => {
    void aiAction(async () => {
      const result = await api.updateAi({ enabled: next });
      setAi(result.ai);
      setAiMessage(next ? "AI 搜索已开启" : "AI 搜索已关闭");
    });
  };

  const handleToggleClassify = (next: boolean) => {
    void aiAction(async () => {
      const result = await api.updateAi({ classify: next });
      setAi(result.ai);
      setAiMessage(next ? "已允许 AI 重新分类" : "已关闭 AI 重新分类");
    });
  };

  const handleSaveAiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = aiKey.trim();
    if (key.length < 8) {
      setAiError("API Key 太短，请检查是否复制完整");
      return;
    }
    void aiAction(async () => {
      const result = await api.updateAi({ apiKey: key, enabled: true });
      setAi(result.ai);
      setAiKey("");
      setAiMessage("API Key 已加密保存，AI 搜索已开启");
    });
  };

  const handleSaveAiModel = () => {
    void aiAction(async () => {
      const result = await api.updateAi({
        model: aiModel.trim() || undefined,
        baseUrl: aiBaseUrl.trim() || undefined,
      });
      setAi(result.ai);
      setAiMessage("模型设置已保存");
    });
  };

  const handleAiHealth = () => {
    void aiAction(async () => {
      const result = await api.aiHealth();
      setAiHealth(result.health);
    });
  };

  const handleDeleteAiKey = () => {
    void aiAction(async () => {
      const result = await api.deleteAiKey();
      setAi(result.ai);
      setAiHealth(null);
      setAiMessage("API Key 已删除，AI 搜索已关闭");
    });
  };

  if (loading && libraries.length === 0 && error === null) {
    return <FullPageLoading label="正在读取媒体库…" />;
  }

  return (
    <div className="page page--settings">
      <header className="page__head">
        <div>
          <h1 className="page__title">设置</h1>
          <p className="page__subtitle">管理媒体库与扫描任务。扫描只读，不会改动磁盘文件。</p>
        </div>
      </header>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {formError ? (
        <p className="form__error" role="alert">
          {formError}
        </p>
      ) : null}

      <section className="card" aria-labelledby="libraries-title">
        <div className="card__head">
          <h2 id="libraries-title" className="card__title">
            媒体库
          </h2>
          <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
            刷新
          </button>
        </div>

        {libraries.length === 0 ? (
          <EmptyState
            title="还没有媒体库"
            description="在下面填写名称与根路径，添加后即可扫描。"
          />
        ) : (
          <ul className="library-list">
            {libraries.map((library) => {
              const busy = busyId === library.id;
              const confirming = confirmingId === library.id;
              return (
                <li key={library.id} className="library">
                  <div className="library__main">
                    <div className="library__title-row">
                      <h3 className="library__title">{library.name}</h3>
                      <span className="chip chip--small">{LIBRARY_KIND_LABEL[library.kind]}</span>
                    </div>
                    <p className="library__path mono break-all">{library.rootPath}</p>
                    <p className="library__meta">
                      {library.workCount} 部作品 · 上次扫描：{formatDateTime(library.lastScanAt)}
                    </p>
                  </div>

                  <div className="library__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleScan(library)}
                      disabled={busy}
                    >
                      {busy ? "处理中…" : "扫描"}
                    </button>
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--danger"
                          onClick={() => void handleDelete(library)}
                          disabled={busy}
                        >
                          确认删除索引
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => setConfirmingId(null)}
                          disabled={busy}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setConfirmingId(library.id)}
                        disabled={busy}
                      >
                        移除
                      </button>
                    )}
                  </div>
                  {confirming ? (
                    <p className="library__warning" role="status">
                      只会删除 NekoShelf 的索引记录，磁盘上的文件不会被删除。
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="add-library-title">
        <div className="card__head">
          <h2 id="add-library-title" className="card__title">
            添加媒体库
          </h2>
        </div>
        <form className="form form--inline" onSubmit={(event) => void handleCreate(event)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="settings-library-name">
              名称
            </label>
            <input
              id="settings-library-name"
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的漫画"
              disabled={creating}
            />
          </div>
          <div className="field field--grow">
            <label className="field__label" htmlFor="settings-library-path">
              根路径
            </label>
            <input
              id="settings-library-path"
              className="input input--mono"
              type="text"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="/data/comics"
              disabled={creating}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="settings-library-kind">
              类型
            </label>
            <select
              id="settings-library-kind"
              className="input"
              value={kind}
              onChange={(event) => setKind(event.target.value as LibraryKind)}
              disabled={creating}
            >
              {LIBRARY_KINDS.map((item) => (
                <option key={item} value={item}>
                  {LIBRARY_KIND_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--actions">
            <button type="submit" className="btn btn--primary" disabled={creating}>
              {creating ? "添加中…" : "添加媒体库"}
            </button>
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="interaction-title">
        <div className="card__head">
          <h2 id="interaction-title" className="card__title">
            交互模式
          </h2>
          <span className="chip chip--small">当前生效：{INPUT_LABEL[input]}</span>
        </div>
        <p className="muted">
          自动检测，可手动指定。触摸模式使用大号按钮、点击左右半屏或左右滑动翻页；鼠标模式使用悬停提示、滚轮与键盘方向键翻页。
          切换后立即生效，并记住在这台设备上的选择。
        </p>
        <div className="form form--inline">
          <div className="field field--grow">
            <span className="field__label" id="interaction-mode-label">
              指针输入
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="interaction-mode-label">
              {INTERACTION_MODES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={preference === item}
                  className={preference === item ? "segmented__item is-active" : "segmented__item"}
                  onClick={() => chooseInteraction(item)}
                >
                  {INTERACTION_LABEL[item]}
                </button>
              ))}
            </div>
            <p className="field__hint">
              {preference === "auto"
                ? `当前按设备指针能力判断为「${INPUT_LABEL[input]}」`
                : `已固定为「${INTERACTION_LABEL[preference]}」模式`}
            </p>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="reader-defaults-title">
        <div className="card__head">
          <h2 id="reader-defaults-title" className="card__title">
            阅读器默认值
          </h2>
          <span className="chip chip--small">新作品打开时使用</span>
        </div>
        <p className="muted">
          每部作品会记住自己上次用的阅读模式与缩放；这里设置的是还没有单独调整过的作品使用的初始值，也决定阅读器里按 m / p / f
          切换后的落点。
        </p>
        <div className="form form--inline">
          <div className="field field--grow">
            <span className="field__label" id="reader-default-mode-label">
              模式
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="reader-default-mode-label">
              {READER_MODES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={readerDefaults.mode === item}
                  className={
                    readerDefaults.mode === item ? "segmented__item is-active" : "segmented__item"
                  }
                  onClick={() => updateReaderDefaults({ mode: item })}
                >
                  {MODE_LABEL[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="field field--grow">
            <span className="field__label" id="reader-default-direction-label">
              方向
            </span>
            <div
              className="segmented"
              role="radiogroup"
              aria-labelledby="reader-default-direction-label"
            >
              {READER_DIRECTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={readerDefaults.direction === item}
                  className={
                    readerDefaults.direction === item
                      ? "segmented__item is-active"
                      : "segmented__item"
                  }
                  onClick={() => updateReaderDefaults({ direction: item })}
                >
                  {DIRECTION_LABEL[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="field field--grow">
            <span className="field__label" id="reader-default-fit-label">
              适配
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="reader-default-fit-label">
              {READER_FITS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={readerDefaults.fit === item}
                  className={
                    readerDefaults.fit === item ? "segmented__item is-active" : "segmented__item"
                  }
                  onClick={() => updateReaderDefaults({ fit: item })}
                >
                  {FIT_LABEL[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="field field--grow">
            <span className="field__label" id="reader-default-zoom-label">
              缩放
            </span>
            <div
              className="segmented"
              role="radiogroup"
              aria-labelledby="reader-default-zoom-label"
            >
              {ZOOM_STEPS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={readerDefaults.zoom === item}
                  className={
                    readerDefaults.zoom === item ? "segmented__item is-active" : "segmented__item"
                  }
                  onClick={() => updateReaderDefaults({ zoom: item })}
                >
                  {item}×
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="field__hint">
          当前默认：{MODE_LABEL[readerDefaults.mode]} · {DIRECTION_LABEL[readerDefaults.direction]} ·{" "}
          {FIT_LABEL[readerDefaults.fit]} · {readerDefaults.zoom}×（已保存在这台设备）
        </p>
      </section>

      <section className="card" aria-labelledby="scraper-title">
        <div className="card__head">
          <h2 id="scraper-title" className="card__title">
            E-H 刮削（里站）
          </h2>
          <button type="button" className="btn btn--ghost" onClick={loadScraper} disabled={scraperBusy}>
            刷新
          </button>
        </div>
        <p className="muted">
          默认关闭；只在开启后、且作品没有 ComicInfo / 已有标签时才请求里站（exhentai）。可对单个作品手动刮削。
        </p>

        {scraper ? (
          <>
            <div className="form form--inline">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={scraper.enabled}
                  disabled={scraperBusy || !scraper.hasCredential}
                  onChange={(event) => handleToggleScraper(event.target.checked)}
                />
                开启刮削
              </label>
              <span className="chip chip--small">
                {scraper.hasCredential ? "已导入 Cookie" : "未导入 Cookie"}
              </span>
              <span className="chip chip--small">待刮 {scraper.candidateCount} 个</span>
              <span className="chip chip--small">间隔 {Math.round(scraper.intervalMs / 1000)}s</span>
            </div>
            {!scraper.hasCredential ? (
              <p className="kv__note">先在下方粘贴 Cookie 并保存，再勾选「开启刮削」即可；不需要改环境变量。</p>
            ) : null}
            {!scraper.envGate ? (
              <p className="kv__note">提示：ENABLE_SCRAPER=1 可在无界面场景强制开启（设置页开关仍然有效）。</p>
            ) : null}

            <div className="form form--inline">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleHealth}
                disabled={scraperBusy || !scraper.hasCredential}
              >
                测试登录
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleBatchScrape}
                disabled={scraperBusy || !scraper.enabled}
              >
                批量刮削（≤10）
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() =>
                  void scraperAction(async () => {
                    const result = await api.deleteScraperCookie();
                    setScraper(result.scraper);
                    setScraperHealth(null);
                    setScrapeMessage("Cookie 已删除，刮削已关闭");
                  })
                }
                disabled={scraperBusy || !scraper.hasCredential}
              >
                删除 Cookie
              </button>
            </div>
            {scraperHealth ? (
              <p className="kv__note" role="status">
                {scraperHealth.ok
                  ? `登录正常（${scraperHealth.latencyMs ?? "?"} ms）`
                  : `登录异常：${scraperHealth.error ?? "未知原因"}`}
              </p>
            ) : null}
            {scrapeMessage ? (
              <p className="kv__note" role="status">
                {scrapeMessage}
              </p>
            ) : null}

            <form className="form form--inline" onSubmit={(event) => void handleSaveCookie(event)} noValidate>
              <div className="field">
                <label className="field__label" htmlFor="eh-member">
                  ipb_member_id
                </label>
                <input
                  id="eh-member"
                  className="input input--mono"
                  value={cookie.ipbMemberId}
                  onChange={(event) => setCookie({ ...cookie, ipbMemberId: event.target.value })}
                  disabled={scraperBusy}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="eh-passhash">
                  ipb_pass_hash
                </label>
                <input
                  id="eh-passhash"
                  className="input input--mono"
                  value={cookie.ipbPassHash}
                  onChange={(event) => setCookie({ ...cookie, ipbPassHash: event.target.value })}
                  disabled={scraperBusy}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="eh-igneous">
                  igneous
                </label>
                <input
                  id="eh-igneous"
                  className="input input--mono"
                  value={cookie.igneous}
                  onChange={(event) => setCookie({ ...cookie, igneous: event.target.value })}
                  disabled={scraperBusy}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="eh-cf">
                  cf_clearance（可选）
                </label>
                <input
                  id="eh-cf"
                  className="input input--mono"
                  value={cookie.cfClearance}
                  onChange={(event) => setCookie({ ...cookie, cfClearance: event.target.value })}
                  disabled={scraperBusy}
                />
              </div>
              <div className="field field--actions">
                <button type="submit" className="btn" disabled={scraperBusy}>
                  {scraperBusy ? "保存中…" : "保存 Cookie"}
                </button>
              </div>
            </form>
          </>
        ) : null}
        {scraperError ? (
          <p className="form__error" role="alert">
            {scraperError}
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="ai-title">
        <div className="card__head">
          <h2 id="ai-title" className="card__title">
            AI 自然语言搜索
          </h2>
          <button type="button" className="btn btn--ghost" onClick={loadAi} disabled={aiBusy}>
            刷新
          </button>
        </div>
        <p className="muted">
          默认关闭；只会把「一句话描述」翻译成检索条件（不发作品内容、不做向量索引），默认服务商是 DeepSeek。
        </p>

        {ai ? (
          <>
            <div className="form form--inline">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.enabled}
                  disabled={aiBusy || !ai.configured}
                  onChange={(event) => handleToggleAi(event.target.checked)}
                />
                开启 AI 搜索
              </label>
              <span className="chip chip--small">
                {ai.configured
                  ? `已保存 API Key（${ai.apiKeyHint ?? "…"}）`
                  : "未配置 API Key"}
              </span>
              <span className="chip chip--small">模型 {ai.model}</span>
              <span className="chip chip--small">已请求 {ai.usage.requests} 次</span>
            </div>
            {!ai.configured ? (
              <div className="notice">
                <p className="notice__title">先保存 API Key</p>
                <p className="muted">在下方填入 DeepSeek API Key 并保存，然后勾选「开启 AI 搜索」即可；不需要改容器环境变量。</p>
              </div>
            ) : null}
            {!ai.envGate ? (
              <p className="muted">
                提示：旧版的容器环境变量硬开关已取消，设置页开关即可生效（配置会持久化在 /config）。
              </p>
            ) : null}

            <div className="form form--inline">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.classifyEnabled}
                  disabled={aiBusy || !ai.enabled}
                  onChange={(event) => void handleToggleClassify(event.target.checked)}
                />
                允许 AI 重新分类作品
              </label>
              <span className="muted">判不准的作品可在详情页手动触发（不批量、不自动运行）。</span>
            </div>

            <form className="form form--inline" onSubmit={handleSaveAiKey} noValidate>
              <div className="field field--grow">
                <label className="field__label" htmlFor="ai-key">
                  DeepSeek API Key
                </label>
                <input
                  id="ai-key"
                  className="input input--mono"
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={aiKey}
                  onChange={(event) => setAiKey(event.target.value)}
                  disabled={aiBusy}
                />
              </div>
              <div className="field field--actions">
                <button type="submit" className="btn" disabled={aiBusy || aiKey.trim() === ""}>
                  {aiBusy ? "保存中…" : "保存 Key 并开启"}
                </button>
              </div>
            </form>

            <div className="form form--inline">
              <div className="field field--grow">
                <label className="field__label" htmlFor="ai-model">
                  模型名
                </label>
                <input
                  id="ai-model"
                  className="input input--mono"
                  value={aiModel}
                  onChange={(event) => setAiModel(event.target.value)}
                  disabled={aiBusy}
                />
              </div>
              <div className="field field--grow">
                <label className="field__label" htmlFor="ai-baseurl">
                  Base URL（OpenAI 兼容网关）
                </label>
                <input
                  id="ai-baseurl"
                  className="input input--mono"
                  value={aiBaseUrl}
                  onChange={(event) => setAiBaseUrl(event.target.value)}
                  disabled={aiBusy}
                />
              </div>
              <div className="field field--actions">
                <button type="button" className="btn" onClick={handleSaveAiModel} disabled={aiBusy}>
                  保存模型设置
                </button>
              </div>
            </div>

            <div className="form form--inline">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleAiHealth}
                disabled={aiBusy || !ai.configured}
              >
                测试连接
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={handleDeleteAiKey}
                disabled={aiBusy || !ai.configured}
              >
                删除 Key
              </button>
            </div>
            {aiHealth ? (
              <p className="kv__note" role="status">
                {aiHealth.ok
                  ? `连接正常（${aiHealth.latencyMs ?? "?"} ms）`
                  : `连接异常：${aiHealth.error ?? "未知原因"}`}
              </p>
            ) : null}
            {aiMessage ? (
              <p className="kv__note" role="status">
                {aiMessage}
              </p>
            ) : null}
          </>
        ) : null}
        {aiError ? (
          <p className="form__error" role="alert">
            {aiError}
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="organize-title">
        <div className="card__head">
          <h2 id="organize-title" className="card__title">
            整理与元数据
          </h2>
          <span className="muted">{org?.writebackEnabled ? "可写回" : "仅预览（DATA_MODE 非 writeback）"}</span>
        </div>
        <p className="muted">
          按模板重命名/移动媒体文件（不改文件内容）。默认只预览；真正执行需要容器以 DATA_MODE=writeback
          启动并在这里打开开关。
        </p>
        <div className="form form--inline">
          <label className="field">
            <span className="field__label">媒体库</span>
            <select value={orgLib} onChange={(event) => setOrgLib(event.target.value)}>
              <option value="">选择媒体库…</option>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}（{library.rootPath}）
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void runOrganize("toggle")}
            disabled={orgBusy || !org}
          >
            {org?.enabled ? "整理已开启（点击关闭）" : "整理未开启（点击打开）"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void runOrganize("nfo")}
            disabled={orgBusy || !org || !org.enabled}
            title="NFO 写回还需 DATA_MODE=writeback"
          >
            {org?.nfoEnabled ? "NFO 写回已开启（点击关闭）" : "NFO 写回未开启（点击打开）"}
          </button>
        </div>
        <div className="form form--inline">
          <label className="field field--grow">
            <span className="field__label">重命名模板</span>
            <input
              value={orgPattern}
              onChange={(event) => setOrgPattern(event.target.value)}
              placeholder="{author} - {title} [{pages}P]"
            />
          </label>
          <button type="button" className="btn btn--ghost" onClick={() => void runOrganize("save")} disabled={orgBusy}>
            保存模板
          </button>
          <button type="button" className="btn" onClick={() => void runOrganize("preview")} disabled={orgBusy}>
            预览
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void runOrganize("apply")}
            disabled={orgBusy || !org?.enabled || !org?.writebackEnabled}
          >
            执行整理
          </button>
        </div>
        {orgMessage ? <p className="kv__note">{orgMessage}</p> : null}
        {orgError ? (
          <p className="form__error" role="alert">
            {orgError}
          </p>
        ) : null}
        {orgPreview ? (
          orgPreview.items.length === 0 ? (
            <p className="muted">没有需要整理的作品。</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>作品</th>
                    <th>当前</th>
                    <th>目标</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {orgPreview.items.map((item) => (
                    <tr key={item.workId}>
                      <td>{item.title}</td>
                      <td className="muted">{item.from}</td>
                      <td className="muted">{item.to}</td>
                      <td>
                        {item.conflict ? (
                          <span className="badge badge--failed">{item.conflict}</span>
                        ) : (
                          <span className="badge badge--done">可整理</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <section className="card" aria-labelledby="maintenance-title">
        <div className="card__head">
          <h2 id="maintenance-title" className="card__title">
            备份与维护
          </h2>
          <span className="muted">{maintenance ? `版本 ${maintenance.version}` : "—"}</span>
        </div>
        <p className="muted">
          SQLite 在线快照（`VACUUM INTO`）写到 /config/backups，不触碰媒体目录。恢复时停容器、替换
          nekoshelf.db 后重启即可（见 README「发布与备份」）。
        </p>
        <div className="form form--inline">
          <button type="button" className="btn" onClick={() => void handleBackup()} disabled={backupBusy}>
            {backupBusy ? "备份中…" : "立即备份"}
          </button>
          <span className="muted">共 {maintenance?.backupCount ?? 0} 份快照</span>
        </div>
        {backupMessage ? <p className="kv__note">{backupMessage}</p> : null}
        {maintenance && maintenance.backups.length > 0 ? (
          <ul className="journal-list">
            {maintenance.backups.slice(0, 5).map((backup) => (
              <li className="journal-row" key={backup.name}>
                <span className="badge">快照</span>
                <span className="muted">{backup.name}</span>
                <span className="muted">{(backup.bytes / 1024 / 1024).toFixed(1)} MB</span>
                <span className="muted">{formatDateTime(backup.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card" aria-labelledby="journal-title">
        <div className="card__head">
          <h2 id="journal-title" className="card__title">
            写回记录（journal）
          </h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={loadJournal}>
            刷新
          </button>
        </div>
        <p className="muted">整理重命名 / NFO 写入 / 合并标记每次都会留一条记录，可在此撤销（只还原，不覆盖已有文件）。</p>
        {journal.length === 0 ? (
          <p className="muted">还没有写回记录。</p>
        ) : (
          <ul className="journal-list">
            {journal.map((entry) => (
              <li className="journal-row" key={entry.id}>
                <span className="badge">{entry.type}</span>
                <span className="muted">{entry.detail}</span>
                <span className="muted">{formatDateTime(entry.at)}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void handleUndo(entry.id)}
                  disabled={journalBusy !== null}
                >
                  {journalBusy === entry.id ? "撤销中…" : "撤销"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {journalMessage ? <p className="kv__note">{journalMessage}</p> : null}
      </section>

      <section className="card" aria-labelledby="jobs-title">
        <div className="card__head">
          <h2 id="jobs-title" className="card__title">
            扫描任务
          </h2>
        </div>
        {jobs.length === 0 ? (
          <p className="muted">还没有启动扫描任务。点击媒体库上的「扫描」开始。</p>
        ) : (
          <ul className="job-list">
            {jobs.map((entry) => (
              <JobRow key={entry.key} entry={entry} onFinished={handleJobFinished} />
            ))}
          </ul>
        )}
      </section>

      {interactionToast ? (
        <div className="app-toast" role="status" aria-live="polite">
          {interactionToast}
        </div>
      ) : null}
    </div>
  );
}
