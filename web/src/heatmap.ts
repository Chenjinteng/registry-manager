/**
 * 贡献日历（GitHub 式热力图）的**纯几何与分档逻辑**。
 *
 * 单独放在 .ts 而不是写在组件里，是为了能在 Node 里直接断言 ——
 * 日期对齐、跨月标签、强度分档这几处错了只会表现为"日历长得不对"，
 * 而渲染结果没法靠读代码确认（见 AGENTS.md）。测试入口见 scripts/verify-heatmap.mjs。
 *
 * 日期一律按 **UTC** 计算，与服务端 `toISOString().slice(0,10)` 的口径一致；
 * 混用本地时区会让格子整体错位一天。
 */
import type { StatsSeriesPoint } from './types';

export interface HeatmapCell {
  /** YYYY-MM-DD（UTC） */
  day: string;
  events: number;
  /** 第几列（第几周） */
  col: number;
  /** 第几行：周一起排，0=周一 … 6=周日 */
  row: number;
  /** 强度 0–4；0 表示当天没有事件 */
  level: number;
}

export interface HeatmapLayout {
  cells: HeatmapCell[];
  totalCols: number;
  total: number;
  max: number;
  /** 月份标签：只在月份变化的那一列打一个，避免重复 */
  months: { col: number; text: string }[];
}

/** 单元格间距与坐标留白。渲染与"按宽度算格宽"共用同一份常量，避免两处漂移。 */
export const HEATMAP_GAP = 3;
export const HEATMAP_ROW_LABEL_WIDTH = 28;
export const HEATMAP_TOP_LABEL_HEIGHT = 18;

/** 格子边长的上下限：太小看不清，太大就失去"日历"的密度感。 */
export const HEATMAP_MIN_CELL = 9;
export const HEATMAP_MAX_CELL = 34;

/**
 * 格宽：**按容器实际宽度反算**，让日历像 GitHub 那样铺满一整行。
 *
 * 为什么不能只按列数定一个固定值：日历的宽度 = 列数 × 格宽，而卡片宽度随视口变。
 * 固定 16px 时 53 列只有 1035px，在 1440 视口（可用约 1370px）里右侧会留下四分之一空白，
 * 在 1920 视口里留得更多 —— 看起来就是"一小块缩在左边"。
 *
 * @param availableWidth 容器内容宽度（px）。不知道时传 0，退化成按列数的经验值。
 */
export function pickCellSize(totalCols: number, availableWidth = 0) {
  if (totalCols <= 0) {
    return HEATMAP_MIN_CELL;
  }
  // 容器宽度未知时的经验值（首帧、或在测试里直接调用）。
  const fallback =
    totalCols <= 6 ? 34 : totalCols <= 10 ? 28 : totalCols <= 16 ? 22 : totalCols <= 30 ? 19 : 16;
  if (!availableWidth) {
    return Math.max(HEATMAP_MIN_CELL, Math.min(HEATMAP_MAX_CELL, fallback));
  }
  // 每个格子占 (cell + gap)，总宽 = 行标签 + 列数 × (cell + gap)，反解出 cell。
  const fitted = Math.floor((availableWidth - HEATMAP_ROW_LABEL_WIDTH) / totalCols) - HEATMAP_GAP;
  return Math.max(HEATMAP_MIN_CELL, Math.min(HEATMAP_MAX_CELL, fitted));
}

/**
 * 把"只有有事件的日期"的序列，补成窗口内**每一天**都有的日历格子。
 *
 * 服务端的 `/api/stats/series` 是 `GROUP BY day`，没有事件的日期根本不在返回里。
 * 不补齐的话日历会出现空洞、后续列也会整体错位。
 *
 * @param today 用于测试注入；默认取当前 UTC 日期
 */
export function buildHeatmap(
  points: StatsSeriesPoint[],
  days: number,
  today: string = new Date().toISOString().slice(0, 10)
): HeatmapLayout {
  const safeDays = Math.max(1, Math.floor(days) || 1);
  const byDay = new Map(points.map((p) => [p.day, p.events]));

  // 最后一格是"今天"，往前推 safeDays-1 天。
  const end = new Date(`${today}T00:00:00Z`);
  const cells: HeatmapCell[] = [];
  let firstRow = 0;
  let lastCol = 0;

  for (let i = 0; i < safeDays; i += 1) {
    const date = new Date(end.getTime() - (safeDays - 1 - i) * 86400000);
    const day = date.toISOString().slice(0, 10);
    // 周一起排：(getUTCDay()+6)%7 把 周日=0 映射成 6，周一=1 映射成 0。
    const row = (date.getUTCDay() + 6) % 7;
    if (i === 0) {
      firstRow = row;
    }
    // 首行不是周一时，第一列的前几格留空，所以起始要加 firstRow 个偏移。
    const col = Math.floor((i + firstRow) / 7);
    lastCol = col;
    cells.push({ day, events: byDay.get(day) ?? 0, col, row, level: 0 });
  }

  /*
   * 强度按**窗口内**的最大值归一化，而不是按传进来的全部 points。
   * 两者通常一致（服务端已按 days 过滤），但一旦有窗口外的点混进来
   * （例如切换时间窗时数据还没刷新），按全局 max 归一化会把所有档位压成第 1 档 ——
   * 日历会变成一整片同色，且看不出是数据问题。
   */
  const max = cells.reduce((m, c) => Math.max(m, c.events), 0);
  const total = cells.reduce((sum, c) => sum + c.events, 0);
  for (const cell of cells) {
    if (cell.events > 0 && max > 0) {
      // 四档强度，保证峰值必是第 4 档；max=0 时不进这个分支，避免除零。
      const q = cell.events / max;
      cell.level = q <= 0.25 ? 1 : q <= 0.5 ? 2 : q <= 0.75 ? 3 : 4;
    }
  }

  return { cells, totalCols: lastCol + 1, total, max, months: buildMonthLabels(cells, lastCol + 1) };
}

/**
 * 月份标签：**只在包含"某月 1 号"的那一列打标签**，另外第一列总是打上它所在月份。
 *
 * 不能按"每列的第一天"判断 —— 月份切换经常发生在**一列内部**
 * （例如 2025-12-29 ~ 2026-01-03 同属一列，那列的第一天还是 12 月），
 * 那样 1 月会被整月跳过，日历上直接少一个月份刻度。
 */
export function buildMonthLabels(cells: HeatmapCell[], totalCols: number) {
  const labels: { col: number; text: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < totalCols; col += 1) {
    const inCol = cells.filter((c) => c.col === col);
    if (inCol.length === 0) {
      continue;
    }
    const firstOfMonth = inCol.find((c) => c.day.slice(8, 10) === '01');
    const month = Number((firstOfMonth ?? inCol[0]).day.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      lastMonth = month;
      labels.push({ col, text: `${month + 1} 月` });
    }
  }
  return labels;
}
