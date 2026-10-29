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

## 定时提醒（起床 / 取餐 / 任意提醒）

统一由插件内的提醒系统处理，**不依赖模型自己建定时任务**（DSH 侧会在 prompt 里明确禁止，
否则模型会自建"自动化任务"导致重复提醒——实际发生过）。

- 触发：**点名/叫名字**的消息里出现「提醒我 / 叫我 / 别忘了 / 记得 / 闹钟」等意图；
- 支持绝对时间：「七点半」「下午一点四十」「明早」（默认 7:30）；
- 支持相对时间：「五分钟后」「二十分钟后」「半小时后」「一小时后」；
- 支持两段式对话：
  1. 「提醒我取餐」（没给时间）→ 记住话题，模型自然问/确认；
  2. 5 分钟内补一句「五分钟后吧」「七点吧」→ 自动登记；
- 提醒持久化到 `~/.dsh-qqbot/alarms.json`（含原话 `note`），重启不丢；
- 到点由巡检触发，主动发消息；即使群里最近没人说话也会加载并触发；
- 错过超过 2 小时的提醒不补发；记录保留 7 天。

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
