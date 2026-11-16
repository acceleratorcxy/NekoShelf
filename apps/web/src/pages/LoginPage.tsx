import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { describeError } from "../api";
import { ErrorState, FullPageLoading } from "../components/States";

function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function LoginPage() {
  const { status, user, initialized, error: authError, setUser, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = sanitizeNext(searchParams.get("next"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "loading") return <FullPageLoading label="正在检查登录状态…" />;
  if (status === "error") {
    return (
      <ErrorState
        title="无法连接服务器"
        message={authError ?? "请确认 NekoShelf 后端已启动"}
        onRetry={refresh}
      />
    );
  }
  if (!initialized) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to={next} replace />;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const name = username.trim();
    if (!name || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.login({ username: name, password });
      setUser(result.user);
      navigate(next, { replace: true });
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-card__brand">
          <span className="brand__mark brand__mark--large" aria-hidden="true">
            猫
          </span>
          <h1 className="auth-card__title">NekoShelf</h1>
          <p className="auth-card__subtitle">本地漫画与媒体书库</p>
        </div>

        <form className="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="login-username">
              用户名
            </label>
            <input
              id="login-username"
              className="input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="login-password">
              密码
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </div>

          {error ? (
            <p className="form__error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>

        <p className="auth-card__hint">
          首次使用？先在浏览器打开 /setup 完成初始化向导。
          <br />
          <Link className="auth-card__help" to="/help">
            第一次部署？先看帮助文档 →
          </Link>
        </p>
      </div>
    </div>
  );
}
