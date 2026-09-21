import { useState, type ReactNode } from 'react';
import { App as AntdApp, Segmented, Tag } from 'antd';
import { DockerOutlined, SettingOutlined } from '@ant-design/icons';

import ImagesPage from './pages/images-page';
import SettingsPage from './pages/settings-page';
import type { AppConfig, Inventory } from './types';

type PageKey = 'images' | 'settings';

/**
 * 布局对齐 平台 控制台（web/src/app/layout.tsx + web/src/components/sub-layout）：
 *   header（顶栏）→ main（p-4）→ 顶部横向 Segmented 导航 → 页面内容
 * 应用内导航在顶部，而不是左侧栏。
 */
const NAV_ITEMS: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'images', label: '镜像列表', icon: <DockerOutlined /> },
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
          </div>
          <div className="app-header-meta">
            {config?.usingProxy ? <Tag color="gold">经代理</Tag> : null}
            {config && !config.allowDelete ? <Tag color="green">只读模式</Tag> : null}
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
