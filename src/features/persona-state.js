/**
 * 作息与情绪状态
 *
 * 让机器人有"现在几点、今天心情怎么样"的连续状态，而不是每条消息都一个样：
 *   - 作息：awakeFromHour ~ sleepFromHour 之外算"困了"（默认 23:00-07:00），
 *     困的时候不主动找话、说话更短更迷糊（提示词层面）；
 *   - 情绪：被夸会开心、被冷落会低落，带衰减（默认 30 分钟），
 *     影响主动插话概率和当前语气。
 *
 * 状态以 prompt 片段注入（session-manager 的 system-prompt/assemble 钩子），
 * 并在 reply-policy 里作为回复概率的乘数。
 */
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
/** 被夸的简单启发式（用于涨心情） */
const PRAISE_RE = /(可爱|喜欢你|爱你|想你|真棒|好厉害|厉害|聪明|乖|好听话|好萌)/;
/**
 * 创建作息/情绪服务。
 * @param config - 插件配置（读取 config.persona）
 * @param logger - 插件 logger
 */
export function createPersonaState(config, logger) {
    const cfg = config.persona ?? {};
    const enabled = cfg.enabled !== false;
    const awakeFrom = num(cfg.awakeFromHour, 7);
    const sleepFrom = num(cfg.sleepFromHour, 23);
    const decayMs = Math.max(60 * 1000, num(cfg.moodDecayMs, 30 * 60 * 1000));
    const moods = new Map();
    /** 当前小时（含小数），用于作息判断 */
    function hourOf(now = Date.now()) {
        const date = new Date(now);
        return date.getHours() + date.getMinutes() / 60;
    }
    /** 是否处于"困了"的时段（支持跨零点） */
    function isSleepy(now = Date.now()) {
        if (!enabled)
            return false;
        const hour = hourOf(now);
        if (awakeFrom < sleepFrom)
            return hour < awakeFrom || hour >= sleepFrom;
        return hour < awakeFrom && hour >= sleepFrom;
    }
    function getMood(gid) {
        let mood = moods.get(gid);
        if (mood === undefined) {
            mood = { value: 0, until: 0 };
            moods.set(gid, mood);
        }
        if (mood.until > 0 && Date.now() > mood.until) {
            mood.value = 0;
            mood.until = 0;
        }
        return mood;
    }
    /** 被夸/聊得开心：涨心情 */
    function notePraise(gid) {
        if (!enabled)
            return;
        const mood = getMood(gid);
        mood.value = Math.min(1, mood.value + 0.6);
        mood.until = Date.now() + decayMs;
    }
    /** 被冷落/被无视：掉心情 */
    function noteIgnored(gid) {
        if (!enabled)
            return;
        const mood = getMood(gid);
        mood.value = Math.max(-1, mood.value - 0.6);
        mood.until = Date.now() + decayMs;
    }
    /** 一条人类消息：顺手判断是不是在夸它 */
    function noteHumanMessage(gid, opts = {}) {
        if (!enabled)
            return;
        if (typeof opts.content === 'string' && PRAISE_RE.test(opts.content))
            notePraise(gid);
    }
    /** 主动回复概率的乘数：困了 ×0.2，开心 ×1.3，低落 ×0.5 */
    function replyChanceMultiplier(gid) {
        if (!enabled)
            return 1;
        let multiplier = 1;
        if (isSleepy())
            multiplier *= Math.max(0, Math.min(1, num(cfg.sleepyMultiplier, 0.2)));
        const mood = getMood(gid);
        if (mood.value >= 0.4) {
            multiplier *= Math.max(1, num(cfg.happyMultiplier, 1.3));
        }
        else if (mood.value <= -0.4) {
            multiplier *= Math.max(0, Math.min(1, num(cfg.lowMultiplier, 0.5)));
        }
        return Math.max(0, Math.min(2, multiplier));
    }
    /** 注入给模型的"当前状态"片段；空字符串表示不注入 */
    function statusText(gid, now = Date.now()) {
        if (!enabled)
            return '';
        const date = new Date(now);
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const lines = [];
        if (isSleepy(now)) {
            lines.push(`现在是 ${hh}:${mm}，你已经很困、快睡着了。说话要短、有点迷糊，可以打哈欠（"呜…好困"），不要长篇大论。`);
        }
        else {
            lines.push(`现在是 ${hh}:${mm}。`);
        }
        const mood = getMood(gid);
        if (mood.value >= 0.4)
            lines.push('你心情不错（刚被夸/聊得开心），说话带点小得意、更活泼。');
        else if (mood.value <= -0.4)
            lines.push('你刚被冷落了一会儿，有点小情绪，不太想主动找话。');
        return `【当前状态】${lines.join('')}`;
    }
    return {
        enabled,
        isSleepy,
        replyChanceMultiplier,
        statusText,
        notePraise,
        noteIgnored,
        noteHumanMessage,
    };
}
