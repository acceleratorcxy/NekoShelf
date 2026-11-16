import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ROLE_LABEL } from "../format";
import { applyTheme, readStoredTheme, storeTheme, type Theme } from "../theme";

export function AppShell({ children }: { children?: ReactNode }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // 会话可能已经失效，仍然按退出处理
    } finally {
      setUser(null);
      setLoggingOut(false);
      navigate("/login", { replace: true });
    }
  };

  const nextTheme: Theme = theme === "dark" ? "light" : "dark";

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="brand" aria-label="NekoShelf 书库首页">
            <span className="brand__mark" aria-hidden="true">
              猫
            </span>
            <span className="brand__text">
              NekoShelf
              <span className="brand__sub">猫猫书架</span>
            </span>
          </Link>

          <nav className="app-nav" aria-label="主导航">
            <NavLink
              to="/"
              end
              className={({ isActive }) => (isActive ? "app-nav__link is-active" : "app-nav__link")}
            >
              书库
            </NavLink>
            <NavLink
              to="/duplicates"
              className={({ isActive }) => (isActive ? "app-nav__link is-active" : "app-nav__link")}
            >
              重复
            </NavLink>
            <NavLink
              to="/jobs"
              className={({ isActive }) => (isActive ? "app-nav__link is-active" : "app-nav__link")}
            >
              任务
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) => (isActive ? "app-nav__link is-active" : "app-nav__link")}
            >
              设置
            </NavLink>
            <NavLink
              to="/help"
              className={({ isActive }) => (isActive ? "app-nav__link is-active" : "app-nav__link")}
            >
              帮助
            </NavLink>
          </nav>

          <div className="app-header__actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={() => setTheme(nextTheme)}
              aria-label={nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题"}
              title={nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题"}
            >
              {theme === "dark" ? (
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="4.1" />
                  <path d="M12 2.7v2.1M12 19.2v2.1M2.7 12h2.1M19.2 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
                </svg>
              ) : (
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8Z" />
                </svg>
              )}
            </button>
            {user ? (
              <span className="app-header__user" title={`${user.username}（${ROLE_LABEL[user.role]}）`}>
                {user.username}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost app-header__logout"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
            >
              {loggingOut ? "退出中…" : "退出"}
            </button>

            {user ? (
              <div className="app-header__menu-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="btn btn--ghost app-header__menu"
                  aria-label="账号菜单"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <span className="app-header__avatar" aria-hidden="true">
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {menuOpen ? (
                  <div className="app-header__dropdown" role="menu">
                    <div className="app-header__dropdown-head">
                      <strong>{user.username}</strong>
                      <span>{ROLE_LABEL[user.role]}</span>
                    </div>
                    <Link to="/settings" role="menuitem" onClick={() => setMenuOpen(false)}>
                      设置
                    </Link>
                    <Link to="/help" role="menuitem" onClick={() => setMenuOpen(false)}>
                      帮助
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={loggingOut}
                      onClick={() => {
                        setMenuOpen(false);
                        void handleLogout();
                      }}
                    >
                      {loggingOut ? "退出中…" : "退出登录"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="app-main">
        {children ?? <Outlet />}
      </main>

      <footer className="app-footer">
        <span>NekoShelf · 默认只读源，扫描不会改动你的文件</span>
      </footer>
    </div>
  );
}
