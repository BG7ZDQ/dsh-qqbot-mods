# 06 · 上下文管理（QQ 专用压缩 preset）

> 可选但强烈建议。不做的话，QQ 会话的上下文会一路涨到模型窗口的 80% 才会被压缩——对聊天场景等于永不压缩。

## 问题：默认阈值对聊天机器人形同虚设

DSH 的自动压缩由 `@deepseek-ai/dsh-compaction-basic` 提供，默认参数：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `thresholdRatio` | 0.8 | 压力超过 `min(窗口×0.8, 窗口−输出预留−余量)` 才压缩 |
| `headroomTokens` | 65536 | 额外压力余量 |
| `retainRatio` | 0.16 | 压缩后**逐字保留** `(窗口−输出预留)×0.16` 的近期历史 |

实测（DeepSeek 账号适配器，`deepseek-flash`）：

- 上下文窗口 **1,000,000**，单次请求输出预留 **256,000** ⇒ 触发阈值 ≈ **678,000 tokens**；
- 扫全部历史会话，自动压缩实际都发生在 **~42.7 万 ~ 46.6 万 tokens**；
- `retainRatio 0.16` 作用在 744k 上 ⇒ **要保留约 119k 逐字历史**，所以会话小于 ~12 万时连手动 `/compact` 都压不动（返回 shadowed 0）；
- 结果：QQ 私聊/群聊一路涨到 8~13 万 tokens/轮，账单自然越滚越多。

## 方案：给 QQ 会话一个独立 agent preset

不动 GUI 用的 `standard` preset（否则写代码的会话也会 4 万就被压缩），而是新增一个 `qq` preset：

- 插件组成**照抄** `standard`（同样的工具/提示词/技能），只改压缩参数；
- 通过 bundle 的 `- insert:` 形式新增（profile patch 只能覆盖已存在条目，**不能新增**）；
- `im-qqbot.preset` 指向 `qq`。

推荐参数（可按自己模型/预算调）：

| 参数 | 值 | 说明 |
|---|---|---|
| `thresholdRatio` | `0.04` | 1M 窗口下 ≈ 4 万 tokens 就压缩 |
| `headroomTokens` | `8192` | 压力余量 |
| `retainTokens` | `10000` | 逐字保留 1 万近期对话（不再用比例） |
| `maxTokens` | `16384` | 摘要输出上限；用默认 65536 也能跑，只是贵 |
| `summarizationProvider` / `summarizationModel` | `deepseek-account` / `deepseek-flash` | 摘要用便宜模型 |
| 同 preset 的 `tool-result-pruner` | `4096/2048/512` | 压缩前先剪大块工具输出，能省掉一次摘要调用 |

> 如果你的模型窗口不是 1M，按 `threshold = 想要的 token 数 / 窗口` 换算 `thresholdRatio`；
> 约束：`retainTokens < thresholdTokens`，否则插件加载时报配置错误。

## 步骤

### 1. 拿到当前 DSH 版本的标准 preset 组成

Desktop profile 被 Electron 独占，不能直接 `--dump-config`，用一个临时 profile 探测：

```powershell
# ~/.dsh/profiles/cfgprobe/package.json
# { "name": "cfgprobe", "private": true,
#   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }

$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh --profile cfgprobe --dump-default-config 2>&1 | Out-File -Encoding utf8 dump.yml
```

（缺哪个 bundle 会提示 `skipping profile bundle`，按提示把 `dsh.profile.bundles` 补全即可；探测完删掉临时 profile。）

### 2. 生成 QQ preset

```powershell
node scripts/gen-qq-preset.mjs dump.yml preset-qq.generated.yml
node scripts/to-bundle-patch.mjs preset-qq.generated.yml preset-qq.bundle.yml
```

`gen-qq-preset.mjs` 只做三件事：改行 id / `config.id` / 条目名，给 `compaction-basic` 加压缩配置，
收紧 `tool-result-pruner`。参数在脚本顶部常量里，直接改。

### 3. 装进 profile

```
# 1) bundle 包（node_modules 里手动放一个包即可，DSH 从 profile 解析）
~/.dsh/profiles/desktop/node_modules/@local/dsh-qq-preset/package.json
  { "name": "@local/dsh-qq-preset", "version": "0.0.1", "private": true, "type": "module",
    "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
~/.dsh/profiles/desktop/node_modules/@local/dsh-qq-preset/cordis.patch.yml   # = preset-qq.bundle.yml

# 2) 注册 bundle
#   ~/.dsh/profiles/desktop/package.json → dsh.profile.bundles 末尾加 "@local/dsh-qq-preset"

# 3) 指向 preset
#   ~/.dsh/profiles/desktop/cordis.patch.yml → im-qqbot.preset: qq
```

### 4. 重启并验证

```powershell
node scripts/install.ps1   # 如果还没装模块
# 重启 DSH：scripts/restart-dsh.ps1 或手动重启
```

验证方法：等 QQ 会话上下文涨到 4 万左右，看 `~/.dsh-qqbot/` 之外的会话日志里
`compaction/summary` 事件的 `maxTokens`：

- **16384 = 新 preset 生效**；
- 65536 = 还在用旧的 standard（检查 `preset` 是否拼对、bundle 是否被跳过）。

也可以主动在 QQ 里发 `/compact` 立即触发一次。

## 风险与回滚

- **preset 是整份复制**：DSH 升级后 `standard` 若新增工具，QQ 会话会缺这些工具 —— 重新执行第 1~2 步生成并覆盖 bundle 即可；
- **手动放进 `node_modules/@local/` 的包可能被后续 `pnpm install` 清理**：失效时 DSH 只打印
  `skipping profile bundle` 警告，插件会退回宿主默认 preset（即本改动前的行为），**QQ 不会挂**；
- 回滚：删 bundle 目录 → 从 `dsh.profile.bundles` 移除该行 → `im-qqbot.preset` 改回原值 → 重启。

## 实测效果（参考）

| 指标 | 改动前（standard preset） | 改动后（qq preset） |
|---|---|---|
| 首次自动压缩触发点 | ~42.7 万–46.6 万 tokens | ~4 万（估算压力） |
| 压缩后保留 | ~11.9 万逐字 | 1 万逐字 |
| 单次摘要输入 | 8.7 万 tokens | 约 2 万 tokens |
| 摘要输出上限 | 65536 | 16384 |
