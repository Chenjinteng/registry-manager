import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Descriptions, Empty, Space, Table, Tag, Tooltip } from 'antd';
import { ApiOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import {
  fetchIgnoreRules,
  fetchStatsEvents,
  probeRegistry,
  purgeHeat,
  refreshInventory,
  removeIgnoreRule,
} from '../api';
import IgnoreRuleModal from '../components/ignore-rule-modal';
import type { ApiResult, AppConfig, IgnoreRules, Inventory } from '../types';
import { formatDateTime } from '../utils';

interface Props {
  config: AppConfig | null;
  onConfigChange: (config: AppConfig) => void;
  inventory: Inventory | null;
  onInventoryChange: (inventory: Inventory) => void;
}

export default function SettingsPage({ config, onConfigChange, inventory, onInventoryChange }: Props) {
  const { message, modal } = App.useApp();
  const [probing, setProbing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [purging, setPurging] = useState(false);
  const [ignoreRules, setIgnoreRules] = useState<IgnoreRules | null>(null);
  const [ignoreModalOpen, setIgnoreModalOpen] = useState(false);
  /** 预览素材：最近收到的客户端。进这一页时取一次即可。 */
  const [knownUseragents, setKnownUseragents] = useState<string[]>([]);
  const [notice, setNotice] = useState<ApiResult<unknown> | null>(null);

  const handleProbe = async () => {
    setProbing(true);
    setNotice(null);
    try {
      const result = await probeRegistry();
      setNotice(
        result.success
          ? { ...result, message: `连接成功（API ${result.data?.apiVersion ?? 'registry/2.0'}）` }
          : result
      );
    } finally {
      setProbing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      const result = await refreshInventory();
      setNotice(result);
      if (result.success && result.data) {
        onInventoryChange(result.data);
        message.success(`扫描完成，用时 ${result.data.durationMs} ms`);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const statsEnabled = config?.statsEnabled === true;

  // 规则与预览素材各取一次。热度不可用时服务端会回空结构，不用单独降级。
  useEffect(() => {
    if (!statsEnabled) {
      return;
    }
    void (async () => {
      const [rules, events] = await Promise.all([fetchIgnoreRules(), fetchStatsEvents(50)]);
      if (rules.success && rules.data) {
        setIgnoreRules(rules.data);
      }
      if (events.success && events.data) {
        setKnownUseragents([
          ...new Set(events.data.items.map((event) => event.useragent).filter(Boolean)),
        ]);
      }
    })();
  }, [statsEnabled]);

  /** 规则表：环境变量来的标出来、不给删；界面加的可以删。 */
  const ruleRows = useMemo(() => {
    const env = (ignoreRules?.env ?? []).map((rule) => ({ key: `env:${rule}`, rule, source: 'env' as const }));
    const panel = (ignoreRules?.panel ?? []).map((rule) => ({ key: `panel:${rule}`, rule, source: 'panel' as const }));
    return [...env, ...panel];
  }, [ignoreRules]);

  /** 生效规则同步回顶层配置，热度页标题上的「已忽略：…」才不会滞后。 */
  const applyRules = (rules: IgnoreRules) => {
    setIgnoreRules(rules);
    if (config) {
      onConfigChange({ ...config, statsIgnoreUseragents: rules.effective });
    }
  };

  const handleRemoveRule = async (rule: string) => {
    const result = await removeIgnoreRule(rule);
    if (result.success && result.data) {
      message.success(result.message || '已删除规则');
      applyRules(result.data);
    } else {
      setNotice(result);
    }
  };

  const ruleColumns: ColumnsType<{ key: string; rule: string; source: 'env' | 'panel' }> = [
    {
      title: '规则片段',
      dataIndex: 'rule',
      key: 'rule',
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip title={value}>
          <span className="mono ellipsis" style={{ display: 'block' }}>
            {value}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 150,
      render: (source: 'env' | 'panel') =>
        source === 'env' ? (
          <Tooltip title="来自环境变量 REGISTRY_STATS_IGNORE_USERAGENTS，要改得改部署配置并重启">
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
              环境变量
            </Tag>
          </Tooltip>
        ) : (
          <Tag style={{ marginInlineEnd: 0 }}>界面</Tag>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, record) =>
        record.source === 'panel' ? (
          <Button
            type="link"
            size="small"
            danger
            style={{ padding: 0, height: 'auto' }}
            onClick={() => void handleRemoveRule(record.rule)}
          >
            删除
          </Button>
        ) : (
          // 说清楚为什么这里没有删除按钮，否则会被当成 bug。
          <span style={{ color: 'var(--color-text-4)', fontSize: 12 }}>不可在此删除</span>
        ),
    },
  ];

  const handlePurgeHeat = async () => {
    setPurging(true);
    setNotice(null);
    try {
      const result = await purgeHeat();
      if (result.success) {
        message.success(result.message || '已清空热度数据');
      } else {
        setNotice(result);
      }
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">设置</h2>
          <p className="page-subtitle">当前管理的镜像仓库、连接状态与清单缓存。</p>
        </div>
        <div className="page-actions">
          <Button icon={<ApiOutlined />} loading={probing} onClick={() => void handleProbe()}>
            测试连接
          </Button>
          <Button type="primary" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void handleRefresh()}>
            重新扫描
          </Button>
        </div>
      </div>

      {/*
        只在有文案时渲染。成功路径的 message 是空串（扫描结果由顶部 toast 和下方
        「清单状态」展示），无条件渲染会得到一个没有内容的空绿框。
      */}
      {notice?.message ? (
        <Alert
          type={notice.success ? 'success' : 'warning'}
          showIcon
          closable
          onClose={() => setNotice(null)}
          message={notice.message}
        />
      ) : null}

      <div className="panel" style={{ padding: 16 }}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="名称">{config?.name ?? '--'}</Descriptions.Item>
          <Descriptions.Item label="地址">
            <span className="mono">{config?.url ?? '--'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="镜像引用前缀">
            <span className="mono">{config?.host ?? '--'}</span>
            <span style={{ marginLeft: 8, color: 'var(--color-text-3)' }}>
              例：{config?.host ?? '<host>'}/library/nginx:1.25
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="访问方式">
            {config?.usingProxy ? <Tag color="gold">经 HTTP 代理</Tag> : <Tag>直连</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="清单缓存">
            {config ? `${config.cacheTtlSeconds} 秒` : '--'}
          </Descriptions.Item>
          <Descriptions.Item label="删除能力">
            {config?.allowDelete ? <Tag color="red">已启用</Tag> : <Tag color="green">只读模式</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="清单状态">
            {inventory ? (
              <Space size={8}>
                <span>
                  {inventory.repositories.length} 个仓库 / {inventory.errorCount} 项读取失败
                </span>
                <span style={{ color: 'var(--color-text-3)' }}>
                  刷新于 {formatDateTime(inventory.refreshedAt)}
                </span>
              </Space>
            ) : (
              '尚未扫描'
            )}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <Alert
        type="info"
        showIcon
        message="如何修改要管理的镜像仓库"
        description={
          <div>
            <div>这个工具一次管理一个 registry。地址通过环境变量或配置文件提供，改完重启服务即可。</div>
            <pre
              className="mono"
              style={{
                margin: '8px 0 0',
                padding: '10px 12px',
                background: 'var(--color-fill-1)',
                border: '1px solid var(--color-border-2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
              }}
            >{`# 方式一：环境变量
REGISTRY_URL=http://192.0.2.10:10001 \\
REGISTRY_PROXY=http://proxy.example.com:8080 \\
PORT=8787 pnpm start

# 方式二：项目根目录 registry.config.json
{
  "name": "内网离线镜像源",
  "url": "http://192.0.2.10:10001",
  "proxy": "",
  "cacheTtlSeconds": 60,
  "port": 8787
}`}</pre>
          </div>
        }
      />

      {/*
        规则管理放这里，但**添加的主要入口在热度页那一行上** —— 要排掉某个客户端时人正看着
        那条 UA，不该被赶到设置页来手动粘。这里负责"看全量 + 删 + 标出来源"。
      */}
      {statsEnabled ? (
        <div className="panel" style={{ padding: 16 }}>
          <div className="stats-panel-head">
            <h3 className="stats-panel-title">热度忽略规则</h3>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setIgnoreModalOpen(true)}>
              添加规则
            </Button>
          </div>
          <p style={{ margin: '0 0 12px', color: 'var(--color-text-3)', fontSize: 13 }}>
            命中的客户端不计入热度（子串匹配、忽略大小写）。加规则不用重启 ——
            嫌麻烦的话，热度页「最近事件」每一行的「忽略」是最快的入口。
          </p>
          <Table
            rowKey="key"
            size="small"
            columns={ruleColumns}
            dataSource={ruleRows}
            pagination={false}
            locale={{
              emptyText: <Empty description="还没有规则：所有客户端的事件都会计入热度" />,
            }}
          />
        </div>
      ) : null}

      {config?.statsEnabled ? (
        <Alert
          type="info"
          showIcon
          message="热度数据可以从头重计"
          description={
            <div>
              <div>
                热度按天聚合在本地数据库里，保留 {config.statsRetentionDays} 天
                {config.statsSince ? `（最早一天 ${config.statsSince}）` : ''}。 如果统计口径改过
                —— 例如发现某个自动化进程（镜像同步工具）也在按点扫全量、把热度刷了上去 ——
                可以把它清空、从现在重新累计。
              </div>
              <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                会清除热度聚合、幂等去重记录与「见过的客户端」清单（后者的计入数与热度同源，
                留着会自相矛盾），<strong>拉取历史不受影响</strong>。此操作不可撤销。
              </div>
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                loading={purging}
                style={{ marginTop: 8 }}
                onClick={() =>
                  modal.confirm({
                    title: '清空全部热度数据？',
                    content:
                      '已统计的热度会全部归零，从现在重新累计。「见过的客户端」清单也会一起清掉（它会在几小时内被重新填回来）。拉取历史不受影响。此操作不可撤销。',
                    okText: '清空',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: handlePurgeHeat,
                  })
                }
              >
                清空热度数据
              </Button>
            </div>
          }
        />
      ) : null}

      <Alert
        type={config?.allowDelete ? 'warning' : 'info'}
        showIcon
        message={config?.allowDelete ? '删除已启用，操作不可撤销' : '当前为只读模式'}
        description={
          <div>
            {config?.allowDelete ? (
              <>
                <div>
                  删除按 digest 生效，会移除 manifest，该镜像随即无法再被拉取。删除前页面会列出同一 digest
                  下的全部 tag。
                </div>
                <div style={{ marginTop: 4 }}>
                  若 registry 侧未开启删除，请求会被拒绝，页面会给出对应提示。此外，删除 manifest 只是解除引用，
                  磁盘空间要运行 <span className="mono">registry garbage-collect</span> 才会真正回收。
                </div>
                <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                  想完全关掉破坏性操作：在配置里设置 <span className="mono">allowDelete: false</span>
                  （或环境变量 <span className="mono">REGISTRY_ALLOW_DELETE=false</span>）后重启服务。
                </div>
              </>
            ) : (
              <div>
                服务端已设置 <span className="mono">allowDelete=false</span>，删除入口已隐藏，
                所有删除请求都会被拒绝。
              </div>
            )}
          </div>
        }
      />

      <IgnoreRuleModal
        open={ignoreModalOpen}
        knownUseragents={knownUseragents}
        onCancel={() => setIgnoreModalOpen(false)}
        onSaved={(rules) => {
          setIgnoreModalOpen(false);
          applyRules(rules);
        }}
      />
    </div>
  );
}
