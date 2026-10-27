# 大肥鱼 QQ 机器人 · 升级
# 用法：.\scripts\upgrade.ps1 [-SnowLumaTag v2.2.1]
param(
    [string]$SnowLumaTag = ''
)
$ErrorActionPreference = 'Stop'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $ProjectDir 'docker-compose.yml'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

Step '停止写入并进行一致性备份'
$migrationConfig = Join-Path ([IO.Path]::GetTempPath()) ('dafeiyu-live-' + [guid]::NewGuid().ToString('N') + '.json')
& $Docker stop --timeout 35 fish-bot snowluma
if ($LASTEXITCODE -ne 0) { throw '停止容器失败，升级中止' }
try {
    & $Docker cp -L 'fish-bot:/opt/qq-bridge/config.json' $migrationConfig
    if ($LASTEXITCODE -ne 0) { throw '备份运行配置失败' }
    & $Docker cp $migrationConfig 'fish-bot:/data/bridge-config.pre-upgrade-live.json'
    if ($LASTEXITCODE -ne 0) { throw '准备配置迁移失败' }
} finally {
    if (Test-Path -LiteralPath $migrationConfig) { Remove-Item -LiteralPath $migrationConfig }
}
if ($LASTEXITCODE -ne 0) { throw '停止容器失败，升级中止' }
& (Join-Path $PSScriptRoot 'backup.ps1')
if ($LASTEXITCODE -ne 0) { throw '备份失败，升级中止' }

# ── 1. SnowLuma 升级 ──────────────────────────────────────────────────────
if ($SnowLumaTag) {
    Step "升级 SnowLuma 到 $SnowLumaTag"
    $newImage = "motricseven7/snowluma:$SnowLumaTag"
    & $Docker pull $newImage
    if ($LASTEXITCODE -ne 0) { throw "拉取 $newImage 失败" }

    # 改 compose 里的 tag
    $content = Get-Content $ComposeFile -Raw
    $content = $content -replace '(image:\s*motricseven7/snowluma:)\S+', "`${1}$SnowLumaTag"
    Set-Content $ComposeFile $content -Encoding UTF8 -NoNewline
    Ok "compose 已指向 $newImage"

    Step '重建容器（数据卷保留，登录态不丢）'
    Push-Location $ProjectDir
    try {
        & $Docker compose up -d --force-recreate snowluma
        if ($LASTEXITCODE -ne 0) { throw 'compose up 失败' }
    } finally { Pop-Location }
    Ok 'SnowLuma 已升级'
} else {
    Write-Host '  (未指定 -SnowLumaTag，跳过 SnowLuma 升级)' -ForegroundColor DarkGray
    Write-Host '  查询最新 tag：' -ForegroundColor DarkGray
    Write-Host '  Invoke-RestMethod "https://hub.docker.com/v2/repositories/motricseven7/snowluma/tags?page_size=10&ordering=last_updated" | % { $_.results.name }' -ForegroundColor DarkGray
}

# ── 2. fish-bot 升级 ──────────────────────────────────────────────────────
Step '重建 fish-bot 镜像'
Push-Location $ProjectDir
try {
    & $Docker compose build fish-bot
    if ($LASTEXITCODE -ne 0) { throw '构建失败' }
    & $Docker compose up -d --force-recreate fish-bot
    if ($LASTEXITCODE -ne 0) { throw 'fish-bot 重启失败' }
} finally { Pop-Location }
Ok 'fish-bot 已更新'

# ── 3. 升级后强制复查（计划 §9 风险表要求）────────────────────────────────
Step '复查 Docker 数据盘位置（每次升级必做）'
$vhdx = 'D:\deepseek_flash\data\disk\docker_data.vhdx'
if (Test-Path $vhdx) {
    Ok "数据盘仍在 D 盘：$([math]::Round((Get-Item $vhdx).Length/1GB,2)) GB"
} else {
    Warn '数据盘不在 D 盘！'
    Warn '  修复：Docker Desktop -> Settings -> Resources -> Advanced'
    Warn '        Disk image location 改为 D:\deepseek_flash\data -> Apply & Restart'
}
$cWsl = "$env:LOCALAPPDATA\Docker\wsl"
if (Test-Path $cWsl) {
    $size = (Get-ChildItem $cWsl -Recurse -File -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    Warn "C 盘出现 $cWsl（$([math]::Round($size/1GB,2)) GB），数据可能已回落到 C 盘"
}

Step '复查 WSL 版本未被动过'
$wslVer = (wsl.exe --version 2>&1 | Select-Object -First 1) -replace '\0',''
Write-Host "  $wslVer" -ForegroundColor Gray
if ($wslVer -notmatch '2\.7\.8') {
    Warn 'WSL 版本已变化！计划要求保持 2.7.8.0，请确认是否被自动升级'
}

Write-Host ''
Write-Host '升级完成。验收：.\scripts\status.ps1' -ForegroundColor Cyan
