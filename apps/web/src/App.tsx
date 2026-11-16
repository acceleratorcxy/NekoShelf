import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { AppShell } from "./components/AppShell";
import { DuplicatesPage } from "./pages/DuplicatesPage";
import { HelpPage } from "./pages/HelpPage";
import { JobsPage } from "./pages/JobsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { ReaderPage } from "./pages/ReaderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { WorkPage } from "./pages/WorkPage";
import {
  AuthorPage,
  AuthorsPage,
  SeriesListPage,
  SeriesPage,
  TreePage,
} from "./pages/BrowsePages";
import { VideoPage } from "./pages/VideoPage";
import { applyTheme, readStoredTheme } from "./theme";

function NotFoundPage() {
  const location = useLocation();
  return (
    <section className="notfound">
      <p className="notfound__code">404</p>
      <h1>这里没有书</h1>
      <p className="muted">
        页面 <code>{location.pathname}</code> 不存在，可能链接过期或输入有误。
      </p>
      <Link className="btn btn--primary" to="/">
        回到书库
      </Link>
    </section>
  );
}

export function App() {
  // 恢复主题偏好；AppShell 内部还会在切换时更新 data-theme
  useEffect(() => {
    applyTheme(readStoredTheme());
  }, []);

  return (
    <AuthProvider>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* 帮助页对未登录用户也可访问（登录页/初始化向导里会链到） */}
        <Route path="/help" element={<HelpPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<LibraryPage />} />
          <Route path="works/:id" element={<WorkPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="duplicates" element={<DuplicatesPage />} />
          <Route path="authors" element={<AuthorsPage />} />
          <Route path="authors/:id" element={<AuthorPage />} />
          <Route path="series" element={<SeriesListPage />} />
          <Route path="series/:id" element={<SeriesPage />} />
          <Route path="tree" element={<TreePage />} />
          <Route path="watch/:id" element={<VideoPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* 阅读器全屏独立布局，不套 AppShell */}
        <Route
          path="reader/:id"
          element={
            <RequireAuth>
              <ReaderPage />
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
