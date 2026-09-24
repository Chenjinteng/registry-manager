import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import IgnoreRuleModal from '../components/ignore-rule-modal';

import {
  fetchConfig,
  fetchStatsClients,
  fetchStatsEvents,
  fetchStatsSeries,
  fetchStatsSummary,
  fetchStatsTop,
} from '../api';
import MetricCard from '../components/metric-card';
import ContributionHeatmap from '../components/contribution-heatmap';
import type {
  ApiResult,
  AppConfig,
  IgnoreRules,
  StatsClientItem,
  StatsEventItem,
  StatsEvents,
  StatsSeriesPoint,
  StatsSummary,
  StatsTopBy,
  StatsTopItem,
  StatsWindow,
} from '../types';
import { formatDateTime } from '../utils';

interface Props {
  config: AppConfig | null;
  onConfigChange: (config: AppConfig) => void;
}

const WINDOW_OPTIONS: { label: string; value: StatsWindow }[] = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
];

/**
 * 日历的跨度：**固定 12 个月，不随时间窗变化**。
 *
 * 为什么不跟 Segmented 走：日历的宽度由**列数**决定（一周一列）。30 天只有 5 列，
 * 不论格子多大都只在面板左侧占一小块，右侧一大片空白 —— 实测被反馈"太不好看"。
 * 要像 GitHub 那样铺满，只能靠足够长的跨度：12 个月 ≈ 53 列。
 *
 * 代价：热度数据的保留期默认 90 天，更早的日期会显示成灰色空格。
 * 这不是"没有活动"，而是"数据已被保留期清掉"，所以 caption 里必须写明，
 * 否则会被读成"那段时间没人用"。
 */
const HEATMAP_DAYS = 365;

const BY_OPTIONS: { label: string; value: StatsTopBy }[] = [
  { label: '按仓库', value: 'repository' },
  { label: '按 tag', value: 'tag' },
];

/**
 * registry 侧的通知配置片段。刻意放在前端硬编码：
 * 它是 Distribution 的配置格式，不是本服务的接口契约，从后端取反而会把两件事耦合起来。
 */
const NOTIFY_CONFIG_YAML = `notifications:
  endpoints:
    - name: registry-manager
      url: http://registry-manager:8787/api/registry-events
      headers:
        Authorization: [Bearer <与 REGISTRY_NOTIFY_TOKEN 相同的密钥>]
      timeout: 2s
      threshold: 5
      backoff: 1s`;

