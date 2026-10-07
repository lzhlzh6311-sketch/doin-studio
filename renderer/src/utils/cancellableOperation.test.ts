import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CancellableOperation } from './cancellableOperation.js';

test('取消：cancel() 中止在途操作的 signal，且只生效一次', () => {
  const op = new CancellableOperation();
  assert.equal(op.active, false);
  const signal = op.begin();
  assert.equal(op.active, true);
  assert.equal(signal.aborted, false);
  assert.equal(op.cancel(), true);
  assert.equal(signal.aborted, true);
  assert.equal(op.active, false);
  assert.equal(op.cancel(), false, '没有在途操作时取消是空操作');
});

test('新操作开始时中止上一次仍在途的操作；旧操作的 finish 不会误清新操作', () => {
  const op = new CancellableOperation();
  const first = op.begin();
  const second = op.begin();
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  op.finish(first);
  assert.equal(op.active, true, '旧操作结束不能把新操作的 controller 清掉');
  op.finish(second);
  assert.equal(op.active, false);
  assert.equal(second.aborted, false, '正常结束不是取消');
});

test('dispose()（组件卸载 / 离开页面）中止仍在途的等待', () => {
  const op = new CancellableOperation();
  const signal = op.begin();
  op.dispose();
  assert.equal(signal.aborted, true);
});
