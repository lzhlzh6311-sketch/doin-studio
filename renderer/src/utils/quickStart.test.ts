import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSetupItems, clipboardOffer, diffJobEvents, extractDouyinVideoLink, setupProgress, snapshotJobs } from './quickStart';

test('extracts the link from a full Douyin share text', () => {
  const text = '7.43 复制打开抖音，看看【某某的作品】今天分享一个小技巧 # 干货 https://v.douyin.com/iRNBho6u/ Dbg:/ 08/12 x@S.lP';
  assert.equal(extractDouyinVideoLink(text), 'https://v.douyin.com/iRNBho6u/');
});

test('accepts plain video links and rejects profile pages and other sites', () => {
  assert.equal(extractDouyinVideoLink('https://www.douyin.com/video/7312345678901234567'), 'https://www.douyin.com/video/7312345678901234567');
  assert.equal(extractDouyinVideoLink('看这个 https://www.iesdouyin.com/share/video/123/。'), 'https://www.iesdouyin.com/share/video/123/');
  assert.equal(extractDouyinVideoLink('https://www.douyin.com/user/MS4wLjABAAAA'), null);
  assert.equal(extractDouyinVideoLink('https://www.bilibili.com/video/BV1xx'), null);
  assert.equal(extractDouyinVideoLink('https://evil.example/douyin.com/video/1'), null);
  assert.equal(extractDouyinVideoLink(''), null);
  assert.equal(extractDouyinVideoLink(undefined), null);
});

test('does not offer the same clipboard link twice or when disabled', () => {
  const link = 'https://v.douyin.com/abc/';
  assert.equal(clipboardOffer(link, null, false), link);
  assert.equal(clipboardOffer(link, link, false), null);
  assert.equal(clipboardOffer(link, null, true), null);
  assert.equal(clipboardOffer('随便一段文字', null, false), null);
});

test('setup checklist reflects AI key and runtime state', () => {
  const items = buildSetupItems({ hasAiKey: false, runtime: [
    { id: 'douyin', state: 'ready' }, { id: 'toutiao', state: 'blocked' }, { id: 'xiaohongshu', state: 'unknown' }, { id: 'ffmpeg', state: 'ready' },
  ] });
  const byId = Object.fromEntries(items.map(item => [item.id, item]));
  assert.equal(byId.ai.done, false);
  assert.equal(byId.douyin.done, true);
  assert.equal(byId.toutiao.done, false);
  assert.equal(byId.xiaohongshu.unknown, true);
  const progress = setupProgress(items);
  assert.equal(progress.done, 2);
  assert.equal(progress.total, 5);
  assert.equal(progress.requiredMissing, 1);
  assert.equal(progress.allDone, false);
});

test('unknown state is not counted as missing', () => {
  const progress = setupProgress(buildSetupItems({ hasAiKey: null, runtime: null }));
  assert.equal(progress.requiredMissing, 0);
  assert.equal(progress.done, 0);
});

test('job events fire only on transitions, never on the first snapshot', () => {
  const running = [{ id: 'a', status: 'done', preview: { displayTitle: '测试视频' }, steps: { transcribe: { status: 'running' }, generate_video: { status: 'pending' } } },
    { id: 'b', status: 'processing', topic: '下载中' }];
  assert.deepEqual(diffJobEvents(null, running), []);
  const before = snapshotJobs(running);
  const after = [{ id: 'a', status: 'done', preview: { displayTitle: '测试视频' }, steps: { transcribe: { status: 'succeeded' }, generate_video: { status: 'pending' } } },
    { id: 'b', status: 'failed', topic: '下载中' }];
  const events = diffJobEvents(before, after);
  assert.deepEqual(events.map(e => [e.jobId, e.title, e.ok]), [['a', '转录完成', true], ['b', '任务失败', false]]);
  assert.deepEqual(diffJobEvents(snapshotJobs(after), after), []);
});

test('a failed render reports a failure with the job title', () => {
  const before = snapshotJobs([{ id: 'c', status: 'done', topic: '口播', steps: { generate_video: { status: 'running' } } }]);
  const [event] = diffJobEvents(before, [{ id: 'c', status: 'done', topic: '口播', steps: { generate_video: { status: 'failed' } } }]);
  assert.equal(event.title, '视频渲染失败');
  assert.match(event.body, /口播/);
  assert.equal(event.ok, false);
});
