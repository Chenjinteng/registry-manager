#!/usr/bin/env node
/**
 * 验证拉取任务列表的展开状态机（web/src/utils.ts 的 nextJobExpansion）。
 *
 * 背景（真实 bug）：AntD Table 的 expandedRowKeys 是**受控**属性，
 * 只传它而不传 onExpandedRowsChange，用户点了也改不了状态 ——
 * 表现为"默认展开，且点箭头收不回去"。
 *
 * 状态必须由 nextJobExpansion 统一管；这个脚本锁定它的行为：
 *   - 首屏保持收起（历史记录不该一上来铺满详情）
 *   - 之后新出现的失败 / 取消任务自动展开一次
 *   - 轮询不会把用户手动收起的行重新弹开
 *   - 已移除任务的 key 会被清理
 *
 * 用法：node scripts/verify-job-expansion.mjs
 */
import { nextJobExpansion } from '../web/src/utils.ts';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const J = (id, status) => ({ id, status });

let state = { keys: [], autoHandled: new Set(), firstLoad: true };
const step = (jobs) => {
  state = nextJobExpansion({
    jobs,
    prevKeys: state.keys,
    autoHandled: state.autoHandled,
    firstLoad: state.firstLoad,
  });
  return state.keys;
};

const history = [J('a', 'succeeded'), J('b', 'failed'), J('c', 'succeeded')];

check('首屏保持收起（哪怕已有失败的历史任务）', JSON.stringify(step(history)) === '[]', JSON.stringify(state.keys));

// 用户手动展开 a：模拟组件把 onExpandedRowsChange 的结果写回 state
state.keys = ['a'];
check('用户可以手动展开', JSON.stringify(state.keys) === '["a"]');

check(
  '新出现的失败任务自动展开一次',
  JSON.stringify(step([...history, J('d', 'failed')])) === '["a","d"]',
  JSON.stringify(state.keys)
);

check(
  '轮询刷新（内容未变）不改变展开状态',
  JSON.stringify(step([...history, J('d', 'failed')])) === '["a","d"]',
  JSON.stringify(state.keys)
);

// 用户手动收起 d —— 这正是之前做不到的操作
state.keys = ['a'];
check(
  '手动收起后，再次轮询不会被弹开',
  JSON.stringify(step([...history, J('d', 'failed')])) === '["a"]',
  JSON.stringify(state.keys)
);

check(
  '任务被移除后，其 key 会被清理',
  JSON.stringify(step([J('a', 'succeeded'), J('b', 'failed'), J('d', 'failed')])) === '["a"]',
  JSON.stringify(state.keys)
);

check(
  '再新增失败任务时照常自动展开',
  JSON.stringify(step([J('a', 'succeeded'), J('b', 'failed'), J('d', 'failed'), J('e', 'cancelled')])) ===
    '["a","e"]',
  JSON.stringify(state.keys)
);

check(
  '进行中的任务不自动展开（只有失败 / 取消才展开）',
  JSON.stringify(step([J('a', 'succeeded'), J('b', 'failed'), J('d', 'failed'), J('e', 'cancelled'), J('f', 'running')])) ===
    '["a","e"]',
  JSON.stringify(state.keys)
);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
