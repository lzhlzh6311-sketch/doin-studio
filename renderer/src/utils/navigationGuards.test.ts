import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkDirty, blockedNavigationAction, articleDialogCloseDecision, BUSY_LEAVE_MESSAGE } from './navigationGuards.js';

/**
 * 三处「界面把自己锁死」的回归。
 *
 * 共同症状：页面看上去完全正常、也没有任何提示，但**点任何导航都没反应**。
 * 之所以难查，是因为三处都不是崩溃、不是报错，而是「拦截器/弹窗缺了一个出口」。
 */

test('对标页：折叠起来的「新建对标组」表单不算未保存编辑（否则会在看不见任何待保存内容时拦死导航）', () => {
  const base = { settings: false, editor: false, creating: false, newName: '', newAudience: '', newKeywords: '' };
  assert.equal(benchmarkDirty(base), false);

  // ⚠️ 核心回归：表单收起了，但输入还留着（已进 sessionStorage，展开即可恢复）——不得算 dirty。
  assert.equal(benchmarkDirty({ ...base, creating: false, newName: '科技', newKeywords: 'AI' }), false);

  // 表单真的展开且填了内容，才算未保存编辑（此时它就在页面上，用户看得见）。
  assert.equal(benchmarkDirty({ ...base, creating: true, newName: '科技' }), true);
  assert.equal(benchmarkDirty({ ...base, creating: true, newKeywords: 'AI' }), true);
  assert.equal(benchmarkDirty({ ...base, creating: true, newAudience: '产品经理' }), true);

  // 只有空白字符等于没填。
  assert.equal(benchmarkDirty({ ...base, creating: true, newName: '   ', newKeywords: '\n' }), false);

  // 领域/门槛与账号编辑是浮层表单，与「新建组」是否展开无关。
  assert.equal(benchmarkDirty({ ...base, settings: true }), true);
  assert.equal(benchmarkDirty({ ...base, editor: true }), true);
});

test('页面 blocker：busy 时也必须给出明确归宿，且要有「确认后离开」的出口', () => {
  // ⚠️ 回归一：早先是 `if (busy) return;` —— 既不 proceed 也不 reset，此后每次导航都被静默吞掉。
  // ⚠️ 回归二：之后改成忙时一律 reset —— 不再吞导航，但长请求期间用户根本离不开页面。
  // 现在：忙时问一次，确认就放行（页面卸载会中止等待），否则 reset 解除拦截。
  const asked: string[] = [];
  assert.equal(blockedNavigationAction({ busy: true, dirty: false, confirm: (m) => { asked.push(m); return true; } }), 'proceed');
  assert.equal(blockedNavigationAction({ busy: true, dirty: false, confirm: (m) => { asked.push(m); return false; } }), 'reset');
  assert.equal(asked.length, 2, '忙时每次被拦都必须只问一次');
  assert.equal(asked[0], BUSY_LEAVE_MESSAGE);
  assert.match(asked[0]!, /停止等待/);

  // 忙且有未保存编辑：仍然只问一次，但要把「编辑会丢」说清楚。
  const both: string[] = [];
  assert.equal(blockedNavigationAction({ busy: true, dirty: true, confirm: (m) => { both.push(m); return true; } }), 'proceed');
  assert.equal(both.length, 1);
  assert.match(both[0]!, /未保存的编辑也会丢失/);

  // 正常路径：有未保存编辑 → 由确认框决定去留。
  assert.equal(blockedNavigationAction({ busy: false, dirty: true, confirm: () => true }), 'proceed');
  assert.equal(blockedNavigationAction({ busy: false, dirty: true, confirm: () => false }), 'reset');

  // 各页面可以给自己的未保存提示（素材页、热点页）。
  const custom: string[] = [];
  blockedNavigationAction({ busy: false, dirty: true, dirtyMessage: '备注尚未保存，放弃编辑并离开？', confirm: (m) => { custom.push(m); return false; } });
  assert.deepEqual(custom, ['备注尚未保存，放弃编辑并离开？']);

  // 没有未保存编辑 → 直接放行，不该弹窗。
  let count = 0;
  assert.equal(blockedNavigationAction({ busy: false, dirty: false, confirm: () => { count++; return true; } }), 'proceed');
  assert.equal(count, 0);
});

test('文章包弹窗：busy 时必须仍关得掉（Modal 会给 #root 设 inert，关不掉＝整个应用点击失效）', () => {
  const clean = { busy: false, promptBusy: false, dirty: false, created: false };

  // ⚠️ 核心回归：请求挂住时（默认超时 16 分钟）也要有一条退路，但必须经用户明确确认。
  assert.equal(articleDialogCloseDecision({ ...clean, busy: true, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, promptBusy: true, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, busy: true, confirm: () => false }), 'stay', '用户没确认就不能静默关掉');

  // busy 优先：此时不该再问「放弃未保存内容？」那第二个问题。
  const asked: string[] = [];
  articleDialogCloseDecision({ ...clean, busy: true, dirty: true, confirm: (message) => { asked.push(message); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /不会中断后台请求/);

  // 不忙时保持原有语义：未创建且动过内容才确认放弃。
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, confirm: () => false }), 'stay');
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, created: true, confirm: () => false }), 'close', '已创建后不再当作未保存编辑');
  assert.equal(articleDialogCloseDecision({ ...clean, confirm: () => true }), 'close');
});
