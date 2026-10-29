/**
 * 兴趣判断器 — 用一次轻量 LLM 调用判断一条群消息值不值得插话。
 *
 * 输入：人设要点 + 最近群聊 + 机器人上一条发言 + 当前消息
 * 输出：{ interest: 0~1, invited: 0~1 }；解析失败/超时返回 null（由调用方回退到启发式）。
 *
 * 复用 dsh 的 llm 服务（manager.ctx.get('llm')），默认跟随当前群会话的模型，
 * 也可在 config.trigger.interest.provider/model 指定更便宜的判断模型。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { qqlog } from '../shared/qqlog.js';
/** 默认判断超时：超时直接放弃，不阻塞消息处理 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 默认单次判断输出上限，只要一行 JSON */
const DEFAULT_MAX_TOKENS = 800;
function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
/** 从模型输出里抠出第一个 JSON 对象并校验字段 */
function parseVerdict(text) {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match)
        return null;
    try {
        const raw = JSON.parse(match[0]);
        const interest = num(raw.interest, NaN);
        const invited = num(raw.invited, NaN);
        if (!Number.isFinite(interest) || !Number.isFinite(invited))
            return null;
        return {
            interest: Math.min(1, Math.max(0, interest)),
            invited: Math.min(1, Math.max(0, invited)),
            why: typeof raw.why === 'string' ? raw.why.slice(0, 120) : undefined,
        };
    }
    catch {
        return null;
    }
}
/** 组装判断用的单条 prompt */
function buildPrompt(cfg, input) {
    const history = (input.history ?? [])
        .slice(-Math.max(1, num(cfg.maxHistory, 8)))
        .map((h, i) => `${i + 1}. ${h.senderName ?? '群友'}: ${String(h.content ?? '').slice(0, 160)}`)
        .join('\n');
    const persona = cfg.persona || '12岁活泼少女，喜欢聊天、可爱的东西、游戏和科技小玩意；讨厌被当办公助手使唤。';
    const lastBot = input.lastBotMessage ? String(input.lastBotMessage).slice(0, 160) : '无';
    return `你是群聊机器人"小小鱼"的"要不要插话"判断器。你只输出一行 JSON，不解释。

【小小鱼的人设与兴趣】
${persona}

【最近的群聊】（按时间顺序）
${history || '（无）'}

【小小鱼上一条发言】
${lastBot}

【当前这条消息】
${input.senderName ?? '群友'}: ${String(input.content ?? '').slice(0, 300)}

判断两件事（都是 0~1）：
- interest：小小鱼对当前这条消息"想不想接话"的程度（无聊的指令、纯表情、跟它无关的私事 → 低）；
- invited：说话的人或在场的人是否在邀请小小鱼参与（点名、问"你们/你觉得"、接它的话、明显在跟它聊天 → 高）。

注意：
- 如果当前这条明显是在回应另一个人、或者在聊与小小鱼无关的话题，即使紧跟在它发言之后，两个分数也要给低；
- 如果是在继续跟小小鱼对话（回应它、追问、接它的梗），invited 给高；
- 如果对方在表达情绪、撒娇、无聊求陪、求安慰（"好无聊""难受""陪我""你怎么不理我"之类），
  或者用第二人称"你"在跟它说话，即使没点名，invited 和 interest 也要给高（它应该主动接话）。

只输出：{"interest":0.0,"invited":0.0}`;
}
/** 解析判断用的模型路由：显式配置 > 群会话当前模型 */
function resolveRoute(manager, scope, peerId, cfg) {
    if (cfg.provider && cfg.model)
        return { provider: cfg.provider, model: cfg.model };
    try {
        const route = manager.getEffectiveModel?.(scope, peerId);
        if (route?.provider && route?.model)
            return { provider: route.provider, model: route.model };
    }
    catch {
        // 忽略：回退到 host 默认（由 llm.stream 决定）
    }
    return undefined;
}
/**
 * 判断一条群消息。
 * @returns 判断结果；服务不可用、超时、解析失败均返回 null。
 */
