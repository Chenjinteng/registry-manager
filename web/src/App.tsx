import { useState, type ReactNode } from 'react';
import { App as AntdApp, Button, Segmented, Tag, Tooltip } from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  CloudDownloadOutlined,
  DockerOutlined,
  KeyOutlined,
  MoonOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons';

import ImagesPage from './pages/images-page';
import PullPage from './pages/pull-page';
import CredentialsPage from './pages/credentials-page';
import ProxiesPage from './pages/proxies-page';
import SettingsPage from './pages/settings-page';
import StatsPage from './pages/stats-page';
import type { AppConfig, Inventory } from './types';

type PageKey = 'images' | 'stats' | 'pull' | 'credentials' | 'proxies' | 'settings';

/** 界面主题。持久化与首屏应用都在 main.tsx / index.html 里，这里只负责展示与切换。 */
export type ThemeMode = 'light' | 'dark';

/**
 * 整体布局：
 *   header（顶栏）→ main（p-4）→ 顶部横向 Segmented 导航 → 页面内容
 * 应用内导航放在顶部，而不是左侧栏。
 */
/*
 * 顺序 = **使用频率**，不是功能分组。
 *
 * 「镜像列表」和「镜像拉取」是日常最常来的两件事（看一眼有什么、搬一个进来），
 * 所以它们必须排在最前面、一屏内够得着；热度是"回头查账"时才来的，排在它们之后。
 * 调整顺序时按这个判据，不要按"统计类放一起"之类的分类学去排。
 */
const NAV_ITEMS: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'images', label: '镜像列表', icon: <DockerOutlined /> },
  { key: 'pull', label: '镜像拉取', icon: <CloudDownloadOutlined /> },
  { key: 'stats', label: '镜像热度', icon: <BarChartOutlined /> },
  { key: 'credentials', label: '凭据管理', icon: <KeyOutlined /> },
  { key: 'proxies', label: '代理管理', icon: <ApiOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
];

export default function App({
  mode,
  onToggleMode,
}: {
  mode: ThemeMode;
  onToggleMode: () => void;
}) {
  // 两个页面共享同一份清单：切换页面不该重新抓取 registry。
  const [page, setPage] = useState<PageKey>('images');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);

  const segmentedOptions = NAV_ITEMS.map((item) => ({
    value: item.key,
    label: (
      <span className="app-nav-label">
        <span className="app-nav-icon">{item.icon}</span>
        {item.label}
      </span>
    ),
  }));

  return (
    <AntdApp>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-brand">
            <DockerOutlined />
            <span>镜像仓库管理</span>
            {/* 运行中的版本：服务端从 package.json 读，界面上不写死 */}
            {config?.version ? (
              <Tooltip title={`当前运行版本 v${config.version}`}>
                <span className="app-brand-version">v{config.version}</span>
              </Tooltip>
            ) : null}
          </div>
          <div className="app-header-meta">
            {config?.usingProxy ? <Tag color="gold">经代理</Tag> : null}
            {config && !config.allowDelete ? <Tag color="green">只读模式</Tag> : null}
            {config && !config.allowPull ? <Tag color="default">禁止拉取</Tag> : null}
            <span className="ellipsis mono" title={config?.url}>
              {config ? config.url : '加载中…'}
            </span>
            {/* 图标显示的是"点了会变成什么"，所以深色下显示太阳。 */}
            <Tooltip title={mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
              <Button
                type="text"
                size="small"
                className="app-theme-toggle"
                aria-label={mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={onToggleMode}
              />
            </Tooltip>
          </div>
        </header>

        <main className="app-main">
          <div className="app-nav">
            <Segmented
              options={segmentedOptions}
              value={page}
              onChange={(value) => setPage(value as PageKey)}
            />
          </div>
          <div className="app-content">
            {page === 'images' ? (
              <ImagesPage
                config={config}
                onConfigChange={setConfig}
                inventory={inventory}
                onInventoryChange={setInventory}
                onGoSettings={() => setPage('settings')}
              />
            ) : page === 'stats' ? (
              <StatsPage config={config} onConfigChange={setConfig} />
            ) : page === 'pull' ? (
              <PullPage config={config} />
            ) : page === 'credentials' ? (
              <CredentialsPage config={config} />
            ) : page === 'proxies' ? (
              <ProxiesPage config={config} />
            ) : (
              <SettingsPage
                config={config}
                onConfigChange={setConfig}
                inventory={inventory}
                onInventoryChange={setInventory}
              />
            )}
          </div>
        </main>
      </div>
    </AntdApp>
  );
}
