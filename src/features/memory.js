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
 * 写入策略（本文件的关键）：
 *   1. 落盘前先和已有记忆合并：同义/包含/高相似 → 视为同一条，用新措辞更新，不新增；
 *   2. 带"今天/昨天/刚才/最近"等时间词的条目即使是模型放进长期列表，也会被降级到短期；
 *   3. 短期记忆保留原有 at 时间戳（同一条被重复输出不会续命），真正按 24h 过期；
 *   4. 模型万一返回空列表，不清空已有长期记忆（避免一次抖动把记忆洗掉）。
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
/** 记忆条目长度上限（字符） */
const FACT_MAX_CHARS = 60;
/** "这像是最近发生的事"的词表：命中就从长期降级到短期 */
const RECENT_MARKER = /(今天|今早|今晚|昨天|昨晚|前两天|前天|刚才|刚刚|这次|这一次|这周|本周|上周|最近一次|最近|上午|下午|中午|晚上)/;

/** 归一化：去掉标点/空白，便于判断"意思是不是同一条" */
const PUNCT_RE = /[\s，。、；：！？“”"'‘’（）()【】[\]…—\-·~～!?.,;:]/g;
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
function factKey(text) {
    return String(text ?? '').replace(PUNCT_RE, '').toLowerCase();
}
function bigrams(text) {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1)
        set.add(text.slice(i, i + 2));
    return set;
}
/** 两条记忆是否"同一条"：归一化相等 / 短的一方被包含 / 二元组相似度够高 */
function isSameFact(a, b) {
    const ka = factKey(a);
    const kb = factKey(b);
    if (ka.length === 0 || kb.length === 0)
        return false;
    if (ka === kb)
        return true;
    const [shortKey, longKey] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    if (shortKey.length >= 4 && longKey.includes(shortKey))
        return true;
    if (shortKey.length < 6)
        return false;
    const A = bigrams(ka);
    const B = bigrams(kb);
    let inter = 0;
    for (const g of A)
        if (B.has(g))
            inter += 1;
    const union = A.size + B.size - inter;
    return union > 0 && inter / union >= 0.55;
}
/** 是否"像是最近发生的事"（用于把误放进长期的事件降级到短期） */
function looksRecent(text) {
    return RECENT_MARKER.test(String(text ?? ''));
}
/**
 * 合并式去重：同义条目只保留一条（信息更全的措辞优先），最多 max 条。
 * 超出上限时丢最旧的（列表头部）。
 */
function mergeMemoList(list, max) {
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string')
            continue;
        const text = item.trim().slice(0, FACT_MAX_CHARS);
        if (text.length === 0)
            continue;
        const idx = out.findIndex((existing) => isSameFact(existing, text));
        if (idx >= 0) {
            // 同一条：保留更长/信息量更大的表述；一样长就用新措辞（模型更新过）
            const old = out[idx];
            if (factKey(text).length >= factKey(old).length)
                out[idx] = text;
            continue;
        }
        out.push(text);
    }
    if (out.length <= max)
        return out;
    return out.slice(out.length - max);
}
/** 把列表拆成"稳定事实"和"应该算短期的事件"，后者交给短期层 */
function splitRecent(list) {
    const stable = [];
    const demoted = [];
    for (const item of list) {
        if (typeof item !== 'string')
            continue;
        const text = item.trim().slice(0, FACT_MAX_CHARS);
        if (text.length === 0)
            continue;
        if (looksRecent(text))
            demoted.push(text);
        else
            stable.push(text);
    }
    return { stable, demoted };
}
/**
 * 合并短期记忆并保留原始时间戳：
 * 已有条目即使被模型再次输出，也不会刷新 at，因此 24h TTL 是真实生效的。
 */
