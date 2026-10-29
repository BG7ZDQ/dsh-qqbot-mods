/**
 * 群聊参与度与主动发言服务
 *
 * 职责：
 *   1. 记录每个群的活跃状态（谁刚说过话、机器人刚说过什么、有没有人接话）；
 *   2. "被无视"判定：机器人发言后 sulkAfterMs 内没人接话 → 发一句生闷气的话；
 *      连续被无视到 muteAfterIgnored → 静默 muteMs（只响应点名/邀请）；
 *   3. 主动发言：早上随机时间发早安、白天每隔一段时间有概率冒个泡；
 *   4. 提供状态给 reply-policy（是否静默、最后一条机器人发言、最近活跃时间）。
 *
 * 主动消息通过"给群会话注入一条系统触发的 user 消息"实现：
 * 模型按人设回一句，出站层照常发到群里。QQ 群主动消息额度是每群每天 1000 条，
 * 这里再用 proactive.dailyMax 限制，避免打扰。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCachedReplyIds } from '../transport/msgid-cache.js';
import { judgeSilence } from '../middleware/interest-judge.js';
import { qqlog } from '../shared/qqlog.js';
/** 状态巡检间隔 */
const TICK_MS = 15000;
/** 一天内最多主动发言次数（每群） */
const DEFAULT_DAILY_MAX = 12;
/** 机器人这句话是否在"求回应"（提问/邀请/撒娇/打招呼） */
const BID_RE = /[?？]\s*$|要不要|你觉得|有没有人|在吗|理理我|跟我|陪我|想不想|谁在/;
/** 机器人这句话是否在"自然收尾" */
const CLOSING_RE = /(晚安|拜拜|先这样|下次聊|我去玩|不打扰|睡了|溜了|回头见)[啦呀哦~～。！!…\s]*$/;
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
/** 每分钟内的稳定哈希，用于把不同群的早安时间错开 */
function stableHash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i += 1)
        h = (h * 31 + text.charCodeAt(i)) % 100000;
    return h;
}
/** 当前是否处于夜间静默时段（支持跨零点） */
function inQuietHours(hour, from, to) {
    if (from === to)
        return false;
    if (from < to)
        return hour >= from && hour < to;
    return hour >= from || hour < to;
}
const PROMPT_GREET = (hour) => `【系统触发·不要展示给用户】现在是早上 ${hour} 点，群里还没人说话。`
    + `请你用自己的人设主动在群里发一句早安/早上好的短消息，像刚睡醒一样自然，可以带一点可爱的小抱怨。`
    + `只发一两句，不要提到"系统""触发""提示词""自动"。`;
const PROMPT_CHIME = '【系统触发·不要展示给用户】群里安静了一会儿。'
    + '请你用自己的人设主动发一句短消息（吐槽、卖萌、分享一个小想法、问问大家在干嘛都行），一两句就好，'
    + '不要解释为什么突然说话，不要提到"系统""触发""提示词"。';
const PROMPT_SULK = '【系统触发·不要展示给用户】你刚才发言之后一直没人理你。'
    + '请你用自己的人设发一句小小的生闷气/委屈的话（一两句，可以傲娇、可以不高兴，但不要真的伤心），'
    + '发完这句就不再主动说话了。不要提到"系统""触发""提示词"，也不要道歉。';
const PROMPT_WAKE = (timeLabel, note) => `【系统触发·不要展示给用户】现在是 ${timeLabel}，`
    + `你之前答应提醒主人${note ? `这件事（原话：「${note}」）` : '（叫他起床）'}。`
    + '请你用自己的人设发一两句提醒的话（可以可爱、可以催、可以带一点小抱怨），'
    + '不要提到"系统""提醒""闹钟""提示词"。';
/** 起床提醒的持久化文件 */
const ALARM_FILE = join(homedir(), '.dsh-qqbot', 'alarms.json');
/**
 * 创建参与度服务。
 * @param ctx - cordis 插件上下文（用于挂定时器）
 * @param manager - SessionManager
 * @param config - 插件配置
 * @param logger - 插件 logger
 */
