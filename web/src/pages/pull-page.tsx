import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Radio,
  Select,
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
  listCredentials,
  listProxies,
  listPullJobs,
  probePullSource,
  removePullJob,
} from '../api';
import type {
  ApiResult,
  AppConfig,
  Credential,
  DestStatus,
  ProxyEntry,
  PullJob,
  PullJobInput,
  PullJobStatus,
  PullPhase,
} from '../types';
import {
  DEST_REPO_PATTERN,
  DEST_TAG_PATTERN,
  formatBytes,
  formatDateTime,
  parseImageReference,
  shortDigest,
  splitRepoTag,
} from '../utils';

interface Props {
  config: AppConfig | null;
}

interface FormValues {
  image: string;       // 源镜像名（可能含主机前缀）
  destImage?: string;  // 本 registry 内的目标镜像名 <repo>[:<tag>]，不含主机
  sourceUrl?: string;  // 高级选项：留空时由 image 自动推断
  // 高级选项：源端代理（不用 / 从代理库选 / 临时输入）
  sourceProxyMode?: 'none' | 'library' | 'temp';
  sourceProxyId?: string;
  sourceProxy?: string;
  sourceAuthMode?: 'none' | 'credential' | 'temp';
  sourceCredentialId?: string;
  sourceTempUsername?: string;
  sourceTempPassword?: string;
}

const POLL_INTERVAL_MS = 1500;

/**
 * 失败 / 取消的任务行默认展开，方便用户直接看到错误原因。
 */
function defaultExpandedKeys(jobs: PullJob[]): string[] {
  return jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').map((j) => j.id);
}

/** 把凭据 id 翻译成「名称（账号）」以供预览/列表展示。 */
function resolveCredentialLabel(id: string, list: Credential[] = []): string {
  const c = list.find((x) => x.id === id);
  return c ? `${c.name}（${c.username}）` : id;
}

/** 预览里展示这次用了哪个代理（代理库的名字优先，否则临时地址）。 */
function resolveProxyLabel(input: PullJobInput, list: ProxyEntry[] = []): string {
  if (input.sourceProxyId) {
    const p = list.find((x) => x.id === input.sourceProxyId);
    return p ? `${p.name}（${p.url}）` : input.sourceProxyId;
  }
  return input.sourceProxy ? `临时 ${input.sourceProxy}` : '不使用';
}

/** 从 `<repo>:<tag>` 取出 tag；取不到时返回空串。 */
function sourceTagOf(ref: string): string {
  const colon = ref.lastIndexOf(':');
  if (colon < 0) return '';
  const tag = ref.slice(colon + 1);
  return tag.includes('/') ? '' : tag;
}

/** 完整目的引用的主机前缀，如 `192.0.2.10:10001/`。 */
function hostPrefixOf(host: string): string {
  return host ? `${host}/` : '';
}

/**
 * 把后端稳定的 code 翻译成一句"运维能直接照做"的提示。
 * 摘要放在表格行内，全文在展开区；这里只保留一句最重要的根因。
 *
 * 用 `errorOrigin` 区分源 / 目的：CONNECTION_FAILED 同名但可能是源不可达或目的写不进去。
 */
