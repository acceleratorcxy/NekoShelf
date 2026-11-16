import { percentOf } from "../format";

interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  className?: string;
}

export function ProgressBar({ value, max, label = "阅读进度", className }: ProgressBarProps) {
  const percent = percentOf(value, max);
  const classes = ["progress", className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="progress__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** 扫描任务进度：total 未知时显示为不确定态（条纹动画）。 */
export function IndeterminateBar({ label = "任务进度" }: { label?: string }) {
  return (
    <div className="progress progress--indeterminate" role="progressbar" aria-label={label}>
      <div className="progress__fill" />
    </div>
  );
}
