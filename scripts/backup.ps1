# 大肥鱼 QQ 机器人 · 备份
# 用法：.\scripts\backup.ps1
#
# 备份对象：四个 Docker 命名卷 + 桥接配置
# 依据：_audit/snowluma-audit.md（三卷不可删，升级会丢登录态）
$ErrorActionPreference = 'Stop'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$BackupRoot = 'D:\deepseek_flash\backup\volumes'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "==> 备份到 $dest" -ForegroundColor Cyan

$volumes = @(
    @{ Name = 'qq-gateway-data';  Path = '/app/data' },
    @{ Name = 'qq-client-config'; Path = '/app/.config' },
    @{ Name = 'qq-client-data';   Path = '/app/.local/share' },
    @{ Name = 'fish-bot-dsh';     Path = '/data' }
)

foreach ($v in $volumes) {
    $out = Join-Path $dest "$($v.Name).tar.gz"
    Write-Host "  $($v.Name) ..." -NoNewline
    # 用 alpine 挂载卷打包；路径取自卷的容器内挂载点
    $mountPath = $v.Path
    & $Docker run --rm `
        -v "$($v.Name):$mountPath" `
        -v "${dest}:/backup" `
        alpine:3.21 sh -c "cd $mountPath && tar czf /backup/$($v.Name).tar.gz ." 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out)) {
        Write-Host " OK ($([math]::Round((Get-Item $out).Length/1MB,1)) MB)" -ForegroundColor Green
    } else {
        Write-Host ' 失败或卷不存在' -ForegroundColor Yellow
    }
}

# 桥接配置
$cfg = Join-Path $ProjectDir 'fish-bot\config.json'
if (Test-Path $cfg) {
    Copy-Item $cfg (Join-Path $dest 'bridge-config.json')
    Write-Host '  bridge-config.json  OK' -ForegroundColor Green
}

# 记录版本信息
$info = @{
    timestamp = (Get-Date).ToString('o')
    snowluma  = (& $Docker inspect snowluma --format '{{.Config.Image}}' 2>$null)
    volumes   = $volumes.Name
} | ConvertTo-Json
$info | Set-Content (Join-Path $dest 'manifest.json') -Encoding UTF8

Write-Host ''
Write-Host "完成：$dest" -ForegroundColor Cyan
Write-Host '恢复：docker run --rm -v <卷名>:<路径> -v <备份目录>:/backup alpine sh -c "cd <路径> && tar xzf /backup/<卷名>.tar.gz"' -ForegroundColor DarkGray
