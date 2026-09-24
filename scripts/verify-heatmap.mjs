#!/usr/bin/env node
/**
 * 验证「按天趋势」贡献日历的几何与分档逻辑（`web/src/heatmap.ts`）。
 *
 * 为什么这些断言值得单独写：日历的错法是**"长得不对"**，不是抛异常 ——
 * 列错位一天、跨月标签重复、强度全塌成一档，代码读起来都没问题，
 * 而渲染结果没法靠读代码确认（见 AGENTS.md）。所以把纯逻辑抽成 .ts，在这里钉死。
 *
 * 星期基准来自外部工具（python3 datetime），不是用同一套公式再算一遍 ——
 * 否则断言只是在复述实现。
 *
 * 用法：node --experimental-strip-types --no-warnings scripts/verify-heatmap.mjs
 */
import {
  HEATMAP_GAP,
  HEATMAP_MAX_CELL,
  HEATMAP_MIN_CELL,
  HEATMAP_ROW_LABEL_WIDTH,
  buildHeatmap,
  buildMonthLabels,
  pickCellSize,
} from '../web/src/heatmap.ts';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** 构造 series 的形状：只给有事件的日期（服务端就是 GROUP BY day）。 */
const pts = (map) => Object.entries(map).map(([day, events]) => ({ day, events, pull: events, push: 0 }));

// ───────────────────── 一、窗口补齐 ─────────────────────
{
  const layout = buildHeatmap(pts({ '2026-09-20': 5, '2026-09-22': 3, '2026-09-24': 8 }), 30, '2026-09-24');
  check('30 天窗口补齐成 30 个格子（服务端只返回有事件的天）', layout.cells.length === 30, String(layout.cells.length));
  check('合计 = 有数据那几天之和', layout.total === 16, String(layout.total));
  check(
    '没有事件的日期是 0 次、第 0 档',
    layout.cells.filter((c) => c.events === 0).every((c) => c.level === 0)
  );
  const days = layout.cells.map((c) => c.day);
  check('窗口内每一天都出现且不重复', new Set(days).size === 30, String(new Set(days).size));
  check(
    '日期连续无空洞（跨月、跨年都不会断）',
    layout.cells.every((c, i) => {
      if (i === 0) return true;
      const prev = new Date(`${layout.cells[i - 1].day}T00:00:00Z`).getTime();
      return new Date(`${c.day}T00:00:00Z`).getTime() - prev === 86400000;
    })
  );
  check('末格就是"今天"', layout.cells[29].day === '2026-09-24', layout.cells[29].day);
}

// ───────────────────── 二、UTC 与周对齐（外部星期基准） ─────────────────────
{
  const layout = buildHeatmap([], 7, '2026-09-24');
  const at = (day) => layout.cells.find((c) => c.day === day);
  check('2026-09-24 是周四 → row=3', at('2026-09-24')?.row === 3, String(at('2026-09-24')?.row));
  check('2026-09-18 是周五 → row=4', at('2026-09-18')?.row === 4, String(at('2026-09-18')?.row));

  const jan = buildHeatmap([], 7, '2026-01-05');
  check(
    '2026-01-05 是周一 → row=0（周一起排）',
    jan.cells.find((c) => c.day === '2026-01-05')?.row === 0,
    String(jan.cells.find((c) => c.day === '2026-01-05')?.row)
  );
}

// ───────────────────── 三、列布局（一周一列） ─────────────────────
{
  const layout = buildHeatmap([], 7, '2026-09-24');
  check('7 天窗口跨了周界 → 2 列', layout.totalCols === 2, String(layout.totalCols));

  const col0 = layout.cells.filter((c) => c.col === 0);
  const col1 = layout.cells.filter((c) => c.col === 1);
  check(
    '第一列是周五~周日（3 格）、第二列是周一~周四（4 格）',
    col0.length === 3 && col1.length === 4,
    `${col0.length} / ${col1.length}`
  );

  const long = buildHeatmap([], 90, '2026-09-24');
  check(
    '同一列内行号严格递增',
    [...new Set(long.cells.map((c) => c.col))].every((col) => {
      const rows = long.cells.filter((c) => c.col === col).map((c) => c.row);
      return rows.every((r, i) => i === 0 || r > rows[i - 1]);
    })
  );
  check(
    '列号只增不减，且换列时一定落在周一（row=0）',
    long.cells.every((c, i) => {
      if (i === 0) return true;
      const prev = long.cells[i - 1];
      return c.col === prev.col ? true : c.col === prev.col + 1 && c.row === 0;
    })
  );
  check('90 天窗口的列数合理（13~14 列）', long.totalCols >= 13 && long.totalCols <= 14, String(long.totalCols));
}

