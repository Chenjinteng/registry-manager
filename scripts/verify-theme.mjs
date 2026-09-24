#!/usr/bin/env node
/**
 * 验证深浅两套主题的**对应关系**。
 *
 * 为什么值得单独写：主题的错法几乎都不抛异常，只是"某个角落长得不对"——
 *   1. `:root` 加了 token 但忘了在 `[data-theme='dark']` 里覆盖 → 深色下那块还是白的；
 *   2. 组件里引用了一个根本不存在的 token（`var(--color-error)`）→ 该条声明**静默失效**
 *      （CSS 自定义属性没有值域检查，写错名字不报错、不继承、直接当未定义）；
 *   3. `main.tsx` 的 AntD token 和 `theme.css` 的语义色对不上 → 同屏两种蓝；
 *   4. 首屏脚本被挪到 React 之后 → 深色用户先看到一瞬白屏。
 * 这四种读代码都很难发现，而第 2 种本仓库真实发生过（`--color-error` 从未存在过）。
 *
 * 用法：node scripts/verify-theme.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_CSS = join(ROOT, 'web/src/theme.css');
const MAIN_TSX = join(ROOT, 'web/src/main.tsx');
const INDEX_HTML = join(ROOT, 'web/index.html');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const read = (file) => readFileSync(file, 'utf8');

/** 取出一个 CSS 块里的所有自定义属性声明（`--name: value;`）。 */
const cssTokens = (block) =>
  Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()])
  );

const themeCss = read(THEME_CSS);
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(themeCss);
const darkBlock = /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(themeCss);
check('theme.css 里能找到 :root 块', Boolean(rootBlock));
check("theme.css 里能找到 [data-theme='dark'] 块", Boolean(darkBlock));

const rootTokens = rootBlock ? cssTokens(rootBlock[1]) : {};
const darkTokens = darkBlock ? cssTokens(darkBlock[1]) : {};

// ───────────────────── 一、深浅一一对应 ─────────────────────
{
  /*
   * 要求覆盖的是**颜色**：漏一个的表现是深色下那一块还是白的，而且不报错。
   * 圆角之类的几何 token 与主题无关，深色下本来就该是同一个值 ——
   * 逼它们各写一遍只是徒增两处漂移点，所以明确列出来豁免。
   */
  const THEME_INDEPENDENT = new Set(['--radius-sm', '--radius-md']);
  const mustOverride = Object.keys(rootTokens).filter(
    (name) => name.startsWith('--color-') || !THEME_INDEPENDENT.has(name)
  );
  const missing = mustOverride.filter((name) => !(name in darkTokens));
  check(
    '深色块覆盖了每一个与主题相关的 token',
    missing.length === 0,
    missing.length ? `漏掉: ${missing.join(', ')}` : `${mustOverride.length} 个`
  );

  const extra = Object.keys(darkTokens).filter((name) => !(name in rootTokens));
  check(
    '深色块没有 :root 里不存在的 token（多半是拼错）',
    extra.length === 0,
    extra.join(', ')
  );

  check(
    '两套的 color-scheme 相反（否则原生滚动条不跟随）',
    /color-scheme:\s*light/.test(rootBlock?.[1] ?? '') &&
      /color-scheme:\s*dark/.test(darkBlock?.[1] ?? '')
  );

  // 取反是最省事的做法，也是深色主题最难看的原因；这里只钉"值确实换过"。
  const shared = Object.keys(rootTokens).filter((name) => name in darkTokens);
  const changed = shared.filter((name) => rootTokens[name] !== darkTokens[name]);
  check(
    '深色不是简单复制浅色值',
    changed.length === shared.length,
    `${changed.length}/${shared.length} 个共有 token 换了值`
  );
}

// ───────────────────── 二、引用的 token 必须存在 ─────────────────────
// 这条是本次回归的靶子：`var(--color-error)` 这类名字写错时，CSS 静默丢弃整条声明。
{
  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return ['.css', '.tsx', '.ts'].includes(extname(full)) ? [full] : [];
    });

  const sources = [...walk(join(ROOT, 'web/src')), INDEX_HTML];
  const refs = new Map();
  for (const file of sources) {
    // 要求以 `)` / `,` 收尾：否则注释里的 `var(--color-*)` 会被当成一个叫 `--color-` 的引用。
    for (const match of read(file).matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)) {
      if (!refs.has(match[1])) refs.set(match[1], relative(ROOT, file));
    }
  }

  const undefinedRefs = [...refs].filter(([name]) => !(name in rootTokens));
  check(
    '代码里引用的自定义属性都在 theme.css 的 :root 里有定义',
    undefinedRefs.length === 0,
    undefinedRefs.length
      ? undefinedRefs.map(([name, file]) => `${name}（${file}）`).join(', ')
      : `检查了 ${refs.size} 个引用`
  );

  // 只看 `--color-*`：这类 token 是最容易「凭印象写」的，也正是上面那次事故的形状。
  const colorRefs = [...refs.keys()].filter((name) => name.startsWith('--color-'));
  check(
    '其中语义色的引用数量合理（不是只扫到注释里的 --color-*）',
    colorRefs.length >= 10,
    `${colorRefs.length} 个`
  );
}

