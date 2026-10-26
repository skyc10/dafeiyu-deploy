# 大肥鱼 QQ 机器人 · 启动脚本
# 用法：.\scripts\start.ps1
$ErrorActionPreference = 'Stop'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$env:Path = "$Bin;$env:Path"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  !!  $msg" -ForegroundColor Yellow }

Write-Step '检查 Docker daemon'
try {
    & "$Bin\docker.exe" info --format '{{.ServerVersion}}' | Out-Null
    Write-Ok 'daemon 已就绪'
} catch {
    Write-Warn2 'Docker Desktop 未运行，尝试启动'
    $exe = 'D:\deepseek_flash\DockerDesktop\Docker Desktop.exe'
    if (-not (Test-Path $exe)) { throw "找不到 $exe" }
    Start-Process -FilePath $exe
    $ok = $false
    for ($i = 1; $i -le 60; $i++) {
        Start-Sleep -Seconds 3
        & "$Bin\docker.exe" info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    }
    if (-not $ok) { throw 'Docker daemon 启动超时（180 秒）' }
    Write-Ok 'daemon 已就绪'
}

Write-Step '检查数据盘仍在 D 盘'
$ss = "$env:APPDATA\Docker\settings-store.json"
if (Test-Path $ss) {
    $vhdx = 'D:\deepseek_flash\data\disk\docker_data.vhdx'
    if (Test-Path $vhdx) {
        Write-Ok "数据盘 D:\deepseek_flash\data ($([math]::Round((Get-Item $vhdx).Length/1GB,2)) GB)"
    } else {
        Write-Warn2 'D:\deepseek_flash\data\disk\docker_data.vhdx 不存在！可能被重置到 C 盘'
        Write-Warn2 '请在 Docker Settings -> Resources -> Advanced 把 Disk image location 改回 D:\deepseek_flash\data'
    }
}

Write-Step '启动容器'
Push-Location $ProjectDir
try {
    & "$Bin\docker.exe" compose up -d
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up 失败' }
    Write-Ok '容器已启动'
} finally {
    Pop-Location
}

Write-Step '等待服务就绪'
for ($i = 1; $i -le 40; $i++) {
    $s = & "$Bin\docker.exe" ps --filter name=snowluma --format '{{.Status}}'
    if ($s -like '*Up*') { break }
    Start-Sleep -Seconds 3
}

Write-Host ''
Write-Host '访问地址：' -ForegroundColor Cyan
Write-Host '  noVNC 扫码   http://127.0.0.1:16081/'
Write-Host '  SnowLuma     http://127.0.0.1:16082/'
Write-Host ''
Write-Host '取密码：.\scripts\status.ps1 -ShowSecrets' -ForegroundColor Yellow
