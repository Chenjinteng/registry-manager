import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Input, Modal, Tag } from 'antd';

import { addIgnoreRule } from '../api';
import type { IgnoreRules } from '../types';

interface Props {
  open: boolean;
  /**
   * 预填的规则片段。
   *
   * 从「最近事件」那一行进来时是**该客户端 UA 的第一段**（`regclient/regsync`）——
   * 直接把完整 UA（`regclient/regsync (v0.11.5)`）存成规则的话，对方升个版本规则就失效了，
   * 而且失效时不会有任何提示。所以这里只预填、不替用户决定。
   */
  suggested?: string;
  /** 已经收到过的客户端 UA，用来做"会匹配到什么"的实时预览。 */
  knownUseragents: string[];
  onCancel: () => void;
  onSaved: (rules: IgnoreRules) => void;
}

/**
 * 添加一条热度忽略规则。
 *
 * 为什么要弹框而不是"点一下就加"：规则是**子串匹配**，写宽一点会误伤。
 * 这里把"会匹配到什么"实时算出来，让人在按确定之前就看见后果 ——
 * 尤其是从「最近事件」进来时，预填的片段可能比想象的更宽。
 */
export default function IgnoreRuleModal({
  open,
  suggested = '',
  knownUseragents,
  onCancel,
  onSaved,
}: Props) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState(suggested);
  const [saving, setSaving] = useState(false);

  // 每次打开都重置成当前这一行的建议值；不重置会带上上一次的输入。
  useEffect(() => {
    if (open) {
      setDraft(suggested);
    }
  }, [open, suggested]);

  const rule = draft.trim();
  const matched = useMemo(() => {
    if (!rule) {
      return [];
    }
    const needle = rule.toLowerCase();
    return [...new Set(knownUseragents.filter((ua) => ua.toLowerCase().includes(needle)))];
  }, [rule, knownUseragents]);

  const handleOk = async () => {
    setSaving(true);
    try {
      const result = await addIgnoreRule(rule);
      if (result.success && result.data) {
        message.success(result.message || '已保存');
        onSaved(result.data);
      } else {
        message.error(result.message || '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="忽略这个客户端的热度"
      okText="保存"
      cancelText="取消"
      okButtonProps={{ disabled: rule.length === 0 }}
      confirmLoading={saving}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-3)' }}>
          子串匹配、忽略大小写。写 <span className="mono">regclient/regsync</span> 就能匹配
          带版本号的完整 UA，对方升版本不用改规则。
        </div>
        <Input
          value={draft}
          autoFocus
          placeholder="例如 regclient/regsync"
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={() => {
            if (rule) {
              void handleOk();
            }
          }}
        />
        {/*
          预览是这个框存在的主要理由：规则写宽一点就会误伤，
          让人在按确定之前先看见"会匹配到什么"。
        */}
        {rule ? (
          matched.length > 0 ? (
            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>
               会匹配到<strong>最近收到的 {matched.length} 个</strong>客户端：
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {matched.slice(0, 6).map((ua) => (
                  <Tag key={ua} className="mono" style={{ marginInlineEnd: 0, maxWidth: '100%' }}>
                    <span className="ellipsis" style={{ display: 'inline-block', maxWidth: 420 }}>
                      {ua}
                    </span>
                  </Tag>
                ))}
                {matched.length > 6 ? <Tag>…等 {matched.length} 个</Tag> : null}
              </div>
            </div>
          ) : (
            <Alert
              type="warning"
              showIcon
              message="最近收到的事件里没有匹配到任何客户端"
              description="规则本身会照常保存并生效。如果这条是照着「最近事件」里的 UA 写的，检查一下有没有多打或漏打字符。"
            />
          )
        ) : null}
        <div style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
          只能排掉<strong>以后</strong>的事件。已经统计进去的历史不会自动重算 ——
          需要的话保存之后去「设置」页清空热度、从头累计。
        </div>
      </div>
    </Modal>
  );
}
