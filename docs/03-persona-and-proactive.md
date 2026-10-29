# 03 · 作息情绪 / 主动发言 / 叫我起床

实现：`src/features/persona-state.js`（作息情绪）、`src/features/engagement.js`（参与度与主动发言）。

## 作息与情绪

- 作息：`awakeFromHour`（默认 7）~ `sleepFromHour`（默认 23）之外算"困了"；
  困倦时非点名消息一律不理，`sleepyMultiplier`（默认 0.2）还会降低主动插话概率；
- 情绪：被夸（正则启发式）心情 +，确认被冷落心情 −，`moodDecayMs`（默认 30 分钟）衰减；
  开心 ×1.3、低落 ×0.5 影响插话概率；
- 当前状态以 prompt 片段注入：「现在是 23:10，你已经很困…」「你刚被冷落了一会儿…」。

```yaml
persona:
  enabled: true
  awakeFromHour: 7
  sleepFromHour: 23
  moodDecayMs: 1800000
  sleepyMultiplier: 0.2
  happyMultiplier: 1.3
  lowMultiplier: 0.5
```

## 主动发言

| 行为 | 规则 |
|---|---|
| 早安 | 每天 7:00–7:30 内按群哈希错开（`morningSpreadMs`），不要求群里先安静 |
| 冒泡 | 每 `chimeIntervalMs`（默认 3h）一次机会，`chimeChance` 概率；要求群里安静 `chimeQuietMs`（默认 30min）、且机器人自己 `chimeBotQuietMs`（默认 10min）内没发言 |
| 夜间静默 | `nightQuietFrom`~`nightQuietTo`（默认 23–7）不主动发言 |
| 启动保护 | 插件启动后 `startupGraceMs`（默认 10min）内不主动发言，避免重启后立刻插话 |
| 每日上限 | 每群每天 `dailyMax`（默认 12）条主动消息（生闷气、起床提醒不计） |

## 生闷气（被无视后）

1. 机器人发言后 `sulkAfterMs`（默认 3min）没人接；
2. 且它最后一句是"在等回应"的（提问/邀请/撒娇/打招呼；`sulkOnlyOnBid`）；
3. 且小模型判定为"确实被晾着"（`sulkJudge`，自然结束/不想聊则不抱怨）；
4. 才发一句闷气话；之后安静 `muteMs`（默认 5min），每小时最多 `sulkMaxPerHour`（默认 3）次。

判断失败或判不准 → 不抱怨（宁可不发，也别在别人只是不想聊时硬凑）。

## 叫我起床

- 触发：**点名/叫名字**的消息里出现「X点叫我起床 / 提醒我」这类说法
  （正常聊天不会无故这么说，所以不做全局扫描）；
- 支持中文数字与时段：「七点半」「一点四十」「下午一点四十」「明早」；
- 提醒持久化到 `~/.dsh-qqbot/alarms.json`，重启不丢；
- 到点由巡检触发，主动发一条叫起床的消息；即使群里最近没人说话也会加载并触发；
- 过期超过 2 小时的提醒不补发。

```yaml
proactive:
  enabled: true
  morningGreet: true
  morningFrom: 7
  morningTo: 9
  morningSpreadMs: 1800000
  greetQuietMs: 0
  nightQuietFrom: 23
  nightQuietTo: 7
  randomChime: true
  chimeIntervalMs: 10800000
  chimeChance: 0.35
  chimeActivityMs: 21600000
  chimeQuietMs: 1800000
  chimeBotQuietMs: 600000
  startupGraceMs: 600000
  alarm: true
  sulk: true
  sulkAfterMs: 180000
  sulkMaxPerHour: 3
  sulkOnlyOnBid: true
  sulkJudge: true
  sulkJudgeTimeoutMs: 6000
  muteAfterIgnored: 1
  muteMs: 300000
  dailyMax: 12
```
