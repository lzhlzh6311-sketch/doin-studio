import React, { Fragment, type ReactNode } from 'react';

/**
 * 助手回复用的极简 Markdown：标题、列表、粗体、行内代码、代码块、段落。
 * 只生成 React 元素，不用 innerHTML —— 模型输出里的任何 HTML 都按纯文本显示。
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    parts.push(token.startsWith('**')
      ? <strong key={`${keyBase}-${i++}`} className="font-semibold text-ink">{token.slice(2, -2)}</strong>
      : <code key={`${keyBase}-${i++}`} className="rounded bg-elevated px-1 py-0.5 text-[0.85em]">{token.slice(1, -1)}</code>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i += 1;
      blocks.push(<pre key={key++} className="overflow-x-auto rounded-lg bg-elevated p-3 text-xs leading-5"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key++} className="mt-1 font-semibold text-ink">{inline(heading[2], `h${key}`)}</p>);
      i += 1;
      continue;
    }
    if (/^\s*([-*•]|\d+[.、)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.、)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.、)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={key++} className={`space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((item, n) => <li key={n}>{inline(item, `l${key}-${n}`)}</li>)}</List>);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*•]|\d+[.、)])\s+|\s*```)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{para.map((p, n) => <Fragment key={n}>{n > 0 && <br />}{inline(p, `p${key}-${n}`)}</Fragment>)}</p>);
  }
  return <div className="space-y-2 break-words text-sm leading-6 text-ink">{blocks}</div>;
}
