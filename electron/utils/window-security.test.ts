import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isSafeExternalUrl, isTrustedRendererUrl } from './window-security.js';

test('only web and mail links may be handed to the operating system', () => {
  for (const url of ['https://www.toutiao.com/', 'http://localhost:3100/x', 'mailto:someone@example.com']) {
    assert.equal(isSafeExternalUrl(url), true, url);
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'ms-msdt:/id', 'vscode://file/x', '', 'not a url', 42, undefined, `https://a.example/${'x'.repeat(9000)}`]) {
    assert.equal(isSafeExternalUrl(url), false, String(url).slice(0, 40));
  }
});

test('the app window only trusts its own renderer page', () => {
  const rendererIndexPath = path.resolve('/opt/doin/resources/app/dist-renderer/index.html');
  const index = pathToFileURL(rendererIndexPath).href;
  const prod = { rendererIndexPath };
  assert.equal(isTrustedRendererUrl(index, prod), true);
  assert.equal(isTrustedRendererUrl(`${index}#/articles/1`, prod), true, 'hash routes stay on the same page');
  assert.equal(isTrustedRendererUrl(pathToFileURL(path.resolve('/tmp/evil.html')).href, prod), false);
  assert.equal(isTrustedRendererUrl('http://localhost:5173/', prod), false, 'no dev server in production');
  assert.equal(isTrustedRendererUrl('https://evil.example/', prod), false);
  assert.equal(isTrustedRendererUrl(undefined, prod), false);

  const dev = { rendererIndexPath, devServerUrl: 'http://localhost:5173' };
  assert.equal(isTrustedRendererUrl('http://localhost:5173/articles', dev), true);
  assert.equal(isTrustedRendererUrl('http://localhost:5174/', dev), false);
  assert.equal(isTrustedRendererUrl('https://evil.example/', dev), false);
});
