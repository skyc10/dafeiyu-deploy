# 大肥鱼 QQ 机器人 · 停止脚本
# 用法：.\scripts\stop.ps1 [-RemoveContainers]
param(
    [switch]$RemoveContainers   # 连容器一起删（保留数据卷）
)
$ErrorActionPreference = 'Continue'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"
$ProjectDir = Split-Path -Parent $PSScriptRoot

Write-Host '==> 停止容器' -ForegroundColor Cyan
Push-Location $ProjectDir
try {
    if ($RemoveContainers) {
        Write-Host '    注意：容器被删除后重建，QQ 需要重新扫码登录。' -ForegroundColor Yellow
        & $Docker compose down
        Write-Host '  容器已删除（数据卷、记忆、配置均保留）' -ForegroundColor Green
    } else {
        Write-Host '    容器保留，下次启动不重建，QQ 登录态可保持。' -ForegroundColor DarkGray
        & $Docker compose stop
        Write-Host '  容器已停止（可 start.ps1 恢复）' -ForegroundColor Green
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '下次启动：双击 D:\大肥鱼QQ\启动\启动大肥鱼.bat' -ForegroundColor Cyan
Write-Host '注意：主 DSH（端口 3080）不受影响，仍在运行。' -ForegroundColor DarkGray
Write-Host '如需停止 Docker Desktop 本身：右键托盘图标 -> Quit Docker Desktop' -ForegroundColor DarkGray
