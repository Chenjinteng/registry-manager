import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Segmented, Table, Tooltip } from 'antd';
import {
  ClockCircleOutlined,
  DatabaseOutlined,
  HddOutlined,
  ReloadOutlined,
  SyncOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import { fetchConfig, fetchInventory, fetchRepositoryStats, refreshInventory } from '../api';
import ImageDetailDrawer from '../components/image-detail-drawer';
import MetricCard from '../components/metric-card';
import type {
  ApiResult,
  AppConfig,
  DeleteTagPayload,
  Inventory,
  RegistryRepository,
  StatsRepositoryStat,
  StatsWindow,
} from '../types';
import { formatBytes, formatDateTime } from '../utils';

interface Props {
  config: AppConfig | null;
  onConfigChange: (config: AppConfig) => void;
  inventory: Inventory | null;
  onInventoryChange: (inventory: Inventory) => void;
  onGoSettings: () => void;
}

/** 热度时间窗，与「镜像热度」页保持同样的三档。 */
const STATS_WINDOW_OPTIONS: { label: string; value: StatsWindow }[] = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
];

export default function ImagesPage({
  config,
  onConfigChange,
  inventory,
  onInventoryChange,
  onGoSettings,
}: Props) {
  const [loading, setLoading] = useState(!inventory);
  const [error, setError] = useState<ApiResult<unknown> | null>(null);
  /**
   * 表格的滚动容器。页面用 .page--fill 撑满视口，滚动只发生在这里 ——
   * 所以搜索框、时间窗、KPI 往下翻表格时不会被顶走。
   */
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [detailName, setDetailName] = useState<string | null>(null);
  /** 热度时间窗；与热度页的三档一致。 */
  const [statsDays, setStatsDays] = useState<StatsWindow>(30);
  /** 仓库名 → 窗口内热度。查不到 = 窗口内没有事件，界面显示「—」。 */
  const [heat, setHeat] = useState<Record<string, StatsRepositoryStat>>({});

  const statsEnabled = config?.statsEnabled === true;

  /**
   * 热度是锦上添花：单独拉、失败就保持空 map。
   * 绝不能因为热度接口挂了就让镜像列表变成错误页 —— 列表来自 /api/inventory。
   */
  const loadHeat = useCallback(async (windowDays: StatsWindow) => {
    const result = await fetchRepositoryStats(windowDays);
    if (result.success && result.data) {
      setHeat(result.data.items);
    }
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      const configResult = await fetchConfig();
      if (configResult.success && configResult.data) {
        onConfigChange(configResult.data);
      }
      const result = force ? await refreshInventory() : await fetchInventory();
      if (result.success && result.data) {
        onInventoryChange(result.data);
      } else {
        setError(result);
      }
      setLoading(false);
    },
    // api 函数是模块级常量，不需要进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onConfigChange, onInventoryChange]
  );

  useEffect(() => {
    if (!inventory) {
      void load(false);
    }
    // 首屏只拉一次；后续刷新由刷新按钮显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 配置到手后才知道热度可不可用；不可用就不发请求、也不加那两列。
  useEffect(() => {
    if (!statsEnabled) {
      setHeat({});
      return;
    }
    void loadHeat(statsDays);
  }, [statsEnabled, statsDays, loadHeat]);

  const heatOf = (name: string) => heat[name]?.events ?? 0;
  const lastActivityOf = (name: string) => heat[name]?.lastAt ?? null;

  const rows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (inventory?.repositories ?? []).filter(
      (item) => !keyword || item.name.toLowerCase().includes(keyword)
    );
  }, [inventory, search]);

  const metrics = useMemo(() => {
    const repositories = rows;
    return {
      repositoryCount: repositories.length,
      tagCount: repositories.reduce((total, item) => total + item.tagCount, 0),
      totalSize: repositories.reduce((total, item) => total + item.totalSize, 0),
    };
  }, [rows]);

  const detailRepository = useMemo(
    () => inventory?.repositories.find((item) => item.name === detailName) ?? null,
    [inventory, detailName]
  );

  const handleDeleted = (payload: DeleteTagPayload) => {
    if (!inventory) {
      return;
    }
    const others = inventory.repositories.filter((item) => item.name !== payload.repository.name);
    onInventoryChange({
      ...inventory,
      repositories: [...others, payload.repository].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
    });
  };

  const columns: ColumnsType<RegistryRepository> = [
    {
      title: '仓库名',
      dataIndex: 'name',
      key: 'name',
      sorter: (left, right) => left.name.localeCompare(right.name),
      render: (value: string, record) => (
        <Tooltip title={value}>
          <button type="button" className="link-cell ellipsis" onClick={() => setDetailName(record.name)}>
            {value}
          </button>
        </Tooltip>
      ),
    },
    {
      title: 'Tag 数',
      dataIndex: 'tagCount',
      key: 'tagCount',
      width: 100,
      sorter: (left, right) => left.tagCount - right.tagCount,
    },
    {
      title: '镜像层合计',
      dataIndex: 'totalSize',
      key: 'totalSize',
      width: 150,
      defaultSortOrder: 'descend',
      sorter: (left, right) => left.totalSize - right.totalSize,
      render: (value: number) => formatBytes(value),
    },
    {
      title: '最新构建时间',
      key: 'latestBuildAt',
      width: 170,
      sorter: (left, right) => latestBuildAt(left).localeCompare(latestBuildAt(right)),
      render: (_, record) => formatDateTime(latestBuildAt(record) || null),
    },
    // 热度不可用时这两列整列不出现：两列全是「—」会被读成"确实没人用"。
    ...(statsEnabled
      ? ([
          {
            title: `热度（${statsDays} 天）`,
            key: 'heat',
            width: 130,
            sorter: (left: RegistryRepository, right: RegistryRepository) =>
              heatOf(left.name) - heatOf(right.name),
            // 没有热度的显示「—」而不是 0 —— 0 会和"确实没人用"混淆。
            render: (_: unknown, record: RegistryRepository) =>
              heatOf(record.name) > 0 ? `${heatOf(record.name)} 次` : '—',
          },
          {
            title: '最近活动',
            key: 'lastActivity',
            width: 170,
            sorter: (left: RegistryRepository, right: RegistryRepository) =>
              (lastActivityOf(left.name) ?? '').localeCompare(lastActivityOf(right.name) ?? ''),
            render: (_: unknown, record: RegistryRepository) =>
              formatDateTime(lastActivityOf(record.name)),
          },
        ] as ColumnsType<RegistryRepository>)
      : []),
    {
      title: '操作',
      key: 'actions',
      width: 80,
      fixed: 'right',
      render: (_, record) => (
        <Button type="link" size="small" onClick={() => setDetailName(record.name)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <div className="page page--fill">
      <div className="page-header">
        <div>
          <h2 className="page-title">镜像列表</h2>
          <p className="page-subtitle">浏览并管理 registry 中的镜像。</p>
        </div>
        <div className="page-actions">
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索仓库名"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {statsEnabled ? (
            <Segmented
              options={STATS_WINDOW_OPTIONS}
              value={statsDays}
              onChange={(value) => setStatsDays(value as StatsWindow)}
            />
          ) : null}
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void load(false);
              if (statsEnabled) {
                void loadHeat(statsDays);
              }
            }}
            loading={loading && Boolean(inventory)}
          >
            刷新
          </Button>
          <Button type="primary" icon={<SyncOutlined />} loading={loading} onClick={() => void load(true)}>
            重新扫描
          </Button>
        </div>
      </div>

      {error ? (
        <Alert
          type="warning"
          showIcon
          message="无法获取镜像清单"
          description={
            <div>
              <div>{error.message}</div>
              <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                请确认 registry 地址可达，并在「设置」中检查配置。
                <Button type="link" size="small" onClick={onGoSettings} style={{ paddingInline: 4 }}>
                  去设置
                </Button>
              </div>
            </div>
          }
        />
      ) : null}

      {inventory && inventory.errorCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${inventory.errorCount} 个 tag 读取失败，已跳过`}
          description={
            <span>
              {inventory.errors
                .slice(0, 5)
                .map((item) => `${item.repository}${item.tag ? `:${item.tag}` : ''}`)
                .join('、')}
              {inventory.errorCount > inventory.errors.length
                ? ` 等 ${inventory.errorCount} 项`
                : ''}
            </span>
          }
        />
      ) : null}

      {inventory?.truncated ? (
        <Alert type="warning" showIcon message="仓库数量超过单次扫描上限，清单已截断。" />
      ) : null}

      <div className="metric-grid">
        <MetricCard icon={<HddOutlined />} label="仓库数" value={metrics.repositoryCount} />
        <MetricCard icon={<TagsOutlined />} label="Tag 数" value={metrics.tagCount} />
        <MetricCard
          icon={<DatabaseOutlined />}
          label="镜像层合计"
          value={formatBytes(metrics.totalSize)}
        />
        <MetricCard
          icon={<ClockCircleOutlined />}
          iconColor="var(--color-text-3)"
          iconBackground="var(--color-fill-2)"
          label="清单刷新时间"
          text
          value={formatDateTime(inventory?.refreshedAt ?? null, '尚未扫描')}
        />
      </div>

      <div className="panel">
        {/* 表格自己滚（表头粘住），页面不滚 —— 见 app.css 的 .page--fill。 */}
        <div className="table-scroll" ref={tableWrapRef}>
          <Table<RegistryRepository>
            rowKey="name"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={rows}
            scroll={{ x: statsEnabled ? 1100 : 900 }}
            sticky={{ getContainer: () => tableWrapRef.current ?? window }}
            locale={{
              emptyText: (
                <Empty
                  description={
                    inventory
                      ? '该 registry 没有匹配的镜像'
                      : '还没有清单，点击「重新扫描」从 registry 拉取'
                  }
                />
              ),
            }}
            pagination={{
              size: 'small',
              showSizeChanger: true,
              defaultPageSize: 20,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total) => `共 ${total} 个仓库`,
            }}
          />
        </div>
      </div>

      <ImageDetailDrawer
        open={Boolean(detailName)}
        host={config?.host ?? ''}
        repository={detailRepository}
        allowDelete={config?.allowDelete ?? false}
        onClose={() => setDetailName(null)}
        onDeleted={handleDeleted}
      />
    </div>
  );
}

/** 仓库的"最新构建时间"取所有 tag 构建时间的最大值；用于排序与展示。 */
function latestBuildAt(repository: RegistryRepository): string {
  return repository.tags.reduce((latest, item) => {
    if (!item.createdAt) {
      return latest;
    }
    return item.createdAt > latest ? item.createdAt : latest;
  }, '');
}