export default function StatsPage({ config, onConfigChange }: Props) {
  const [days, setDays] = useState<StatsWindow>(30);
  const [topBy, setTopBy] = useState<StatsTopBy>('repository');
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [topItems, setTopItems] = useState<StatsTopItem[]>([]);
  const [points, setPoints] = useState<StatsSeriesPoint[]>([]);
  const [events, setEvents] = useState<StatsEventItem[]>([]);
  const [clients, setClients] = useState<StatsClientItem[]>([]);
  const [eventTotals, setEventTotals] = useState<StatsEvents['totals'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiResult<unknown> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * 「忽略这个客户端」的弹框。入口在「最近事件」每一行的「客户端」格子上 ——
   * 你要排掉某个客户端时，人正看着那条 UA，不该被赶到设置页去手动粘一遍。
   */
  const [ignoreModal, setIgnoreModal] = useState<{ open: boolean; suggested: string }>({
    open: false,
    suggested: '',
  });
  /**
   * 榜单的滚动容器。这一页下方还有趋势与最近事件，页面本身仍会滚动，
   * 所以这里给表格一个高度上限（.table-scroll--bounded）而不是让它吃掉整个视口。
   */
  const topWrapRef = useRef<HTMLDivElement>(null);

  const statsEnabled = config?.statsEnabled === true;

  /** 已经生效的规则（环境变量 ∪ 界面）。已经命中的客户端就不再给「忽略」入口。 */
  const ignoreRules = config?.statsIgnoreUseragents ?? [];
  const isIgnoredUa = (useragent: string) => {
    const value = String(useragent ?? '').toLowerCase();
    return value.length > 0 && ignoreRules.some((rule) => value.includes(rule.toLowerCase()));
  };

  /** 弹框里"会匹配到什么"的预览素材：当前缓冲里出现过的客户端。 */
  const knownUseragents = useMemo(
    () => [...new Set(events.map((event) => event.useragent).filter(Boolean))],
    [events]
  );

  /** 保存规则后：立刻重拉事件（新规则当场就生效），并把生效规则同步回配置。 */
  const handleIgnoreSaved = (rules: IgnoreRules) => {
    setIgnoreModal({ open: false, suggested: '' });
    if (config) {
      onConfigChange({ ...config, statsIgnoreUseragents: rules.effective });
    }
    setReloadKey((key) => key + 1);
  };

  // 配置由镜像列表页首屏拉取；直接进热度页（或刷新后停在热度页）时这里补一次。
  useEffect(() => {
    if (config) {
      return;
    }
    void (async () => {
      const result = await fetchConfig();
      if (result.success && result.data) {
        onConfigChange(result.data);
      }
    })();
  }, [config, onConfigChange]);

  useEffect(() => {
    if (!statsEnabled) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      // 四路并发：任何一路失败都不影响其它块渲染，缺哪块提示哪块。
      const [summaryResult, topResult, seriesResult, eventsResult, clientsResult] =
        await Promise.all([
          fetchStatsSummary(days),
          fetchStatsTop(days, topBy),
          // 日历固定看 12 个月，与上面的时间窗无关（原因见 HEATMAP_DAYS 的注释）。
          fetchStatsSeries(HEATMAP_DAYS),
          fetchStatsEvents(50),
          fetchStatsClients(days),
        ]);
      if (cancelled) {
        return;
      }
      if (summaryResult.success && summaryResult.data) {
        setSummary(summaryResult.data);
      }
      if (topResult.success && topResult.data) {
        setTopItems(topResult.data.items);
      }
      if (seriesResult.success && seriesResult.data) {
        setPoints(seriesResult.data.points);
      }
      if (eventsResult.success && eventsResult.data) {
        setEvents(eventsResult.data.items);
        setEventTotals(eventsResult.data.totals);
      }
      if (clientsResult.success && clientsResult.data) {
        setClients(clientsResult.data.items);
      }
      const failure = [summaryResult, topResult, seriesResult, eventsResult, clientsResult].find(
        (item) => !item.success
      );
      if (failure) {
        setError(failure);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [days, topBy, statsEnabled, reloadKey]);

  const topColumns: ColumnsType<StatsTopItem> = [
    {
      title: '仓库',
      dataIndex: 'repository',
      key: 'repository',
      sorter: (left, right) => left.repository.localeCompare(right.repository),
      render: (value: string) => (
        <Tooltip title={value}>
          <span className="ellipsis" style={{ display: 'block' }}>
            {value}
          </span>
        </Tooltip>
      ),
    },
    // by=tag 才有的列；by=repository 时整列不出现，避免一列全是 "—"。
    ...(topBy === 'tag'
      ? ([
          {
            title: 'Tag',
            dataIndex: 'tag',
            key: 'tag',
            width: 160,
            render: (value: string) => <span className="mono">{value || '—'}</span>,
          },
        ] as ColumnsType<StatsTopItem>)
      : []),
    {
      title: '合计',
      dataIndex: 'events',
      key: 'events',
      width: 100,
      defaultSortOrder: 'descend',
      sorter: (left, right) => left.events - right.events,
    },
    {
      title: '拉取',
      dataIndex: 'pull',
      key: 'pull',
      width: 100,
      sorter: (left, right) => left.pull - right.pull,
    },
    {
      title: '推送',
      dataIndex: 'push',
      key: 'push',
      width: 100,
      sorter: (left, right) => left.push - right.push,
    },
    {
      title: '最近活动',
      dataIndex: 'lastAt',
      key: 'lastAt',
      width: 170,
      sorter: (left, right) => (left.lastAt ?? '').localeCompare(right.lastAt ?? ''),
      render: (value: string | null) => formatDateTime(value),
    },
  ];

  /**
   * 「见过的客户端」列。
   *
   * 这一块存在的理由：200 条的「最近事件」实测只覆盖最近十几小时，而且重启就空 ——
   * 一个一天只来一次的客户端，你还没打开页面它就已经被挤出去了，但热度每天都在被它污染。
   * 按 UA 聚合之后行数与事件量无关（现实里十几个），所以"有没有我没见过的在打"随时答得上来。
   */
  const clientColumns: ColumnsType<StatsClientItem> = [
    {
      title: '客户端',
      dataIndex: 'useragent',
      key: 'useragent',
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip title={value}>
          <span className="mono ellipsis" style={{ display: 'block' }}>
            {value || '—'}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '事件数',
      dataIndex: 'events',
      key: 'events',
      width: 90,
      sorter: (left, right) => left.events - right.events,
    },
    {
      title: '计入',
      dataIndex: 'counted',
      key: 'counted',
      width: 90,
      sorter: (left, right) => left.counted - right.counted,
      // 一条都没计入 = 已经被规则排掉了，弱化显示；有计入的才是"正在影响热度"的。
      render: (value: number, record) =>
        value > 0 ? (
          <span style={{ color: 'var(--color-text-1)' }}>{value}</span>
        ) : (
          <Tooltip title={record.self ? '本工具自己的读取请求，本来就不计入' : '全部被忽略规则排掉了'}>
            <span style={{ color: 'var(--color-text-4)' }}>0</span>
          </Tooltip>
        ),
    },
    {
      title: '首次见到',
      dataIndex: 'firstSeenAt',
      key: 'firstSeenAt',
      width: 170,
      sorter: (left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt),
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '最近见到',
      dataIndex: 'lastSeenAt',
      key: 'lastSeenAt',
      width: 170,
      defaultSortOrder: 'descend',
      sorter: (left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt),
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, record) => {
        if (record.self) {
          return <span style={{ color: 'var(--color-text-4)', fontSize: 12 }}>本工具</span>;
        }
        if (isIgnoredUa(record.useragent)) {
          return <Tag style={{ marginInlineEnd: 0 }}>已忽略</Tag>;
        }
        return (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto' }}
            onClick={() => setIgnoreModal({ open: true, suggested: record.useragent.split(' ')[0] })}
          >
            忽略
          </Button>
        );
      },
    },
  ];

  const eventColumns: ColumnsType<StatsEventItem> = [
    {
      title: '收到时间',
      dataIndex: 'at',
      key: 'at',
      width: 160,
      render: (value: string, record) => (
        // registry 的事件时间戳小数位不固定，原样放在悬停里，不做截断。
        <Tooltip title={`事件时间：${record.eventAt || '—'}`}>
          <span>{formatDateTime(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'action',
      dataIndex: 'action',
      key: 'action',
      width: 90,
      render: (value: string) => (
        <Tag color={value === 'push' ? 'green' : value === 'pull' ? 'blue' : 'default'}>
          {value || '—'}
        </Tag>
      ),
    },
    { title: 'method', dataIndex: 'method', key: 'method', width: 90, render: monoOrDash },
    {
      title: 'mediaType',
      dataIndex: 'mediaType',
      key: 'mediaType',
      width: 210,
      /*
       * `ellipsis` 必须写在**列**上，不能只靠单元格里那个 `.ellipsis` 类。
       * 表格是 auto 布局（没有它 AntD 就不会切到 fixed），auto 布局下长且不可折行的
       * 内容会把列撑到自身宽度、把 `width` 当摆设 —— 结果是整张表横向滚动，
       * 最右边的「是否计入」被推出视野。实测：mediaType 声明 240 实际撑到 454。
       * `showTitle: false` 是因为下面已经有内容更全的自定义 Tooltip，不要再来一个原生的。
       */
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip title={value || '—'}>
          <span className="mono ellipsis" style={{ display: 'block' }}>
            {value || '—'}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '仓库',
      dataIndex: 'repository',
      key: 'repository',
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip title={value || '—'}>
          <span className="ellipsis" style={{ display: 'block' }}>
            {value || '—'}
          </span>
        </Tooltip>
      ),
    },
    { title: 'tag', dataIndex: 'tag', key: 'tag', width: 130, render: monoOrDash },
    {
      title: '客户端',
      dataIndex: 'useragent',
      key: 'useragent',
      width: 210,
      ellipsis: { showTitle: false },
      /*
       * 排查"热度是不是被自动化进程刷高了"的关键一列：真人用 docker CLI，
       * 同步工具用 regclient / skopeo，User-Agent 一眼分得开。
       * 另外三个身份字段（来源 addr / host / actor）放在悬停里 —— 它们通常没有区分度
       * （端口映射下 addr 是网桥网关、未开认证时 actor 为空），占一整列不值当。
       */
      render: (value: string, record) => {
        const detail = [
          `User-Agent：${record.useragent || '—'}`,
          `来源：${record.addr || '—'}`,
          `Host：${record.host || '—'}`,
          `账号：${record.actor || '（未认证）'}`,
        ].join('\n');
        // 已经被某条规则命中的，就不再给入口 —— 重复加只会让人以为没生效。
        const already = isIgnoredUa(record.useragent);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{detail}</span>}>
              <span className="mono ellipsis" style={{ flex: '1 1 auto', minWidth: 0 }}>
                {value || '—'}
              </span>
            </Tooltip>
            {value && !already ? (
              <Tooltip title="以后不再统计这个客户端的热度">
                <Button
                  type="link"
                  size="small"
                  style={{ flex: 'none', padding: 0, height: 'auto' }}
                  onClick={() => setIgnoreModal({ open: true, suggested: value.split(' ')[0] })}
                >
                  忽略
                </Button>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      title: '是否计入',
      key: 'counted',
      width: 260,
      ellipsis: { showTitle: false },
      render: (_, record) =>
        record.counted ? (
          <Tag color="green">计入</Tag>
        ) : (
          /*
           * 用 Fragment 而不是 <Space>：Space 是 inline-flex，`flex-wrap: nowrap` 下长
           * reason 既不会折行也不会收缩，会把单元格撑出表格、逼出整表横向滚动
           * （实测 `IGNORED_USERAGENT:regclient/regsync` 撑出 80px）。
           * 普通行内流 + `.reason-text` 的 overflow-wrap 才能正常折行。
           */
          <>
            <Tag color="default">未计入</Tag>
            {/* 去重丢弃的事件 reason 仍是 OK，直接显示会让用户以为是误报。 */}
            <span className="reason-text" style={{ color: 'var(--color-text-3)' }}>
              {record.duplicate ? '重复投递，已按 event.id 去重' : readReason(record.reason)}
            </span>
          </>
        ),
    },
  ];

  const header = (
    <div className="page-header">
      <div>
        <h2 className="page-title">镜像热度</h2>
        {/* 只写"这页能做什么"。数字的统计口径（哪些事件计入、为什么）属于设计说明，
            见 docs/design.md §3.3。 */}
        <p className="page-subtitle">统计每个仓库与 tag 被推送、拉取的次数。</p>
      </div>
      <div className="page-actions">
        {statsEnabled ? (
          <Segmented
            options={WINDOW_OPTIONS}
            value={days}
            onChange={(value) => setDays(value as StatsWindow)}
          />
        ) : null}
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          刷新
        </Button>
      </div>
    </div>
  );

  if (!config) {
    return (
      <div className="page">
        {header}
        <div className="panel" style={{ padding: 16 }}>
          <Empty description="正在读取服务配置…" />
        </div>
      </div>
    );
  }

  /**
   * 「为什么没有热度数据」的分档说明。
   *
   * 注意 statsEnabled = 统计库可用 && 开关打开，因此**缺密钥并不会让 statsEnabled 变 false**
   * —— 那种情况会以 total === 0 的形式出现在已启用路径上。所以同一个解释要同时服务
   * 「未启用」和「已启用但窗口内没有数据」两处，避免只在其中一边给出正确原因。
   */
  const notice = statsNotice(config);

  // 未启用：按原因解释，并始终给出 registry 侧配置片段。绝不报错。
  if (!config.statsEnabled) {
    return (
      <div className="page">
        {header}
        <Alert
          type={notice.type}
          showIcon
          message={notice.message}
          description={notice.description}
        />
        <div className="panel" style={{ padding: 16 }}>
          <h3 className="stats-panel-title">registry 侧需要这样配</h3>
          <NotifyConfigSnippet />
        </div>
      </div>
    );
  }

  const empty = summary !== null && summary.total === 0;

  return (
    <div className="page">
      {header}

      {error?.message ? (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setError(null)}
          message={`部分热度数据未能加载：${error.message}`}
          description={
            <span>
              镜像列表与其它功能不受影响。若服务刚重启，稍后点「刷新」即可。
              {error.code ? `（错误分类：${error.code}）` : ''}
            </span>
          }
        />
      ) : null}

      <div className="metric-grid">
        <MetricCard
          icon={<ThunderboltOutlined />}
          label={`事件总数（${days} 天）`}
          value={summary?.total ?? 0}
        />
        <MetricCard
          icon={<CloudDownloadOutlined />}
          label="拉取次数"
          value={summary?.pull ?? 0}
        />
        <MetricCard
          icon={<CloudUploadOutlined />}
          iconColor="var(--color-success)"
          iconBackground="var(--color-fill-2)"
          label="推送次数"
          value={summary?.push ?? 0}
        />
        <MetricCard
          icon={<DatabaseOutlined />}
          iconColor="var(--color-text-3)"
          iconBackground="var(--color-fill-2)"
          label="有活动的仓库数"
          value={summary?.repositories ?? 0}
        />
      </div>

      {empty ? (
        <Alert
          type={notice.type}
          showIcon
          message={notice.message}
          description={
            <div>
              <div>{notice.description}</div>
              <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                所选 {days} 天窗口内没有符合口径的事件，下面的「最近事件」能看到 registry
                到底发过什么。
              </div>
              {/* 已经能用了，配置片段就别再占显眼位置；需要时展开。 */}
              <Collapse
                ghost
                style={{ marginTop: 8 }}
                items={[
                  {
                    key: 'notify-config',
                    label: '怀疑 registry 没配 notifications？查看配置片段',
                    children: <NotifyConfigSnippet />,
                  },
                ]}
              />
            </div>
          }
        />
      ) : null}

      {!empty ? (
        <div className="panel" style={{ padding: 16 }}>
          <div className="stats-panel-head">
            <h3 className="stats-panel-title">Top 榜单</h3>
            <Segmented
              options={BY_OPTIONS}
              value={topBy}
              onChange={(value) => setTopBy(value as StatsTopBy)}
            />
          </div>
          {/* 榜单自己滚、表头粘住，避免翻页/翻列表时把上面的时间窗与 KPI 顶走。 */}
          <div className="table-scroll table-scroll--bounded" ref={topWrapRef}>
            <Table<StatsTopItem>
              /*
               * rowKey 必须**与 topBy 无关**。
               *
               * 早先写成 `topBy === 'tag' ? repo:tag : repo`：切换维度时同一个 record 的 key
               * 会变，React 无法正确协调，表现为**旧行留在 DOM 里** ——
               * 分页器显示"共 8 项"而 DOM 里有 16 行、`data-row-key` 重复，
               * 界面看到的就是"Tag 列错位/空白"，而且每切换一次就多留一批。
               * 用 \u0000 拼接：两种维度下都唯一，且切换维度时不变。
               */
              rowKey={(record) => `${record.repository}\u0000${record.tag ?? ''}`}
              size="middle"
              loading={loading}
              columns={topColumns}
              dataSource={topItems}
              scroll={{ x: 800 }}
              sticky={{ getContainer: () => topWrapRef.current ?? window }}
              pagination={{
                size: 'small',
                showSizeChanger: false,
                defaultPageSize: 20,
                showTotal: (total) => `共 ${total} 项`,
              }}
              locale={{ emptyText: <Empty description="该时间窗内没有可排行的数据" /> }}
            />
          </div>
        </div>
      ) : null}

      <div className="panel" style={{ padding: 16 }}>
        <h3 className="stats-panel-title">按天趋势（近 12 个月）</h3>
        <ContributionHeatmap
          points={points}
          days={HEATMAP_DAYS}
          retentionDays={config?.statsRetentionDays ?? null}
        />
      </div>

      {/*
        放在「最近事件」**上面**：这一块才是"谁在打"的答案（不受 200 条窗口限制、
        重启也不丢），下面那个回答的是"最近发生了什么细节"。
      */}
      <div className="panel" style={{ padding: 16 }}>
        <div className="stats-panel-head">
          <h3 className="stats-panel-title">见过的客户端（近 {days} 天）</h3>
          <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
            「计入 0」= 收到过但被规则排掉了；这一行不存在才是真的没来过
          </span>
        </div>
        <Table<StatsClientItem>
          rowKey="useragent"
          size="small"
          loading={loading}
          columns={clientColumns}
          dataSource={clients}
          pagination={{
            size: 'small',
            hideOnSinglePage: true,
            defaultPageSize: 10,
            showTotal: (total) => `共 ${total} 个客户端`,
          }}
          locale={{ emptyText: <Empty description="这个时间窗内还没收到任何事件" /> }}
        />
      </div>

      <Collapse
        items={[
          {
            key: 'events',
            label: (
              <Space size={8} wrap>
                <span>最近事件（排查用）</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                  计入 {eventTotals?.accepted ?? 0} / 未计入 {eventTotals?.rejected ?? 0}
                </span>
                {/*
                  服务端自身请求（它的 User-Agent 是 registry-manager/<版本>）单列一个数字。
                  不列出来的话，一次「重新扫描」就会按 tag 数量产生一批事件（实测 178 条），
                  把这张表冲成自己的噪音 —— 真正要查的东西反而看不见了。
                */}
                {eventTotals?.self ? (
                  <Tooltip title="服务端自己发往 registry 的读取请求（重新扫描时按 tag 读 manifest 与 image config，一次上百条）。它们永远不计入热度，纯噪音，所以折叠成一个数字。注意：服务端自己**计入热度**的那些（用「镜像拉取」搬进来的 manifest）照常列在下方。">
                    <span style={{ fontSize: 12, color: 'var(--color-text-4)' }}>
                      自身读取 {eventTotals.self} 条
                    </span>
                  </Tooltip>
                ) : null}
                {eventTotals?.ignored ? (
                  <Tooltip title="已被忽略规则排掉的事件：既不计入热度，也不再占这个 200 条的窗口（窗口实测只覆盖最近十几小时，该留给你还没处理过的客户端）。它们的账在上面「见过的客户端」里。">
                    <span style={{ fontSize: 12, color: 'var(--color-text-4)' }}>
                      已忽略折叠 {eventTotals.ignored} 条
                    </span>
                  </Tooltip>
                ) : null}
                {/*
                  把"忽略了哪些客户端"写在这里，是为了让配置**看得见**：
                  否则"规则生效了所以热度不涨"和"规则没读到所以热度不涨"长得一样。
                  被忽略的事件仍然留在下面这张表里（reason 写着 IGNORED_USERAGENT），
                  这样"被排掉了"和"事件根本没到"才分得清。
                */}
                {config?.statsIgnoreUseragents?.length ? (
                  <Tooltip title="这些客户端的事件不计入热度（REGISTRY_STATS_IGNORE_USERAGENTS）">
                    <Tag color="default" style={{ marginInlineEnd: 0 }}>
                      已忽略：{config.statsIgnoreUseragents.join('、')}
                    </Tag>
                  </Tooltip>
                ) : null}
              </Space>
            ),
            children: (
              <Table<StatsEventItem>
                rowKey={(record) => `${record.at}-${record.id}`}
                size="small"
                loading={loading}
                columns={eventColumns}
                dataSource={events}
                scroll={{ x: 1000 }}
                pagination={{
                  size: 'small',
                  defaultPageSize: 10,
                  pageSizeOptions: [10, 20, 50],
                  showSizeChanger: true,
                  showTotal: (total) => `共 ${total} 条`,
                }}
                locale={{ emptyText: <Empty description="还没收到任何事件" /> }}
              />
            ),
          },
        ]}
      />

      <IgnoreRuleModal
        open={ignoreModal.open}
        suggested={ignoreModal.suggested}
        knownUseragents={knownUseragents}
        onCancel={() => setIgnoreModal({ open: false, suggested: '' })}
        onSaved={handleIgnoreSaved}
      />
    </div>
  );
}

/**
 * 「为什么没有热度数据」。按原因分档，因为处置方式完全不同：
 * 库坏了要找服务端看数据目录，开关关了要改环境变量，没配密钥要两边配同一个值，
 * 而一切就绪时可能只是真的没人用 —— 最后一种不能断言用户配错。
 */
function statsNotice(config: AppConfig): {
  type: 'warning' | 'info';
  message: string;
  description: ReactNode;
} {
  const statsError = config.statsError;

  if (statsError) {
    return {
      type: 'warning',
      message: '热度统计不可用：统计库初始化失败',
      description: (
        <div>
          <div>{statsError.message}</div>
          <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
            错误分类：<span className="mono">{statsError.code}</span>
            。这是服务端数据目录或磁盘的问题（与 registry 配置无关）；修复后重启服务即可开始统计。
          </div>
        </div>
      ),
    };
  }

  if (!config.allowRegistryEvents) {
    return {
      type: 'warning',
      message: '服务端已关闭热度事件接收',
      description: (
        <div>
          <div>
            服务端设置了 <span className="mono">REGISTRY_ALLOW_REGISTRY_EVENTS=false</span>
            ，registry 推来的事件会被直接拒绝（HTTP 503），因此不会有任何热度数据。
          </div>
          <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
            需要热度就把这个变量改成 <span className="mono">true</span> 后重启服务。
          </div>
        </div>
      ),
    };
  }

  if (!config.notifyTokenConfigured) {
    return {
      type: 'warning',
      message: '还没配置事件共享密钥（REGISTRY_NOTIFY_TOKEN）',
      description: (
        <div>
          <div>
            没有密钥时服务端会拒绝<strong>全部</strong>事件（HTTP 401）—— 这是刻意的安全默认值，
            因为事件接口只能靠共享密钥鉴权。所以「事件到了但一条都没算」通常是这个原因。
          </div>
          <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
            在服务端设置 <span className="mono">REGISTRY_NOTIFY_TOKEN</span>，并在 registry 的
            notifications 里填<strong>同一个值</strong>，重启两边后开始统计。
          </div>
        </div>
      ),
    };
  }

  return {
    type: 'info',
    message: '还没收到任何热度事件',
    description: (
      <div>
        <div>
          事件接收的三个前提都满足了（开关打开、密钥已配、统计库可用），但一条事件都没进来。
          可能是 registry 还没配 notifications，也可能最近确实没有人 push / pull ——
          这两种情况在界面上完全一样，不要据此断定用户配错了。
        </div>
        <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
          {config.statsSince
            ? `服务端最早的数据是 ${config.statsSince}，可能不在当前时间窗内，可以切到 90 天看看。`
            : '排查顺序：确认 registry 已重启并加载了下面的配置 → 随便拉一个镜像 → 回本页点「刷新」。'}
        </div>
      </div>
    ),
  };
}

/** 可复制的 registry notifications 配置片段 + 重启提醒。 */
function NotifyConfigSnippet() {
  return (
    <div>
      <div className="stats-code-head">
        <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
          registry 容器的 config.yml（片段）
        </span>
        <TextCopyButton text={NOTIFY_CONFIG_YAML} />
      </div>
      <pre className="stats-code mono">{NOTIFY_CONFIG_YAML}</pre>
      <div style={{ marginTop: 8, color: 'var(--color-text-3)' }}>
        <strong>改完必须重启 registry 容器</strong> —— Distribution 没有配置热重载，
        不重启配置不会生效，也不会有任何报错。
      </div>
    </div>
  );
}

/**
 * 只带复制按钮的 Typography.Text。
 * `navigator.clipboard` 在非安全上下文不存在，AntD 内部已带 execCommand 回退。
 */
function TextCopyButton({ text }: { text: string }) {
  return (
    <Typography.Text
      copyable={{ text, tooltips: ['复制配置', '已复制'] }}
      style={{ color: 'var(--color-text-3)' }}
    />
  );
}

/** 空值统一显示成 —，避免空白单元格看起来像渲染失败。 */
function monoOrDash(value: string) {
  return <span className="mono">{value || '—'}</span>;
}

/**
 * 把服务端的 `reason` 翻成人话。
 *
 * 只有被排除的客户端需要翻译：原样显示是 `IGNORED_USERAGENT:regclient/regsync`，
 * 又长又难读，还会把单元格撑爆。**数据里保留完整的 reason**（排查时要 grep 它、
 * 接口也要能读），只在界面上换个说法 —— 命中的规则片段照旧带出来，
 * 否则用户看不出是哪条规则生效了。
 */
function readReason(reason: string) {
  const ignored = /^IGNORED_USERAGENT:(.+)$/.exec(reason ?? '');
  if (ignored) {
    return `已忽略客户端 ${ignored[1]}`;
  }
  return reason || '未知原因';
}