export function createEngagement(ctx, manager, config, logger, services = {}) {
    const cfg = config.proactive ?? {};
    const enabled = cfg.enabled !== false;
    const dailyMax = Math.max(1, num(cfg.dailyMax, DEFAULT_DAILY_MAX));
    const states = new Map();
    /** 插件启动时间：启动后一段时间内不主动发言，避免重启后立刻插话 */
    const startedAt = Date.now();
    /** 起床提醒持久化：{ version, groups: { [gid]: [{ at, label, fired, note }] } } */
    let alarmDoc = { version: 1, groups: {} };
    /** 已说"提醒我…"但还没给时间的话题（5 分钟内补一句时间就登记） */
    const pendingReminders = new Map();
    function loadAlarms() {
        try {
            if (existsSync(ALARM_FILE))
                alarmDoc = JSON.parse(readFileSync(ALARM_FILE, 'utf8'));
            if (alarmDoc === null || typeof alarmDoc !== 'object' || typeof alarmDoc.groups !== 'object')
                alarmDoc = { version: 1, groups: {} };
        }
        catch {
            alarmDoc = { version: 1, groups: {} };
        }
    }
    function saveAlarms() {
        try {
            mkdirSync(join(homedir(), '.dsh-qqbot'), { recursive: true });
            writeFileSync(ALARM_FILE, JSON.stringify(alarmDoc, null, 2), 'utf8');
        }
        catch (err) {
            logger?.debug?.(`im-qqbot: alarm save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    loadAlarms();
    /** 中文数字/阿拉伯数字 → 数字（用于"一点四十"这种时间表达） */
    function cnNumber(text) {
        if (/^\d+$/.test(text))
            return Number(text);
        const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        if (text === '十' || text === '十十')
            return 10;
        let total = 0;
        let current = 0;
        for (const ch of text) {
            if (ch === '十') {
                current = (current === 0 ? 1 : current) * 10;
                total += current;
                current = 0;
            }
            else if (digits[ch] !== undefined) {
                current = digits[ch];
            }
            else {
                return NaN;
            }
        }
        return total + current;
    }
    /** 是否在要求登记提醒（"提醒我取餐""叫我起床""别忘了拿"） */
    function hasReminderIntent(content) {
        if (typeof content !== 'string' || content.length === 0)
            return false;
        return /(提醒|叫我|喊我|叫醒|记得|别忘了|闹钟)/.test(content);
    }
    /** 时间点格式化成 HH:mm */
    function labelOf(at) {
        const d = new Date(at);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    /**
     * 从任意一句话里解析时间点。
     * 相对：5分钟后 / 二十分钟后 / 半小时后 / 1小时后
     * 绝对：7点 / 七点半 / 下午一点四十 / 13:40
     */
    function parseTime(content, now = Date.now()) {
        if (typeof content !== 'string' || content.length === 0)
            return undefined;
        const numPart = '([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})';
        // 半小时后 / 半个小时之后
        if (/半个?\s*小时\s*(?:后|之后|以后)/.test(content)) {
            const at = now + 30 * 60 * 1000;
            return { at, label: labelOf(at) };
        }
        // 相对：N 分钟/小时之后
        const rel = new RegExp(`${numPart}\\s*(分钟|分|个?小时|钟头)\\s*(?:后|之后|以后)`).exec(content);
        if (rel) {
            const value = cnNumber(rel[1]);
            const minutes = /小时|钟头/.test(rel[2]) ? value * 60 : value;
            if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60)
                return undefined;
            const at = now + minutes * 60 * 1000;
            return { at, label: labelOf(at) };
        }
        // 绝对时间
        const abs = new RegExp(`${numPart}\\s*[点:：时]\\s*(半|${numPart})?\\s*分?`).exec(content);
        if (abs) {
            let hour = cnNumber(abs[1]);
            const minuteText = abs[2];
            const minute = minuteText === '半' ? 30 : (minuteText ? cnNumber(minuteText) : 0);
            if (/(下午|晚上|傍晚|夜里)/.test(content) && hour >= 1 && hour < 12)
                hour += 12;
            else if (/中午/.test(content) && hour >= 1 && hour < 11)
                hour += 12;
            if (!Number.isInteger(hour) || hour < 0 || hour > 23)
                return undefined;
            if (!Number.isInteger(minute) || minute < 0 || minute > 59)
                return undefined;
            const at = new Date(now);
            at.setHours(hour, minute, 0, 0);
            if (at.getTime() <= now + 30 * 1000)
                at.setDate(at.getDate() + 1);
            return { at: at.getTime(), label: labelOf(at.getTime()) };
        }
        // "明早/早上" → 默认 7:30
        if (/(早上|早晨|明早|上午)/.test(content)) {
            const at = new Date(now);
            at.setHours(7, 30, 0, 0);
            if (at.getTime() <= now + 30 * 1000)
                at.setDate(at.getDate() + 1);
            return { at: at.getTime(), label: labelOf(at.getTime()) };
        }
        return undefined;
    }
    /**
     * 登记提醒。支持两种对话流程：
     *   1. 一条消息里同时有意图和时间（"七点半叫我起床"）→ 直接登记；
     *   2. 先说意图（"提醒我取餐"）→ 记住 pending；随后 5 分钟内的
     *      "五分钟后吧" / "七点吧" 补全时间 → 登记。
     */
    function requestWakeAlarm(gid, content) {
        if (!gid || cfg.alarm === false)
            return undefined;
        const now = Date.now();
        const time = parseTime(content, now);
        const pending = pendingReminders.get(gid);
        const pendingFresh = pending !== undefined && now - pending.at < 5 * 60 * 1000;
        if (pendingFresh && time !== undefined) {
            pendingReminders.delete(gid);
            return recordAlarm(gid, time, pending.content);
        }
        if (pendingFresh)
            return undefined;
        if (hasReminderIntent(content)) {
            if (time !== undefined)
                return recordAlarm(gid, time, content);
            pendingReminders.set(gid, { at: now, content: String(content).slice(0, 60) });
            return undefined;
        }
        return undefined;
    }
    /** 写入一条提醒（同一时间点去重） */
    function recordAlarm(gid, parsed, note) {
        const list = Array.isArray(alarmDoc.groups[gid]) ? alarmDoc.groups[gid] : [];
        alarmDoc.groups[gid] = list;
        if (list.some((a) => a && a.at === parsed.at && a.fired !== true))
            return parsed;
        list.push({ at: parsed.at, label: parsed.label, fired: false, note: String(note ?? '').slice(0, 80) });
        saveAlarms();
        logger?.info?.(`im-qqbot: reminder set for group ${gid} at ${parsed.label}`);
        return parsed;
    }
    /** 到点的起床提醒（不受夜间静默限制） */
    async function maybeAlarms(state, now) {
        if (cfg.alarm === false)
            return;
        const list = alarmDoc.groups[state.gid];
        if (!Array.isArray(list) || list.length === 0)
            return;
        let changed = false;
        for (const alarm of list) {
            if (!alarm || alarm.fired === true || typeof alarm.at !== 'number')
                continue;
            if (now < alarm.at)
                continue;
            // 错过太久（>2 小时）就不再补发
            if (now - alarm.at > 2 * 60 * 60 * 1000) {
                alarm.fired = true;
                changed = true;
                continue;
            }
            const sent = await promptGroup(state.gid, PROMPT_WAKE(alarm.label ?? '', alarm.note), 'wake');
            if (sent) {
                alarm.fired = true;
                changed = true;
                qqlog('alarm-fired', { gid: state.gid, at: alarm.at, label: alarm.label });
            }
        }
        // 顺手清理 7 天前的记录
        alarmDoc.groups[state.gid] = list.filter((a) => a && typeof a.at === 'number' && now - a.at < 7 * 24 * 60 * 60 * 1000);
        if (changed || alarmDoc.groups[state.gid].length !== list.length)
            saveAlarms();
    }
    function getState(gid) {
        let state = states.get(gid);
        if (state === undefined) {
            state = {
                gid,
                lastHumanAt: 0,
                lastBotAt: 0,
                lastBotMessage: '',
                lastBotKind: 'reply',
                botKindPending: null,
                recent: [],
                humanSinceBot: true,
                sulkArmed: false,
                ignoredStreak: 0,
                mutedUntil: 0,
                greetedDay: '',
                lastProactiveAt: 0,
                lastChimeAt: 0,
                proactiveDay: '',
                proactiveCount: 0,
                sulkTimes: [],
            };
            states.set(gid, state);
        }
        return state;
    }
    /** 记住一条群内人类消息；人被点名/邀请时清掉"被无视"和静默 */
    function noteHumanMessage(gid, opts = {}) {
        if (!gid)
            return;
        const state = getState(gid);
        state.lastHumanAt = Date.now();
        state.humanSinceBot = true;
        if (typeof opts.content === 'string' && opts.content.length > 0) {
            state.recent.push({ senderName: opts.senderName ?? '群友', content: opts.content.slice(0, 200) });
            if (state.recent.length > 8)
                state.recent.shift();
            // 同步给长期记忆与情绪状态（被夸会开心）；带上发送者 openid，人记忆才能跨群共享
            services.memory?.noteHuman?.(gid, { content: opts.content, senderName: opts.senderName, senderId: opts.senderId });
            services.persona?.noteHumanMessage?.(gid, { content: opts.content });
        }
        if (opts.addressed === true) {
            state.ignoredStreak = 0;
            state.mutedUntil = 0;
            state.sulkArmed = false;
        }
    }
    /** 记住机器人刚在群里发过一条消息（用于等待回应 / 生闷气判定） */
    function noteBotMessage(gid, text) {
        if (!gid)
            return;
        const state = getState(gid);
        state.lastBotAt = Date.now();
        state.lastBotMessage = String(text ?? '').slice(0, 300);
        state.lastBotKind = state.botKindPending ?? 'reply';
        state.botKindPending = null;
        state.recent.push({ senderName: '小小鱼', content: state.lastBotMessage });
        if (state.recent.length > 8)
            state.recent.shift();
        // 机器人自己的发言也进记忆滚动缓冲（方便压缩出"聊过什么"）
        services.memory?.noteBot?.(gid, state.lastBotMessage);
        state.humanSinceBot = false;
        state.sulkArmed = false;
    }
    /** 生成主动消息（给群会话注入系统触发的 user 消息） */
    async function promptGroup(gid, prompt, kind) {
        if (!manager || typeof manager.getOrCreate !== 'function')
            return false;
        const now = Date.now();
        const state = getState(gid);
        // 群会话正忙时跳过，避免打断
        const existing = manager.getSessionRecord?.('group', gid);
        if (existing && existing.agent && existing.agent.status !== 'idle')
            return false;
        // 每日主动发言上限
        const today = dayKey();
        if (state.proactiveDay !== today) {
            state.proactiveDay = today;
            state.proactiveCount = 0;
        }
        if (kind !== 'sulk' && kind !== 'wake' && state.proactiveCount >= dailyMax)
            return false;
        const cached = getCachedReplyIds('group', gid);
        const replyTarget = { scope: 'group', targetId: gid, msgId: cached[0]?.id };
        try {
            const record = await manager.getOrCreate('group', gid, cfg.senderId ?? 'dsh-proactive', replyTarget);
            if (record.agent?.status !== 'idle')
                return false;
            const message = createUserMessage({
                content: [{ type: 'text', text: prompt }],
                // 主动消息要写进会话日志，source 必须用 producer-owned kind。
                // 用 'plugin' 会被 session format v4 拒绝：
                // "format v4 message requires a producer-owned source kind"
                source: { kind: 'user' },
            });
            state.lastProactiveAt = now;
            if (kind === 'greet')
                state.greetedDay = today;
            if (kind === 'chime')
                state.lastChimeAt = now;
            if (kind === 'sulk')
                state.sulkTimes.push(now);
            if (kind !== 'sulk')
                state.proactiveCount += 1;
            state.botKindPending = kind;
            record.agent.followup(message);
            qqlog('proactive', { gid, kind });
            void record.agent.whenIdle?.().catch(() => { });
            logger?.info?.(`im-qqbot: proactive ${kind} → group ${gid}`);
            return true;
        }
        catch (err) {
            logger?.warn?.(`im-qqbot: proactive ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    /** 机器人这句话是不是在等回应（提问/邀请/撒娇/打招呼） */
    function looksLikeBid(state) {
        if (state.lastBotKind === 'greet' || state.lastBotKind === 'chime')
            return true;
        return BID_RE.test(state.lastBotMessage ?? '');
    }
    /**
     * 生闷气判定。
     *
     * 沉默不一定等于"被无视"：话题自然收尾、对方去忙、不想聊了都可能是沉默。
     * 这里按三道门槛判断：
     *   ① 机器人最后一句是收尾语（晚安/拜拜…）→ 不闷气；
     *   ② 机器人最后一句不是在求回应（普通陈述/回答）→ 沉默属自然结束，不闷气；
     *   ③ 小模型再判一次"自然结束 vs 被晾着"，判不准就不发（宁可不发，别乱发）。
     */
    async function maybeSulk(state, now) {
        if (cfg.sulk === false)
            return;
        if (state.lastBotAt === 0 || state.humanSinceBot || state.sulkArmed)
            return;
        if (now - state.lastBotAt < num(cfg.sulkAfterMs, 180000))
            return;
        if (now < state.mutedUntil)
            return;
        // 每小时生闷气次数上限（默认 1）
        const maxPerHour = Math.max(0, num(cfg.sulkMaxPerHour, 1));
        state.sulkTimes = state.sulkTimes.filter((t) => now - t < 60 * 60 * 1000);
        if (state.sulkTimes.length >= maxPerHour)
            return;
        // ① 收尾语 → 自然结束
        if (CLOSING_RE.test(state.lastBotMessage ?? '')) {
            state.sulkArmed = true;
            logger?.debug?.(`[engagement] no sulk: closing message (gid=${state.gid})`);
            return;
        }
        // ② 不是在求回应 → 沉默大概率是自然结束
        if (cfg.sulkOnlyOnBid !== false && !looksLikeBid(state)) {
            state.sulkArmed = true;
            logger?.debug?.(`[engagement] no sulk: not a bid (gid=${state.gid})`);
            return;
        }
        // ③ 小模型判断：自然结束 / 不想聊 / 判断失败 都不发闷气
        if (cfg.sulkJudge !== false) {
            const verdict = await judgeSilence(manager, config, logger, {
                peerId: state.gid,
                history: state.recent.slice(-6),
                lastBotMessage: state.lastBotMessage,
            });
            if (verdict === null || verdict.naturalEnd >= 0.5 || verdict.ignored < 0.5) {
                state.sulkArmed = true;
                logger?.debug?.(`[engagement] no sulk: judged natural end (gid=${state.gid}) ${verdict === null ? 'judge-unavailable' : JSON.stringify(verdict)}`);
                return;
            }
        }
        state.sulkArmed = true;
        state.ignoredStreak += 1;
        // 确认被晾着才掉心情（自然结束不扣）
        services.persona?.noteIgnored?.(state.gid);
        const sent = await promptGroup(state.gid, PROMPT_SULK, 'sulk');
        if (sent && state.ignoredStreak >= Math.max(1, num(cfg.muteAfterIgnored, 1))) {
            state.mutedUntil = now + Math.max(0, num(cfg.muteMs, 600000));
            logger?.info?.(`im-qqbot: group ${state.gid} muted ${Math.round(num(cfg.muteMs, 600000) / 1000)}s after being ignored`);
        }
    }
    /** 早上的主动问候（每群每天一次，7 点后按稳定哈希在几十秒~几分钟内错开） */
    async function maybeGreet(state, now) {
        if (cfg.morningGreet === false)
            return;
        // 刚启动的一段时间内不主动说话（避免重启后立刻插话）
        if (now - startedAt < num(cfg.startupGraceMs, 10 * 60 * 1000))
            return;
        // 群里刚有人说话就不打招呼：默认关闭（greetQuietMs = 0），
        // 7 点一到就发；想保留"先安静一会儿"可以把它设成正的毫秒数。
        const greetQuietMs = Math.max(0, num(cfg.greetQuietMs, 0));
        if (greetQuietMs > 0 && state.lastHumanAt > 0 && now - state.lastHumanAt < greetQuietMs)
            return;
        const from = Math.max(0, Math.min(23, num(cfg.morningFrom, 7)));
        const to = Math.max(0, Math.min(24, num(cfg.morningTo, 9)));
        const date = new Date(now);
        const hour = date.getHours();
        if (!(hour >= from && hour < to))
            return;
        const today = dayKey(date);
        if (state.greetedDay === today)
            return;
        if (now < state.mutedUntil)
            return;
        const minuteOfDay = hour * 60 + date.getMinutes();
        // 早安错开窗口：默认 30 分钟（不会拖到 8、9 点）
        const spreadMinutes = Math.max(1, Math.min((to - from) * 60, Math.round(num(cfg.morningSpreadMs, 30 * 60 * 1000) / 60000)));
        const spread = stableHash(state.gid) % spreadMinutes;
        if (minuteOfDay < from * 60 + spread)
            return;
        await promptGroup(state.gid, PROMPT_GREET(hour), 'greet');
    }
    /** 白天偶尔冒泡 */
    async function maybeChime(state, now) {
        if (cfg.randomChime === false)
            return;
        // 刚启动的一段时间内不冒泡
        if (now - startedAt < num(cfg.startupGraceMs, 10 * 60 * 1000))
            return;
        const interval = Math.max(10 * 60 * 1000, num(cfg.chimeIntervalMs, 3 * 60 * 60 * 1000));
        if (now - state.lastProactiveAt < interval)
            return;
        // 群里最近没人说话就不冒泡（默认 6 小时内有人说话才算活跃）
        if (now - state.lastHumanAt > num(cfg.chimeActivityMs, 6 * 60 * 60 * 1000))
            return;
        // 群里得安静一段时间再冒泡（默认 30 分钟没人说话）
        if (now - state.lastHumanAt < num(cfg.chimeQuietMs, 30 * 60 * 1000))
            return;
        // 机器人自己刚说过话也别马上又冒泡
        if (state.lastBotAt > 0 && now - state.lastBotAt < num(cfg.chimeBotQuietMs, 10 * 60 * 1000))
            return;
        if (now < state.mutedUntil)
            return;
        if (Math.random() >= Math.min(1, Math.max(0, num(cfg.chimeChance, 0.35))))
            return;
        await promptGroup(state.gid, PROMPT_CHIME, 'chime');
    }
    async function tick() {
        // 记忆整理巡检：和主动发言开关无关，始终跑
        try {
            await services.memory?.tick?.();
        }
        catch (err) {
            logger?.debug?.(`im-qqbot: memory tick error: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!enabled)
            return;
        // 定时任务（起床提醒）：即使这个群最近没人说话，也要把有提醒的群加载进状态表，
        // 否则重启后提醒永远不会触发。
        try {
            for (const gid of Object.keys(alarmDoc.groups ?? {})) {
                if (gid)
                    getState(gid);
            }
        }
        catch {
            // 忽略
        }
        const now = Date.now();
        const hour = new Date(now).getHours();
        const quiet = inQuietHours(hour, num(cfg.nightQuietFrom, 23), num(cfg.nightQuietTo, 7));
        for (const state of states.values()) {
            try {
                // 起床提醒优先（不受夜间静默限制）
                await maybeAlarms(state, now);
                if (!quiet)
                    await maybeSulk(state, now);
                if (quiet)
                    continue;
                await maybeGreet(state, now);
                await maybeChime(state, now);
            }
            catch (err) {
                logger?.debug?.(`im-qqbot: proactive tick error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    return {
        enabled,
        noteHumanMessage,
        noteBotMessage,
        getState,
        isMuted(gid) {
            return Date.now() < getState(gid).mutedUntil;
        },
        mutedUntil(gid) {
            return getState(gid).mutedUntil;
        },
        lastBotMessage(gid) {
            return getState(gid).lastBotMessage;
        },
        lastHumanAt(gid) {
            return getState(gid).lastHumanAt;
        },
        /** 被点名/被邀请时清状态 */
        noteAddressed(gid) {
            const state = getState(gid);
            state.ignoredStreak = 0;
            state.mutedUntil = 0;
        },
        /** 从一句话里识别"叫我起床"并登记提醒，返回 { at, label } 或 undefined */
        requestWakeAlarm(gid, content) {
            return requestWakeAlarm(gid, content);
        },
        start() {
            if (!enabled)
                return;
            ctx.effect(() => {
                const timer = setInterval(() => {
                    void tick();
                }, TICK_MS);
                return async () => {
                    clearInterval(timer);
                };
            }, 'im-qqbot.proactive');
            logger?.info?.('im-qqbot: proactive service started');
        },
    };
}
