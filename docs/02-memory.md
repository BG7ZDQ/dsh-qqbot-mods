# 02 · 记忆系统

实现：`src/features/memory.js`（新增文件）。

## 存储结构

```
~/.dsh-qqbot/memory/
  <群openid>.json           群记忆
  users/<member_openid>.json 人记忆（跨群共享）
```

每份记忆分两层：

| 层 | 内容 | 生命周期 |
|---|---|---|
| `longTerm` | 稳定事实：称呼、喜好、生日、习惯、群体关系、常聊话题 | 不过期，有上限（群 12 条 / 人 6 条） |
| `shortTerm` | 最近发生的事：今天吃了什么、今天干了什么 | 默认 24 小时后过期，可配置 |

文件格式（version 2）：

```json
{
  "version": 2,
  "longTerm": ["喜欢卫星，梦想造一颗属于自己的卫星"],
  "shortTerm": [{ "text": "午饭吃了酸菜五花肉", "at": 1790000000000 }],
  "pending": ["昵称(openid): 原始消息"],
  "lastDistillAt": 1790000000000,
  "lastHumanAt": 1790000000000,
  "lastSpeakerId": "openid",
  "lastSpeakerName": "昵称"
}
```

人记忆（`users/<openid>.json`）：

```json
{ "version": 2, "name": "昵称", "longTerm": [], "shortTerm": [], "lastSeen": 1790000000000 }
```

旧格式（只有 `facts`）会作为群长期记忆兼容读取。

## 触发时机（不按消息条数）

- 聊天安静 `distillIdleMs`（默认 2 分钟）后整理一次；
- 聊天一直不停时，距上次整理超过 `distillMaxIntervalMs`（默认 10 分钟）强制整理；
- 一次只跑一个群的整理（避免并发拖慢/超时）；
- 重启后会把磁盘上的群记忆全部加载（否则群里没人说话时永远不会触发）。

## 整理过程

一次小模型调用，输入「已有群/人记忆 + 最近 30 条聊天」，输出：

```json
{
  "groupFacts": ["群梗：小小鱼不是鱼"],
  "groupRecent": ["某群友午饭吃了酸菜五花肉"],
  "people": [
    { "openid": "...", "name": "...", "facts": ["喜欢卫星"], "recent": ["今天不想上课"] }
  ]
}
```

- 群结果写群文件，人结果按 `openid` 写人文件（跨群共享）；
- `mirrorPersonFacts: false` 可关闭人记忆写入；
- 模型可以输出空数组表示"没有值得记的"。

## 注入

每轮对话组装 system prompt 时注入两个 section：

- 【你记得的事（长期记忆）】：**当前发言人**的人长期记忆 + 本群长期记忆；
- 【最近的事（短期记忆，会过期）】：当前发言人的短期人记忆 + 本群短期记忆。

只注入当前发言人的记忆，不注入其他人的，避免隐私串群。

## 容量控制

- `maxFacts`：每群长期事实（默认 12）
- `maxPersonFacts`：每人长期事实（默认 6）
- `maxShortTerm`：短期记忆条数（默认 6）
- `maxUsers`：最多保留多少人记忆（默认 500，超出按最久未见淘汰）
- `maxPending`：压缩前滚动缓冲条数（默认 80）

## 配置

```yaml
memory:
  enabled: true
  maxFacts: 12
  maxPersonFacts: 6
  maxShortTerm: 6
  shortTermTtlMs: 86400000     # 24h
  mirrorPersonFacts: true
  maxUsers: 500
  distillEvery: 0              # 0=不按条数触发
  distillIdleMs: 120000
  distillMaxIntervalMs: 600000
  maxPending: 80
  provider: ''                 # 空=跟随群会话模型
  model: ''
  maxTokens: 20000             # 推理模型要留足
  timeoutMs: 60000
```

## 踩坑记录

1. `reasoningEffort` 不设 `low` 时，推理会吃光输出预算，返回空正文；
2. 输出上限太小会截断 JSON（`finish: max-tokens`）→ 默认 20000 足够；
3. 重启后没有消息时，内存里没有群列表 → 定时器空跑，永远不会整理（已通过启动时扫描磁盘修复）。
