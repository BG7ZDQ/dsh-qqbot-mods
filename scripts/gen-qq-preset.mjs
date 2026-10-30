#!/usr/bin/env node
/**
 * 从 `dsh --profile <probe> --dump-default-config` 的输出里取出 standard preset，
 * 生成一份"组成相同、只改上下文压缩参数"的 QQ 专用 preset（entry-list YAML）。
 *
 * 用法：
 *   node scripts/gen-qq-preset.mjs <dump.yml> <out.yml> [options]
 *
 * options（可选，按顺序或 --key=value）：
 *   thresholdRatio=0.04  headroomTokens=8192  retainTokens=10000
 *   maxTokens=16384      summarizerProvider=deepseek-account
 *   summarizerModel=deepseek-flash   presetId=qq  entryId=preset-qq
 *
 * 生成结果再交给 scripts/to-bundle-patch.mjs 包成 bundle patch（- insert: 形式）。
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: node gen-qq-preset.mjs <dump.yml> <out.yml> [key=value ...]');
  process.exit(1);
}
const [dumpFile, outFile, ...rest] = argv;
const opts = {
  thresholdRatio: '0.04',
  headroomTokens: '8192',
  retainTokens: '10000',
  maxTokens: '16384',
  summarizerProvider: 'deepseek-account',
  summarizerModel: 'deepseek-flash',
  presetId: 'qq',
  entryId: 'preset-qq',
};
for (const arg of rest) {
  const m = /^([A-Za-z]+)=(.+)$/.exec(arg);
  if (!m) continue;
  if (m[1] in opts) opts[m[1]] = m[2];
}

const all = fs.readFileSync(dumpFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const startIdx = all.findIndex((l) => l.trim() === '- id: preset-standard');
if (startIdx < 0) throw new Error('未找到 "- id: preset-standard"，请确认 dump 文件来自 --dump-default-config');
let endIdx = all.findIndex((l, i) => i > startIdx && /^- id: preset-/.test(l.trim()));
if (endIdx < 0) endIdx = all.length;

const lines = all.slice(startIdx, endIdx);
const indentOf = (s) => s.slice(0, s.length - s.trimStart().length);
const trimmedAt = (i) => lines[i].trim();
const findTrimmed = (s, from = 0) => {
  for (let i = from; i < lines.length; i += 1) if (trimmedAt(i) === s) return i;
  return -1;
};

// 1) 行 id / config.id / order / name
const iEntry = findTrimmed('- id: preset-standard');
lines[iEntry] = indentOf(lines[iEntry]) + '- id: ' + opts.entryId;
const iId = findTrimmed('id: standard');
if (iId < 0) throw new Error('未找到 config.id');
lines[iId] = indentOf(lines[iId]) + 'id: ' + opts.presetId;
const iOrder = findTrimmed('order: 1');
if (iOrder >= 0) {
  lines[iOrder] = indentOf(lines[iOrder]) + 'order: 90';
  lines.splice(iOrder + 1, 0, indentOf(lines[iOrder]) + 'name: QQ 机器人（早压缩）');
}

// 2) compaction-basic 配置
const iCb = findTrimmed("name: '@deepseek-ai/dsh-compaction-basic'");
if (iCb < 0) throw new Error('未找到 compaction-basic（该版本的 preset 结构可能不同）');
const cbIndent = indentOf(lines[iCb]);
lines.splice(
  iCb + 1,
  0,
  cbIndent + 'config:',
  cbIndent + '  thresholdRatio: ' + opts.thresholdRatio,
  cbIndent + '  headroomTokens: ' + opts.headroomTokens,
  cbIndent + '  retainTokens: ' + opts.retainTokens,
  cbIndent + '  maxTokens: ' + opts.maxTokens,
  cbIndent + '  compactionRetries: 1',
  cbIndent + '  maxOverflowRetries: 1',
  cbIndent + '  auto: true',
  cbIndent + '  summarizationProvider: ' + opts.summarizerProvider,
  cbIndent + '  summarizationModel: ' + opts.summarizerModel,
  cbIndent + '  modelPolicies: []',
);

// 3) 收紧工具结果修剪阈值（压缩触发时先剪大块工具输出，可能省掉一次摘要调用）
const setNum = (prefix, value) => {
  const i = lines.findIndex((l) => l.trim().startsWith(prefix + ':'));
  if (i >= 0) lines[i] = indentOf(lines[i]) + prefix + ': ' + value;
};
setNum('thresholdChars', '4096');
setNum('headChars', '2048');
setNum('tailChars', '512');

const header = [
  '# QQ 专用 agent preset：组成与 standard 相同，只改上下文压缩/修剪参数。',
  '# 该文件由 scripts/gen-qq-preset.mjs 生成，改动请改脚本后重新生成。',
  '',
].join('\n');
fs.writeFileSync(outFile, header + lines.join('\n') + '\n', 'utf8');
console.log(`ok: ${outFile}（${lines.length} 行，presetId=${opts.presetId}）`);