function failureHint(job: PullJob): string {
  const code = job.errorCode ?? '';
  const origin = job.errorOrigin;
  const side = origin === 'source' ? '源' : origin === 'dest' ? '目的' : '';

  switch (code) {
    case 'CONNECTION_FAILED':
      return side ? `${side} registry 连不上，请检查地址 / 代理` : '镜像仓库连不上';
    case 'SOURCE_UNREACHABLE':
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
      return '源地址不合法';
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
  /** 创建前的预览：表单点击"加入队列"后打开 Modal 确认 + 源预检。 */
  const [pendingInput, setPendingInput] = useState<PullJobInput | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const liveConfigRef = useRef<AppConfig | null>(config);
  liveConfigRef.current = config;
  /** 本仓库的 host[:port]；作为固定前缀展示，不可编辑。 */
  const host = config?.host ?? '';
  /** 用户是否手动改过「目标镜像名」——改过就不再跟随源镜像，免得把人的输入冲掉。 */
  const destTouchedRef = useRef(false);

  /**
   * 源镜像变化时，把目标镜像名同步成"同名"（去掉主机前缀后的 <repo>:<tag>）。
   *
   * 只在用户没手动改过目标时才跟随；把目标清空即恢复跟随（否则一旦改过就再也回不到自动）。
   */
  const handleValuesChange = (changed: Partial<FormValues>) => {
    const autoFor = (sourceImage: string | undefined) =>
      parseImageReference(sourceImage ?? '').sourceRef;

    if ('destImage' in changed) {
      // 判断这次变化是不是我们自己 setFieldValue 触发的自动填充。
      if (changed.destImage !== autoFor(form.getFieldValue('image'))) {
        destTouchedRef.current = true;
      }
      if (!changed.destImage) {
        // 清空 = 恢复跟随源镜像
        destTouchedRef.current = false;
        form.setFieldValue('destImage', autoFor(form.getFieldValue('image')));
      }
      return;
    }

    if ('image' in changed) {
      if (!destTouchedRef.current) {
        const auto = autoFor(changed.image);
        if (form.getFieldValue('destImage') !== auto) {
          form.setFieldValue('destImage', auto);
        }
      }
    }
  };

  // 凭据库可用时拉一次；不可用不请求（listCredentials 仍能调，但服务端会返 CREDENTIAL_KEY_MISSING）。
  const refreshCredentials = useCallback(async () => {
    if (!liveConfigRef.current?.allowCredentials) {
      setCredentials([]);
      return;
    }
    const result = await listCredentials();
    if (result.success && result.data) {
      setCredentials(result.data);
    } else {
      setCredentials([]);
    }
  }, []);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);

  /** 代理库与凭据库同源，可用性一起判断。 */
  const refreshProxies = useCallback(async () => {
    if (!liveConfigRef.current?.allowProxies) {
      setProxies([]);
      return;
    }
    const result = await listProxies();
    setProxies(result.success && result.data ? result.data : []);
  }, []);

  useEffect(() => {
    void refreshProxies();
  }, [refreshProxies]);

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

    // 目标引用 = 本仓库地址（固定）+ 目标镜像名。
    // 目标镜像名留空则与源镜像同名；用户可以改它来换落地路径
    // （例如把 library/alpine:3.19 落成 alpine:3.19）。
    // 主机部分来自服务配置，不可能指到别的 registry。
    const destRef = values.destImage?.trim() || sourceRefEffective;
    const { repo: destRepo, tag: destTag } = splitRepoTag(destRef);
    if (!DEST_REPO_PATTERN.test(destRepo)) {
      message.error('目标镜像名的仓库路径不合法（只能小写字母 / 数字 / ._- 分段，且不能带主机）');
      return;
    }

    // 源端认证：credential / temp / none。
    let sourceCredentialId: string | undefined;
    let sourceAuthInline: { username: string; password: string } | undefined;
    if (values.sourceAuthMode === 'credential' && values.sourceCredentialId) {
      sourceCredentialId = values.sourceCredentialId;
    } else if (values.sourceAuthMode === 'temp') {
      const u = values.sourceTempUsername?.trim();
      const p = values.sourceTempPassword ?? '';
      if (u && p) {
        sourceAuthInline = { username: u, password: p };
      }
    }

    // 打开预览 Modal，让用户看清将要做什么 + 预检，再真正入队。
    setPendingInput({
      sourceUrl: sourceUrlEffective,
      sourceRef: sourceRefEffective,
      destRepo,
      // 目标镜像名里没写 tag 时留空，让服务端沿用源 tag（同一套默认口径）。
      destTag: destTag || undefined,
      sourceProxyId:
        values.sourceProxyMode === 'library' && values.sourceProxyId
          ? values.sourceProxyId
          : undefined,
      sourceProxy:
        values.sourceProxyMode === 'temp' ? values.sourceProxy?.trim() || undefined : undefined,
      sourceCredentialId,
      sourceAuthInline,
    });
  };

  /** Modal 里点确认才真正创建。 */
  const handleConfirmCreate = async () => {
    if (!pendingInput) return;
    setSubmitting(true);
    try {
      const result = await createPullJob(pendingInput);
      if (!result.success) {
        setError(result);
        message.error(result.message || '创建任务失败');
        return;
      }
      message.success(
        `已加入队列：从 ${pendingInput.sourceUrl} 拉取 ${pendingInput.sourceRef} → ${pendingInput.destRepo}`
      );
      setPendingInput(null);
      form.resetFields();
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelPreview = () => {
    setPendingInput(null);
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
          initialValues={{ image: 'library/alpine:3.19', destImage: 'library/alpine:3.19' }}
          onFinish={handleSubmit}
          onValuesChange={handleValuesChange}
          disabled={Boolean(config && !config.allowPull)}
        >
          <Form.Item
            label="源镜像名"
            name="image"
            extra="支持任意 docker pull 引用：alpine:3.19、library/alpine:3.19、ghcr.io/owner/img:1.0、192.0.2.20:10001/library/alpine:3.9 等。"
            rules={[
              { required: true, message: '请填写镜像名' },
              {
                validator: (_, value: string) => {
                  // 不能用 `value.includes(':')` 判断：主机前缀里也有冒号
                  // （`192.0.2.20:10001/library/alpine` 会被误判为"已有 tag"），
                  // 于是提交后才被后端拒，报错还跟输入对不上。
                  // 正解是先剥掉主机段，再看剩下部分有没有 tag。
                  const parsed = parseImageReference(value ?? '');
                  const ref = parsed.sourceRef;
                  const colon = ref.lastIndexOf(':');
                  const tag = colon >= 0 ? ref.slice(colon + 1) : '';
                  if (!ref) {
                    return Promise.reject(new Error('请填写镜像名'));
                  }
                  if (!tag || tag.includes('/')) {
                    return Promise.reject(
                      new Error('缺少 tag，请写成 <repo>:<tag>，例如 alpine:3.19')
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="alpine:3.19" allowClear autoFocus />
          </Form.Item>

          <Form.Item
            label="目标镜像名"
            name="destImage"
            extra={
              host
                ? `本仓库地址 ${host}/ 固定不可改；留空表示与源镜像同名。改这里可以把镜像落到别的路径（例如去掉 library/ 前缀）。`
                : '本仓库地址固定不可改；留空表示与源镜像同名。'
            }
            rules={[
              {
                validator: (_, value: string | undefined) => {
                  if (!value || !value.trim()) {
                    return Promise.resolve(); // 留空 = 沿用源镜像
                  }
                  const { repo, tag } = splitRepoTag(value);
                  if (!DEST_REPO_PATTERN.test(repo)) {
                    return Promise.reject(
                      new Error('仓库路径只能是小写字母 / 数字 / ._- 分段，且不能带主机')
                    );
                  }
                  if (tag && !DEST_TAG_PATTERN.test(tag)) {
                    return Promise.reject(new Error('tag 只能包含字母数字与 ._-'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            {/* 固定前缀用 addonBefore 呈现：视觉上就是"不可编辑的一段"。 */}
            <Input
              addonBefore={host ? <span className="mono">{host}/</span> : undefined}
              placeholder="与源镜像同名"
              allowClear
            />
          </Form.Item>
          <Collapse
            ghost
            expandIcon={({ isActive }) => (
              <DownOutlined rotate={isActive ? 180 : 0} style={{ fontSize: 12 }} />
            )}
            items={[
              {
                key: 'advanced',
                label: '高级选项（来源地址 / 来源代理 / 认证）',
                children: (
                  <>
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
                    </div>

                    <Form.Item
                      label="源端代理"
                      extra="仅作用于本次拉取访问源；本仓库自身的代理走服务配置。"
                    >
                      <Input.Group compact>
                        <Form.Item name="sourceProxyMode" noStyle initialValue="none">
                          <Radio.Group optionType="button" buttonStyle="solid">
                            <Radio.Button value="none">不用</Radio.Button>
                            <Radio.Button value="library">代理库</Radio.Button>
                            <Radio.Button value="temp">临时输入</Radio.Button>
                          </Radio.Group>
                        </Form.Item>
                      </Input.Group>
                    </Form.Item>

                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, current) =>
                        prev.sourceProxyMode !== current.sourceProxyMode
                      }
                    >
                      {({ getFieldValue }) => {
                        const mode = getFieldValue('sourceProxyMode');
                        if (mode === 'library') {
                          return (
                            <Form.Item
                              label="选择代理"
                              name="sourceProxyId"
                              rules={[{ required: true, message: '请选择一个代理' }]}
                            >
                              <Select
                                placeholder={
                                  proxies.length === 0
                                    ? '代理库还是空的，请先到「代理管理」新增'
                                    : '选择代理'
                                }
                                disabled={proxies.length === 0}
                                options={proxies.map((p) => ({
                                  value: p.id,
                                  label: `${p.name}（${p.url}${p.hasAuth ? '，带认证' : ''}）`,
                                }))}
                              />
                            </Form.Item>
                          );
                        }
                        if (mode === 'temp') {
                          return (
                            <Form.Item
                              label="临时代理地址"
                              name="sourceProxy"
                              rules={[
                                { required: true, message: '请填写代理地址' },
                                {
                                  validator: (_, value: string | undefined) =>
                                    !value || /^https?:\/\//i.test(value.trim())
                                      ? Promise.resolve()
                                      : Promise.reject(
                                          new Error('需要以 http:// 或 https:// 开头')
                                        ),
                                },
                              ]}
                              extra="只用于本次任务，不写入代理库。需要认证时写成 http://用户:密码@主机:端口。"
                            >
                              <Input placeholder="http://proxy.example.com:8080" allowClear />
                            </Form.Item>
                          );
                        }
                        return null;
                      }}
                    </Form.Item>

                    <Form.Item
                      label="源认证"
                      extra={
                        config?.allowCredentials
                          ? '凭据库由「凭据管理」维护；临时输入不会落盘。'
                          : '凭据库未配置，只能临时输入账号 / 密码（不会落盘）。'
                      }
                    >
                      <Input.Group compact>
                        <Form.Item name="sourceAuthMode" noStyle initialValue="none">
                          <Radio.Group
                            optionType="button"
                            buttonStyle="solid"
                            onChange={() => form.resetFields(['sourceCredentialId'])}
                          >
                            <Radio.Button value="none">不用</Radio.Button>
                            <Radio.Button value="credential">凭据库</Radio.Button>
                            <Radio.Button value="temp">临时输入</Radio.Button>
                          </Radio.Group>
                        </Form.Item>
                      </Input.Group>
                    </Form.Item>

                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, current) =>
                        prev.sourceAuthMode !== current.sourceAuthMode
                      }
                    >
                      {({ getFieldValue }) => {
                        const mode = getFieldValue('sourceAuthMode');
                        if (mode === 'credential') {
                          // 凭据库里全是外部源凭据，没有"用途"维度，直接全列。
                          const sourceCandidates = credentials;
                          return (
                            <Form.Item
                              label="选择源凭据"
                              name="sourceCredentialId"
                              rules={[
                                { required: true, message: '请选择一条凭据' },
                              ]}
                            >
                              <Select
                                placeholder={
                                  sourceCandidates.length === 0
                                    ? '凭据库里还没有凭据，请先到「凭据管理」新增'
                                    : '选择凭据'
                                }
                                disabled={sourceCandidates.length === 0}
                                options={sourceCandidates.map((c) => ({
                                  value: c.id,
                                  label: `${c.name}（${c.username} @ ${c.registryUrl}）`,
                                }))}
                              />
                            </Form.Item>
                          );
                        }
                        if (mode === 'temp') {
                          return (
                            <>
                              <Form.Item
                                label="临时账号"
                                name="sourceTempUsername"
                                rules={[{ required: true, message: '请填写用户名' }]}
                              >
                                <Input autoComplete="off" placeholder="username" />
                              </Form.Item>
                              <Form.Item
                                label="临时密码"
                                name="sourceTempPassword"
                                rules={[{ required: true, message: '请填写密码' }]}
                                extra="只用于本次任务，不会写入凭据库。"
                              >
                                <Input.Password
                                  autoComplete="new-password"
                                  placeholder="••••••"
                                />
                              </Form.Item>
                            </>
                          );
                        }
                        return null;
                      }}
                    </Form.Item>

                  </>
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

      <PullPreviewModal
        input={pendingInput}
        host={config?.host ?? ''}
        usingAuth={Boolean(config?.usingAuth)}
        credentials={credentials}
        proxies={proxies}
        onConfirm={handleConfirmCreate}
        onCancel={handleCancelPreview}
        submitting={submitting}
      />
    </div>
  );
}

/**
 * 创建任务前的预览 Modal：
 *   - 列出解析后的全部字段（源 / 目的 / 代理）
 *   - 真实打一次源端 GET /v2/，把"能不能连"立刻告诉用户
 *   - 源不通时不允许"确认入队"，避免浪费一次任务
 *   - 目的端的可达性由 /api/probe 单独验证（沿用既有 endpoint）
 */
function PullPreviewModal({
  input,
  host,
  usingAuth,
  credentials,
  proxies,
  onConfirm,
  onCancel,
  submitting,
}: {
  input: PullJobInput | null;
  /** 本仓库的 host[:port]，用于拼出完整的目的引用。 */
  host: string;
  /** 本仓库是否配了 basic auth（来自服务配置，任务级不可改）。 */
  usingAuth: boolean;
  credentials: Credential[];
  proxies: ProxyEntry[];
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [probeResult, setProbeResult] = useState<
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'ok'; apiVersion: string; host: string; dest?: DestStatus }
    | { state: 'failed'; message: string; origin?: 'source' | 'dest' }
  >({ state: 'idle' });

  // 打开时主动跑一次源端预检。
  useEffect(() => {
    if (!input) {
      setProbeResult({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setProbeResult({ state: 'loading' });
    probePullSource({
        sourceUrl: input.sourceUrl,
        sourceProxy: input.sourceProxy,
        credentialId: input.sourceCredentialId,
        proxyId: input.sourceProxyId,
        sourceRef: input.sourceRef,
        destRepo: input.destRepo,
        destTag: input.destTag,
      })
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          setProbeResult({
            state: 'ok',
            apiVersion: result.data.apiVersion,
            host: result.data.host,
            dest: result.data.dest,
          });
        } else {
          setProbeResult({
            state: 'failed',
            message: result.message,
            origin: (result as { origin?: 'source' | 'dest' }).origin,
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setProbeResult({ state: 'failed', message: String(error?.message ?? error) });
      });
    return () => {
      cancelled = true;
    };
  }, [input]);

  return (
    <Modal
      open={Boolean(input)}
      title="即将创建拉取任务"
      okText="确认入队"
      cancelText="再改改"
      okButtonProps={{
        disabled:
          probeResult.state === 'failed' ||
          probeResult.state === 'loading' ||
          // 源 tag 不存在时不让入队：入队也必然失败，还白占一次队列。
          (probeResult.state === 'ok' && probeResult.dest?.sourceExists === false) ||
          submitting,
        loading: submitting,
      }}
      onCancel={onCancel}
      onOk={onConfirm}
      destroyOnClose
    >
      {input ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="源 registry">
              <span className="mono">{input.sourceUrl}</span>
              {input.sourceProxyId || input.sourceProxy ? (
                <Tag color="gold" style={{ marginLeft: 8 }}>
                  源端代理：{resolveProxyLabel(input, proxies)}
                </Tag>
              ) : null}
            </Descriptions.Item>
            <Descriptions.Item label="源认证">
              {input.sourceCredentialId
                ? `${resolveCredentialLabel(input.sourceCredentialId, credentials)}（凭据库）`
                : input.sourceAuthInline
                ? `临时账号 ${input.sourceAuthInline.username}（不保存）`
                : '不使用'}
            </Descriptions.Item>
            <Descriptions.Item label="源镜像">
              <span className="mono">{input.sourceRef}</span>
            </Descriptions.Item>
            <Descriptions.Item label="目的引用">
              <span className="mono">
                {hostPrefixOf(host)}
                {input.destRepo}:{input.destTag ?? sourceTagOf(input.sourceRef)}
              </span>
              <span style={{ marginLeft: 8, color: 'var(--color-text-3)' }}>
                自动补全：本仓库地址 + 源镜像路径
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="目的认证">
              {usingAuth ? (
                <span>
                  <Tag color="blue">已配置</Tag>
                  <span style={{ color: 'var(--color-text-3)' }}>
                    来自 registry.config.json / REGISTRY_USERNAME，所有本仓库请求自动携带
                  </span>
                </span>
              ) : (
                <span style={{ color: 'var(--color-text-3)' }}>
                  未配置（匿名访问本仓库）
                </span>
              )}
            </Descriptions.Item>
          </Descriptions>

          {/* 源侧 tag 不存在：拼错了在这里就拦下，别等入队后才失败。 */}
          {probeResult.state === 'ok' && probeResult.dest?.sourceExists === false ? (
            <Alert
              type="error"
              showIcon
              message={`源镜像不存在：${input.sourceRef}`}
              description={
                <span style={{ color: 'var(--color-text-3)' }}>
                  源 registry 可达，但没有这个 tag。请检查镜像名与 tag 是否拼写正确。
                </span>
              }
            />
          ) : null}

          {/* 目标 tag 已存在的提示：manifest PUT 是覆盖语义，替掉前必须让用户知道。 */}
          {probeResult.state === 'ok' && probeResult.dest?.identical ? (
            <Alert
              type="info"
              showIcon
              message="目标 tag 已存在，且与源 digest 一致"
              description={
                <span style={{ color: 'var(--color-text-3)' }}>
                  本仓库已有 <span className="mono">{probeResult.dest.destRepo}:{probeResult.dest.destTag}</span>
                  （{shortDigest(probeResult.dest.existingDigest)}），与源相同，重复拉取不会改变内容。
                </span>
              }
            />
          ) : null}
          {probeResult.state === 'ok' && probeResult.dest?.willReplace ? (
            <Alert
              type="warning"
              showIcon
              message="目标 tag 已存在，本次拉取将替换它"
              description={
                <div>
                  <div>
                    本仓库 <span className="mono">{probeResult.dest.destRepo}:{probeResult.dest.destTag}</span>{' '}
                    当前指向 <span className="mono">{shortDigest(probeResult.dest.existingDigest)}</span>，
                    拉取后将指向 <span className="mono">{shortDigest(probeResult.dest.sourceDigest)}</span>。
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                    如果这个 tag 已被其他系统固定引用，替换后它们拿到的镜像会变。原 manifest 不会保留。
                  </div>
                </div>
              }
            />
          ) : null}
          {probeResult.state === 'ok' && probeResult.dest && !probeResult.dest.exists ? (
            <Alert
              type="success"
              showIcon
              message="目标 tag 不存在，将新建"
              description={
                <span style={{ color: 'var(--color-text-3)' }}>
                  <span className="mono">{probeResult.dest.destRepo}:{probeResult.dest.destTag}</span>{' '}
                  在本仓库中尚不存在。
                </span>
              }
            />
          ) : null}
          {probeResult.state === 'ok' && probeResult.dest?.probeError ? (
            <Alert
              type="warning"
              showIcon
              message="未能确认目标 tag 的现状"
              description={
                <span style={{ color: 'var(--color-text-3)' }}>{probeResult.dest.probeError}</span>
              }
            />
          ) : null}

          <Alert
            type={
              probeResult.state === 'ok'
                ? 'success'
                : probeResult.state === 'failed'
                ? 'error'
                : 'info'
            }
            showIcon
            message={
              probeResult.state === 'idle'
                ? '准备预检'
                : probeResult.state === 'loading'
                ? '正在测试源 registry 连通性…'
                : probeResult.state === 'ok'
                ? `源可达 · API ${probeResult.apiVersion}（${probeResult.host}）`
                : `源不可达${probeResult.origin === 'source' ? '' : ''}`
            }
            description={
              probeResult.state === 'failed' ? (
                <span>
                  <strong style={{ display: 'block', marginBottom: 4 }}>{probeResult.message}</strong>
                  <span style={{ color: 'var(--color-text-3)' }}>
                    请确认源地址是否正确；若在内网/受限网段，请在「高级选项」里填一个来源代理。
                  </span>
                </span>
              ) : probeResult.state === 'ok' ? (
                <span style={{ color: 'var(--color-text-3)' }}>
                  源 registry 已就绪。目的端的写入权限由本仓库决定，不在此处预检。
                </span>
              ) : null
            }
          />
        </Space>
      ) : null}
    </Modal>
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
            {job.errorOrigin === 'source'
              ? '源端'
              : job.errorOrigin === 'dest'
              ? '目的端'
              : ''}
            {failedPhaseLabel(job) ? ` · ${failedPhaseLabel(job)}` : ''}
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