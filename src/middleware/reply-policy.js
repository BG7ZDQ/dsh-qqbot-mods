/**
 * 群聊触发策略中间件
 *
 * 目标：机器人在群里"旁观"，只在合适的时候发言：
 *   1. 被 @（GROUP_AT_MESSAGE_CREATE / mentions.is_you）
 *   2. 文本里叫到它的名字（nameKeywords）
 *   3. 命中兴趣词（topicKeywords）
 *   4. 对话延续：机器人刚在这个群说过话，同一人的追问（followUpWindowMs 内）
 *   5. 兴趣判断：小模型判断这条消息"想不想接 / 是不是在邀请它"（interest.enabled）
 *   6. 其余消息按 randomChance 随机插话
 *   7. 明确 @ 了别人的消息不插话
 *   8. 被无视到静默期（engagement.mutedUntil）只响应点名/邀请
 *
 * 未命中的消息不回复，但仍由 historyBuffer 记录，之后被触发时模型能带上群聊上下文。
 * c2c（私聊）不走这个策略，始终回复。
 */
import { judgeInterest } from './interest-judge.js';
import { qqlog } from '../shared/qqlog.js';
/** 每个群最近一次发言时间（冷却 + 对话窗口） */
const lastReplyAt = new Map();
/** 每个群最近一次发言对应的触发者，用于"对话延续"只认同一个人 */
const lastReplySender = new Map();
/** 兴趣判断的调用时间戳，用于每分钟限流 */
const judgeCalls = [];
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
function judgeBudgetLeft(cfg) {
    const max = Math.max(1, num(cfg.maxPerMinute, 20));
    const now = Date.now();
    while (judgeCalls.length > 0 && now - judgeCalls[0] > 60 * 1000)
        judgeCalls.shift();
    return judgeCalls.length < max;
}
/**
 * @param config - 插件配置（读取 config.trigger）
 * @param logger - 插件 logger
 * @param manager - SessionManager（判断器需要 llm 服务与模型路由）
 * @param services - { engagement, persona }（可为空对象）
 */
