/**
 * 诊断日志：把 QQ 插件处理链路的关键节点追加到 ~/.dsh-qqbot/debug.jsonl。
 *
 * 排查"消息到了却没回/回复异常"时用：inbound → policy → handler → turn-end
 * 四个节点串起来能定位卡在哪一步。写失败静默忽略，不影响消息处理。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DIR = join(homedir(), '.dsh-qqbot');
const FILE = join(DIR, 'debug.jsonl');
let dirReady = false;
/**
 * 追加一条诊断日志。
 * @param tag - 节点名（inbound / policy / handler / turn-end / proactive）
 * @param payload - 任意可 JSON 序列化的字段
 */
export function qqlog(tag, payload = {}) {
    try {
        if (!dirReady) {
            mkdirSync(DIR, { recursive: true });
            dirReady = true;
        }
        appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), tag, ...payload }) + '\n');
    }
    catch {
        // 诊断失败不影响主流程
    }
}
