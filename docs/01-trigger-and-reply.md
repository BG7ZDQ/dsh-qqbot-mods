# 01 · 触发策略 / 兴趣判断 / 对话延续

核心目标：让机器人像群友一样"旁观"，而不是每条消息都回。

## 消息进入后的判定顺序

```
被 @ / 叫名字 / 命中情绪词     → 直接回（不调模型）
消息明确 @ 了别人              → 不回（避免抢话）
静默期（被无视后）             → 不回
困倦时段（23:00-07:00）        → 非点名消息不回
对话延续（2 分钟内同一人）      → 调判断器确认"还在跟它聊"再回
其余消息                       → 调兴趣判断器打分
判断器没给高分                 → 15% 随机
否则                           → 不回
```

实现：`src/middleware/reply-policy.js`，作为 QQ SDK 中间件插在「斜杠命令 / 待答问题」之后、
并发守卫之前（显式交互不会被随机策略吞掉）。

## 配置（`im-qqbot.trigger`）

```yaml
trigger:
  mentionAlways: true
  nameKeywords: [小小鱼, 小鱼鱼, 小鱼]      # 名字/昵称，命中视为点名
  topicKeywords: [无聊, 安慰, 陪我, 理理我] # 情绪/求陪类关键词，命中直接回
  topicChance: 1
  randomChance: 0.15
  cooldownMs: 120000
  followUpWindowMs: 120000
  followUpChance: 0.9
  followUpSameSenderOnly: true
  interest:
    enabled: true
    provider: ''            # 空=跟随群会话模型
    model: ''
    minScore: 0.5           # interest 达到多少就插话
    invitedScore: 0.6       # invited 达到多少就当被邀请
    followUpInvitedScore: 0.35
    followUpBias: 0.2
    maxPerMinute: 20
    timeoutMs: 8000
    maxHistory: 8
    maxTokens: 800          # 推理模型要留足输出预算
    persona: 12岁活泼少女，喜欢聊天、游戏、科技小玩意；讨厌被当办公助手使唤。
```

## 兴趣判断器（`src/middleware/interest-judge.js`）

一次小模型调用，输入「人设要点 + 最近群聊 + 机器人上一条发言 + 当前消息」，输出：

```json
{"interest": 0.0, "invited": 0.0}
```

- `invited ≥ invitedScore` → 回（有人在拉它参与）
- `interest ≥ minScore` → 回（它自己感兴趣）
- 否则不回；调用失败/超时返回 `null`，调用方回退到概率

关键实现细节（踩过的坑）：

- 必须传 `reasoningEffort: 'low'`，否则推理会吃光输出 token、正文为空；
- 输出上限给足（默认 800），并在解析失败时记录原始文本；
- 每分钟限流（`maxPerMinute`），失败不影响消息处理。

## 对话延续

机器人发言后 `followUpWindowMs` 内、**同一发送者**的追问，会先交给判断器：

- `invited ≥ followUpInvitedScore` 或 `interest + followUpBias ≥ minScore` → 回；
- 判断为"在跟别人说/无关话题" → 不回；
- 判断器不可用 → 退回 `followUpChance` 概率。

这样既不会把正常聊天打断，也不会把无关话题硬接过来。
