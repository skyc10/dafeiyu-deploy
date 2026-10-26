# 大肥鱼 QQ 机器人 · 获取专用 DSH 管理页地址
# 用法：.\scripts\dsh-url.ps1
#
# 为什么需要这个脚本：
#   DSH 的 launch token 是「每进程现生成、只存在内存里」的，DSH 每次重启就变。
#   容器内绑的是 eth0 IP（宿主要经端口映射访问），所以宿主侧要用 18080 端口
#   拼上本次的 token。手动拼容易出错，用这个脚本直接拿到可用地址。
$ErrorActionPreference = 'Stop'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"

$internal = (& $Docker exec fish-bot cat /data/dsh-url.txt 2>$null)
if (-not $internal) {
    Write-Host '读取失败：fish-bot 容器未运行，或 /data/dsh-url.txt 不存在。' -ForegroundColor Red
    Write-Host '先启动：.\scripts\start.ps1' -ForegroundColor Yellow
    exit 1
}

if ($internal -notmatch 'token=(?<t>[A-Za-z0-9_-]+)') {
    Write-Host "未能从 $internal 提取 token" -ForegroundColor Red
    exit 1
}
$tok = $Matches['t']

$url = "http://127.0.0.1:18080/?token=$tok"

Write-Host ''
Write-Host '专用 DSH 管理页（在浏览器打开）：' -ForegroundColor Cyan
Write-Host ''
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host '用途：' -ForegroundColor DarkGray
Write-Host '  - 配置模型 API key（设置 → 模型）' -ForegroundColor DarkGray
Write-Host '  - 开启记忆插件、绑定心情会话' -ForegroundColor DarkGray
Write-Host ''
Write-Host '注意：DSH 重启后 token 会变，重新运行本脚本即可。' -ForegroundColor Yellow

# 自检（用 Invoke-WebRequest，它会跟随重定向并保存 cookie）
try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    Write-Host "自检：HTTP $($r.StatusCode)，页面 $($r.Content.Length) 字节 —— 可访问" -ForegroundColor Green
} catch {
    Write-Host "自检失败：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '若显示 401，请直接在浏览器里打开上面的地址（浏览器会正确处理 token 重定向）。' -ForegroundColor DarkGray
}
