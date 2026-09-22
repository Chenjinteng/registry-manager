import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import {
  createProxy,
  deleteProxy,
  fetchConfig,
  listProxies,
  testProxy,
  updateProxy,
} from '../api';
import type { ApiResult, AppConfig, ProxyEntry, ProxyInput, ProxyPatch, ProxyTestResult } from '../types';
import { formatDateTime } from '../utils';

interface Props {
  config: AppConfig | null;
}

interface FormValues {
  name: string;
  url: string;
  username?: string;
  password?: string;
  note?: string;
}

export default function ProxiesPage({ config: initialConfig }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [config, setConfig] = useState<AppConfig | null>(initialConfig);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [editing, setEditing] = useState<ProxyEntry | null>(null);
  const [form] = Form.useForm<FormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<ApiResult<unknown> | null>(null);

  /** 连通性测试弹窗状态。 */
  const [testing, setTesting] = useState<ProxyEntry | null>(null);
  const [testTarget, setTestTarget] = useState('');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  const refresh = useCallback(async () => {
    if (!config?.allowProxies) {
      return;
    }
    const result = await listProxies();
    if (result.success && result.data) {
      setProxies(result.data);
      setError(null);
    } else {
      setError(result);
    }
  }, [config?.allowProxies]);

  useEffect(() => {
    if (!config) {
      void fetchConfig().then((r) => {
        if (r.success && r.data) {
          setConfig(r.data);
        }
      });
    }
  }, [config]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const handleOpenEdit = (p: ProxyEntry) => {
    setEditing(p);
    form.resetFields();
    form.setFieldsValue({
      name: p.name,
      url: p.url,
      username: p.username,
      // 密码不回显：留空表示不改
      password: '',
      note: p.note,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      if (editing) {
        const patch: ProxyPatch = {
          name: values.name,
          url: values.url,
          username: values.username ?? '',
          note: values.note,
        };
        // 密码留空 = 不修改；想改成匿名代理请把用户名也清空。
        if (values.password !== undefined && values.password !== '') {
          patch.password = values.password;
        }
        const result = await updateProxy(editing.id, patch);
        if (!result.success) {
          message.error(result.message || '更新失败');
          return;
        }
        message.success('已更新代理');
      } else {
        const input: ProxyInput = {
          name: values.name,
          url: values.url,
          username: values.username ?? '',
          password: values.password ?? '',
          note: values.note,
        };
        const result = await createProxy(input);
        if (!result.success) {
          message.error(result.message || '创建失败');
          return;
        }
        message.success('已创建代理');
      }
      setModalOpen(false);
      await refresh();
    } catch (err) {
      message.error(String((err as Error)?.message ?? err));
    }
  };

  const handleOpenTest = (p: ProxyEntry) => {
    setTesting(p);
    setTestTarget('');
    setTestResult(null);
  };

  const handleRunTest = async () => {
    if (!testing) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await testProxy(testing.id, testTarget.trim() || undefined);
      if (!result.success) {
        setTestResult({
          ok: false,
          elapsedMs: 0,
          targetUrl: testTarget.trim() || '(默认：本仓库 /v2/)',
          error: result.message,
        });
        return;
      }
      if (result.data) {
        setTestResult(result.data);
      }
    } finally {
      setTestRunning(false);
    }
  };

  const handleDelete = (p: ProxyEntry) => {
    modal.confirm({
      title: `删除代理「${p.name}」？`,
      content: '不会影响已完成的拉取，但引用它的任务会立即失败。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await deleteProxy(p.id);
        if (!result.success) {
          message.error(result.message || '删除失败');
          return;
        }
        message.success('已删除代理');
        await refresh();
      },
    });
  };

  const columns: ColumnsType<ProxyEntry> = [
    {
      title: '名称',
      key: 'name',
      width: 200,
      render: (_, p) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
          <strong>{p.name}</strong>
          {p.note ? (
            <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>{p.note}</span>
          ) : null}
        </Space>
      ),
    },
    {
      title: '代理地址',
      key: 'url',
      render: (_, p) => <span className="mono">{p.url}</span>,
    },
    {
      title: '认证',
      key: 'hasAuth',
      width: 160,
      render: (_, p) =>
        p.hasAuth ? (
          <Tag color="blue" icon={<CheckCircleOutlined />}>
            {p.username}
          </Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />}>匿名</Tag>
        ),
    },
    {
      title: '更新时间',
      key: 'updatedAt',
      width: 150,
      render: (_, p) => <Tooltip title={p.updatedAt}>{formatDateTime(p.updatedAt)}</Tooltip>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      fixed: 'right',
      render: (_, p) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<ApiOutlined />} onClick={() => handleOpenTest(p)}>
            测试
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleOpenEdit(p)}>
            编辑
          </Button>
          <Popconfirm
            title="确定删除？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(p)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (config && !config.allowProxies) {
    const err = config.credentialError;
    const keyMissing = !err || err.code === 'CREDENTIAL_KEY_MISSING';
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h2 className="page-title">代理管理</h2>
            <p className="page-subtitle">管理访问外部源时使用的 HTTP 代理。</p>
          </div>
        </div>
        <Alert
          type="warning"
          showIcon
          message={
            keyMissing
              ? '服务端未配置 REGISTRY_CREDENTIAL_KEY，代理库不可用。'
              : `加密存储初始化失败（${err.code}）`
          }
          description={
            keyMissing ? (
              <div>
                代理可能带账号密码，因此与凭据库共用同一套加密存储和密钥。请设置环境变量{' '}
                <span className="mono">REGISTRY_CREDENTIAL_KEY</span> 后重启服务。
              </div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{err.message}</div>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">代理管理</h2>
          <p className="page-subtitle">
            维护访问<strong>外部源</strong>用的 HTTP 代理，拉取任务里可按名字选用。本 registry
            自身的代理属于部署配置，在 <span className="mono">registry.config.json</span> 的{' '}
            <span className="mono">proxy</span>（或{' '}
            <span className="mono">REGISTRY_PROXY</span>）里配，不在这里管理。
          </p>
        </div>
        <div className="page-actions">
          <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreate}>
            新增代理
          </Button>
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

      <div className="panel">
        <Table<ProxyEntry>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={proxies}
          pagination={false}
          locale={{ emptyText: '还没有代理，点击右上「新增代理」' }}
        />
      </div>

      <Alert
        type="info"
        showIcon
        message="连通性测试说明"
        description={
          <div>
            <div>
              代理本身没有可直接访问的资源，所以测试会<strong>实际穿过这个代理</strong>去访问一个目标。
            </div>
            <div style={{ marginTop: 4 }}>
              目标留空 = 本仓库的 <span className="mono">/v2/</span>；想验证"能不能出外网"就填{' '}
              <span className="mono">https://registry-1.docker.io/v2/</span> 之类。超时上限 8 秒。
            </div>
          </div>
        }
      />

      <Modal
        open={modalOpen}
        title={editing ? `编辑代理：${editing.name}` : '新增代理'}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        destroyOnClose
      >
        <Form<FormValues> form={form} layout="vertical" preserve={false}>
          <Form.Item
            label="名称"
            name="name"
            rules={[{ required: true, message: '请填写名称' }]}
            extra="仅本工具内部识别用，可写「公司统一出口」这类描述。"
          >
            <Input placeholder="内网代理" />
          </Form.Item>
          <Form.Item
            label="代理地址"
            name="url"
            rules={[
              { required: true, message: '请填写代理地址' },
              {
                validator: (_, value: string) =>
                  /^https?:\/\//i.test(value?.trim() ?? '')
                    ? Promise.resolve()
                    : Promise.reject(new Error('需要以 http:// 或 https:// 开头，例如 http://192.0.2.10:4433')),
              },
            ]}
            extra="只填 http://主机:端口，不要带路径，也不要把账号密码写进地址。"
          >
            <Input placeholder="http://192.0.2.10:4433" />
          </Form.Item>
          <Form.Item
            label="用户名（可选，匿名代理留空）"
            name="username"
            extra="留空 = 匿名代理，不会发送 Proxy-Authorization。"
          >
            <Input autoComplete="off" placeholder="proxy-user" />
          </Form.Item>
          <Form.Item
            label={editing ? '密码（留空保留原密码）' : '密码（可选）'}
            name="password"
            extra="密码不会回显；落盘前与凭据库一样以 AES-256-GCM 加密。"
          >
            <Input.Password autoComplete="new-password" placeholder="••••••" />
          </Form.Item>
          <Form.Item label="备注（可选）" name="note">
            <Input placeholder="例如：只有它能出外网" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(testing)}
        title={testing ? `测试代理：${testing.name}` : '测试代理'}
        footer={null}
        onCancel={() => setTesting(null)}
        destroyOnClose
      >
        {testing ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="代理地址">
                <span className="mono">{testing.url}</span>
              </Descriptions.Item>
              <Descriptions.Item label="认证">
                {testing.hasAuth ? `${testing.username}（已配置）` : '匿名'}
              </Descriptions.Item>
            </Descriptions>

            <Input
              addonBefore="访问目标"
              placeholder="留空 = 本仓库 /v2/"
              value={testTarget}
              onChange={(e) => setTestTarget(e.target.value)}
              allowClear
            />

            <Button type="primary" loading={testRunning} onClick={() => void handleRunTest()}>
              开始测试
            </Button>

            {testResult ? (
              <Alert
                type={testResult.ok ? 'success' : 'error'}
                showIcon
                message={
                  testResult.ok
                    ? `连通正常 · HTTP ${testResult.status} · ${testResult.elapsedMs} ms`
                    : '连通失败'
                }
                description={
                  <div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {testResult.ok ? testResult.targetUrl : testResult.error}
                    </div>
                    {testResult.ok ? (
                      <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                        目标：<span className="mono">{testResult.targetUrl}</span>
                        {testResult.registryApiVersion
                          ? ` · registry API ${testResult.registryApiVersion}`
                          : ''}
                      </div>
                    ) : null}
                  </div>
                }
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
