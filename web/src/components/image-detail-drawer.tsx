import { useMemo, useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Empty, Popconfirm, Space, Table, Tooltip } from 'antd';
import { CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import { deleteTag } from '../api';
import type { ApiResult, DeleteTagPayload, RegistryRepository, RegistryTag } from '../types';
import { buildPullCommand, copyText, formatBytes, formatDateTime, shortDigest } from '../utils';

interface Props {
  open: boolean;
  host: string;
  repository: RegistryRepository | null;
  /** false 时隐藏删除入口（服务端同样会拒绝）。 */
  allowDelete: boolean;
  onClose: () => void;
  /** 删除成功后把最新仓库快照交回页面，避免整表重扫。 */
  onDeleted: (payload: DeleteTagPayload) => void;
}

export default function ImageDetailDrawer({
  open,
  host,
  repository,
  allowDelete,
  onClose,
  onDeleted,
}: Props) {
  const { message, modal } = App.useApp();
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [notice, setNotice] = useState<ApiResult<DeleteTagPayload> | null>(null);

  // 同一 digest 可能被多个 tag 指向，删除会一次影响它们，确认时必须讲清影响面。
  const digestTagMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of repository?.tags ?? []) {
      const siblings = map.get(item.digest) ?? [];
      siblings.push(item.tag);
      map.set(item.digest, siblings);
    }
    return map;
  }, [repository]);

  const copy = async (text: string) => {
    if (await copyText(text)) {
      message.success('已复制');
      return;
    }
    // 两条路径都失败时不假装成功：把命令摊开，让用户能手动选中复制。
    modal.error({
      title: '复制失败',
      width: 620,
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>浏览器拒绝了剪贴板操作。请手动选择下面的命令复制：</p>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: '10px 12px',
              background: 'var(--color-fill-1)',
              border: '1px solid var(--color-border-2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              userSelect: 'text',
            }}
          >
            {text}
          </pre>
        </div>
      ),
    });
  };

  const handleDelete = async (record: RegistryTag) => {
    if (!repository) {
      return;
    }
    setDeletingTag(record.tag);
    setNotice(null);
    try {
      const result = await deleteTag(repository.name, record.tag);
      setNotice(result);
      if (result.success && result.data) {
        onDeleted(result.data);
      }
    } finally {
      setDeletingTag(null);
    }
  };

  const columns: ColumnsType<RegistryTag> = [
    {
      title: 'Tag',
      dataIndex: 'tag',
      key: 'tag',
      width: 200,
      render: (value: string) => (
        <Tooltip title={value}>
          <span className="ellipsis" style={{ display: 'block', fontWeight: 500 }}>
            {value || '--'}
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'Digest',
      dataIndex: 'digest',
      key: 'digest',
      width: 190,
      render: (value: string) => (
        <Tooltip title={value}>
          <span className="mono" style={{ color: 'var(--color-text-3)' }}>
            {shortDigest(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '架构',
      dataIndex: 'architecture',
      key: 'architecture',
      width: 150,
      render: (value: string, record) => {
        if (!value) {
          return '--';
        }
        const platform = `${record.os || 'linux'}/${value}`;
        return record.platformCount > 1 ? `${platform} +${record.platformCount - 1}` : platform;
      },
    },
    { title: '层数', dataIndex: 'layerCount', key: 'layerCount', width: 80 },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 110,
      render: (value: number) => formatBytes(value),
    },
    {
      title: '构建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (value: string | null) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, record) => {
        const pullCommand = buildPullCommand(host, repository?.name ?? '', record.tag);
        const siblings = digestTagMap.get(record.digest) ?? [];
        return (
          <Space size={2}>
            <Tooltip title={pullCommand}>
              <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void copy(pullCommand)} />
            </Tooltip>
            {allowDelete ? (
              <Popconfirm
                title={`确认删除 ${record.tag}？`}
                description={
                  <div style={{ maxWidth: 320 }}>
                    <div>将按 digest 删除该 manifest，删除后该镜像无法再被拉取。</div>
                    {siblings.length > 1 ? (
                      <div style={{ marginTop: 4, color: 'var(--color-warning)' }}>
                        该 digest 同时被 {siblings.length} 个 tag 指向（{siblings.join('、')}），删除会一并影响它们。
                      </div>
                    ) : null}
                    <div style={{ marginTop: 4, color: 'var(--color-text-3)' }}>
                      删除不会立即释放磁盘空间，需要在 registry 侧运行 registry garbage-collect。
                    </div>
                  </div>
                }
                okText="确认删除"
                cancelText="取消"
                okButtonProps={{ danger: true, loading: deletingTag === record.tag }}
                onConfirm={() => handleDelete(record)}
              >
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={1020}
      title={repository?.name ?? '镜像详情'}
      destroyOnClose
    >
      <div className="drawer-stack">
        {notice ? (
          <Alert
            type={notice.success ? 'success' : 'warning'}
            showIcon
            closable
            onClose={() => setNotice(null)}
            message={notice.message}
            description={
              notice.success && notice.data && notice.data.affectedTags.length > 1 ? (
                <span>受影响 tag: {notice.data.affectedTags.join('、')}</span>
              ) : undefined
            }
          />
        ) : null}

        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="仓库">{repository?.name ?? '--'}</Descriptions.Item>
          <Descriptions.Item label="Registry">{host || '--'}</Descriptions.Item>
          <Descriptions.Item label="Tag 数">{repository?.tagCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="镜像层合计">{formatBytes(repository?.totalSize)}</Descriptions.Item>
        </Descriptions>

        <Alert
          type="info"
          showIcon
          message="「镜像层合计」为各 manifest 中 layer 大小之和，不是磁盘占用：不同 tag 与仓库共享底层 blob，registry 本身也不提供存储用量接口。"
        />

        <div className="drawer-scroll">
          {repository?.tags.length ? (
            <Table<RegistryTag>
              rowKey="tag"
              size="small"
              columns={columns}
              dataSource={repository.tags}
              pagination={false}
              scroll={{ x: 1000 }}
            />
          ) : (
            <Empty description="该仓库当前没有可用的 tag" />
          )}
        </div>
      </div>
    </Drawer>
  );
}
