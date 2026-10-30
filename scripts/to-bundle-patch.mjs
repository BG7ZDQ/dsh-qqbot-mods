#!/usr/bin/env node
/**
 * 把 entry-list YAML（如 preset-qq.generated.yml）包成 bundle patch 的 `- insert:` 形式。
 *
 * 背景：profile 的 cordis.patch.yml 只能覆盖已存在条目（`patch: entry "x" not found`），
 * 新增条目必须放在 bundle 的 patch 里，且用 `- insert:` 包裹（否则同样报 entry not found）。
 *
 * 用法：
 *   node scripts/to-bundle-patch.mjs <in.yml> <out.yml>
 */
import fs from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node to-bundle-patch.mjs <in.yml> <out.yml>');
  process.exit(1);
}
const lines = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const comments = [];
const body = [];
for (const line of lines) {
  if (line.trim().startsWith('#') || line.trim() === '') {
    comments.push(line);
    continue;
  }
  body.push('    ' + line);
}
const out = ['# bundle patch：用 - insert: 新增 preset 条目', ...comments, '- insert:', ...body, ''].join('\n');
fs.writeFileSync(dst, out, 'utf8');
console.log(`ok: ${dst}（${body.length} 行条目）`);