export async function judgeInterest(manager, config, logger, input) {
    const cfg = config?.trigger?.interest ?? {};
    if (cfg.enabled === false)
        return null;
    let llm;
    try {
        llm = manager.ctx?.get?.('llm');
    }
    catch {
        llm = undefined;
    }
    if (typeof llm?.stream !== 'function') {
        logger?.debug?.('[interest-judge] llm service unavailable');
        return null;
    }
    const route = resolveRoute(manager, input.scope, input.peerId, cfg);
    if (route === undefined) {
        logger?.debug?.('[interest-judge] no model route');
        return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, num(cfg.timeoutMs, DEFAULT_TIMEOUT_MS)));
    const started = Date.now();
    try {
        const message = createUserMessage({
            content: [{ type: 'text', text: buildPrompt(cfg, input) }],
            source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
        });
        const assembler = new BlockAssembler();
        for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [message],
            maxTokens: Math.max(300, num(cfg.maxTokens, 800)),
            // 结构化判断任务：低推理，避免把输出预算烧在 reasoning 上
            reasoningEffort: 'low',
            signal: controller.signal,
        })) {
            assembler.push(chunk);
        }
        const text = assembler
            .blocks()
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ');
        const verdict = parseVerdict(text);
        qqlog('interest-judge', {
            chars: text.length,
            finish: assembler.finish?.kind,
            verdict,
            ms: Date.now() - started,
            content: String(input.content ?? '').slice(0, 60),
        });
        logger?.debug?.(`[interest-judge] ${Date.now() - started}ms interest=${verdict?.interest ?? '?'} invited=${verdict?.invited ?? '?'} ${verdict?.why ?? ''}`);
        return verdict;
    }
    catch (err) {
        qqlog('interest-judge', { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started });
        logger?.debug?.(`[interest-judge] failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 沉默性质判断：这段沉默是"话题自然结束/不想聊"还是"机器人在等回应被晾着"。
 *
 * 只在"机器人发言后一段时间没人接话"时调用一次；判断失败返回 null，
 * 调用方按"不发闷气"处理（宁可不发，也别在别人只是不想聊的时候硬凑）。
 */
export async function judgeSilence(manager, config, logger, input) {
    const cfg = config?.proactive ?? {};
    if (cfg.sulkJudge === false)
        return null;
    let llm;
    try {
        llm = manager.ctx?.get?.('llm');
    }
    catch {
        llm = undefined;
    }
    if (typeof llm?.stream !== 'function')
        return null;
    const route = resolveRoute(manager, 'group', input.peerId, { provider: '', model: '' });
    if (route === undefined)
        return null;
    const history = (input.history ?? [])
        .slice(-6)
        .map((h) => `${h.senderName ?? '群友'}: ${String(h.content ?? '').slice(0, 120)}`)
        .join('\n');
    const prompt = `你是群聊机器人"小小鱼"的"沉默判断器"。只输出一行 JSON，不解释。

【最近群聊】
${history || '（无）'}

【小小鱼最后一句】
${String(input.lastBotMessage ?? '').slice(0, 200)}

请判断这段沉默属于哪种（0~1）：
- natural_end：话题已经自然聊完、对方去忙/去睡/不想继续，小小鱼那句只是陈述或收尾，再追一句会显得打扰；
- ignored：小小鱼那句是在等回应（提问、邀请、撒娇、打招呼），但确实没人接。

只输出：{"natural_end":0.0,"ignored":0.0}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, num(cfg.sulkJudgeTimeoutMs, 6000)));
    try {
        const message = createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
        });
        const assembler = new BlockAssembler();
        for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [message],
            maxTokens: 600,
            reasoningEffort: 'low',
            signal: controller.signal,
        })) {
            assembler.push(chunk);
        }
        const text = assembler
            .blocks()
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ');
        const match = /\{[\s\S]*\}/.exec(text);
        if (!match) {
            qqlog('silence-judge', { ok: false, stage: 'no-json', chars: text.length, finish: assembler.finish?.kind });
            return null;
        }
        const raw = JSON.parse(match[0]);
        const naturalEnd = num(raw.natural_end, NaN);
        const ignored = num(raw.ignored, NaN);
        if (!Number.isFinite(naturalEnd) || !Number.isFinite(ignored)) {
            qqlog('silence-judge', { ok: false, stage: 'bad-fields', chars: text.length });
            return null;
        }
        qqlog('silence-judge', { naturalEnd, ignored, chars: text.length });
        return {
            naturalEnd: Math.min(1, Math.max(0, naturalEnd)),
            ignored: Math.min(1, Math.max(0, ignored)),
        };
    }
    catch (err) {
        logger?.debug?.(`[silence-judge] failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
