import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';
import { pageContextOf, suggestionsFor } from './AssistantPanel';

test('从路由推出作品 / 文章上下文', () => {
  assert.equal(pageContextOf('/jobs/abc').jobId, 'abc');
  assert.equal(pageContextOf('/articles/xyz').articleId, 'xyz');
  assert.equal(pageContextOf('/articles/benchmarks').articleId, undefined);
  assert.equal(pageContextOf('/hotspots').jobId, undefined);
});

test('快捷提问随页面变化', () => {
  assert.match(suggestionsFor(pageContextOf('/jobs/abc'))[0], /这条/);
  assert.match(suggestionsFor(pageContextOf('/hotspots')).join(), /热榜/);
  assert.match(suggestionsFor(pageContextOf('/')).join(), /热榜/);
});

test('Markdown 渲染列表与粗体，HTML 按纯文本显示', () => {
  const html = renderToStaticMarkup(<Markdown text={'**结论**：可以做\n\n1. 第一条\n2. 第二条\n\n<script>alert(1)</script>'} />);
  assert.match(html, /<strong[^>]*>结论<\/strong>/);
  assert.match(html, /<ol[^>]*>.*第一条.*第二条.*<\/ol>/s);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