// ───────────────────── 三、AntD token 与 CSS 语义色对齐 ─────────────────────
{
  const mainTsx = read(MAIN_TSX);
  const pick = (name) => new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(mainTsx)?.[1];
  const light = pick('LIGHT_TOKENS');
  const dark = pick('DARK_TOKENS');
  check('main.tsx 里能找到 LIGHT_TOKENS / DARK_TOKENS', Boolean(light && dark));

  const tsTokens = (block) =>
    Object.fromEntries(
      [...(block ?? '').matchAll(/(\w+)\s*:\s*'(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]])
    );
  const lightTs = tsTokens(light);
  const darkTs = tsTokens(dark);

  const lightKeys = Object.keys(lightTs).sort();
  const darkKeys = Object.keys(darkTs).sort();
  check(
    '两套 AntD token 的键完全一致',
    lightKeys.join(',') === darkKeys.join(','),
    lightKeys.join(',')
  );

  /** AntD token → theme.css 里对应的语义 token。 */
  const PAIRS = {
    colorPrimary: '--color-primary',
    colorBgLayout: '--color-background-body',
    colorBgContainer: '--color-bg',
    colorText: '--color-text-1',
    colorTextSecondary: '--color-text-2',
    colorBorder: '--color-border',
    colorSuccess: '--color-success',
    colorWarning: '--color-warning',
    colorInfo: '--color-info',
    colorError: '--color-fail',
  };
  check(
    'PAIRS 覆盖了全部 AntD token（新增 token 时这里要一起加）',
    Object.keys(PAIRS).sort().join(',') === lightKeys.join(','),
    Object.keys(PAIRS).sort().join(',')
  );

  for (const [tsName, cssName] of Object.entries(PAIRS)) {
    check(
      `浅色 ${tsName} == ${cssName}`,
      lightTs[tsName]?.toLowerCase() === rootTokens[cssName]?.toLowerCase(),
      `${lightTs[tsName]} vs ${rootTokens[cssName]}`
    );
    check(
      `深色 ${tsName} == ${cssName}`,
      darkTs[tsName]?.toLowerCase() === darkTokens[cssName]?.toLowerCase(),
      `${darkTs[tsName]} vs ${darkTokens[cssName]}`
    );
  }

  check(
    '深色用 darkAlgorithm 打底（否则上百个派生色仍是浅色）',
    /algorithm:\s*antdTheme\.darkAlgorithm/.test(mainTsx)
  );
}

// ───────────────────── 四、首屏不闪白 ─────────────────────
{
  const html = read(INDEX_HTML);
  const inline = html.indexOf('document.documentElement.dataset.theme');
  const moduleScript = html.indexOf('type="module"');
  check('index.html 里有内联的主题脚本', inline !== -1);
  check(
    '内联脚本在模块脚本之前（早于 React 挂载）',
    inline !== -1 && moduleScript !== -1 && inline < moduleScript,
    `inline=${inline}, module=${moduleScript}`
  );
  check(
    '内联脚本先读 localStorage，再退回系统偏好',
    /localStorage\.getItem\(/.test(html) && /prefers-color-scheme:\s*dark/.test(html)
  );
  check(
    'localStorage 读不到时退回浅色（隐私模式不白屏）',
    /document\.documentElement\.dataset\.theme = 'light'/.test(html)
  );

  const STORAGE_KEY = /const STORAGE_KEY = '([^']+)'/.exec(read(MAIN_TSX))?.[1];
  check(
    '两边的存储键是同一个（否则记不住选择）',
    Boolean(STORAGE_KEY) && html.includes(`'${STORAGE_KEY}'`),
    STORAGE_KEY
  );

  // main.tsx 只读属性、不重新判断系统偏好：两处判断 = 两个真相来源。
  const mainTsx = read(MAIN_TSX);
  check(
    'main.tsx 从 dataset 读初值，不重复系统偏好判断',
    /dataset\.theme === 'dark'/.test(mainTsx) && !/prefers-color-scheme/.test(mainTsx)
  );
}

// ───────────────────── 五、切换按钮真的接上了 ─────────────────────
{
  const appTsx = read(join(ROOT, 'web/src/App.tsx'));
  check('App.tsx 导出 ThemeMode', /export type ThemeMode = 'light' \| 'dark'/.test(appTsx));
  check('切换按钮调用了 onToggleMode', /onClick=\{onToggleMode\}/.test(appTsx));
  check(
    '切换按钮有无障碍名称（纯图标按钮没有可读文本）',
    /aria-label=\{mode === 'dark'/.test(appTsx)
  );
  check(
    '图标跟随当前模式（深色下提示切回浅色）',
    /mode === 'dark' \? <SunOutlined \/> : <MoonOutlined \/>/.test(appTsx)
  );

  const mainTsx = read(MAIN_TSX);
  check(
    '切换后写回 documentElement.dataset.theme',
    /document\.documentElement\.dataset\.theme = mode/.test(mainTsx)
  );
  check(
    '切换后写回 localStorage',
    /localStorage\.setItem\(STORAGE_KEY, mode\)/.test(mainTsx)
  );
  check(
    '存储写失败不会中断切换（隐私模式）',
    /localStorage\.setItem\(STORAGE_KEY, mode\)[\s\S]{0,200}catch/.test(mainTsx)
  );
  // 嵌套两层 <App> 会给页面套上两层 .ant-app 上下文，message/modal 挂到哪一层变得不确定。
  const antdAppCount =
    (read(MAIN_TSX).match(/<AntdApp>/g) ?? []).length + (appTsx.match(/<AntdApp>/g) ?? []).length;
  check('App / AntdApp 上下文只包裹一层', antdAppCount === 1, `${antdAppCount} 层`);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
