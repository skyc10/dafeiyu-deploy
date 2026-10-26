# 大肥鱼 QQ 机器人 · 开机自启保障脚本
# 用法：由计划任务在登录后调用，也可手动运行
#
# 为什么需要它：
#   容器的 restart: unless-stopped 只保证「Docker daemon 起来后拉起容器」，
#   但有两个边界：
#     1. 若曾用 `docker compose stop` 停过，Docker 会记住「手动停止」，开机不拉起
#     2. Docker Desktop 首次启动可能比登录慢，容器起不来时没有重试
#   本脚本等 daemon 就绪后确保容器在跑，并对失败做有界重试。
$ErrorActionPreference = 'Continue'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"
$ProjectDir = 'D:\deepseek_flash\project'
$LogDir = 'D:\deepseek_flash\logs'
$Log = Join-Path $LogDir 'autostart.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

Log '===== 开机自启检查开始 ====='

# 1. 等 Docker daemon（最多 5 分钟）
$ready = $false
for ($i = 1; $i -le 60; $i++) {
    & $Docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    if ($i -eq 1) { Log 'Docker daemon 未就绪，等待中…' }
    Start-Sleep -Seconds 5
}

if (-not $ready) {
    Log '✗ Docker daemon 5 分钟内未就绪，放弃。请手动启动 Docker Desktop。'
    exit 1
}
Log "✓ Docker daemon 就绪"

# 2. 复查数据盘（每次启动都查，成本极低）
$vhdx = 'D:\deepseek_flash\data\disk\docker_data.vhdx'
if (Test-Path $vhdx) {
    $gb = [math]::Round((Get-Item $vhdx).Length / 1GB, 2)
    Log "✓ 数据盘在 D 盘：$gb GB"
} else {
    Log '✗ 数据盘不在 D 盘！需在 Docker Settings -> Resources -> Advanced 改回 D:\deepseek_flash\data'
}

# 3. 确保容器在跑（先看状态，不盲目 up）
Push-Location $ProjectDir
try {
    $running = & $Docker ps --filter name=snowluma --filter name=fish-bot --format '{{.Names}}' 2>$null
    $count = ($running | Where-Object { $_ }).Count
    if ($count -ge 2) {
        Log "✓ 两个容器已在运行"
    } else {
        Log "容器未全起（当前 $count 个），执行 compose up…"
        & $Docker compose up -d 2>&1 | ForEach-Object { Log "  $_" }
    }
} finally {
    Pop-Location
}

# 4. 等待并复核
Start-Sleep -Seconds 20
Push-Location $ProjectDir
try {
    $status = & $Docker compose ps --format '{{.Name}} {{.Status}}' 2>$null
    foreach ($s in $status) { Log "  $s" }
} finally {
    Pop-Location
}

# 5. 记录可用内存（内存是本机瓶颈，留个趋势）
$os = Get-CimInstance Win32_OperatingSystem
$availGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
Log "宿主可用内存：$availGb GB"
if ($availGb -lt 1.5) {
    Log '⚠️ 低于 1.5 GB 警戒线，建议检查'
}

Log '===== 开机自启检查结束 ====='
