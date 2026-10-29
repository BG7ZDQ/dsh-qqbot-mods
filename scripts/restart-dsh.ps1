# 重启 DSH 桌面端（一次性计划任务版）
#
# 为什么要用计划任务：本脚本通常由 DSH 自己通过 pwsh 调用，直接 taskkill 会把
# 调用它的进程树一起杀掉，导致"重启命令自己中途死亡"。用 schtasks 创建一次性
# 任务、延迟几十秒再执行，就能避开这个问题。
#
# 用法（在 DSH 会话里）：
#   $tr = '"' + "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Resolve-Path .\scripts\restart-dsh.ps1) + '"'
#   $st = (Get-Date).AddMinutes(10).ToString('HH:mm')
#   schtasks /create /tn "DSH-Restart-Once" /tr $tr /sc once /st $st /f
#   schtasks /run /tn "DSH-Restart-Once"
param(
  [int]$DelaySeconds = 45,
  [string]$ExePattern = '*DeepSeek*Harness*.exe'
)

$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds $DelaySeconds

$proc = Get-Process | Where-Object { $_.Name -like '*DeepSeek*' -and $_.MainWindowTitle } |
        Select-Object -First 1
$exe = $proc.Path
if (-not $exe) {
  $candidate = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter $ExePattern -ErrorAction SilentlyContinue |
               Select-Object -First 1
  $exe = $candidate.FullName
}
if (-not $exe -or -not (Test-Path $exe)) {
  throw "找不到 DSH 可执行文件，请检查安装路径。"
}

# 结束所有进程树（含子进程），再重新启动
Get-Process -Name ($proc.Name) -ErrorAction SilentlyContinue | ForEach-Object {
  & taskkill.exe /PID $_.Id /T /F | Out-Null
}
Start-Sleep -Seconds 3
Start-Process -FilePath $exe
