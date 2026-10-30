# dsh-qqbot-mods

> 让 DSH 的 QQ 机器人**活在群里**。
>
> 给 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)（QQ 机器人插件）做的**拟人化行为增强补丁集**，运行在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）上：会看气氛决定接不接话、有长期/短期记忆、有作息和情绪、会主动开口，也替你管住上下文成本。


不是 fork，也不重新分发原插件代码：**新增若干独立模块** + 对原包 `dist/` 的少量**定点修改**（逐条列在 [`docs/05-install-and-patch.md`](docs/05-install-and-patch.md)），升级原插件后照着清单重新核对即可。

> ⚠️ 本仓库不含任何凭据、群 ID、openid 或聊天内容；示例配置全部是占位符。
> 所有记忆/日志文件都放在 `~/.dsh-qqbot/`，不进仓库（见 `.gitignore`）。

## 这是什么

原版 `dsh-qqbot` 是一个"收到消息 → 调模型 → 回复"的通道。本补丁集把它补成一个**像人一样待在群里**的机器人：

| 能力 | 说明 |
|---|---|
| **群聊触发策略** | 旁观模式：被 @ / 叫名字 / 命中情绪词 / 对话延续 / 兴趣判断器打分 / 其余按概率随机插话，不命中的消息只看不回 |
| **兴趣判断器** | 每条候选消息一次小模型调用，输出 `{interest, invited}` 决定接不接话；低推理 + 失败回退 |
| **对话延续** | 机器人发言后 2 分钟内同一人追问，先判断"是不是还在跟它聊"再回，避免硬插无关话题 |
| **长期/短期记忆** | 群记忆 + 人记忆（按 `member_openid` 跨群共享），各分长期（稳定事实，不过期）与短期（最近事件，默认 24h 过期）；**写入前与已有记忆合并去重**，同义条目只更新不新增，短期时间戳不会被刷新续命 |
| **上下文管理** | 给 QQ 会话单独的 agent preset，把自动压缩阈值从默认的 ~678k tokens 降到 ~4 万，并保留 1 万逐字近期历史；摘要走便宜模型（详见 [`docs/06-context-management.md`](docs/06-context-management.md)） |
| **作息与情绪** | 深夜困倦（非点名消息不理、回复更短）；被夸心情好、被冷落心情低，影响插话概率 |
| **主动发言** | 早安（按群错开时间）、偶尔冒泡（要求群里安静一段时间）、被无视后生闷气（先判定 → 抱怨 → 安静一段时间） |
| **定时提醒** | 「七点半叫我起床」「五分钟后提醒我」「下午一点四十叫我」→ 插件登记并持久化，到点主动发消息；支持两段式对话（先记话题再补时间）；system prompt 里禁止模型自建定时任务 |
| **多 @ 还原** | 一句话 @ 多个人时，把别人的 `@id` 还原成 `@昵称` |
| **图片理解** | QQ 图片下载到本地后提示模型调用 `qqbot_describe_image` |
| **错误不刷屏** | 工具失败不再发 `❌ 工具 xxx 执行失败` 卡片，改由模型用自然语言解释 |
| **诊断日志** | `~/.dsh-qqbot/debug.jsonl` 按 tag 记录 policy / handler / turn-end / proactive / memory-distill / interest-judge / alarm-set / alarm-fired 等节点 |

## 版本兼容

| 组件 | 验证过的版本 |
|---|---|
| `@tencent-connect/dsh-qqbot` | `0.5.2` |
| DeepSeek Harness Desktop | `0.2.1-rc.2` |
| 平台 | Windows（PowerShell 脚本按 Windows 写）；补丁本身是 ESM JS，其他平台需自行改脚本 |

原插件版本不同则 `dist/` 结构与行号可能不同，请按 `docs/05` 的清单**逐条核对**后再应用。

## 快速开始

```text
1. 安装并登录 DSH Desktop，安装 QQ 插件 @tencent-connect/dsh-qqbot@0.5.2
2. 把 src/ 下的模块复制到插件 dist/（scripts/install.ps1 会先备份）
3. 按 docs/05-install-and-patch.md 完成对原包文件的定点修改
4. 把 config/cordis.patch.example.yml 的 im-qqbot / tool-fs-search 两段
   合并进 ~/.dsh/profiles/desktop/cordis.patch.yml，填入自己的 appId/appSecret
5. （可选，强烈建议）按 docs/06-context-management.md 配置上下文压缩
6. 重启 DSH（scripts/restart-dsh.ps1）
```

`scripts/install.ps1` 只负责复制 `src/`；定点修改需要手工做，这是刻意的——升级原包时你能清楚知道动了哪里。

## 配置

完整示例见 [`config/cordis.patch.example.yml`](config/cordis.patch.example.yml)。几个最容易踩的键：

```yaml
- id: im-qqbot
  config:
    appId: '<your-app-id>'
    appSecret: '<your-app-secret>'
    # 显式路由：provider 与 model 必须同时给，否则回退宿主默认链
    provider: deepseek-account
    model: deepseek-flash
    # 专用 agent preset（见 docs/06）；不配则用宿主默认 preset
    preset: qq
    cwd: '<workspace-path>'      # 固定工作目录，避免全盘搜索超时
    requireMention: false        # 旁观模式必须 false
    historyLimit: 20
    trigger:
      interest: { enabled: true, minScore: 0.5, maxTokens: 800 }
    memory:
      maxFacts: 12
      maxPersonFacts: 6
      maxShortTerm: 6
      shortTermTtlMs: 86400000
```

