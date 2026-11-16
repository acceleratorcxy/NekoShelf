import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  api,
  describeError,
  type CreateLibraryInput,
  type Library,
  type LibraryKind,
} from "../api";
import { useAuth } from "../auth";
import { ErrorState, FullPageLoading } from "../components/States";
import { IndeterminateBar, ProgressBar } from "../components/ProgressBar";
import { LIBRARY_KIND_LABEL } from "../format";
import { useJob } from "../hooks/useJob";

type SetupStep = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<SetupStep, string> = {
  1: "创建管理员",
  2: "添加媒体库",
  3: "扫描媒体库",
  4: "完成",
};

const LIBRARY_KINDS: LibraryKind[] = ["comic", "video", "mixed"];

const JOB_STATE_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "扫描中",
  done: "扫描完成",
  failed: "扫描失败",
};

export function SetupPage() {
  const { status, initialized, user, setUser, markInitialized, refresh, error: authError } = useAuth();
  const navigate = useNavigate();

  const [started, setStarted] = useState(false);
  const [step, setStep] = useState<SetupStep>(1);
  const [error, setError] = useState<string | null>(null);

  // 第 1 步：管理员账号
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [creatingAdmin, setCreatingAdmin] = useState(false);

  // 第 2 步：媒体库
  const [libraryName, setLibraryName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [libraryKind, setLibraryKind] = useState<LibraryKind>("comic");
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);

  // 第 3 步：扫描
  const [jobId, setJobId] = useState<string | null>(null);
  const [startingScan, setStartingScan] = useState(false);
  const { job, error: jobError } = useJob(jobId);

  if (status === "loading") return <FullPageLoading label="正在检查初始化状态…" />;
  if (status === "error") {
    return (
      <ErrorState
        title="无法连接服务器"
        message={authError ?? "请确认 NekoShelf 后端已启动"}
        onRetry={refresh}
      />
    );
  }
  if (!started && initialized) {
    return <Navigate to={user ? "/" : "/login"} replace />;
  }

  const handleCreateAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingAdmin) return;
    const name = username.trim();
    if (!name) {
      setError("请输入管理员用户名");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setError(null);
    setCreatingAdmin(true);
    try {
      const result = await api.setup({ username: name, password });
      setUser(result.user);
      markInitialized();
      setStarted(true);
      setStep(2);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setCreatingAdmin(false);
    }
  };

  const handleCreateLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingLibrary) return;
    const name = libraryName.trim();
    const path = rootPath.trim();
    if (!name) {
      setError("请输入媒体库名称");
      return;
    }
    if (!path) {
      setError("请输入媒体库根路径");
      return;
    }
    setError(null);
    setSavingLibrary(true);
    try {
      const input: CreateLibraryInput = { name, rootPath: path, kind: libraryKind };
      const result = await api.createLibrary(input);
      setLibrary(result.library);
      setStep(3);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSavingLibrary(false);
    }
  };

  const handleStartScan = async () => {
    if (!library || startingScan) return;
    setError(null);
    setStartingScan(true);
    try {
      const result = await api.scanLibrary(library.id);
      setJobId(result.jobId);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setStartingScan(false);
    }
  };

  const scanFinished = job?.state === "done";
  const progressTotal = job?.progress.total ?? 0;

  return (
    <div className="setup-page">
      <div className="setup-card">
        <header className="setup-card__header">
          <h1 className="setup-card__title">首次使用向导</h1>
          <p className="setup-card__subtitle">三步完成初始化，随时可以在设置里继续调整</p>
          <Link className="setup-card__help" to="/help">
            不确定怎么填？打开帮助文档 →
          </Link>
        </header>

        <ol className="stepper" aria-label="初始化步骤">
          {([1, 2, 3, 4] as SetupStep[]).map((item) => {
            const state = item < step ? "is-done" : item === step ? "is-active" : "";
            return (
              <li key={item} className={`stepper__item ${state}`} aria-current={item === step ? "step" : undefined}>
                <span className="stepper__index" aria-hidden="true">
                  {item < step ? "✓" : item}
                </span>
                <span className="stepper__label">{STEP_TITLES[item]}</span>
              </li>
            );
          })}
        </ol>

        {error ? (
          <p className="form__error" role="alert">
            {error}
          </p>
        ) : null}

        {step === 1 ? (
          <form className="form" onSubmit={(event) => void handleCreateAdmin(event)} noValidate>
            <p className="form__hint">管理员账号用于登录 NekoShelf，只保存在本机。</p>
            <div className="field">
              <label className="field__label" htmlFor="setup-username">
                用户名
              </label>
              <input
                id="setup-username"
                className="input"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={creatingAdmin}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="setup-password">
                密码
              </label>
              <input
                id="setup-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={creatingAdmin}
                required
                minLength={6}
              />
              <p className="field__hint">至少 6 位</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="setup-confirm">
                确认密码
              </label>
              <input
                id="setup-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                disabled={creatingAdmin}
                required
              />
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={creatingAdmin}>
              {creatingAdmin ? "创建中…" : "创建管理员并继续"}
            </button>
          </form>
        ) : null}

        {step === 2 ? (
          <form className="form" onSubmit={(event) => void handleCreateLibrary(event)} noValidate>
            <p className="form__hint">
              媒体库指向你存放漫画/视频的目录。NekoShelf 默认只读，扫描不会修改任何文件。
            </p>
            <div className="field">
              <label className="field__label" htmlFor="library-name">
                媒体库名称
              </label>
              <input
                id="library-name"
                className="input"
                type="text"
                value={libraryName}
                onChange={(event) => setLibraryName(event.target.value)}
                placeholder="例如：我的漫画"
                disabled={savingLibrary}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="library-path">
                根路径
              </label>
              <input
                id="library-path"
                className="input input--mono"
                type="text"
                value={rootPath}
                onChange={(event) => setRootPath(event.target.value)}
                placeholder="例如：/data/comics 或 D:\Comics"
                disabled={savingLibrary}
                required
              />
              <p className="field__hint">容器里通常是挂载进 /data 的只读目录。</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="library-kind">
                类型
              </label>
              <select
                id="library-kind"
                className="input"
                value={libraryKind}
                onChange={(event) => setLibraryKind(event.target.value as LibraryKind)}
                disabled={savingLibrary}
              >
                {LIBRARY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {LIBRARY_KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={savingLibrary}>
              {savingLibrary ? "添加中…" : "添加媒体库并继续"}
            </button>
          </form>
        ) : null}

        {step === 3 && library ? (
          <div className="form">
            <p className="form__hint">
              即将扫描「{library.name}」。扫描在后台进行，只读取文件并建立索引。
            </p>
            <dl className="kv">
              <div className="kv__row">
                <dt>名称</dt>
                <dd>{library.name}</dd>
              </div>
              <div className="kv__row">
                <dt>根路径</dt>
                <dd className="mono">{library.rootPath}</dd>
              </div>
              <div className="kv__row">
                <dt>类型</dt>
                <dd>{LIBRARY_KIND_LABEL[library.kind]}</dd>
              </div>
            </dl>

            {jobId === null ? (
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void handleStartScan()}
                disabled={startingScan}
              >
                {startingScan ? "启动中…" : "开始扫描"}
              </button>
            ) : (
              <div className="job-panel">
                <div className="job-panel__head">
                  <span className={`badge badge--${job?.state ?? "queued"}`}>
                    {JOB_STATE_LABEL[job?.state ?? "queued"] ?? "任务状态未知"}
                  </span>
                  {job ? (
                    <span className="job-panel__count">
                      {job.progress.done} / {progressTotal > 0 ? progressTotal : "?"}
                    </span>
                  ) : null}
                </div>
                {job && progressTotal > 0 ? (
                  <ProgressBar
                    value={job.progress.done}
                    max={progressTotal}
                    label="扫描进度"
                  />
                ) : (
                  <IndeterminateBar label="扫描进度" />
                )}
                {job?.message ? <p className="job-panel__message">{job.message}</p> : null}
                {jobError ? (
                  <p className="form__error" role="alert">
                    {jobError}
                  </p>
                ) : null}
                {job?.state === "failed" ? (
                  <button
                    type="button"
                    className="btn btn--block"
                    onClick={() => void handleStartScan()}
                    disabled={startingScan}
                  >
                    重新扫描
                  </button>
                ) : null}
              </div>
            )}

            <div className="setup-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep(4)}
              >
                {scanFinished ? "跳过，直接完成" : "暂时跳过扫描"}
              </button>
              {scanFinished ? (
                <button type="button" className="btn btn--primary" onClick={() => setStep(4)}>
                  下一步
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="form">
            <p className="form__hint">初始化完成，可以开始浏览书库了。</p>
            <dl className="kv">
              <div className="kv__row">
                <dt>管理员</dt>
                <dd>{user?.username ?? username}</dd>
              </div>
              <div className="kv__row">
                <dt>媒体库</dt>
                <dd>{library ? `${library.name}（${library.rootPath}）` : "—"}</dd>
              </div>
              <div className="kv__row">
                <dt>扫描</dt>
                <dd>
                  {job
                    ? `${JOB_STATE_LABEL[job.state] ?? job.state}${
                        job.state === "done"
                          ? `，处理 ${job.progress.done} 项`
                          : ""
                      }`
                    : "未扫描，可稍后在设置页触发"}
                </dd>
              </div>
            </dl>
            <div className="setup-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setStep(2);
                  setLibraryName("");
                  setRootPath("");
                  setLibraryKind("comic");
                  setLibrary(null);
                  setJobId(null);
                }}
              >
                再添加一个媒体库
              </button>
              <button type="button" className="btn btn--primary" onClick={() => navigate("/")}>
                进入书库
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
