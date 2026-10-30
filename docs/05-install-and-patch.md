# 05 · 安装与原文件修改清单

## 前提

- `@tencent-connect/dsh-qqbot@0.5.2`（本仓库按此版本验证，其他版本行号/结构可能不同）
- 插件安装位置：
  - 全局：`~/.dsh/profiles/desktop/node_modules/@tencent-connect/dsh-qqbot/dist/`
  - 或 DSH 应用内置副本（若存在）
- 修改后需要**重启 DSH 桌面端**才生效（`dist/` 是 ESM，进程内不热更新）。
- 想让 QQ 会话的上下文压缩更早触发（强烈建议）：装完本页后按
  [`06-context-management.md`](06-context-management.md) 配一个 QQ 专用 agent preset。

## 步骤 1：复制新增模块

把 `src/` 下文件复制到插件 `dist/` 的对应位置：

```
src/features/memory.js        → dist/features/memory.js
src/features/persona-state.js → dist/features/persona-state.js
src/features/engagement.js    → dist/features/engagement.js
src/middleware/interest-judge.js → dist/middleware/interest-judge.js
src/middleware/reply-policy.js   → dist/middleware/reply-policy.js
src/shared/qqlog.js           → dist/shared/qqlog.js
```

这些是新文件（`shared/` 目录可能需要新建），不会覆盖原有逻辑。

## 步骤 2：对原 package 的定点修改

> 以下修改涉及第三方包代码（MIT）。请按需手动应用；升级插件后需要重新核对。

### 2.1 `dist/config.js`

- 在 `trigger` schema 里加入 `interest` 子对象（见 `config/cordis.patch.example.yml`），
  字段：`enabled/provider/model/minScore/invitedScore/followUpInvitedScore/followUpBias/
  maxPerMinute/timeoutMs/maxHistory/maxTokens/persona`；
- 新增 `memory`、`persona` 两个顶层配置段（字段见文档 02、03）；
- 在 `proactive` 段加入 `alarm/sulk/sulkAfterMs/sulkMaxPerHour/sulkOnlyOnBid/sulkJudge/
  sulkJudgeTimeoutMs/muteAfterIgnored/muteMs/morningSpreadMs/greetQuietMs/
  chimeQuietMs/chimeBotQuietMs/startupGraceMs/dailyMax`。

### 2.2 `dist/gateway/bootstrap.js`

- 引入并创建：`createPersonaState`、`createMemory`、`createEngagement`；
- `setupMiddlewares(...)` 调用多传一个 `services`（`{ engagement, persona, memory }`）；
- 出站发送用一层包装：发送成功后调用 `engagement.noteBotMessage(gid, text)`；
- 启动后调用 `engagement.start()`（15 秒巡检：早安/冒泡/闷气/起床提醒/记忆整理）；
- 把 `memory`、`personaState` 挂到 `manager` 上供 `session-manager` 注入。

### 2.3 `dist/gateway/middleware-setup.js`

- 新增 `replyPolicyGate`，插在「斜杠命令 / 待答问题」之后、并发守卫之前；
- mention 闸门改为 `requireMentionInGroup: false`（否则非 @ 消息进不来）；
- 新增内容 transform：mention id → `@昵称`，并在末尾追加「（本条 @ 了：…）」；
- 可选：入站 debug 中间件，把原始消息落 `inbound-debug.jsonl`（默认关闭）。

### 2.4 `dist/transport/inbound.js`

- 入站日志（`qqlog('handler', …)`）；
- 历史消息在非 @ 触发时也带进正文（配合触发策略）；
- 图片消息：下载到本地后提示模型调用 `qqbot_describe_image`；
- 私聊（c2c）也调用 `memory.noteHuman(gid, { senderId, senderName, content })`；
- `whenIdle` 增加 90 秒超时兜底（防止一个卡住的 turn 阻塞后续消息）。

### 2.5 `dist/transport/outbound.js`

- 回合结束写 `qqlog('turn-end', { sessionId, reason, failure })`；
- 发送成功后回调 `engagement.noteBotMessage(...)`（驱动闷气/冒泡的"机器人刚说过话"判断）。

### 2.6 `dist/transport/tool-presenter.js`

- 工具结果含 `data.error` 时返回 `null`，不渲染失败卡片。

### 2.7 `dist/session/session-manager.js`

- 新增字段：`memory`、`personaState`；
- 组装 system prompt 时追加四个 section（按 order 排序）：
  - `qqbot:persona-state`（作息/情绪状态，order 91）
  - `qqbot:memory`（长期记忆，order 92）
  - `qqbot:memory-short`（短期记忆，order 93）
  - `qqbot:rules`（系统规则：提醒统一由插件登记，禁止模型自建定时任务，order 94）
- 记忆注入用 `memory.render(peerId, memory.lastSpeaker(peerId))`。

## 步骤 3：插件配置（`~/.dsh/profiles/desktop/cordis.patch.yml`）

把 `config/cordis.patch.example.yml` 里的 `im-qqbot` 与 `tool-fs-search` 两段合并进去，
替换：`appId`、`appSecret`、`cwd`、`preset` 等占位符。

注意：

- `im-qqbot.cwd` 建议指向一个固定工作目录（避免工具超时）；
- `groupPrompt`/`persona` 里的角色卡按需替换；
- 本仓库示例**不含任何真实凭据**。

## 步骤 4：重启

```powershell
# 方式 A：直接重启应用
# 方式 B：用一次性计划任务（桌面端被自身重启进程打断时更稳）
.\scripts\restart-dsh.ps1
```

## 验证

1. 群里随便发一句（不 @ 它），看 `~/.dsh-qqbot/debug.jsonl` 是否出现
   `policy` 决策与 `interest-judge` 打分；
2. 聊几句后等待 2 分钟，检查 `memory/*.json` 与 `memory/users/*.json` 是否更新；
3. 说「X点叫我起床」，确认 `alarms.json` 出现记录，到点收到消息；
4. 观察 `proactive` 事件（`greet`/`chime`/`sulk`/`wake`）是否符合配置。

## 回滚

修改前的文件建议备份为 `*.bak`（`scripts/install.ps1` 会自动备份新增/覆盖的文件）。
恢复 `dist/` 备份并重启即可；新增模块文件可直接删除，不影响原逻辑。
