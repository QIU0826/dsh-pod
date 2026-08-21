# DSH-Pod 重启自举脚本
# 用途：等待旧 DSH 释放 3080 端口后启动新 DSH（带 PATH 修复——Clawd hook 会改写 PATH，CR-03-7）
# 由旧会话以脱离进程树的方式启动，重启动作完成后旧会话终止，本脚本负责拉起新实例。
$ErrorActionPreference = 'Continue'
$log = 'D:\玩具\dsh-pod\reports\restart-dsh.log'
Start-Transcript -Path $log -Append -Force

# 1) PATH 修复（Windows 专项：外部程序可能改写系统 PATH）
$env:PATH = "D:\nodejs;D:\STUDYSOFT\Git\mingw64\bin;" + $env:PATH

# 2) 等旧进程释放 3080（最长 90 秒）
$port = 3080
$waited = 0
while ($waited -lt 90) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener -eq $null) { break }
    Start-Sleep -Seconds 2
    $waited += 2
    Write-Host "[restart] waiting for port $port release... ${waited}s"
}

# 3) 启动新 DSH
Write-Host "[restart] launching dsh --profile web (no-open)"
try {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "dsh --profile web --no-open" -WorkingDirectory "D:\玩具" -WindowStyle Minimized
    Write-Host "[restart] launched"
} catch {
    Write-Host "[restart] LAUNCH FAILED: $_"
}
Stop-Transcript
