import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import App, { type ThemeMode } from './App';
import './theme.css';
import './app.css';

/**
 * AntD 的 token 必须跟着主题走，否则会出现"半深色"：
 * 自定义 CSS 用的 `--color-*` 变深了，而 AntD 的表格 / 弹窗 / 下拉还是浅色，
 * 同一屏里两套配色 —— 这是深色主题最常见的翻车方式。
 *
 * 深色以 AntD 的 `darkAlgorithm` 打底（它负责上百个我们没显式列出的派生色，
 * 比如禁用态、hover 态、阴影），再把语义色**对齐到 theme.css 的深色值** ——
 * 两边必须是同一组值，否则会出现两种不同的蓝。
 */
const LIGHT_TOKENS = {
  colorPrimary: '#155AEF',
  colorBgLayout: '#F2F4F7',
  colorBgContainer: '#FFFFFF',
  colorText: '#1E252E',
  colorTextSecondary: '#475468',
  colorBorder: '#EAECF0',
  colorSuccess: '#27C274',
  colorWarning: '#FAAD14',
  colorInfo: '#1677FF',
  colorError: '#F43B2C',
};

const DARK_TOKENS = {
  colorPrimary: '#4C8DFF',
  colorBgLayout: '#0F131A',
  colorBgContainer: '#171B24',
  colorText: '#E6EAF2',
  colorTextSecondary: '#AAB6C8',
  colorBorder: '#2A313D',
  colorSuccess: '#3DDC84',
  colorWarning: '#FFC53D',
  colorInfo: '#4096FF',
  colorError: '#FF6B5E',
};

const STORAGE_KEY = 'registry-manager-theme';

const buildAntdTheme = (mode: ThemeMode) =>
  mode === 'dark'
    ? { cssVar: true, algorithm: antdTheme.darkAlgorithm, token: DARK_TOKENS }
    : { cssVar: true, token: LIGHT_TOKENS };

/**
 * 初值直接读 index.html 已经设好的属性。
 *
 * "上次的选择 > 系统偏好"那套逻辑**只在 index.html 里写一份** ——
 * 这里再判断一次就有两个真相来源，迟早会不一致（而且那是首屏闪烁的根源）。
 */
function readInitialMode(): ThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // 存储不可用（隐私模式）只是记不住选择，不影响本次会话。
    }
  }, [mode]);

  return (
    <ConfigProvider theme={buildAntdTheme(mode)} locale={zhCN}>
      <App
        mode={mode}
        onToggleMode={() => setMode((current) => (current === 'dark' ? 'light' : 'dark'))}
      />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
