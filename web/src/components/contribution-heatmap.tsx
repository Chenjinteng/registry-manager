import { useEffect, useRef, useState } from 'react';

import type { StatsSeriesPoint } from '../types';
import {
  HEATMAP_GAP,
  HEATMAP_ROW_LABEL_WIDTH,
  HEATMAP_TOP_LABEL_HEIGHT,
  buildHeatmap,
  pickCellSize,
} from '../heatmap';

/**
 * 按天趋势：**GitHub 贡献日历式**的方格热力图。
 *
 * 为什么不用折线：折线擅长看"量级涨跌"，看不出"节奏"。对镜像热度真正有用的判断是
 * "哪些天 / 星期几在用"（周内高峰、周末低谷、某次发布后的长尾），
 * 这类密度与周期问题用日历格子一眼能看出来，折线看不出来。
 *
 * 实现上仍然**不引任何图表库**：一周一列、七天一行，位置由日期算出来，
 * 颜色走 app.css 的语义 token。几何与分档逻辑在 `web/src/heatmap.ts`（可单独断言）。
 *
 * **铺满宽度**：格宽由容器的实际宽度反算（见 pickCellSize），所以 12 个月 ≈ 53 列
 * 会像 GitHub 那样占满一整行，而不是缩在左边一小块。
 */
/** 没有事件的日期也画格子（灰色）—— 和 GitHub 一样，"空"本身也是信息。 */
const ROW_LABELS: Record<number, string> = { 0: '一', 2: '三', 4: '五' };

export default function ContributionHeatmap({
  points,
  days,
  retentionDays = null,
}: {
  points: StatsSeriesPoint[];
  /** 日历跨度（天）。**不由时间窗 Segmented 决定**，见 stats-page 的 HEATMAP_DAYS。 */
  days: number;
  /** 热度数据的保留天数；比跨度短时要说明"更早的灰色不是没有活动"。 */
  retentionDays?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  // 量容器宽度：卡片宽度随视口变，格宽必须跟着变才能铺满。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    setAvailableWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) {
        setAvailableWidth(width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const safeDays = Math.max(1, Math.floor(days) || 1);
  const { cells, totalCols, total, months } = buildHeatmap(points, safeDays);
  const cell = pickCellSize(totalCols, availableWidth);
  const pitch = cell + HEATMAP_GAP;
  const width = HEATMAP_ROW_LABEL_WIDTH + totalCols * pitch;
  const height = HEATMAP_TOP_LABEL_HEIGHT + 7 * pitch;
  const axisY = (row: number) => HEATMAP_TOP_LABEL_HEIGHT + row * pitch + cell / 2 + 4;
  const period = safeDays >= 360 ? '近 12 个月' : `近 ${safeDays} 天`;
  // 保留期比跨度短时，更早的格子必然是灰的 —— 必须说清那不是"没有活动"。
  const retentionNote =
    retentionDays && retentionDays < safeDays
      ? `热度数据只保留 ${retentionDays} 天，更早的灰色是已过期，不代表没有活动`
      : null;

  return (
    <div className="heatmap" ref={wrapRef}>
      <div className="heatmap-caption">
        <span>
          {period}共 <strong>{total}</strong> 次
        </span>
        {total === 0 ? <span className="heatmap-hint">这段时间内还没有收到事件</span> : null}
        {retentionNote ? <span className="heatmap-hint">{retentionNote}</span> : null}
      </div>

      {/* 宽度由格宽 × 列数算出来（已按容器反算，因此正好铺满）；
          窄屏兜一层 max-width。方格必须保持正方形，所以只等比缩放、不拉伸。 */}
      <svg
        className="heatmap-grid"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${period}的事件热度日历，共 ${total} 次`}
      >
        {months.map((label) => (
          <text
            key={`${label.col}-${label.text}`}
            className="heatmap-axis"
            x={HEATMAP_ROW_LABEL_WIDTH + label.col * pitch}
            y={HEATMAP_TOP_LABEL_HEIGHT - 6}
          >
            {label.text}
          </text>
        ))}

        {Object.entries(ROW_LABELS).map(([row, text]) => (
          <text
            key={text}
            className="heatmap-axis"
            x={HEATMAP_ROW_LABEL_WIDTH - 6}
            y={axisY(Number(row))}
            textAnchor="end"
          >
            {text}
          </text>
        ))}

        {cells.map((c) => (
          <rect
            key={c.day}
            className={`heatmap-cell heatmap-cell--l${c.level}`}
            x={HEATMAP_ROW_LABEL_WIDTH + c.col * pitch}
            y={HEATMAP_TOP_LABEL_HEIGHT + c.row * pitch}
            width={cell}
            height={cell}
            rx={2}
          >
            <title>{`${c.day}：${c.events} 次`}</title>
          </rect>
        ))}
      </svg>

      <div className="heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className={`heatmap-swatch heatmap-cell--l${level}`}
            style={{ width: cell, height: cell }}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
