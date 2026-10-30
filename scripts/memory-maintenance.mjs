#!/usr/bin/env node
/**
 * 记忆文件维护（在 DSH 停止时运行，避免运行中的插件把结果写回）。
 *
 * 做三件事：
 *   1) 长期/短期同义合并去重（归一化相等 / 包含 / 二元组相似度≥0.55）；
 *   2) 含"今天/昨天/刚才/最近…"的长期条目降级到短期；
 *   3) 短期条目保留最早的 at（不续命），并按 TTL 之外的上限截断。
 *
 * 用法：
 *   node scripts/memory-maintenance.mjs [记忆目录]
 *   默认目录：~/.dsh-qqbot/memory
 *
 * 建议先备份：Copy-Item -Recurse ~/.dsh-qqbot/memory ~/.dsh-qqbot/memory.bak
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.argv[2] ?? path.join(os.homedir(), '.dsh-qqbot', 'memory');
const USERS = path.join(DIR, 'users');
const FACT_MAX_CHARS = 60;
const RECENT_MARKER = /(今天|今早|今晚|昨天|昨晚|前两天|前天|刚才|刚刚|这次|这一次|这周|本周|上周|最近一次|最近|上午|下午|中午|晚上)/;
const PUNCT_RE = /[\s，。、；：！？“”"'‘’（）()【】[\]…—\-·~～!?.,;:]/g;
const MAX_GROUP_FACTS = 12;
const MAX_PERSON_FACTS = 6;
const MAX_SHORT = 6;

const key = (t) => String(t ?? '').replace(PUNCT_RE, '').toLowerCase();
const bigrams = (t) => {
  const s = new Set();
  for (let i = 0; i < t.length - 1; i += 1) s.add(t.slice(i, i + 2));
  return s;
};
function same(a, b) {
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [s, l] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (s.length >= 4 && l.includes(s)) return true;
  if (s.length < 6) return false;
  const A = bigrams(ka);
  const B = bigrams(kb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= 0.55;
}
function mergeLong(list, max) {
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, FACT_MAX_CHARS);
    if (!text) continue;
    const i = out.findIndex((x) => same(x, text));
    if (i >= 0) {
      if (key(text).length >= key(out[i]).length) out[i] = text;
      continue;
    }
    out.push(text);
  }
  return out.length <= max ? out : out.slice(out.length - max);
}
function mergeShort(existing, incoming, now, max) {
  const out = [];
  const upsert = (text, at) => {
    if (typeof text !== 'string') return;
    const t = text.trim().slice(0, FACT_MAX_CHARS);
    if (!t) return;
    const i = out.findIndex((x) => same(x.text, t));
    if (i >= 0) {
      out[i] = { text: t, at: Math.min(out[i].at, at) };
      return;
    }
    out.push({ text: t, at });
  };
  for (const s of existing) {
    if (s && typeof s.text === 'string' && typeof s.at === 'number') upsert(s.text, s.at);
  }
  for (const t of incoming) upsert(t, now);
  return out.length <= max ? out : out.slice(out.length - max);
}
const split = (list) => {
  const stable = [];
  const demoted = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const t = x.trim().slice(0, FACT_MAX_CHARS);
    if (!t) continue;
    (RECENT_MARKER.test(t) ? demoted : stable).push(t);
  }
  return { stable, demoted };
};

const stats = { files: 0, merged: 0, demoted: 0 };
const now = Date.now();

function processFile(file, maxFacts) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const beforeLong = Array.isArray(doc.longTerm) ? doc.longTerm : [];
  const beforeShort = Array.isArray(doc.shortTerm) ? doc.shortTerm : [];
  const sp = split(beforeLong);
  stats.demoted += sp.demoted.length;
  const longTerm = mergeLong(sp.stable, maxFacts);
  stats.merged += Math.max(0, sp.stable.length - longTerm.length);
  const shortTerm = mergeShort(beforeShort, sp.demoted, now, MAX_SHORT);
  stats.merged += Math.max(0, beforeShort.length + sp.demoted.length - shortTerm.length);
  doc.longTerm = longTerm;
  doc.shortTerm = shortTerm;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  stats.files += 1;
  return { beforeLong: beforeLong.length, afterLong: longTerm.length, beforeShort: beforeShort.length, afterShort: shortTerm.length };
}

if (!fs.existsSync(DIR)) {
  console.error('记忆目录不存在:', DIR);
  process.exit(1);
}
console.log('memory dir:', DIR);
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const r = processFile(path.join(DIR, f), MAX_GROUP_FACTS);
  console.log(`group ${f.slice(0, 6)}… long ${r.beforeLong}->${r.afterLong} short ${r.beforeShort}->${r.afterShort}`);
}
if (fs.existsSync(USERS)) {
  for (const f of fs.readdirSync(USERS).filter((x) => x.endsWith('.json'))) {
    const r = processFile(path.join(USERS, f), MAX_PERSON_FACTS);
    console.log(`user  ${f.slice(0, 6)}… long ${r.beforeLong}->${r.afterLong} short ${r.beforeShort}->${r.afterShort}`);
  }
}
console.log('summary:', JSON.stringify(stats));
