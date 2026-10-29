# dsh-qqbot-mods

给 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)（QQ 机器人插件，0.5.2 验证）做的**行为增强补丁集**，运行于 DeepSeek Harness Desktop（0.2.1-rc.2 验证）。

不是 fork，而是「新增模块 + 对原 package `dist/` 的少量定点修改」；新增模块都是独立文件，原代码改动在 `docs/05-install-and-patch.md` 里逐条列出。

> ⚠️ 本仓库不含任何凭据、群 ID、openid 或聊天内容。示例配置里的值全部是占位符。

## 能力一览

| 能力 | 说明 |
|---|---|
| **群聊触发策略** | 旁观模式：被 @ / 叫名字 / 命中情绪词 / 对话延续 / 兴趣判断 / 随机插话，其余不回复 |
| **兴趣判断器** | 每条候选消息一次小模型调用，返回 `{interest, invited}`，决定要不要接话；低推理 + 失败回退 |
| **对话延续** | 机器人发言后 2 分钟内、同一人追问，先由判断器确认"还在跟它聊"再回，避免硬插无关话题 |
| **长期/短期记忆** | 群记忆 + 人记忆（按 openid 跨群共享），各含长期（稳定事实）与短期（最近事件，默认 24h 过期），定期由模型自己决定记什么 |
| **作息与情绪** | 23:00–07:00 困倦（非点名消息不理、说话更短）；被夸心情好、被冷落心情低，影响插话概率 |
| **主动发言** | 早安（7:00–7:30 按群错开）、偶尔冒泡（要求群里安静 30 分钟）、被无视后生闷气（3 分钟判定 → 抱怨 → 安静 5 分钟，每小时最多 3 次） |
| **叫我起床** | 「七点半叫我起床」「下午一点四十叫我」→ 登记提醒，到点主动发消息（中文数字/上午下午都支持） |
| **多 @ 处理** | 一句话里 @ 多个人时，把别人的 @ 还原成 `@昵称`，不再出现"名字空空的" |
| **图片理解** | QQ 图片下载到本地后，提示模型调用 `qqbot_describe_image` 看图 |
| **错误不刷屏** | 工具失败不再发 `❌ 工具 ... 执行失败` 卡片，改由模型自己用自然语言解释 |
| **诊断日志** | `~/.dsh-qqbot/debug.jsonl` 记录 inbound / policy / handler / turn-end / proactive / memory-distill / interest-judge 等节点 |

## 目录结构

```
src/                     新增模块（直接覆盖到插件 dist/ 对应位置）
  features/memory.js         群/人记忆 + 长期/短期
  features/persona-state.js  作息与情绪
  features/engagement.js     参与度状态机 + 主动发言 + 起床提醒
  middleware/interest-judge.js  兴趣判断 / 沉默判断（小模型）
  middleware/reply-policy.js    群聊触发策略
  shared/qqlog.js            诊断日志
docs/
  01-trigger-and-reply.md    触发策略 / 判断器 / 对话延续
  02-memory.md               记忆系统设计
  03-persona-and-proactive.md 作息情绪 / 早安冒泡闷气 / 叫我起床
  04-fixes.md                多@ / 图片 / 错误卡片 / 超时等修复
  05-install-and-patch.md    安装步骤 + 原文件逐条修改清单
config/
  cordis.patch.example.yml   脱敏后的插件配置示例
scripts/
  install.ps1                备份并复制新模块，打印剩余手工修改清单
  restart-dsh.ps1            重启 DSH 桌面端的一次性计划任务脚本
```

## 快速开始

1. 确认插件版本为 `@tencent-connect/dsh-qqbot@0.5.2`（其他版本行号/结构可能不同）；
2. 按 `docs/05-install-and-patch.md` 把 `src/` 下文件复制到插件 `dist/`，并完成列出的定点修改；
3. 把 `config/cordis.patch.example.yml` 里 `im-qqbot`、`tool-fs-search` 两段合并进
   `~/.dsh/profiles/desktop/cordis.patch.yml`，填上自己的 appId / appSecret；
4. 重启 DSH 桌面端（见 `scripts/restart-dsh.ps1`）。

## 已知限制

- **QQ 群消息权限**：公域机器人在群里默认只收到 @ 它的消息。要"旁观/随机插话"需要群主在
  机器人权限里开启「接收全部群消息」，否则大多数策略没有输入。
- **openid 与机器人绑定**：`member_openid` 在同一机器人（appId）下跨群一致，但**换机器人后
  同一个人会得到新 openid**，人记忆无法延续。
- **主动消息额度**：QQ 群主动消息官方限额 1000 条/群/天，本方案另有 `dailyMax` 限制。
- **模型推理预算**：判断/记忆等工具型调用需显式 `reasoningEffort: 'low'` 并给足输出上限，
  否则推理会吃光输出、返回空正文（这是实际踩过的坑）。

## License

本仓库新增代码：MIT。对被修改的第三方包 `@tencent-connect/dsh-qqbot`（MIT）仅做说明性引用，
不重新分发其代码，详见 `NOTICE`。
