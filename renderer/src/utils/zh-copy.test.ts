import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 界面文案守门：带中文的界面文字里不允许混进英文单词（白名单里的专有名词、格式名除外）。
 * 新加一句「生成 Skill」「在 Finder 中显示」这种半中半英的文案，这里会直接失败。
 */
const ALLOW = new Set(`AI API ID Key AppID AppSecret Cookie Cookies App Doin Studio DeepSeek OpenAI Claude Code Gemini Kimi Qwen GPT
HTML URL QQ IP Tokens Token Ctrl Mac Shift Alt Enter Esc F12 Application MB GB KB MP jpg png webp mp mp3 wav m4a aac JSON SRT
Markdown PDF XX YYYY MM DDTHH mm WECHAT APP SECRET AUTHOR Documents raw processed output videos logs`.split(/\s+/));

const ROOT = path.resolve(import.meta.dirname, '..');
const CJK = /[\u4e00-\u9fff]/;
const LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
const JSX_TEXT = />([^<>{}\n]+)</g;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'dev') yield* sourceFiles(full); continue; }
    if (/\.(tsx?|ts)$/.test(name) && !name.includes('.test.')) yield full;
  }
}

test('界面中文文案里没有混入英文单词', () => {
  const problems: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const texts = [...line.matchAll(LITERAL)].map(m => m[1] ?? m[2]).concat([...line.matchAll(JSX_TEXT)].map(m => m[1]));
      for (const text of texts) {
        if (!CJK.test(text) || /className=|https?:\/\/|<section|style=/.test(text)) continue;
        const bad = (text.match(/[A-Za-z]{2,}/g) ?? []).filter(word => !ALLOW.has(word));
        if (bad.length) problems.push(`${path.relative(ROOT, file)}:${index + 1} ${bad.join(',')} ← ${text.trim().slice(0, 60)}`);
      }
    });
  }
  assert.deepEqual(problems, []);
});
