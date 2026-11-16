import type { ReactNode } from "react";

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function FullPageLoading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="full-page-loading" role="status" aria-live="polite">
      <Spinner />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  title = "出错了",
  message,
  onRetry,
  children,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title}</h2>
      <p className="state__message">{message}</p>
      <div className="state__actions">
        {onRetry ? (
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            重试
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="state state--empty">
      <div className="state__glyph" aria-hidden="true">
        📚
      </div>
      <h2 className="state__title">{title}</h2>
      {description ? <p className="state__message">{description}</p> : null}
      {children ? <div className="state__actions">{children}</div> : null}
    </div>
  );
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="work-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="work-card work-card--skeleton" key={`skeleton-${index}`}>
          <div className="skeleton skeleton--cover" />
          <div className="work-card__body">
            <div className="skeleton skeleton--line skeleton--w80" />
            <div className="skeleton skeleton--line skeleton--w50" />
          </div>
        </div>
      ))}
    </div>
  );
}
