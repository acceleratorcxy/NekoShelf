import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { AppShell } from "../components/AppShell";
import { FullPageLoading } from "../components/States";
import { HELP_SECTIONS } from "../content/help";

/** 帮助内容主体（登录/未登录共用）；支持 URL 锚点与章节过滤。 */
function HelpContent() {
  const location = useLocation();
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return HELP_SECTIONS;
    return HELP_SECTIONS.filter(
      (s) => s.title.toLowerCase().includes(kw) || s.summary.toLowerCase().includes(kw),
    );
  }, [keyword]);

  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    document.getElementById("help-top")?.scrollIntoView({ behavior: "auto", block: "start" });
  }, [location.hash]);

  return (
    <div id="help-top" className="help-page">
      <header className="help-hero">
        <div>
          <h1>帮助</h1>
          <p className="muted">NekoShelf 使用手册 · v0.5.0 · 应用内为权威版本</p>
        </div>
        <a className="btn btn--ghost" href="#faq">
          直接看常见问题
        </a>
      </header>

      <div className="help-layout">
        <aside className="help-toc" aria-label="目录">
          <input
            className="input help-toc__filter"
            type="search"
            placeholder="过滤章节…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="过滤章节"
          />
          <ol>
            {filtered.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  <span>{section.title}</span>
                  <small>{section.summary}</small>
                </a>
              </li>
            ))}
            {filtered.length === 0 && <li className="help-toc__empty">没有匹配的章节</li>}
          </ol>
        </aside>

        <main className="help-content">
          {filtered.map((section) => (
            <section key={section.id} id={section.id} className="help-section card">
              <h2>
                <a className="help-section__anchor" href={`#${section.id}`} aria-label="本页锚点">
                  #
                </a>
                {section.title}
              </h2>
              {section.body}
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}

/** 未登录时的轻量外壳：品牌 + 登录/初始化入口。 */
function PublicHelpLayout() {
  const { initialized } = useAuth();
  return (
    <div className="help-public">
      <header className="help-public__header">
        <Link to={initialized ? "/login" : "/setup"} className="brand" aria-label="NekoShelf 首页">
          <span className="brand__mark" aria-hidden="true">
            猫
          </span>
          <span className="brand__text">
            NekoShelf
            <span className="brand__sub">猫猫书架</span>
          </span>
        </Link>
        <div className="help-public__actions">
          <Link className="btn btn--ghost" to={initialized ? "/login" : "/setup"}>
            {initialized ? "登录" : "开始初始化"}
          </Link>
        </div>
      </header>
      <HelpContent />
      <footer className="app-footer">
        <span>NekoShelf · 默认只读源，扫描不会改动你的文件</span>
      </footer>
    </div>
  );
}

/**
 * 帮助页：已登录时嵌在 AppShell 里（带主导航），未登录时用公开轻量外壳，
 * 这样登录页 / 初始化向导都能直接链过来看文档。
 */
export function HelpPage() {
  const { status, user } = useAuth();
  if (status === "loading") return <FullPageLoading />;
  if (user) {
    return (
      <AppShell>
        <HelpContent />
      </AppShell>
    );
  }
  return <PublicHelpLayout />;
}