function mergeShortTerm(existing, incoming, now, max) {
    const out = [];
    const upsert = (text, at) => {
        if (typeof text !== 'string')
            return;
        const trimmed = text.trim().slice(0, FACT_MAX_CHARS);
        if (trimmed.length === 0)
            return;
        const idx = out.findIndex((item) => isSameFact(item.text, trimmed));
        if (idx >= 0) {
            // 同一条：保留更早的时间戳（不续命），措辞用更新的
            out[idx] = { text: trimmed, at: Math.min(out[idx].at, at) };
            return;
        }
        out.push({ text: trimmed, at });
    };
    for (const item of existing) {
        if (item && typeof item.text === 'string' && typeof item.at === 'number')
            upsert(item.text, item.at);
    }
    for (const item of incoming) {
        if (item && typeof item.at === 'number' && typeof item.text === 'string')
            upsert(item.text, item.at);
        else
            upsert(item, now);
    }
    if (out.length <= max)
        return out;
    return out.slice(out.length - max);
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
        const { stable, demoted } = splitRecent(longTerm);
        const existingShort = Array.isArray(doc.shortTerm)
            ? doc.shortTerm.filter((x) => x && typeof x.text === 'string' && typeof x.at === 'number')
            : [];
        state = {
            // 加载时就合并去重：历史遗留的重复条目在这里收敛
            longTerm: mergeMemoList(stable, maxGroupFacts),
            shortTerm: mergeShortTerm(existingShort, demoted, Date.now(), maxShortTerm),
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
        const { stable, demoted } = splitRecent(Array.isArray(doc.longTerm) ? doc.longTerm : []);
        const existingShort = Array.isArray(doc.shortTerm)
            ? doc.shortTerm.filter((x) => x && typeof x.text === 'string' && typeof x.at === 'number')
            : [];
        state = {
            openid,
            name: typeof doc.name === 'string' ? doc.name : '',
            longTerm: mergeMemoList(stable, maxPersonFacts),
            shortTerm: mergeShortTerm(existingShort, demoted, Date.now(), maxShortTerm),
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

请更新记忆（在已有记忆的基础上"更新"，不是重新写一份）：
1. groupFacts：本群稳定事实，最多 ${maxGroupFacts} 条，每条≤40字；
2. groupRecent：本群最近发生的事，最多 ${maxShortTerm} 条，会短期保存；
3. people：每个发过言的成员的记忆（openid 必须原样照抄聊天记录括号里的 id）：
   - facts：这个人的稳定信息，每人最多 ${maxPersonFacts} 条，每条≤40字；
   - recent：这个人最近发生的事，每人最多 ${maxShortTerm} 条，会短期保存。

长期 vs 短期（很重要）：
- 长期 = 不随日期变化：身份、称呼、喜好、生日、习惯、人际关系、群的主题/梗/群规；
- 短期 = 最近发生的事：今天吃了什么、今天做了什么、最近在玩什么、一次性的话题。
  "今天/昨天/刚才/最近/上午/下午"这类描述一律放 recent，不要放长期。
- 例子（放长期）：喜欢堇子 / 习惯叫小小鱼"鱼" / 群梗是"小小鱼不是鱼" / 群里常聊卫星
- 例子（放短期）：今天吃了火锅 / 最近在玩QQ农场 / 今天聊到压缩上下文 / 今天早八到教室

规则：
- 已有记忆仍然有效的保留；过时的删掉；措辞可以更新得更准确；
- 同一条意思只输出一次：已有条目和新条目意思相同，就合并成一条（用更准确的措辞），
  绝不允许输出两条同义条目；
- 已有群长期记忆里如果其实是某个成员的稳定信息（称呼、喜好、生日、习惯），
  移到该成员的 facts 里、并从 groupFacts 删除（人记忆会跨群共享）；
- 不要把一次性寒暄、隐私敏感信息写进长期记忆；
- 不要记录任何关于"小小鱼"自身实现/设计的讨论：token 消耗、上下文压缩、记忆系统、
  提示词、模型/参数、自动审查机制、调试报错、插件/代码等。这类是开发调试内容，不是群记忆，
  遇到直接忽略，也不要写进 recent。
- 反例（一律不记）：群友讨论 token 消耗 / 压缩上下文到 40k / 自动审查是否有必要 /
  记忆系统怎么实现的。

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
            let deduped = 0;
            let demoted = 0;
            // ── 群长期：拆掉"其实是短期"的条目 → 合并去重 → 和已有记忆对齐 ──
            if (Array.isArray(raw.groupFacts) && (raw.groupFacts.length > 0 || group.longTerm.length === 0)) {
                const before = group.longTerm.length;
                const split = splitRecent(raw.groupFacts);
                demoted += split.demoted.length;
                const merged = mergeMemoList(split.stable, maxGroupFacts);
                deduped += Math.max(0, split.stable.length - merged.length);
                group.longTerm = merged;
                // 被降级的条目补进 groupRecent，避免丢信息
                if (split.demoted.length > 0) {
                    if (!Array.isArray(raw.groupRecent))
                        raw.groupRecent = [];
                    raw.groupRecent = [...split.demoted, ...raw.groupRecent];
                }
                logger?.debug?.(`im-qqbot: group facts ${before}->${group.longTerm.length}`);
            }
            // ── 群短期：保留原时间戳（不续命），合并去重 ──
            if (Array.isArray(raw.groupRecent)) {
                const merged = mergeShortTerm(group.shortTerm, raw.groupRecent, now, maxShortTerm);
                deduped += Math.max(0, pruneShort(group.shortTerm).length + raw.groupRecent.length - merged.length);
                group.shortTerm = merged;
            }
            group.pending = group.pending.slice(-10);
            saveGroup(gid, group);
            // ── 人记忆（跨群共享）：长期=合并更新（不重复追加），短期=带时间戳合并 ──
            let peopleWritten = 0;
            if (mirrorPersonFacts && Array.isArray(raw.people)) {
                for (const person of raw.people) {
                    if (!person || typeof person.openid !== 'string' || person.openid.length < 8)
                        continue;
                    const user = loadUser(person.openid);
                    if (typeof person.name === 'string' && person.name.length > 0)
                        user.name = person.name;
                    const splitFacts = splitRecent(Array.isArray(person.facts) ? person.facts : []);
                    demoted += splitFacts.demoted.length;
                    if (splitFacts.stable.length > 0 || user.longTerm.length === 0) {
                        const before = user.longTerm.length;
                        const merged = mergeMemoList([...user.longTerm, ...splitFacts.stable], maxPersonFacts);
                        deduped += Math.max(0, before + splitFacts.stable.length - merged.length);
                        user.longTerm = merged;
                    }
                    const recentIn = [...splitFacts.demoted, ...(Array.isArray(person.recent) ? person.recent : [])];
                    if (recentIn.length > 0) {
                        const beforeShort = pruneShort(user.shortTerm).length;
                        const merged = mergeShortTerm(user.shortTerm, recentIn, now, maxShortTerm);
                        deduped += Math.max(0, beforeShort + recentIn.length - merged.length);
                        user.shortTerm = merged;
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
                groupRecent: pruneShort(group.shortTerm).length,
                people: peopleWritten,
                merged: deduped,
                demoted,
                ms: Date.now() - started,
            });
            logger?.info?.(`im-qqbot: memory updated (${Date.now() - started}ms, group=${group.longTerm.length}f, people=${peopleWritten}, merged=${deduped}, demoted=${demoted})`);
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
        const longTerm = mergeMemoList([...userLong, ...group.longTerm], maxPersonFacts + maxGroupFacts);
        const shortTerm = mergeMemoList([...userShort, ...groupShort], maxShortTerm * 2);
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
