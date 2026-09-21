import type { ReactNode } from 'react';

/**
 * 指标卡。解剖对齐 平台 的 summary-metric-card（vertical 布局）：
 *   图标块（28×28、圆角、语义色底）+ 13px 标签 / 下方为数值
 * 卡片本身是 rounded-lg + border + --color-bg-1。
 */
export default function MetricCard({
  label,
  value,
  icon,
  iconColor = 'var(--color-primary)',
  iconBackground = 'var(--color-primary-bg-active)',
  text = false,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  iconColor?: string;
  iconBackground?: string;
  /** 值本身是文本（例如时间）而不是数字时，用更小的字号。 */
  text?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="metric-head">
        {icon ? (
          <span className="metric-icon" style={{ background: iconBackground, color: iconColor }}>
            {icon}
          </span>
        ) : null}
        <span className="metric-label">{label}</span>
      </div>
      <div className={`metric-value${text ? ' is-text' : ''}`}>{value}</div>
    </div>
  );
}
