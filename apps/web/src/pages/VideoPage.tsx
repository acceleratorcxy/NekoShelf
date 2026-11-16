/**
 * 视频播放页（/watch/:id）。
 *
 * - 直接走 `/api/works/:id/video` 的 Range 流（不转码，交给浏览器解码）；
 * - 支持缩放（1x/1.25x/1.5x/2x：用容器宽度放大，可横向拖动）与「适应宽度/原始尺寸」；
 * - 键盘：+/- 缩放，0 复位，f 适应，Esc 返回。
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, describeError, type WorkChapter, type WorkDetail } from "../api";
import { ErrorState, FullPageLoading } from "../components/States";

const ZOOM_STEPS = [1, 1.25, 1.5, 2] as const;

export function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [chapters, setChapters] = useState<WorkChapter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [chapter, setChapter] = useState(0);
  const [fit, setFit] = useState<"contain" | "none">("contain");

  useEffect(() => {
    if (!id) return;
    setError(null);
    api
      .getWork(id)
      .then((result) => {
        setWork(result.work);
        setChapters(result.chapters ?? []);
      })
      .catch((reason: unknown) => setError(describeError(reason)));
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") {
        setZoom((current) => ZOOM_STEPS.find((step) => step > current) ?? current);
      } else if (event.key === "-") {
        setZoom((current) => [...ZOOM_STEPS].reverse().find((step) => step < current) ?? current);
      } else if (event.key === "0") {
        setZoom(1);
        setFit("contain");
      } else if (event.key.toLowerCase() === "f") {
        setZoom(1);
        setFit((current) => (current === "contain" ? "none" : "contain"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return (
      <section className="page">
        <ErrorState message={error} />
        <Link className="btn" to="/">
          回到书库
        </Link>
      </section>
    );
  }
  if (!work || !id) return <FullPageLoading label="加载视频…" />;

  const src =
    chapters.length > 1
      ? `/api/works/${encodeURIComponent(id)}/video?chapter=${chapter}`
      : `/api/works/${encodeURIComponent(id)}/video`;
  return (
    <section className="video-page">
      <header className="video-page__bar">
        <Link className="btn btn--ghost" to={`/works/${encodeURIComponent(id)}`}>
          ← 返回作品
        </Link>
        <h1 className="video-page__title">{work.titleZh ?? work.title}</h1>
        <div className="video-page__zoom" role="group" aria-label="缩放">
          {ZOOM_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={zoom === step ? "segmented__item is-active" : "segmented__item"}
              onClick={() => setZoom(step)}
            >
              {step}×
            </button>
          ))}
          <button
            type="button"
            className={fit === "none" ? "segmented__item is-active" : "segmented__item"}
            onClick={() => {
              setFit((current) => (current === "contain" ? "none" : "contain"));
              setZoom(1);
            }}
          >
            {fit === "contain" ? "适应窗口" : "原始尺寸"}
          </button>
        </div>
      </header>
      <div className={zoom > 1 ? "video-stage is-zoomed" : "video-stage"}>
        <video
          className="video-player"
          src={src}
          controls
          autoPlay={false}
          preload="metadata"
          style={{ width: `${zoom * 100}%`, objectFit: fit }}
        />
      </div>
      {chapters.length > 1 ? (
        <nav className="chapter-grid chapter-grid--video" aria-label="剧集">
          {chapters.map((item) => (
            <button
              key={item.index}
              type="button"
              className={item.index === chapter ? "chapter-item is-active" : "chapter-item"}
              onClick={() => setChapter(item.index)}
            >
              <span className="chapter-item__title">{item.title}</span>
            </button>
          ))}
        </nav>
      ) : null}
      <p className="muted video-page__hint">
        快捷键：+ / - 缩放，0 复位，f 切换适应窗口；拖动底部进度条定位，右键可画中画/全屏。
      </p>
    </section>
  );
}
