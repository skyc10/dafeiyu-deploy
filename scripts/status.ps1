# 大肥鱼 QQ 机器人 · 状态与健康检查
# 用法：.\scripts\status.ps1 [-ShowSecrets]
param(
    [switch]$ShowSecrets
)
$ErrorActionPreference = 'Continue'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"

function Section($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }

Section 'Docker daemon'
$ver = & $Docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "  版本 $ver" -ForegroundColor Green }
else { Write-Host '  未运行' -ForegroundColor Red }

Section '容器'
& $Docker ps -a --filter name=snowluma --filter name=fish-bot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

Section '资源占用'
& $Docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>$null

Section '端口绑定（应全部 127.0.0.1）'
& $Docker ps --format '{{.Names}} {{.Ports}}' | Where-Object { $_ -match '1608|3100' }

Section '宿主内存'
$os = Get-CimInstance Win32_OperatingSystem
$availGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$warn = if ($availGb -lt 1.5) { '低于 1.5 G 警戒线！' } else { '正常' }
Write-Host "  可用 $availGb G / 总 $totalGb G ($warn)" -ForegroundColor $(if ($availGb -lt 1.5) { 'Red' } else { 'Green' })

Section '数据盘位置（关键）'
$vhdx = 'D:\deepseek_flash\data\disk\docker_data.vhdx'
if (Test-Path $vhdx) {
    Write-Host ("  D 盘: {0} GB  " -f [math]::Round((Get-Item $vhdx).Length / 1GB, 2)) -ForegroundColor Green
} else {
    Write-Host '  D 盘 vhdx 不存在！检查 Disk image location' -ForegroundColor Red
}
$cDocker = "$env:LOCALAPPDATA\Docker\wsl"
if (Test-Path $cDocker) {
    Write-Host "  警告：C 盘也存在 $cDocker（数据可能在 C 盘）" -ForegroundColor Yellow
}

Section 'SnowLuma 内部进程'
$sc = & $Docker exec snowluma supervisorctl status 2>$null
if ($LASTEXITCODE -eq 0) { $sc | ForEach-Object { Write-Host "  $_" } }
else { Write-Host '  容器未运行或不可 exec' -ForegroundColor Yellow }

Section 'ptrace capability（应含 cap_sys_ptrace=ep）'
$cap = & $Docker exec snowluma getcap /usr/local/bin/node 2>$null
if ($cap -match 'cap_sys_ptrace=ep') { Write-Host "  $cap" -ForegroundColor Green }
else { Write-Host "  $cap  <-- 异常" -ForegroundColor Red }

Section '登录状态'
$logs = & $Docker logs snowluma 2>&1
$awaiting = $logs | Select-String -Pattern 'awaiting login' | Select-Object -Last 1
$loggedIn = $logs | Select-String -Pattern 'loggedIn=true|登录成功|已登录' | Select-Object -Last 1
if ($loggedIn) { Write-Host "  已登录：$loggedIn" -ForegroundColor Green }
elseif ($awaiting) { Write-Host "  等待扫码：$awaiting" -ForegroundColor Yellow }
else { Write-Host '  状态未知，看日志：docker logs snowluma --tail 50' }

if ($ShowSecrets) {
    Section 'noVNC 远程桌面密码'
    $vnc = $logs | Select-String -Pattern '远程桌面密码:|remote desktop password:' | Select-Object -Last 1
    if ($vnc) { Write-Host "  $vnc" -ForegroundColor Yellow }
    else { Write-Host '  日志中已无（密码存于卷 /app/data/config/vnc-password）' }
    Write-Host '  重取：docker exec snowluma cat /app/data/config/vnc-password' -ForegroundColor DarkGray
    $vncFile = & $Docker exec snowluma cat /app/data/config/vnc-password 2>$null
    if ($LASTEXITCODE -eq 0 -and $vncFile) { Write-Host "  当前密码: $vncFile" -ForegroundColor Yellow }

    Section 'WebUI 临时密码'
    $webui = $logs | Select-String -Pattern '临时密码|initial credentials' | Select-Object -Last 1
    if ($webui) { Write-Host "  $webui" -ForegroundColor Yellow }
    else { Write-Host '  只在全新卷首启打印一次，已丢失；可清卷重来或改密码' }
}

Write-Host ''
