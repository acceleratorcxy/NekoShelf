import { useEffect, useState } from "react";

interface CoverProps {
  src: string;
  alt: string;
  className?: string;
  /** 详情页首屏封面用 eager，列表里保持懒加载。 */
  eager?: boolean;
}

/**
 * 封面图：加载失败或没有 404 时退化为占位色块，
 * 避免满屏破图标。
 */
export function Cover({ src, alt, className, eager = false }: CoverProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const classes = ["cover", className].filter(Boolean).join(" ");

  if (failed || src.trim() === "") {
    const initial = alt.trim().slice(0, 1) || "书";
    return (
      <div className={`${classes} cover--placeholder`} role="img" aria-label={`${alt}（暂无封面）`}>
        <span aria-hidden="true">{initial}</span>
      </div>
    );
  }

  return (
    <img
      className={classes}
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
