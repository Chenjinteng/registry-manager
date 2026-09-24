import { useState, type ReactNode } from 'react';
import { App as AntdApp, Segmented, Tag, Tooltip } from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  CloudDownloadOutlined,
  DockerOutlined,
  KeyOutlined,
  SettingOutlined,
} from '@ant-design/icons';

import ImagesPage from './pages/images-page';
import PullPage from './pages/pull-page';
import CredentialsPage from './pages/credentials-page';
import ProxiesPage from './pages/proxies-page';
import SettingsPage from './pages/settings-page';
import StatsPage from './pages/stats-page';
import type { AppConfig, Inventory } from './types';

type PageKey = 'images' | 'stats' | 'pull' | 'credentials' | 'proxies' | 'settings';

/**
 * 整体布局：
 *   header（顶栏）→ main（p-4）→ 顶部横向 Segmented 导航 → 页面内容
 * 应用内导航放在顶部，而不是左侧栏。
 */
const NAV_ITEMS: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'images', label: '镜像列表', icon: <DockerOutlined /> },
  { key: 'stats', label: '镜像热度', icon: <BarChartOutlined /> },
  { key: 'pull', label: '镜像拉取', icon: <CloudDownloadOutlined /> },
  { key: 'credentials', label: '凭据管理', icon: <KeyOutlined /> },
  { key: 'proxies', label: '代理管理', icon: <ApiOutlined /> },
  { key: 'settings', label: '设置', icon: <SettingOutlined /> },
];

export default function App() {
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
