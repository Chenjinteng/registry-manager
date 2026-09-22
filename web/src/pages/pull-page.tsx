import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Collapse,
  Empty,
  Form,
  Input,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  DownOutlined,
  HourglassOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import {
  cancelPullJob,
  createPullJob,
  fetchConfig,
  listPullJobs,
  removePullJob,
} from '../api';
import type {
  ApiResult,
  AppConfig,
  PullJob,
  PullJobInput,
  PullJobStatus,
  PullPhase,
} from '../types';
import { formatBytes, formatDateTime, parseImageReference, shortDigest } from '../utils';

interface Props {
  config: AppConfig | null;
}

interface FormValues {
  image: string;     // 用户输入的镜像名（可能含主机前缀）
  destRepo?: string;
  destTag?: string;
  sourceUrl?: string;  // 高级选项：留空时由 image 自动推断
  sourceProxy?: string; // 高级选项：本任务的来源代理
}

const POLL_INTERVAL_MS = 1500;

/**
 * 从 `<repo>[:<tag>]` 字符串里取出 repo 部分。
 *
 * - `library/alpine:3.19` → `library/alpine`
 * - `alpine:3.19`        → `alpine`
 * - `alpine`             → `alpine`
 *
 * 后端会再做合法性校验，这里只是给 destRepo 一个 fallback。
 */
function defaultDestRepoFromRef(ref: string): string {
  const colon = ref.lastIndexOf(':');
  const candidate = colon >= 0 && !ref.slice(colon + 1).includes('/') ? ref.slice(0, colon) : ref;
  return candidate.replace(/^\/+/, '').trim();
}

/**
 * 失败 / 取消的任务行默认展开，方便用户直接看到错误原因。
 */
function defaultExpandedKeys(jobs: PullJob[]): string[] {
  return jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').map((j) => j.id);
}

/**
 * 把后端稳定的 code 翻译成一句"运维能直接照做"的提示。
 * 摘要放在表格行内，全文在展开区；这里只保留一句最重要的根因。
 */
function failureHint(job: PullJob): string {
  const code = job.errorCode ?? '';
  switch (code) {
    case 'SOURCE_UNREACHABLE':
    case 'CONNECTION_FAILED':
      return '源 registry 连不上，请检查地址 / 代理';
    case 'SOURCE_UNAUTHORIZED':
      return '源 registry 要求认证，本工具不支持';
    case 'SOURCE_MANIFEST_NOT_FOUND':
      return '源镜像 / tag 不存在';
    case 'SOURCE_BLOB_NOT_FOUND':
      return '源 blob 缺失，镜像不完整';
    case 'SOURCE_HTTP_FAILED':
      return '源 registry 响应异常';
    case 'SOURCE_MANIFEST_INVALID':
      return '源 manifest 解析失败';
    case 'INVALID_URL':
    case 'INVALID_REQUEST':
      return '输入参数不合法';
    case 'DEST_FORBIDDEN':
      return '目的 registry 拒绝写入';
    case 'BLOB_UPLOAD_FAILED':
    case 'BLOB_MOUNT_FAILED':
    case 'BLOB_UPLOAD_INIT_FAILED':
      return '目的 blob 上传失败';
    case 'MANIFEST_PUT_FAILED':
      return '目的 manifest 落库失败';
    case 'CANCELLED':
      return '已取消';
    case 'JOB_NOT_FOUND':
      return '任务不存在';
    case 'PULL_DISABLED':
      return '服务端禁止拉取（allowPull=false）';
    default:
      // 没识别出来的 code：把后端原始 message 兜底展示。
      return job.errorMessage ?? '失败原因未知';
  }
}

const STATUS_META: Record<
  PullJobStatus,
  { label: string; color: string; icon: React.ReactNode }
