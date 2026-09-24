#!/usr/bin/env node
/**
 * 用**真实浏览器**验证布局：滚动是否只发生在表格内部。
 *
 * 为什么需要它：`AGENTS.md` 里那条"渲染结果无法靠读代码确认"不是理论 ——
 * 这个脚本第一次跑就抓到两个读代码看不出来的问题：
 *   1. 表格改成内部滚动后，AntD 的分页器被卷进滚动区，要滚到底才能翻页；
 *   2. 30 天窗口的日历只有 5 列，缩成一条 133px 的细缝。
 * 两者都不会让 type-check 或 build 失败。
 *
 * 它**刻意不进 `pnpm verify`**：需要先起开发态服务，还要一个本地 Chrome，
 * 在无桌面环境里跑不起来。定位是"改了布局时手动跑一次"。
 *
 * 前置：
 *   pnpm dev                      # 另开一个终端，前端在 http://localhost:5273
 *   node scripts/verify-layout.mjs
 *
 * 找不到 Chrome 时会**跳过**（退出码 0），不会把 CI 弄挂。
 * 用 CHROME_PATH 环境变量可以指定浏览器路径。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 注意用 localhost 而不是 127.0.0.1：Vite 在 macOS 上只绑 IPv6 的 [::1]。 */
const APP = process.env.APP_URL || 'http://localhost:5273/';
const PORT = 9000 + Math.floor(Math.random() * 900);
const SHOT_DIR = process.env.SHOT_DIR || tmpdir();

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.log('⏭  未找到 Chrome/Chromium，跳过布局验证（设置 CHROME_PATH 可指定）。');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const skip = (label, why) => console.log(`⏭  ${label} — ${why}`);

// ───────────────────── 起浏览器 ─────────────────────
const profile = mkdtempSync(join(tmpdir(), 'rm-layout-chrome-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    // Chrome 自带的沙箱在部分受限环境（CI、容器、seatbelt）里起不来，
    // 表现为 "sandbox initialization failed" 后整个进程被 SIGTRAP。
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    // ignore
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // ignore
  }
};