export function replyPolicyGate(config, logger, manager, services = {}) {
    const engagement = services.engagement;
    const persona = services.persona;
    const trigger = config.trigger ?? {};
    const interest = trigger.interest ?? {};
    const mentionAlways = trigger.mentionAlways !== false;
    const names = (trigger.nameKeywords ?? []).filter((k) => typeof k === 'string' && k.length > 0);
    const topics = (trigger.topicKeywords ?? []).filter((k) => typeof k === 'string' && k.length > 0);
    const randomChance = Math.min(1, Math.max(0, num(trigger.randomChance, 0)));
    const topicChance = Math.min(1, Math.max(0, num(trigger.topicChance, 1)));
    const cooldownMs = Math.max(0, num(trigger.cooldownMs, 0));
    const followUpWindowMs = Math.max(0, num(trigger.followUpWindowMs, 0));
    const followUpChance = Math.min(1, Math.max(0, num(trigger.followUpChance, 1)));
    const followUpSameSenderOnly = trigger.followUpSameSenderOnly !== false;
    const interestEnabled = interest.enabled !== false && manager !== undefined;
    const interestMin = Math.min(1, Math.max(0, num(interest.minScore, 0.5)));
    const invitedMin = Math.min(1, Math.max(0, num(interest.invitedScore, 0.6)));
    return async (ctx, next) => {
        const msg = ctx.message;
        // 私聊/频道：始终回复
        if (msg.kind !== 'group') {
            await next();
            return;
        }
        const content = (msg.content ?? '').trim();
        const gid = msg.groupOpenid ?? '';
        const senderId = msg.senderId ?? '';
        const now = Date.now();
        const last = lastReplyAt.get(gid) ?? 0;
        const mention = ctx.state.mention;
        const mentioned = mention?.wasMentioned === true || mention?.implicit === true;
        const named = names.some((k) => content.includes(k));
        const addressed = mentioned || named;
        const topicHit = topics.some((k) => content.includes(k));
        const mentionsOthers = Array.isArray(msg.mentions) && msg.mentions.some((m) => !m?.is_you);
        // 记录人类消息（含未被回复的），驱动"被无视/主动发言"状态；
        // 带上 senderId（member_openid），人记忆才能按人跨群共享。
        engagement?.noteHumanMessage(gid, { addressed, content, senderName: msg.senderName, senderId });
        if (addressed)
            engagement?.noteAddressed(gid);
        // 提醒（起床/取餐等）只在"点名/叫名字"的消息里识别：正常聊天不会无故这么说。
        const wakeAlarm = addressed ? engagement?.requestWakeAlarm?.(gid, content) : undefined;
        if (wakeAlarm) {
            ctx.message.content = `${content}\n[系统提示：已登记 ${wakeAlarm.label} 的提醒，到点系统会自己提醒；回复里自然确认一下即可，不要提"系统""闹钟"]`;
            qqlog('alarm-set', { gid, label: wakeAlarm.label, at: wakeAlarm.at });
        }
        const muted = engagement?.isMuted(gid) === true;
        // 作息/情绪：困了×0.2、开心×1.3、低落×0.5
        const moodMult = persona?.replyChanceMultiplier?.(gid) ?? 1;
        const sleepy = persona?.isSleepy?.() === true;
        // 对话延续：机器人刚在这个群说过话，同一个人的追问视为继续聊
        const inFollowUpWindow = followUpWindowMs > 0
            && now - last < followUpWindowMs
            && (!followUpSameSenderOnly || lastReplySender.get(gid) === senderId);
        let reason;
        if (wakeAlarm) {
            // 明确是在要求它定提醒 → 必须回应
            reason = 'alarm';
        }
        else if (mentionAlways && addressed) {
            reason = named && !mentioned ? 'name' : 'mention';
        }
        else if (mentionsOthers) {
            // 消息明确 @ 了别人且没点名机器人：不插话，避免抢话
            reason = 'skip';
        }
        else if (muted) {
            // 被无视后的静默期：只响应点名/邀请，不再主动找话
            reason = 'muted';
        }
        else if (sleepy) {
            // 困了：非点名消息一律不理（它睡着了）
            reason = 'sleepy';
        }
        else if (topicHit && Math.random() < topicChance * moodMult) {
            reason = 'topic';
        }
        else if (inFollowUpWindow) {
            // 对话延续：先让判断器确认"这条还是在跟它聊"，避免把无关话题硬接过来。
            // 判断不可用（超时/失败）时退回概率 followUpChance。
            let ok;
            if (interestEnabled && judgeBudgetLeft(interest)) {
                judgeCalls.push(Date.now());
                const verdict = await judgeInterest(manager, config, logger, {
                    scope: 'group',
                    peerId: gid,
                    history: Array.isArray(ctx.state.history) ? ctx.state.history.map((h) => ({
                        senderName: h.senderName,
                        content: h.content,
                    })) : [],
                    content,
                    senderName: msg.senderName,
                    lastBotMessage: engagement?.lastBotMessage(gid) ?? '',
                });
                if (verdict === null) {
                    ok = Math.random() < followUpChance * moodMult;
                }
                else {
                    const followUpInvited = Math.min(1, Math.max(0, num(interest.followUpInvitedScore, 0.35)));
                    const followUpBias = Math.max(0, num(interest.followUpBias, 0.2));
                    ok = verdict.invited >= followUpInvited
                        || verdict.interest * moodMult + followUpBias >= interestMin;
                }
            }
            else {
                ok = Math.random() < followUpChance * moodMult;
            }
            reason = ok ? 'followup' : 'skip';
        }
        else if (interestEnabled && judgeBudgetLeft(interest)) {
            judgeCalls.push(Date.now());
            const verdict = await judgeInterest(manager, config, logger, {
                scope: 'group',
                peerId: gid,
                history: Array.isArray(ctx.state.history) ? ctx.state.history.map((h) => ({
                    senderName: h.senderName,
                    content: h.content,
                })) : [],
                content,
                senderName: msg.senderName,
                lastBotMessage: engagement?.lastBotMessage(gid) ?? '',
            });
            if (verdict !== null && verdict.invited >= invitedMin) {
                reason = 'invited';
                engagement?.noteAddressed(gid);
            }
            else if (verdict !== null && verdict.interest * moodMult >= interestMin) {
                reason = 'interest';
            }
            else {
                reason = randomChance > 0 && Math.random() < randomChance * moodMult ? 'random' : 'skip';
            }
        }
        else if (randomChance > 0 && Math.random() < randomChance * moodMult) {
            reason = 'random';
        }
        else {
            reason = 'skip';
        }
        // 冷却只约束"主动插话"（topic/random）；点名、对话延续、邀请、兴趣回复不受限
        if ((reason === 'topic' || reason === 'random') && cooldownMs > 0 && now - last < cooldownMs) {
            reason = 'cooldown';
        }
        if (reason === 'skip' || reason === 'cooldown' || reason === 'muted' || reason === 'sleepy') {
            qqlog('policy', { gid, senderId, decision: 'skip', reason, content: content.slice(0, 80) });
            logger?.debug?.(`[reply-policy] skip (${reason}) gid=${gid} content="${content.slice(0, 40)}"`);
            ctx.stop(`reply-policy:${reason}`);
            return;
        }
        lastReplyAt.set(gid, now);
        lastReplySender.set(gid, senderId);
        qqlog('policy', { gid, senderId, decision: 'reply', reason, content: content.slice(0, 80) });
        logger?.debug?.(`[reply-policy] reply (${reason}) gid=${gid} content="${content.slice(0, 40)}"`);
        await next();
    };
}