// ───────────────────── 四、强度分档 ─────────────────────
{
  const zero = buildHeatmap(pts({ '2026-09-20': 0 }), 7, '2026-09-24');
  check('全部为 0 时不分档（不会除零、也不会全塌成 1）', zero.cells.every((c) => c.level === 0) && zero.max === 0);

  const one = buildHeatmap(pts({ '2026-09-20': 42 }), 7, '2026-09-24');
  check('只有一个非零值时它是峰值 → 第 4 档', one.cells.find((c) => c.day === '2026-09-20')?.level === 4);

  const spread = buildHeatmap(pts({ '2026-09-20': 100, '2026-09-21': 75, '2026-09-22': 50, '2026-09-23': 25, '2026-09-24': 1 }), 7, '2026-09-24');
  check('峰值是第 4 档', spread.cells.find((c) => c.events === 100)?.level === 4);
  check(
    '档位随事件数单调不减',
    [...spread.cells].sort((a, b) => a.events - b.events).every((c, i, arr) => i === 0 || c.level >= arr[i - 1].level),
    spread.cells.map((c) => `${c.events}:L${c.level}`).join(' ')
  );
  check(
    '四档都被用到（25% / 50% / 75% / 100% 各落一档）',
    new Set(spread.cells.map((c) => c.level)).size === 5,
    [...new Set(spread.cells.map((c) => c.level))].join(',')
  );

  /*
   * 回归：强度必须按**窗口内**的最大值归一化。
   * 若按传进来的全部 points 归一化，窗口外那个 9999 会把窗口内的所有格子压成第 1 档 ——
   * 日历变成一整片同色，而且看不出是数据问题。
   */
  const stray = buildHeatmap(pts({ '2026-09-20': 10, '2020-01-01': 9999 }), 7, '2026-09-24');
  check('窗口外的点不参与归一化（否则整片塌成第 1 档）', stray.max === 10, `max=${stray.max}`);
  check('窗口外的点不计入合计', stray.total === 10, String(stray.total));
  check('窗口内的峰值仍是第 4 档', stray.cells.find((c) => c.day === '2026-09-20')?.level === 4);
}

// ───────────────────── 五、月份标签 ─────────────────────
{
  const cross = buildHeatmap([], 10, '2026-01-03');
  check(
    '跨年窗口出现两个月份标签且顺序递增',
    cross.months.length === 2 &&
      cross.months[0].text === '12 月' &&
      cross.months[1].text === '1 月' &&
      cross.months[0].col < cross.months[1].col,
    JSON.stringify(cross.months)
  );
  check(
    '同一个月份只打一次标签（不会每列都写）',
    new Set(cross.months.map((m) => m.text)).size === cross.months.length
  );

  const single = buildHeatmap([], 7, '2026-09-24');
  check('7 天窗口只落在一个月内时只有一个标签', single.months.length === 1 && single.months[0].text === '9 月', JSON.stringify(single.months));

  const wide = buildHeatmap([], 90, '2026-09-24');
  check(
    '90 天窗口的月份标签数量合理（3~4 个）',
    wide.months.length >= 3 && wide.months.length <= 4,
    JSON.stringify(wide.months.map((m) => m.text))
  );
}

// ───────────────────── 六、边界 ─────────────────────
{
  const one = buildHeatmap([], 1, '2026-09-24');
  check('days=1 → 单格单列', one.cells.length === 1 && one.totalCols === 1);

  check('days=0 按 1 天处理（不抛、不产生空数组）', buildHeatmap([], 0, '2026-09-24').cells.length === 1);
  check('days=NaN 按 1 天处理', buildHeatmap([], Number.NaN, '2026-09-24').cells.length === 1);
  check('days 为负数按 1 天处理', buildHeatmap([], -5, '2026-09-24').cells.length === 1);

  const empty = buildHeatmap([], 30, '2026-09-24');
  check('没有数据时不抛，且合计为 0', empty.total === 0 && empty.max === 0 && empty.cells.length === 30);

  check(
    '容器宽度未知时按列数取经验值（列少放大、列多缩小）',
    pickCellSize(6) === 34 && pickCellSize(11) === 22 && pickCellSize(17) === 19 && pickCellSize(53) === 16,
    [6, 11, 17, 53].map((n) => `${n}→${pickCellSize(n)}`).join(' ')
  );

  /*
   * 关键：格宽要按**容器实际宽度**反算，日历才会像 GitHub 那样铺满。
   * 只按列数定固定值的话，53 列固定 16px 只有 1035px，在 1440 视口里右侧会空出四分之一。
   */
  {
    const cols = 53;
    const available = 1374;
    const cell = pickCellSize(cols, available);
    const gridWidth = HEATMAP_ROW_LABEL_WIDTH + cols * (cell + HEATMAP_GAP);
    check(
      '按容器宽度反算后日历正好铺满（剩余留白小于一个格子）',
      gridWidth <= available && available - gridWidth < cell + HEATMAP_GAP,
      `cell=${cell} 网格=${gridWidth} 容器=${available} 留白=${available - gridWidth}`
    );
    check(
      '容器越宽格子越大（宽度确实参与了计算）',
      pickCellSize(cols, 2000) > pickCellSize(cols, 1200),
      `1200→${pickCellSize(cols, 1200)} 2000→${pickCellSize(cols, 2000)}`
    );
  }

  check(
    '格宽被夹在上下限内（宽屏不会变成巨型方块、窄屏不会小到看不清）',
    pickCellSize(5, 1200) === HEATMAP_MAX_CELL && pickCellSize(53, 300) === HEATMAP_MIN_CELL,
    `5列/1200px→${pickCellSize(5, 1200)} 53列/300px→${pickCellSize(53, 300)}`
  );

  check(
    'buildMonthLabels 在空列上不抛（防御性）',
    Array.isArray(buildMonthLabels([], 3)) && buildMonthLabels([], 3).length === 0
  );
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