/** CDP 端口有时绑 127.0.0.1、有时绑 ::1，两个都试。 */
const resolveCdpHost = async () => {
  for (let i = 0; i < 60; i += 1) {
    for (const host of ['127.0.0.1', '[::1]']) {
      try {
        const r = await fetch(`http://${host}:${PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return host;
      } catch {
        // 继续试
      }
    }
    await sleep(250);
  }
  return null;
};

const cdpHost = await resolveCdpHost();
if (!cdpHost) {
  cleanup();
  console.log(`⏭  浏览器没有在 ${PORT} 上暴露调试端口，跳过布局验证。`);
  process.exit(0);
}

const targets = await (await fetch(`http://${cdpHost}:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  // awaitPromise：页面里要跑 fetch(...) 这类异步表达式时，不设它拿回来的是个 Promise 对象。
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  return false;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(SHOT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};
/** 在元素中心派发**真实滚轮**，让浏览器自己决定哪个容器滚 —— 直接改 scrollTop 证明不了这一点。 */
const wheelOver = async (selector, deltaY) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(120, r.height / 2)) };
  })()`);
  if (!box) throw new Error(`找不到元素 ${selector}`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY,
    pointerType: 'mouse',
  });
  await sleep(600);
};

const listSnapshot = () =>
  evaluate(`(() => {
    const content = document.querySelector('.app-content');
    const search = document.querySelector('input[placeholder="搜索仓库名"]');
    const scroller = document.querySelector('.table-scroll');
    const thead = document.querySelector('.ant-table-thead');
    const pag = document.querySelector('.ant-table-pagination');
    const box = pag ? pag.getBoundingClientRect() : null;
    return {
      contentScrollTop: content ? Math.round(content.scrollTop) : null,
      searchTop: search ? Math.round(search.getBoundingClientRect().top) : null,
      tableScrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      tableScrollHeight: scroller ? scroller.scrollHeight : null,
      tableClientHeight: scroller ? scroller.clientHeight : null,
      theadTop: thead ? Math.round(thead.getBoundingClientRect().top) : null,
      pagTop: box ? Math.round(box.top) : null,
      pagVisible: box ? box.top >= 0 && box.bottom <= window.innerHeight : null,
      viewportHeight: window.innerHeight,
    };
  })()`);

const heatSnapshot = () =>
  evaluate(`(() => {
    const rects = [...document.querySelectorAll('.heatmap-grid rect')];
    const levels = {};
    for (const r of rects) {
      const m = /heatmap-cell--l(\\d)/.exec(r.getAttribute('class') || '');
      if (m) levels[m[1]] = (levels[m[1]] || 0) + 1;
    }
    const grid = document.querySelector('.heatmap-grid');
    const wrap = document.querySelector('.heatmap');
    return {
      cells: rects.length,
      levels,
      cellSize: rects[0] ? Math.round(Number(rects[0].getAttribute('width'))) : null,
      gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : null,
      containerWidth: wrap ? Math.round(wrap.clientWidth) : 0,
      caption: document.querySelector('.heatmap-caption')?.textContent ?? '',
    };
  })()`);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });

  if (!(await waitFor('!!document.querySelector(".ant-table-row")', '镜像列表出现数据行', 12000))) {
    skip('布局验证', `打不开 ${APP}（先确认 pnpm dev 在跑，且用 localhost 而不是 127.0.0.1）`);
    ws.close();
    cleanup();
    process.exit(0);
  }
  await sleep(900);

  console.log('\n──── 镜像列表 ────');
  const before = await listSnapshot();
  console.log('  ', JSON.stringify(before));
  console.log('   截图:', await shot('layout-images-top'));
  check(
    '表格被限制高度（可滚动区大于可视区），而不是随内容无限变高',
    before.tableScrollHeight > before.tableClientHeight + 50,
    `${before.tableScrollHeight} > ${before.tableClientHeight}`
  );
  check(
    '分页器无需滚动即可见（否则翻页要滚到底）',
    before.pagVisible === true,
    `pagTop=${before.pagTop} vh=${before.viewportHeight}`
  );

  await wheelOver('.table-scroll', 700);
  const after = await listSnapshot();
  console.log('  ', JSON.stringify(after));
  console.log('   截图:', await shot('layout-images-scrolled'));
  check('在表格上滚轮后页面本身没有滚动', after.contentScrollTop === 0, `contentScrollTop=${after.contentScrollTop}`);
  check('搜索框位置纹丝不动', after.searchTop === before.searchTop, `${before.searchTop} → ${after.searchTop}`);
  check('滚的是表格自身', after.tableScrollTop > before.tableScrollTop, `${before.tableScrollTop} → ${after.tableScrollTop}`);
  check('表头粘住', Math.abs(after.theadTop - before.theadTop) < 2, `${before.theadTop} → ${after.theadTop}`);
  check('滚到底后分页器仍可见', after.pagVisible === true, `pagTop=${after.pagTop}`);

  console.log('\n──── 镜像热度 ────');
  await evaluate(
    `[...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent.includes('镜像热度'))?.click()`
  );
  if (await waitFor('!!document.querySelector(".heatmap-grid")', '热度页渲染', 12000)) {
    await sleep(700);
    const h365 = await heatSnapshot();
    console.log('  ', JSON.stringify(h365));
    check('日历固定渲染 365 天（近 12 个月）', h365.cells === 365, String(h365.cells));
    check('四档强度都用到，不是一整片同色', Object.keys(h365.levels).length >= 4, JSON.stringify(h365.levels));
    /*
     * 真实反馈：30 天窗口只有 5 列，不论格子多大都缩在卡片左边，右侧一大片空白。
     * 修法是"按容器宽度反算格宽 + 固定 12 个月跨度"，所以这里断言网格**铺满**容器。
     */
    check(
      '日历铺满容器宽度，而不是缩在左边一小块',
      h365.gridWidth !== null &&
        h365.containerWidth > 0 &&
        h365.containerWidth - h365.gridWidth < h365.cellSize + 6,
      `网格=${h365.gridWidth} 容器=${h365.containerWidth} 留白=${h365.containerWidth - h365.gridWidth} cell=${h365.cellSize}`
    );
    check(
      '保留期短于跨度时，caption 说明更早的灰色不是"没有活动"',
      h365.caption.includes('保留') || h365.caption.includes('12 个月'),
      h365.caption.slice(0, 60)
    );
    console.log('   截图:', await shot('layout-stats-heatmap'));

    // 日历是固定跨度：切时间窗不该改变它（KPI 与榜单才跟时间窗走）。
    await evaluate(
      `[...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent.trim() === '90 天')?.click()`
    );
    await sleep(1600);
    const hAfter = await heatSnapshot();
    check(
      '切换时间窗不影响日历（它是固定跨度，避免 30 天只有 5 列缩成一小块）',
      hAfter.cells === 365,
      `切换后 ${hAfter.cells} 格`
    );

    await evaluate(
      `[...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent.trim() === '30 天')?.click()`
    );
    await sleep(1200);

    await evaluate('document.querySelector(".app-content").scrollTop = 0');
    await sleep(300);
    await wheelOver('.table-scroll', 400);
    const scrolled = await evaluate(`(() => {
      const c = document.querySelector('.app-content');
      const s = document.querySelector('.table-scroll');
      return { content: Math.round(c.scrollTop), table: Math.round(s.scrollTop) };
    })()`);
    check(
      '在榜单上滚轮时滚的是榜单而不是整页',
      scrolled.content === 0 && scrolled.table > 0,
      JSON.stringify(scrolled)
    );

    /*
     * 回归：反复切换「按仓库 / 按 tag」，表格必须整体重建。
     *
     * 真实缺陷：rowKey 写成 `topBy === 'tag' ? repo:tag : repo`，切换维度时同一个 record 的
     * key 变了 → React 协调失败 → **旧行留在 DOM 里**。表现是分页器说"共 8 项"而 DOM 有 16 行、
     * `data-row-key` 重复、单元格数从 6 变成 5，界面上就是"Tag 列错位/空白"，
     * 而且每切换一次就多留一批（17→25→33…）。
     */
    const toggleBy = (label) =>
      evaluate(`[...document.querySelectorAll('.stats-panel-title')]
        .find((h) => h.textContent.includes('Top'))
        ?.closest('.panel')
        .querySelectorAll('.ant-segmented-item')
        .forEach((el) => { if (el.textContent.trim() === ${JSON.stringify(label)}) el.click(); })`);

    const tableSnapshot = () =>
      evaluate(`(() => {
        const wrap = [...document.querySelectorAll('.stats-panel-title')]
          .find((h) => h.textContent.includes('Top'))?.closest('.panel');
        const rows = [...wrap.querySelectorAll('tr.ant-table-row')];
        const keys = rows.map((r) => r.getAttribute('data-row-key'));
        return {
          domRows: rows.length,
          dataRows: Number((wrap.querySelector('.ant-pagination-total-text')?.innerText || '').replace(/\\D/g, '')) || 0,
          duplicateKeys: keys.length - new Set(keys).size,
          headerCells: wrap.querySelectorAll('thead th').length,
          bodyCellCounts: [...new Set(rows.map((r) => r.querySelectorAll('td').length))],
        };
      })()`);

    const badRounds = [];
    for (let round = 0; round < 3; round += 1) {
      for (const label of ['按 tag', '按仓库']) {
        await toggleBy(label);
        await sleep(1400);
        const snap = await tableSnapshot();
        const consistent =
          snap.domRows === snap.dataRows &&
          snap.duplicateKeys === 0 &&
          snap.bodyCellCounts.length === 1 &&
          snap.bodyCellCounts[0] === snap.headerCells;
        if (!consistent) {
          badRounds.push({ round: round + 1, label, ...snap });
        }
      }
    }
    check(
      '反复切换「按仓库 / 按 tag」不残留旧行（行数=分页总数、无重复 rowKey、单元格数与表头一致）',
      badRounds.length === 0,
      badRounds.length ? JSON.stringify(badRounds[0]) : '6 次切换全部一致'
    );

    /*
     * 「最近事件」面板的「客户端」列。
     *
     * 存在的理由：registry 上常驻的同步工具会按点扫全量、把每个 tag 的热度刷成同一个数，
     * 而 registry 侧的 notifications 只有 ignore.mediatypes / ignore.actions 两个口子，
     * 排不掉它。能不能把机器和真人分开，全看这一列。
     *
     * 注意这个面板是 **Collapse 且默认折叠** 的 —— 不先展开，`thead` 根本不在 DOM 里
     * （会得到一个"看起来像通过"的空结果）。
     */
    const eventPanel = () =>
      evaluate(`(() => {
        const header = [...document.querySelectorAll('.ant-collapse-header')]
          .find((h) => h.innerText.includes('最近事件'));
        if (!header) return null;
        const item = header.closest('.ant-collapse-item');
        const headers = [...item.querySelectorAll('thead th')].map((th) => th.innerText.trim());
        const idx = headers.indexOf('客户端');
        const cells = idx < 0
          ? []
          : [...item.querySelectorAll('tbody tr')].map((tr) => tr.children[idx]?.innerText.trim() ?? '');
        return {
          headers,
          idx,
          cells,
          expanded: item.className.includes('ant-collapse-item-active'),
        };
      })()`);

    let panel = await eventPanel();
    if (panel && !panel.expanded) {
      await evaluate(
        `[...document.querySelectorAll('.ant-collapse-header')].find((h) => h.innerText.includes('最近事件'))?.click()`
      );
      await sleep(900);
      panel = await eventPanel();
    }
    check(
      '「最近事件」面板能展开（客户端身份就藏在它里面）',
      panel !== null && panel.expanded === true,
      JSON.stringify({ found: panel !== null, expanded: panel?.expanded })
    );
    check(
      '「最近事件」面板有「客户端」列（排查是谁在打）',
      Boolean(panel?.idx >= 0),
      JSON.stringify(panel?.headers)
    );
    check(
      '有事件时「客户端」列真的显示了 User-Agent（不是一整列空）',
      !panel?.cells?.length || panel.cells.some((cell) => cell.length > 0),
      JSON.stringify(panel?.cells?.slice(0, 4))
    );
    // 截图前先把它滚进视野：这个面板在页面最底部，不滚的话截到的是 Top 榜单。
    await evaluate(
      `[...document.querySelectorAll('.ant-collapse-header')].find((h) => h.innerText.includes('最近事件'))?.scrollIntoView({ block: 'center' })`
    );
    await sleep(400);
    console.log('   截图:', await shot('layout-stats-events'));
  } else {
    skip('热度页布局', '热度页没渲染出来（可能未启用热度统计）');
  }

  /*
   * ───────────────────── 深色主题 ─────────────────────
   *
   * 深色主题的典型翻车方式读代码看不出来：自定义 CSS 用的 `--color-*` 变深了，
   * 而 AntD 的表格 / 分页器 / 下拉还是浅色 —— 同一屏里两套配色（"半深色"）。
   * 静态检查（scripts/verify-theme.mjs）只能证明两套 token 一一对应，
   * 证明不了**浏览器算出来的最终颜色**是对的，所以这里真点一下按钮、真读一遍 computed style。
   */
  console.log('\n──── 深色主题 ────');

  /** 同时取多个"面"的背景色：AntD 的面和自绘的面都要看。 */
  const SURFACES = [
    'body',
    '.app-header',
    '.panel',
    '.ant-table',
    '.ant-table-thead th',
    '.ant-pagination',
    '.ant-segmented',
    '.ant-tag',
  ];
  const themeSnapshot = () =>
    evaluate(`(() => {
      const surfaces = {};
      for (const sel of ${JSON.stringify(SURFACES)}) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        surfaces[sel] = cs.backgroundColor;
      }
      return {
        theme: document.documentElement.dataset.theme ?? null,
        stored: localStorage.getItem('registry-manager-theme'),
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        surfaces,
        hasToggle: !!document.querySelector('.app-theme-toggle'),
      };
    })()`);

  /** 相对亮度 0~1；只看 rgb，忽略 alpha（调用方自己处理透明）。 */
  const luminance = (css) => {
    const nums = (css.match(/[\d.]+/g) || []).map(Number);
    const [r, g, b] = nums;
    if (r === undefined) return null;
    if (nums.length === 4 && nums[3] === 0) return null; // 完全透明：这个面没有自己的底色
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const opaqueDark = (css) => {
    const l = luminance(css);
    return l === null ? null : l < 0.35;
  };

  const lightSnap = await themeSnapshot();
  console.log('   浅色:', JSON.stringify(lightSnap.surfaces));
  check('顶栏有主题切换按钮', lightSnap.hasToggle === true);
  /*
   * 存在 ≠ 看得见。顶栏是右对齐的 flex，meta 区一旦被 URL 撑满，
   * 按钮会被挤出视口 —— DOM 查询照样能查到，但用户点不到。
   */
  const toggleBox = await evaluate(`(() => {
    const el = document.querySelector('.app-theme-toggle');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth,
    };
  })()`);
  check(
    '切换按钮真的可见（没被 URL 挤出顶栏）',
    Boolean(toggleBox) &&
      toggleBox.w > 0 &&
      toggleBox.h > 0 &&
      toggleBox.left >= 0 &&
      toggleBox.right <= toggleBox.vw,
    JSON.stringify(toggleBox)
  );
  check('初始是浅色（未设置过选择时）', lightSnap.theme === 'light', String(lightSnap.theme));
  check('浅色下 color-scheme 是 light（原生滚动条跟随）', lightSnap.colorScheme.includes('light'));

  await evaluate('document.querySelector(".app-theme-toggle").click()');
  await sleep(700);
  const darkSnap = await themeSnapshot();
  console.log('   深色:', JSON.stringify(darkSnap.surfaces));

  check('点一下按钮就切到深色', darkSnap.theme === 'dark', String(darkSnap.theme));
  check('选择被记进 localStorage', darkSnap.stored === 'dark', String(darkSnap.stored));
  check('深色下 color-scheme 是 dark', darkSnap.colorScheme.includes('dark'));
  check(
    'body 背景真的变暗了',
    (luminance(darkSnap.bodyBg) ?? 1) < 0.25 && (luminance(lightSnap.bodyBg) ?? 0) > 0.25,
    `${lightSnap.bodyBg} → ${darkSnap.bodyBg}`
  );
  check(
    '文字色跟着变亮（深底上必须是浅字）',
    (luminance(darkSnap.bodyColor) ?? 0) > 0.5,
    darkSnap.bodyColor
  );

  /*
   * 这一条是本节的重点：**每一个面**都得是深色。
   * 只要 AntD 的某一层没跟上（例如分页器、表头），这里就会抓到。
   */
  const lightSurfacesInDark = Object.entries(darkSnap.surfaces).filter(([, bg]) => opaqueDark(bg) === false);
  check(
    '自定义 CSS 与 AntD 一起变深，没有"半深色"的面',
    lightSurfacesInDark.length === 0,
    lightSurfacesInDark.length ? lightSurfacesInDark.map(([s, bg]) => `${s}=${bg}`).join(', ') : `${Object.keys(darkSnap.surfaces).length} 个面全部为深色`
  );
  const darkCount = Object.values(darkSnap.surfaces).filter((bg) => opaqueDark(bg) === true).length;
  check('确实取到了足够多的面（不是选择器全落空）', darkCount >= 5, `${darkCount} 个深色面`);

  console.log('   截图:', await shot('layout-dark-stats'));

  // 镜像列表页也看一眼：表格 + 分页器是 AntD 面最多的一页。
  await evaluate(
    `[...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent.includes('镜像列表'))?.click()`
  );
  await sleep(1200);
  const darkList = await themeSnapshot();
  check(
    '镜像列表页同样没有浅色残留',
    Object.entries(darkList.surfaces).every(([, bg]) => opaqueDark(bg) !== false),
    Object.entries(darkList.surfaces).filter(([, bg]) => opaqueDark(bg) === false).map(([s, bg]) => `${s}=${bg}`).join(', ')
  );
  console.log('   截图:', await shot('layout-dark-images'));

  /*
   * 刷新后不闪白：`data-theme` 必须在 React 渲染出任何 DOM **之前**就设好。
   * 用首屏注入的 MutationObserver 抓住第一次设置属性时的现场：
   * 那时 `#root` 还不存在（-1）或还是空的（0），就说明主题先于 React 生效。
   * 若主题交给 React 的 useEffect 去设，这里会看到 rootChildren > 0 —— 那一帧就是白屏。
   */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__themeTrace = [];
      /*
       * 观察 document 而不是 documentElement：document-start 阶段 <html> 可能还没建出来，
       * 观察 null 会直接抛错，于是"一个记录都没有" —— 那看起来和"没闪"一模一样。
       */
      new MutationObserver(() => {
        window.__themeTrace.push({
          theme: document.documentElement.dataset.theme ?? null,
          rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        });
      }).observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });
    `,
  });
  await send('Page.navigate', { url: APP });
  await waitFor('!!document.querySelector(".app-header")', '刷新后重新挂载', 12000);
  await sleep(500);
  const trace = await evaluate('window.__themeTrace ?? []');
  const reloaded = await themeSnapshot();
  check('刷新后仍是深色（选择被记住）', reloaded.theme === 'dark', String(reloaded.theme));
  check(
    '刷新首帧就是深色，且早于 React 渲染（否则深色用户会看到一瞬白屏）',
    trace.length > 0 && trace[0].theme === 'dark' && trace[0].rootChildren <= 0,
    JSON.stringify(trace[0] ?? null)
  );

  // 切回浅色：round-trip 要能回来，否则等于"只能进不能出"。
  await evaluate('document.querySelector(".app-theme-toggle").click()');
  await sleep(700);
  const backSnap = await themeSnapshot();
  check('再点一下能切回浅色', backSnap.theme === 'light', String(backSnap.theme));
  check('切回后 localStorage 也更新了', backSnap.stored === 'light', String(backSnap.stored));
  check(
    '切回浅色后没有深色残留',
    Object.entries(backSnap.surfaces).every(([, bg]) => {
      const l = luminance(bg);
      return l === null || l > 0.6;
    }),
    Object.entries(backSnap.surfaces).filter(([, bg]) => luminance(bg) !== null && luminance(bg) <= 0.6).map(([s, bg]) => `${s}=${bg}`).join(', ')
  );

  /*
   * ───────────────────── 设置页：清空热度的入口 ─────────────────────
   *
   * 这是一个**不可撤销**的动作，所以断言的不是"能点"，而是"点一下不会立刻生效"：
   * 必须弹二次确认、必须写清后果。这三条只有真的点一遍才知道，
   * 读代码看不出确认框到底有没有挂上去（Modal 是运行时创建的）。
   */
  console.log('\n──── 设置页：清空热度 ────');
  await evaluate(
    `[...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent.includes('设置'))?.click()`
  );
  await sleep(1000);

  const purgeBtn = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('清空热度数据'));
    return btn ? { text: btn.innerText.trim(), danger: btn.className.includes('dangerous') } : null;
  })()`);
  check('设置页有「清空热度数据」入口', purgeBtn !== null, JSON.stringify(purgeBtn));
  check('这个按钮是危险样式（红色），不会跟旁边的普通按钮混在一起', purgeBtn?.danger === true);
  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('清空热度数据'))?.scrollIntoView({ block: 'center' })`
  );
  await sleep(400);
  console.log('   截图:', await shot('layout-settings-purge'));

  const heatTotal = () =>
    evaluate(`fetch('/api/stats/summary?days=30').then((r) => r.json()).then((j) => j.data.total)`);
  const beforeTotal = await heatTotal();

  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('清空热度数据'))?.click()`
  );
  await sleep(600);
  const dialog = await evaluate(`(() => {
    const modal = document.querySelector('.ant-modal-confirm');
    if (!modal) return null;
    return {
      title: modal.querySelector('.ant-modal-confirm-title')?.innerText.trim() ?? '',
      body: (modal.innerText || '').replace(/\\s+/g, ' '),
    };
  })()`);
  check('点一下不会立刻清空，而是先弹确认框', dialog !== null, JSON.stringify(dialog?.title));
  check(
    '确认框写清了后果（不可撤销；拉取历史不受影响）',
    Boolean(dialog?.body?.includes('不可撤销') && dialog.body.includes('拉取历史')),
    dialog?.body?.slice(0, 90)
  );

  // 点「取消」：数据一行都不该少，弹窗要关掉。
  // 注意 AntD 会在两个汉字之间插空格（「取 消」），所以按去空白后的文本匹配。
  await evaluate(
    `[...document.querySelectorAll('.ant-modal-confirm .ant-btn')]
      .find((b) => b.innerText.replace(/\\s+/g, '') === '取消')?.click()`
  );
  await sleep(700);
  const afterTotal = await heatTotal();
  check('点「取消」后热度数据一行都没少', afterTotal === beforeTotal, `${beforeTotal} → ${afterTotal}`);
  check(
    '点「取消」后确认框关闭',
    (await evaluate(`!document.querySelector('.ant-modal-confirm')`)) === true
  );
} finally {
  ws.close();
  cleanup();
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