- **人设/语气**：`groupPrompt` / `directPrompt` 里写，想换成什么角色都行（示例里是一个 12 岁少女，可自由替换）；
- **触发词**：`trigger.nameKeywords` / `topicKeywords` 按自己的机器人和群调整；
- **推理模型**：所有工具型小模型调用都必须 `reasoningEffort: 'low'` 且给足 `maxTokens`，否则推理吃光输出、正文为空（本项目实际踩过的坑，已在代码里写死）。

### 人设定制（重要）

示例人设叫「小小鱼」。**人设主体**在 `groupPrompt` / `directPrompt`，想换成什么角色直接改配置即可。

另有少量提示词、判断器描述、记忆前缀在代码里写死了这个名字，换机器人名时请一并替换：

```powershell
grep -rn 小小鱼 src/
# src/middleware/interest-judge.js（判断器 prompt，11 处）
# src/features/memory.js（记忆整理 prompt / 缓冲前缀，4 处）
# src/features/engagement.js（主动发言相关，1 处）
```

改完重新复制到插件 `dist/` 并重启。触发词 `trigger.nameKeywords` 也要换成新名字。

## 目录结构

```
src/                                 新增模块（复制到插件 dist/ 对应位置）
  features/memory.js                   群/人记忆，长期/短期，写入前合并去重
  features/persona-state.js            作息与情绪
  features/engagement.js               参与度状态机 + 主动发言 + 提醒轮询
  middleware/interest-judge.js         兴趣判断 / 沉默判断（小模型）
  middleware/reply-policy.js           群聊触发策略
  shared/qqlog.js                      诊断日志
config/
  cordis.patch.example.yml             脱敏配置示例
docs/
  01-trigger-and-reply.md              触发策略 / 判断器 / 对话延续
  02-memory.md                         记忆系统（结构、整理流程、合并策略）
  03-persona-and-proactive.md          作息情绪 / 早安冒泡闷气 / 定时提醒
  04-fixes.md                          多@ / 图片 / 错误卡片 / 超时等修复
  05-install-and-patch.md              安装步骤 + 原文件逐条修改清单
  06-context-management.md             上下文压缩（QQ 专用 preset）
scripts/
  install.ps1                          备份并复制新模块，打印剩余手工修改清单
  restart-dsh.ps1                      用一次性计划任务重启 DSH 桌面端
  gen-qq-preset.mjs                    从 dsh --dump-default-config 生成 QQ preset
  to-bundle-patch.mjs                  把 preset 包成 bundle patch（- insert: 形式）
  memory-maintenance.mjs               记忆文件维护：去重 / 时间词降级（停机时跑）
```

## 诊断

```text
~/.dsh-qqbot/debug.jsonl   逐行 JSON，tag 决定含义：
  policy / handler / turn-end         消息是否回复、为什么
  interest-judge / silence-judge      小模型判断结果与耗时
  proactive                           早安 / 冒泡 / 闷气 / 提醒
  alarm-set / alarm-fired             提醒登记与触发
  memory-distill / memory-distill-step 记忆整理：ok/merged/demoted、耗时、失败原因
```

```powershell
# 最近 24h 各类事件计数
Get-Content ~/.dsh-qqbot/debug.jsonl -Tail 2000 | ForEach-Object { ($_ | ConvertFrom-Json).tag } |
  Group-Object | Sort-Object Count -Descending
```

## 已知限制

- **群消息权限**：公域机器人在群里默认只收到 @ 它的消息。要旁观/随机插话，需要群主在机器人权限里开启「接收全部群消息」，否则大多数策略没有输入。
- **openid 与机器人绑定**：`member_openid` 在同一 appId 下跨群一致，但**换机器人后同一个人会得到新 openid**，人记忆无法延续。
- **主动消息额度**：QQ 群主动消息有官方额度限制，本项目另有 `proactive.dailyMax` 兜底。
- **记忆是模型写的**：整理由小模型完成，可能漏记/错记；合并去重只能处理"字面相近"，语义相近但措辞差很多的条目要靠提示词让模型自己收敛。
- **上下文压缩 preset 是整份复制**：DSH 升级后标准 preset 若新增工具，需要按 `docs/06` 重新生成，否则 QQ 会话会少新工具。
- **模型成本**：判断器、记忆整理、上下文摘要、主动发言都会产生额外调用，请自行按账单调参。

## 安全与隐私

- 仓库里没有凭据；`.gitignore` 已排除 `cordis.patch.yml`、`node_modules/`、`*.bak`、`*.jsonl`、`memory/`、`alarms.json`、`secrets*`。
- 记忆文件按 `member_openid` 分人存储，只向当前发言人注入其本人记忆，不串群、不串人。
- 群 ID / openid / 聊天内容只出现在本机 `~/.dsh-qqbot/`，不要提交、不要贴日志原文。
- 开源/分享时请注意：**示例配置里不要填真实 appId/appSecret**，也不要贴真实群 ID。

## 回滚

- `scripts/install.ps1` 覆盖前会把原文件备份成 `<file>.<时间戳>.bak`，恢复备份 + 重启即可；
- 上下文压缩 preset 的回退：删掉 profile 的 `node_modules/@local/dsh-qq-preset/`、从 `package.json` 的 `dsh.profile.bundles` 里移除该行、把 `im-qqbot.preset` 改回原值，重启；
- 新增模块文件（`src/` 对应的 6 个文件）如果原本不存在，直接删除不影响原版逻辑。

## License

本仓库新增代码：MIT（见 [`LICENSE`](LICENSE)）。
对被修改的第三方包 `@tencent-connect/dsh-qqbot`（MIT）仅做说明性引用，不重新分发其代码，见 [`NOTICE`](NOTICE)。
