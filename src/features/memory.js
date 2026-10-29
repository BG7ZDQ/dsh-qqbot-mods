/**
 * 记忆系统（群记忆 + 人记忆，各有长期/短期两层）
 *
 * 存储：
 *   ~/.dsh-qqbot/memory/<群openid>.json         群记忆
 *   ~/.dsh-qqbot/memory/users/<member_openid>.json  人记忆（跨群共享）
 *
 * 每份记忆分两层：
 *   longTerm  —— 稳定事实（称呼、喜好、生日、习惯、群体关系），不过期，有上限；
 *   shortTerm —— 最近发生的事（今天吃了什么、今天干了什么），默认 24 小时后过期。
 *
 * 触发（不按消息条数）：聊天安静 distillIdleMs 后整理一次；聊个不停时最多
 * distillMaxIntervalMs 强制整理。整理时由模型自己决定写什么（可以一条都不写）。
 *
 * 失败不影响聊天：压缩失败只记 debug 日志，旧记忆保持。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { qqlog } from '../shared/qqlog.js';
/** 记忆文件默认目录 */
export const MEMORY_ROOT = resolve(homedir(), '.dsh-qqbot', 'memory');
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
/** 解析压缩用的模型路由：显式配置 > 该群会话当前模型 */
function resolveRoute(manager, gid, cfg) {
    if (cfg.provider && cfg.model)
        return { provider: cfg.provider, model: cfg.model };
    try {
        const route = manager.getEffectiveModel?.('group', gid);
        if (route?.provider && route?.model)
            return { provider: route.provider, model: route.model };
    }
    catch {
        // 忽略，回退到 host 默认
    }
    return undefined;
}
/** 去重 + 截断 */
function normalizeList(list, max) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string')
            continue;
        const text = item.trim().slice(0, 60);
        if (text.length === 0 || seen.has(text))
            continue;
        seen.add(text);
        out.push(text);
        if (out.length >= max)
            break;
    }
    return out;
}
/**
 * 创建记忆服务。
 * @param manager - SessionManager（需要 llm 服务与模型路由）
 * @param config - 插件配置（读取 config.memory）
 * @param logger - 插件 logger
 */
