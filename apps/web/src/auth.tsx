import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, api, describeError, type User } from "./api";
import { ErrorState, FullPageLoading } from "./components/States";

type AuthStatus = "loading" | "ready" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** 是否已完成首次初始化（/api/setup/status.initialized）。 */
  initialized: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  markInitialized: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setStatus("loading");
      setError(null);
      try {
        const setup = await api.setupStatus();
        if (cancelled) return;
        setInitialized(setup.initialized);
        if (!setup.initialized) {
          setUser(null);
          setStatus("ready");
          return;
        }

        try {
          const me = await api.me();
          if (cancelled) return;
          setUser(me.user);
        } catch (meError) {
          if (cancelled) return;
          if (meError instanceof ApiError && meError.isUnauthorized) {
            setUser(null);
          } else {
            throw meError;
          }
        }
        setStatus("ready");
      } catch (bootstrapError) {
        if (cancelled) return;
        setError(describeError(bootstrapError));
        setStatus("error");
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      initialized,
      error,
      setUser,
      markInitialized: () => setInitialized(true),
      refresh: () => setReloadToken((token) => token + 1),
    }),
    [status, user, initialized, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必须在 <AuthProvider> 内部使用");
  return context;
}

/** 登录态 + 初始化状态守卫，包住需要会话的页面。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user, initialized, error, refresh } = useAuth();
  const location = useLocation();

  if (status === "loading") return <FullPageLoading label="正在检查登录状态…" />;

  if (status === "error") {
    return (
      <ErrorState
        title="无法连接服务器"
        message={error ?? "请确认 NekoShelf 后端已在 127.0.0.1:8080 启动"}
        onRetry={refresh}
      />
    );
  }

  if (!initialized) return <Navigate to="/setup" replace />;

  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}