> = {
  queued: { label: '排队中', color: 'default', icon: <HourglassOutlined /> },
  running: { label: '拉取中', color: 'processing', icon: <LoadingOutlined /> },
  succeeded: { label: '已完成', color: 'success', icon: <CheckCircleOutlined /> },
  failed: { label: '失败', color: 'error', icon: <CloseCircleOutlined /> },
  cancelled: { label: '已取消', color: 'warning', icon: <PauseCircleOutlined /> },
};

export default function PullPage({ config }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [jobs, setJobs] = useState<PullJob[]>([]);
  const [error, setError] = useState<ApiResult<unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const liveConfigRef = useRef<AppConfig | null>(config);
  liveConfigRef.current = config;

  const refresh = useCallback(async () => {
    const result = await listPullJobs();
    if (result.success && result.data) {
      setJobs(result.data);
      setError(null);
    } else {
      setError(result);
    }
  }, []);

  // 首屏 + 配置就绪后拉一次；后续只在有未完成任务时持续轮询。
  const hasActive = useMemo(
    () => jobs.some((job) => job.status === 'running' || job.status === 'queued'),
    [jobs]
  );
  useEffect(() => {
    void refresh();
    if (!config) {
      void fetchConfig().then((result) => {
        if (result.success && result.data) {
          liveConfigRef.current = result.data;
        }
      });
    }
  }, [refresh, config]);

  useEffect(() => {
    if (!hasActive) {
      return undefined;
    }
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActive, refresh]);

  const runningJob = useMemo(() => jobs.find((job) => job.status === 'running'), [jobs]);
  const queuedJobs = useMemo(
    () => jobs.filter((job) => job.status === 'queued'),
    [jobs]
  );

  const handleSubmit = async (values: FormValues) => {
    if (config && !config.allowPull) {
      message.warning('当前为禁止拉取模式（allowPull=false），无法创建任务');
      return;
    }
    const image = values.image?.trim();
    if (!image) {
      message.error('请填写镜像名');
      return;
    }
    // 智能解析：用户写 `ghcr.io/owner/repo:tag` 这种含主机前缀的引用，
    // 自动拆出 sourceUrl；写 `alpine:3.19` / `library/alpine:3.19` 默认走 docker.io。
    // 高级选项里的 sourceUrl 仅在用户显式覆盖时生效。
    const parsed = parseImageReference(image);
    const sourceUrlEffective = values.sourceUrl?.trim() || parsed.sourceUrl;
    const sourceRefEffective = parsed.sourceRef || image;

    // destRepo：留空沿用源 repo；用户在表里可显式改成别的。
    const destRepo = values.destRepo?.trim() || defaultDestRepoFromRef(sourceRefEffective);

    setSubmitting(true);
    try {
      const input: PullJobInput = {
        sourceUrl: sourceUrlEffective,
        sourceRef: sourceRefEffective,
        destRepo,
        destTag: values.destTag?.trim() || undefined,
        sourceProxy: values.sourceProxy?.trim() || undefined,
      };
      const result = await createPullJob(input);
      if (!result.success) {
        setError(result);
        message.error(result.message || '创建任务失败');
        return;
      }
      message.success(
        `已加入队列：从 ${input.sourceUrl} 拉取 ${input.sourceRef} → ${input.destRepo}`
      );
      form.resetFields();
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (job: PullJob) => {
    const result = await cancelPullJob(job.id);
    if (!result.success) {
      message.error(result.message || '取消失败');
      return;
    }
    message.info('已请求取消，正在传输的 chunk 会写完再退出');
    await refresh();
  };

  const handleRemove = (job: PullJob) => {
    modal.confirm({
      title: '从历史中移除该任务？',
      content: '不会删除已落库的镜像，仅清理任务记录。',
      okText: '移除',
      cancelText: '取消',
      onOk: async () => {
        const result = await removePullJob(job.id);
        if (!result.success) {
          message.error(result.message || '移除失败');
          return;
        }
        await refresh();
      },
    });
  };

  const columns: ColumnsType<PullJob> = [
    {
      title: '来源',
      key: 'source',
      width: 280,
      render: (_, job) => (
        <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
          <Tooltip title={job.sourceUrl}>
            <span className="mono ellipsis" style={{ maxWidth: 260, display: 'inline-block' }}>
              {job.sourceUrl.replace(/^https?:\/\//i, '')}
            </span>
          </Tooltip>
          <span className="mono ellipsis" style={{ color: 'var(--color-text-3)' }}>
            {job.sourceRepo}:{job.sourceTag}
          </span>
        </Space>
      ),
    },
    {
      title: '目标',
      key: 'dest',
      width: 200,
      render: (_, job) => (
        <Tooltip title={`${job.destRepo}:${job.destTag}`}>
          <span className="mono ellipsis" style={{ maxWidth: 180, display: 'inline-block' }}>
            {job.destRepo}:{job.destTag}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 200,
      render: (_, job) => {
        const meta = STATUS_META[job.status];
        const failureReason = job.errorMessage ? failureHint(job) : null;
        return (
          <Space direction="vertical" size={2} style={{ lineHeight: 1.3 }}>
            <Tag color={meta.color} icon={meta.icon} style={{ margin: 0 }}>
              {meta.label}
            </Tag>
            {failureReason ? (
              <Tooltip title={failureReason}>
                <span style={{ fontSize: 12, color: 'var(--color-text-3)' }} className="ellipsis">
                  {failureReason}
                </span>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '进度',
      key: 'progress',
      width: 220,
      render: (_, job) => <JobProgress job={job} />,
    },
    {
      title: '提交于',
      key: 'createdAt',
      width: 150,
      render: (_, job) => (
        <Tooltip title={job.createdAt}>{formatDateTime(job.createdAt)}</Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, job) => (
        <Space size={4}>
          {job.status === 'running' || job.status === 'queued' ? (
            <Button
              type="link"
              size="small"
              icon={<StopOutlined />}
              onClick={() => void handleCancel(job)}
            >
              取消
            </Button>
          ) : null}
          <Button type="link" size="small" onClick={() => void handleRemove(job)}>
            移除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">镜像拉取</h2>
          <p className="page-subtitle">
            像 <code>docker pull</code> 一样贴一个镜像名就可以拉取。源在公网或受限网段时，
            在「高级选项」里填一个来源代理（仅作用于本次任务）。
          </p>
        </div>
      </div>

      {error?.message ? (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setError(null)}
          message={error.message}
          description={error.code ? `错误分类：${error.code}` : undefined}
        />
      ) : null}

      {config && !config.allowPull ? (
        <Alert
          type="info"
          showIcon
          message="当前为禁止拉取模式（allowPull=false），仅可查看历史任务。"
        />
      ) : null}

      <div className="panel" style={{ padding: 16 }}>
        <Form<FormValues>
          form={form}
          layout="vertical"
          initialValues={{ image: 'library/alpine:3.19' }}
          onFinish={handleSubmit}
          disabled={Boolean(config && !config.allowPull)}
        >
          <Form.Item
            label="镜像名"
            name="image"
            extra="支持任意 docker pull 引用：alpine:3.19、library/alpine:3.19、ghcr.io/owner/img:1.0、192.0.2.10:10001/example/x:1 等。"
            rules={[
              { required: true, message: '请填写镜像名' },
              {
                validator: (_, value: string) =>
                  value.includes(':')
                    ? Promise.resolve()
                    : Promise.reject(new Error('需要形如 <repo>:<tag>')),
              },
            ]}
          >
            <Input placeholder="alpine:3.19" allowClear autoFocus />
          </Form.Item>
          <div className="pull-form-grid">
            <Form.Item
              label="目标仓库（留空沿用源仓库名）"
              extra="同名仓库已存在时会落到同一仓库下，不会覆盖已有 tag。"
              rules={[
                {
                  validator: (_, value: string | undefined) =>
                    !value ||
                    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
                      value
                    )
                      ? Promise.resolve()
                      : Promise.reject(new Error('仓库名仅允许小写字母、数字、._-/')),
                },
              ]}
            >
              <Input placeholder="library/alpine" allowClear />
            </Form.Item>
            <Form.Item
              label="目标 Tag（留空沿用源 tag）"
              rules={[
                {
                  validator: (_, value: string | undefined) =>
                    !value || /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(value)
                      ? Promise.resolve()
                      : Promise.reject(new Error('tag 仅允许字母数字 ._-')),
                },
              ]}
            >
              <Input placeholder="3.19" allowClear />
            </Form.Item>
          </div>
          <Collapse
            ghost
            expandIcon={({ isActive }) => (
              <DownOutlined rotate={isActive ? 180 : 0} style={{ fontSize: 12 }} />
            )}
            items={[
              {
                key: 'advanced',
                label: '高级选项（来源地址 / 来源代理）',
                children: (
                  <div className="pull-form-grid">
                    <Form.Item
                      label="来源 registry 地址"
                      extra="留空时按镜像名前缀自动推断：含主机段则用该主机；否则默认 Docker Hub。"
                      rules={[
                        {
                          validator: (_, value: string | undefined) =>
                            !value || /^https?:\/\//i.test(value.trim())
                              ? Promise.resolve()
                              : Promise.reject(new Error('需要以 http:// 或 https:// 开头')),
                        },
                      ]}
                    >
                      <Input placeholder="自动推断" allowClear />
                    </Form.Item>
                    <Form.Item
                      label="来源代理（可选）"
                      extra="仅作用于本次任务的源端；目的端走服务配置的代理。"
                      rules={[
                        {
                          validator: (_, value: string | undefined) =>
                            !value || /^https?:\/\//i.test(value.trim())
                              ? Promise.resolve()
                              : Promise.reject(new Error('需要以 http:// 或 https:// 开头')),
                        },
                      ]}
                    >
                      <Input placeholder="http://proxy.example.com:8080" allowClear />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />
          <Space>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              htmlType="submit"
              loading={submitting}
              disabled={Boolean(config && !config.allowPull)}
            >
              加入队列
            </Button>
            <Tooltip title="单并发：当前任务完成后才会启动下一个">
              <Tag icon={<CloudDownloadOutlined />} color="default">
                单并发 / FIFO
              </Tag>
            </Tooltip>
          </Space>
        </Form>
      </div>

      {runningJob ? (
        <div className="panel" style={{ padding: 16 }}>
          <div className="pull-running-head">
            <strong>当前任务</strong>
            <span className="mono ellipsis" style={{ color: 'var(--color-text-3)' }}>
              {runningJob.sourceRepo}:{runningJob.sourceTag} → {runningJob.destRepo}:{runningJob.destTag}
            </span>
          </div>
          <JobProgress job={runningJob} detailed />
          <div style={{ marginTop: 12 }}>
            <Button
              icon={<StopOutlined />}
              danger
              onClick={() => void handleCancel(runningJob)}
            >
              优雅取消
            </Button>
            <span style={{ marginLeft: 12, color: 'var(--color-text-3)', fontSize: 12 }}>
              取消时，正在传输的 chunk 会写完再退出；目的端不会留下半截 manifest。
            </span>
          </div>
        </div>
      ) : null}

      {queuedJobs.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message={`排队中 ${queuedJobs.length} 个任务`}
          description={
            <span>
              {queuedJobs
                .slice(0, 3)
                .map(
                  (job) =>
                    `${job.sourceRepo}:${job.sourceTag} → ${job.destRepo}:${job.destTag}`
                )
                .join('、')}
              {queuedJobs.length > 3 ? ` 等 ${queuedJobs.length} 个` : ''}
            </span>
          }
        />
      ) : null}

      <div className="panel">
        <Table<PullJob>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={jobs}
          scroll={{ x: 1000 }}
          pagination={false}
          expandable={{
            expandedRowRender: (job) => <JobPhases job={job} />,
            rowExpandable: (job) => job.status === 'failed' || job.status === 'cancelled',
            defaultExpandAllRows: false,
            expandedRowKeys: defaultExpandedKeys(jobs),
          }}
          locale={{
            emptyText: (
              <Empty description="还没有任务，填写上方表单加入第一个" />
            ),
          }}
        />
      </div>
    </div>
  );
}

function JobProgress({ job, detailed = false }: { job: PullJob; detailed?: boolean }) {
  const total = job.totalBytes ?? 0;
  const percent =
    total > 0 ? Math.min(100, Math.round((job.bytes / total) * 100)) : job.status === 'succeeded' ? 100 : 0;
  const currentPhase = job.phases.find((phase) => phase.status === 'running');
  return (
    <Space direction="vertical" size={4} style={{ width: detailed ? '100%' : 'auto' }}>
      <Progress
        percent={percent}
        size="small"
        status={
          job.status === 'failed'
            ? 'exception'
            : job.status === 'cancelled'
            ? 'normal'
            : job.status === 'succeeded'
            ? 'success'
            : 'active'
        }
        showInfo={false}
        style={detailed ? { width: '100%' } : undefined}
      />
      <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
        {formatBytes(job.bytes)}
        {total > 0 ? ` / ${formatBytes(total)}` : ''}
        {currentPhase ? ` · 正在 ${phaseLabel(currentPhase)}` : ''}
      </span>
      {detailed && currentPhase?.message ? (
        <span style={{ fontSize: 12, color: 'var(--color-text-3)' }} className="mono">
          {currentPhase.message}
        </span>
      ) : null}
    </Space>
  );
}

function JobPhases({ job }: { job: PullJob }) {
  if (!job.phases.length) {
    return null;
  }
  return (
    <div className="pull-phase-list">
      {job.phases.map((phase, index) => (
        <div key={`${phase.name}-${index}`} className="pull-phase-row">
          <Tag color={phaseStatusColor(phase.status)} style={{ minWidth: 80, textAlign: 'center' }}>
            {phaseLabel(phase)}
          </Tag>
          <Tooltip title={phase.digest}>
            <span className="mono ellipsis" style={{ maxWidth: 320 }}>
              {phase.digest ? shortDigest(phase.digest) : '—'}
            </span>
          </Tooltip>
          <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>
            {phase.totalBytes != null
              ? `${formatBytes(phase.bytes)} / ${formatBytes(phase.totalBytes)}`
              : phase.bytes
              ? formatBytes(phase.bytes)
              : ''}
          </span>
          {phase.message ? (
            <span
              style={{
                fontSize: 12,
                color: phase.status === 'failed' ? 'var(--color-error)' : 'var(--color-text-3)',
              }}
            >
              {phase.message}
            </span>
          ) : null}
        </div>
      ))}
      {job.errorMessage ? (
        <div
          className="pull-phase-row"
          style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
        >
          <Tag color="error">失败</Tag>
          <span style={{ fontSize: 12 }}>
            {failedPhaseLabel(job)}
            {job.errorCode ? ` · ${job.errorCode}` : ''}：{job.errorMessage}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** 找到失败时正在跑的 phase，用它来定位失败发生在哪一步。 */
function failedPhaseLabel(job: PullJob): string {
  const failed = job.phases.find((p) => p.status === 'failed');
  if (!failed) {
    return '';
  }
  return phaseLabel(failed);
}

function phaseLabel(phase: PullPhase): string {
  if (phase.name === 'manifest') {
    return 'manifest';
  }
  if (phase.name === 'config') {
    return 'config';
  }
  if (phase.name.startsWith('blob:')) {
    const index = phase.name.slice('blob:'.length);
    return `blob #${index}`;
  }
  return phase.name;
}

function phaseStatusColor(status: PullPhase['status']): string {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'processing';
    case 'skipped':
      return 'default';
    default:
      return 'default';
  }
}