export function createMemory(manager, config, logger) {
    const cfg = config.memory ?? {};
    const enabled = cfg.enabled !== false;
    const maxGroupFacts = Math.max(1, num(cfg.maxFacts, 10));
    const maxPersonFacts = Math.max(1, num(cfg.maxPersonFacts, 6));
    const maxShortTerm = Math.max(1, num(cfg.maxShortTerm, 6));
    const shortTermTtlMs = Math.max(5 * 60 * 1000, num(cfg.shortTermTtlMs, 24 * 60 * 60 * 1000));
    const mirrorPersonFacts = cfg.mirrorPersonFacts !== false;
    const maxUsers = Math.max(10, num(cfg.maxUsers, 500));
    /** 聊天安静多久后整理一次（毫秒） */
    const distillIdleMs = Math.max(15 * 1000, num(cfg.distillIdleMs, 120000));
    /** 聊天一直不停时，最长多久强制整理一次（毫秒） */
    const distillMaxIntervalMs = Math.max(60 * 1000, num(cfg.distillMaxIntervalMs, 10 * 60 * 1000));
    const maxPending = Math.max(10, num(cfg.maxPending, 80));
    const dir = typeof cfg.dir === 'string' && cfg.dir.length > 0 ? resolve(cfg.dir) : MEMORY_ROOT;
    const usersDir = join(dir, 'users');
    const groups = new Map();
    const users = new Map();
    /** 正在进行压缩的群，避免同群并发压缩 */
    const distilling = new Set();
    /** 是否已从磁盘扫描过"尚未在内存里出现"的群（重启后补加载用） */
    let groupsScanned = false;
    function groupFile(gid) {
        return join(dir, `${encodeURIComponent(gid)}.json`);
    }
    function userFile(openid) {
        return join(usersDir, `${encodeURIComponent(openid)}.json`);
    }
    function readJson(file) {
        try {
            if (!existsSync(file))
                return undefined;
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch (err) {
            logger?.debug?.(`im-qqbot: memory read failed: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    function writeJson(file, doc) {
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
        }
        catch (err) {
            logger?.warn?.(`im-qqbot: memory write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    function loadGroup(gid) {
        let state = groups.get(gid);
        if (state !== undefined)
            return state;
        const doc = readJson(groupFile(gid)) ?? {};
        // 兼容旧格式：旧文件只有 facts
        const longTerm = Array.isArray(doc.longTerm) ? doc.longTerm : (Array.isArray(doc.facts) ? doc.facts : []);
        state = {
            longTerm: normalizeList(longTerm, maxGroupFacts),
            shortTerm: Array.isArray(doc.shortTerm) ? doc.shortTerm.filter((x) => x && typeof x.text === 'string' && typeof x.at === 'number') : [],
            pending: Array.isArray(doc.pending) ? doc.pending.filter((l) => typeof l === 'string').slice(-maxPending) : [],
            humanCount: typeof doc.humanCount === 'number' ? Math.min(doc.humanCount, maxPending) : 0,
            lastDistillAt: typeof doc.lastDistillAt === 'number' ? doc.lastDistillAt : 0,
            lastHumanAt: typeof doc.lastHumanAt === 'number' ? doc.lastHumanAt : 0,
            dirty: false,
            lastSpeakerId: typeof doc.lastSpeakerId === 'string' ? doc.lastSpeakerId : '',
            lastSpeakerName: typeof doc.lastSpeakerName === 'string' ? doc.lastSpeakerName : '',
        };
        // 重启后如果缓冲里还有没整理的消息，标记为待整理
        state.dirty = state.pending.length > 0;
        groups.set(gid, state);
        return state;
    }
    function saveGroup(gid, state) {
        writeJson(groupFile(gid), {
            version: 2,
            longTerm: state.longTerm,
            shortTerm: pruneShort(state.shortTerm),
            pending: state.pending,
            humanCount: state.humanCount,
            lastDistillAt: state.lastDistillAt,
            lastHumanAt: state.lastHumanAt,
            lastSpeakerId: state.lastSpeakerId,
            lastSpeakerName: state.lastSpeakerName,
        });
    }
    function loadUser(openid) {
        let state = users.get(openid);
        if (state !== undefined)
            return state;
        const doc = readJson(userFile(openid)) ?? {};
        state = {
            openid,
            name: typeof doc.name === 'string' ? doc.name : '',
            longTerm: normalizeList(Array.isArray(doc.longTerm) ? doc.longTerm : [], maxPersonFacts),
            shortTerm: Array.isArray(doc.shortTerm) ? doc.shortTerm.filter((x) => x && typeof x.text === 'string' && typeof x.at === 'number') : [],
            lastSeen: typeof doc.lastSeen === 'number' ? doc.lastSeen : Date.now(),
        };
        users.set(openid, state);
        return state;
    }
    function saveUser(state) {
        writeJson(userFile(state.openid), {
            version: 2,
            name: state.name,
            longTerm: state.longTerm,
            shortTerm: pruneShort(state.shortTerm),
            lastSeen: state.lastSeen,
        });
        pruneUsers();
    }
    /** 超出 maxUsers 时按最久未见淘汰 */
    function pruneUsers() {
        try {
            if (users.size <= maxUsers)
                return;
            const sorted = [...users.values()].sort((a, b) => a.lastSeen - b.lastSeen);
            const remove = sorted.slice(0, users.size - maxUsers);
            for (const u of remove) {
                users.delete(u.openid);
                rmSync(userFile(u.openid), { force: true });
            }
            logger?.info?.(`im-qqbot: memory pruned ${remove.length} inactive users`);
        }
        catch (err) {
            logger?.debug?.(`im-qqbot: memory prune failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 过滤过期的短期记忆，并按上限截断 */
    function pruneShort(list) {
        const now = Date.now();
        return list.filter((x) => x && typeof x.text === 'string' && typeof x.at === 'number' && now - x.at < shortTermTtlMs).slice(-maxShortTerm);
    }
    function push(state, line) {
        state.pending.push(line.slice(0, 200));
        if (state.pending.length > maxPending)
            state.pending.splice(0, state.pending.length - maxPending);
    }
    /** 记录一条人类消息（群聊由 reply-policy 调用；私聊由 inbound 调用） */
    function noteHuman(gid, input = {}) {
        if (!enabled || !gid)
            return;
        if (typeof input.content !== 'string' || input.content.length === 0)
            return;
        const state = loadGroup(gid);
        const senderId = typeof input.senderId === 'string' ? input.senderId : '';
        const senderName = typeof input.senderName === 'string' && input.senderName.length > 0 ? input.senderName : '群友';
        push(state, senderId ? `${senderName}(${senderId}): ${input.content}` : `${senderName}: ${input.content}`);
        state.humanCount += 1;
        state.lastHumanAt = Date.now();
        state.dirty = true;
        state.lastSpeakerId = senderId;
        state.lastSpeakerName = senderName;
        if (senderId) {
            const user = loadUser(senderId);
            user.lastSeen = Date.now();
            user.name = senderName;
            saveUser(user);
        }
        // 不按消息条数触发：只标记"有待整理"，由 tick 在聊天告一段落 /
        // 距上次整理太久时决定何时压缩；压缩时由模型自己判断记什么。
        saveGroup(gid, state);
    }
    /**
     * 定时驱动（由 engagement 的 15s 巡检调用）：
     *   - 聊天安静 distillIdleMs 之后 → 整理一次；
     *   - 或距上次整理超过 distillMaxIntervalMs → 即使还在聊也整理；
     *   - 一次只跑一个群的压缩，避免并发拖慢/超时。
     */
    async function tick() {
        if (!enabled)
            return;
        // 启动后先把磁盘上的群记忆全部加载进来：
        // 否则重启后如果群里还没人说话，groups 是空的，永远不会触发整理。
        if (!groupsScanned) {
            groupsScanned = true;
            try {
                if (existsSync(dir)) {
                    for (const name of readdirSync(dir)) {
                        if (!name.endsWith('.json'))
                            continue;
                        try {
                            loadGroup(decodeURIComponent(name.slice(0, -5)));
                        }
                        catch {
                            // 单个文件损坏不影响其它群
                        }
                    }
                }
            }
            catch (err) {
                logger?.debug?.(`im-qqbot: memory scan failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const now = Date.now();
        for (const [gid, state] of groups) {
            if (distilling.size > 0)
                break;
            if (!state.dirty || distilling.has(gid))
                continue;
            if (state.pending.length === 0)
                continue;
            const idle = now - state.lastHumanAt >= distillIdleMs;
            const overdue = now - state.lastDistillAt >= distillMaxIntervalMs;
            if (!idle && !overdue)
                continue;
            state.dirty = false;
            state.humanCount = 0;
            state.lastDistillAt = now;
            saveGroup(gid, state);
            qqlog('memory-distill-start', { gid, pending: state.pending.length, idle, overdue });
            void distill(gid, state).catch((err) => {
                // 兜底：任何未在 distill 内部处理的异常都要落诊断日志，不能静默失败
                qqlog('memory-distill', { gid, ok: false, stage: 'uncaught', error: err instanceof Error ? err.message : String(err) });
                logger?.debug?.(`im-qqbot: memory distill failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
    }
    /** 记录一条机器人消息（只进缓冲，不单独触发压缩） */
    function noteBot(gid, text) {
        if (!enabled || !gid)
            return;
        const state = loadGroup(gid);
        push(state, `小小鱼: ${String(text ?? '').slice(0, 120)}`);
        saveGroup(gid, state);
    }
    /** 组装压缩 prompt 里"已有记忆"部分 */
    function describeExisting(group) {
        const lines = [];
        lines.push('【已有的群长期记忆】');
        lines.push(group.longTerm.length > 0 ? group.longTerm.map((f) => `- ${f}`).join('\n') : '（无）');
        const groupShort = pruneShort(group.shortTerm);
        lines.push('【已有的群短期记忆】');
        lines.push(groupShort.length > 0 ? groupShort.map((s) => `- ${s.text}`).join('\n') : '（无）');
        // 最近发言人的已有个人记忆
        const seen = new Set();
        for (const line of group.pending.slice(-30)) {
            const m = /\(([0-9A-Za-z]{8,})\):/.exec(line);
            if (!m)
                continue;
            const openid = m[1];
            if (seen.has(openid))
                continue;
            seen.add(openid);
            const user = loadUser(openid);
            if (user.longTerm.length === 0 && pruneShort(user.shortTerm).length === 0)
                continue;
            lines.push(`【成员 ${user.name || openid}(${openid}) 已有长期记忆】`);
            lines.push(user.longTerm.length > 0 ? user.longTerm.map((f) => `- ${f}`).join('\n') : '（无）');
            lines.push(`【成员 ${user.name || openid}(${openid}) 已有短期记忆】`);
            const short = pruneShort(user.shortTerm);
            lines.push(short.length > 0 ? short.map((s) => `- ${s.text}`).join('\n') : '（无）');
        }
        return lines.join('\n');
    }
    /** 调小模型压缩最近的聊天，更新群记忆与人记忆（并发保护） */
    async function distill(gid, group) {
        if (distilling.has(gid))
            return;
        distilling.add(gid);
        try {
            await runDistill(gid, group);
        }
        finally {
            distilling.delete(gid);
        }
    }
    /** 真正的压缩逻辑 */
    async function runDistill(gid, group) {
        qqlog('memory-distill-enter', { gid, pending: group.pending.length });
        let llm;
        try {
            llm = manager.ctx?.get?.('llm');
        }
        catch {
            llm = undefined;
        }
        if (typeof llm?.stream !== 'function') {
            qqlog('memory-distill', { gid, ok: false, stage: 'no-llm' });
            return;
        }
        const route = resolveRoute(manager, gid, cfg);
        if (route === undefined) {
            qqlog('memory-distill', { gid, ok: false, stage: 'no-route' });
            return;
        }
        const transcript = group.pending.slice(-30).join('\n');
        if (transcript.length === 0) {
            qqlog('memory-distill', { gid, ok: false, stage: 'empty' });
            return;
        }
        const prompt = `你是群聊机器人"小小鱼"的记忆整理器。只输出一行 JSON，不解释。

${describeExisting(group)}

【最近的聊天记录】（格式：昵称(openid): 内容）
${transcript}

请更新记忆：
1. groupFacts：本群稳定事实（群里的梗、常聊话题、群体关系、群规），最多 ${maxGroupFacts} 条，每条≤40字；
2. groupRecent：本群最近发生的事（一次性事件，比如谁今天做了什么），最多 ${maxShortTerm} 条，会短期保存；
3. people：每个发过言的成员的记忆（openid 必须原样照抄聊天记录括号里的 id）：
   - facts：这个人的稳定信息（称呼、喜好、生日、习惯、关系），每人最多 ${maxPersonFacts} 条，每条≤40字；
   - recent：这个人最近发生的事（今天吃了什么、今天干了什么），每人最多 ${maxShortTerm} 条，会短期保存。

规则：
- 短期记忆只留"最近、有用、几天内还可能提到"的事，过期无意义的不要；
- 不要把一次性寒暄、隐私敏感信息写进长期记忆；
- 已有记忆如果仍然有效就保留，过时了才删；
- 已有群长期记忆里如果其实是某个成员的稳定信息（称呼、喜好、生日、习惯），
  可以移到该成员的 facts 里、并从 groupFacts 删除（人记忆会跨群共享）。

只输出：{"groupFacts":[],"groupRecent":[],"people":[{"openid":"","name":"","facts":[],"recent":[]}]}`;
        const controller = new AbortController();
        const timeoutMs = Math.max(5000, num(cfg.timeoutMs, 60000));
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const started = Date.now();
        try {
            const message = createUserMessage({
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
            });
            const assembler = new BlockAssembler();
            let hardTimer;
            const hardTimeout = new Promise((_resolve, reject) => {
                hardTimer = setTimeout(() => reject(new Error('distill hard timeout')), timeoutMs + 5000);
            });
            try {
                const consume = (async () => {
                    for await (const chunk of llm.stream({
                        provider: route.provider,
                        model: route.model,
                        messages: [message],
                        maxTokens: Math.max(500, num(cfg.maxTokens, 4000)),
                        // 记忆整理是结构化工具任务，不需要长时间推理：
                        // 默认高推理会把输出预算烧在 reasoning 上，导致正文为空。
                        reasoningEffort: 'low',
                        signal: controller.signal,
                    })) {
                        assembler.push(chunk);
                    }
                })();
                await Promise.race([consume, hardTimeout]);
            }
            finally {
                clearTimeout(hardTimer);
            }
            const text = assembler
                .blocks()
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join(' ');
            qqlog('memory-distill-step', {
                gid,
                stage: 'stream-done',
                chars: text.length,
                finish: assembler.finish?.kind,
                ms: Date.now() - started,
            });
            const match = /\{[\s\S]*\}/.exec(text);
            if (!match) {
                // 模型没按格式输出 JSON（常见原因：推理 token 用完了输出上限）——记录原始文本便于排查
                qqlog('memory-distill', { gid, ok: false, stage: 'no-json', text: text.slice(0, 300), ms: Date.now() - started });
                return;
            }
            const raw = JSON.parse(match[0]);
            const now = Date.now();
            // 群记忆
            if (Array.isArray(raw.groupFacts))
                group.longTerm = normalizeList(raw.groupFacts, maxGroupFacts);
            if (Array.isArray(raw.groupRecent)) {
                const recent = normalizeList(raw.groupRecent, maxShortTerm);
                group.shortTerm = recent.map((t) => ({ text: t, at: now }));
            }
            group.pending = group.pending.slice(-10);
            saveGroup(gid, group);
            // 人记忆（跨群共享；mirrorPersonFacts 关闭时跳过）
            let peopleWritten = 0;
            if (mirrorPersonFacts && Array.isArray(raw.people)) {
                for (const person of raw.people) {
                    if (!person || typeof person.openid !== 'string' || person.openid.length < 8)
                        continue;
                    const user = loadUser(person.openid);
                    if (typeof person.name === 'string' && person.name.length > 0)
                        user.name = person.name;
                    if (Array.isArray(person.facts))
                        user.longTerm = normalizeList([...user.longTerm, ...person.facts], maxPersonFacts);
                    if (Array.isArray(person.recent)) {
                        const merged = [
                            ...pruneShort(user.shortTerm).map((s) => s.text),
                            ...normalizeList(person.recent, maxShortTerm),
                        ];
                        user.shortTerm = normalizeList(merged, maxShortTerm).map((t) => ({ text: t, at: now }));
                    }
                    user.lastSeen = now;
                    saveUser(user);
                    peopleWritten += 1;
                }
            }
            qqlog('memory-distill', {
                gid,
                ok: true,
                groupFacts: group.longTerm.length,
                groupRecent: group.shortTerm.length,
                people: peopleWritten,
                ms: Date.now() - started,
            });
            logger?.info?.(`im-qqbot: memory updated (${Date.now() - started}ms, group=${group.longTerm.length}f, people=${peopleWritten})`);
        }
        catch (err) {
            qqlog('memory-distill', { gid, ok: false, error: err instanceof Error ? err.message : String(err) });
            logger?.debug?.(`im-qqbot: memory distill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * 渲染注入 system prompt 的记忆文本。
     * @param gid - 群 openid（私聊时就是对方 openid）
     * @param senderId - 当前发言人 openid；缺省用该群最后发言人
     */
    function render(gid, senderId) {
        if (!enabled)
            return { longTerm: '', shortTerm: '' };
        const group = loadGroup(gid);
        const now = Date.now();
        const groupShort = pruneShort(group.shortTerm).map((s) => s.text);
        const speaker = typeof senderId === 'string' && senderId.length > 0 ? senderId : group.lastSpeakerId;
        let userLong = [];
        let userShort = [];
        let userName = '';
        if (speaker) {
            const user = loadUser(speaker);
            userName = user.name;
            if (now - user.lastSeen < 180 * 24 * 60 * 60 * 1000) {
                userLong = user.longTerm;
                userShort = pruneShort(user.shortTerm).map((s) => s.text);
            }
        }
        const longTerm = normalizeList([...userLong, ...group.longTerm], maxPersonFacts + maxGroupFacts);
        const shortTerm = normalizeList([...userShort, ...groupShort], maxShortTerm * 2);
        const longText = longTerm.length > 0
            ? `【你记得的事（长期记忆）】\n${longTerm.map((f) => `- ${f}`).join('\n')}\n（自然使用，别整段复述，也别提"记忆库"这种词。）`
            : '';
        const shortText = shortTerm.length > 0
            ? `【最近的事（短期记忆，会过期）】\n${shortTerm.map((f) => `- ${f}`).join('\n')}\n（可以自然提起，但别当成永远成立的事实。）`
            : '';
        return { longTerm: longText, shortTerm: shortText, userName };
    }
    return {
        enabled,
        noteHuman,
        noteBot,
        tick,
        render,
        lastSpeaker: (gid) => loadGroup(gid).lastSpeakerId,
        facts: (gid) => loadGroup(gid).longTerm,
        shortFacts: (gid) => pruneShort(loadGroup(gid).shortTerm).map((s) => s.text),
        userFacts: (openid) => {
            const user = loadUser(openid);
            return { name: user.name, longTerm: user.longTerm, shortTerm: pruneShort(user.shortTerm).map((s) => s.text) };
        },
    };
}
