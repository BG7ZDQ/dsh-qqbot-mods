# 把 src/ 下的新增模块复制进已安装的 QQ 插件 dist/（会先备份被覆盖的文件）
#
# 用法：
#   pwsh -File install.ps1 -PluginDist "C:\Users\<you>\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\dist"
#   （省略 -PluginDist 时自动探测常见安装位置）
param(
  [string]$PluginDist = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not $PluginDist) {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\dist'),
    (Join-Path $env:USERPROFILE '.dsh\node_modules\@tencent-connect\dsh-qqbot\dist')
  )
  $PluginDist = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $PluginDist -or -not (Test-Path $PluginDist)) {
  throw '找不到插件 dist/ 目录，请用 -PluginDist 指定。'
}

Write-Host "目标插件目录: $PluginDist"

$map = @{
  'src/features/memory.js'          = 'features/memory.js'
  'src/features/persona-state.js'   = 'features/persona-state.js'
  'src/features/engagement.js'      = 'features/engagement.js'
  'src/middleware/interest-judge.js'= 'middleware/interest-judge.js'
  'src/middleware/reply-policy.js'  = 'middleware/reply-policy.js'
  'src/shared/qqlog.js'             = 'shared/qqlog.js'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($srcRel in $map.Keys) {
  $srcFile = Join-Path $repo $srcRel
  $dstFile = Join-Path $PluginDist $map[$srcRel]
  $dstDir  = Split-Path -Parent $dstFile
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  if (Test-Path $dstFile) {
    Copy-Item $dstFile "$dstFile.$stamp.bak" -Force
  }
  Copy-Item $srcFile $dstFile -Force
  Write-Host "  [ok] $($map[$srcRel])"
}

Write-Host ''
Write-Host '新增模块已复制。还需要手动完成 docs/05-install-and-patch.md 里的定点修改：'
Write-Host '  dist/config.js              追加 trigger.interest / memory / persona 配置'
Write-Host '  dist/gateway/bootstrap.js   创建并接线 persona/memory/engagement'
Write-Host '  dist/gateway/middleware-setup.js  插入 replyPolicyGate 等'
Write-Host '  dist/transport/inbound.js   历史/图片/私聊记忆/超时兜底'
Write-Host '  dist/transport/outbound.js  turn-end 日志 + 机器人发言回调'
Write-Host '  dist/transport/tool-presenter.js  错误卡片不渲染'
Write-Host '  dist/session/session-manager.js   注入 persona/memory prompt'
Write-Host ''
Write-Host '完成后重启 DSH 桌面端。备份文件后缀为 .<时间戳>.bak，可随时回滚。'
