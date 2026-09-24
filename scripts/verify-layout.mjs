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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
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
  } else {
    skip('热度页布局', '热度页没渲染出来（可能未启用热度统计）');
  }

} finally {
  ws.close();
  cleanup();
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
