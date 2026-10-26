# 大肥鱼 QQ 机器人 · 桥接控制台地址
# 用法：.\scripts\console-url.ps1
#
# 控制台能做什么：
#   - 改白名单（allow.private / allow.groups）、管理员 QQ
#   - 切换聊天模式（chat / reserved / reserved2 / closed-agent）
#   - 看 token 用量、会话列表、群/好友、表情库
#   - 重置 QQ 会话（会丢当前会话上下文）
#
# 技术说明：
#   桥接把控制台硬编码绑在容器内 127.0.0.1:3100，且 Host 校验只认回环。
#   宿主经 13100 访问时，由容器内 console-proxy.mjs 转发并改写 Host 头。
$ErrorActionPreference = 'Stop'

$Bin = 'D:\deepseek_flash\DockerDesktop\resources\bin'
$env:Path = "$Bin;$env:Path"
$Docker = "$Bin\docker.exe"

$tok = $null
# 来源一：桥接自动生成的令牌文件（仅在 config.consoleToken 未配置时生成）
try {
    $raw = & $Docker exec fish-bot sh -c 'cat /data/bridge-state/console-token 2>/dev/null' 2>$null
    if ($raw) { $tok = ($raw | Out-String).Trim() }
} catch { }

# 来源二：config.json 里显式配置的 consoleToken
if (-not $tok) {
    try {
        $raw = & $Docker exec fish-bot node -e "const c=require('/data/bridge-config.json');process.stdout.write(String(c.consoleToken||''))" 2>$null
        if ($raw) { $tok = ($raw | Out-String).Trim() }
    } catch { }
}

if (-not $tok) {
    Write-Host '读取控制台令牌失败：fish-bot 未运行，或未配置令牌。' -ForegroundColor Red
    Write-Host '先启动：.\scripts\start.ps1' -ForegroundColor Yellow
    exit 1
}

$url = "http://127.0.0.1:13100/?token=$tok"

Write-Host ''
Write-Host '桥接控制台（在浏览器打开）：' -ForegroundColor Cyan
Write-Host ''
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host '令牌（也可手工粘贴到页面提示框）：' -ForegroundColor DarkGray
Write-Host "  $tok" -ForegroundColor DarkGray
Write-Host ''

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:13100/api/status?token=$tok" -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    $j = $r.Content | ConvertFrom-Json
    Write-Host "自检：HTTP $($r.StatusCode)" -ForegroundColor Green
    Write-Host "  模式       : $($j.mode)" -ForegroundColor Gray
    Write-Host "  DSH 就绪   : $($j.dshReady)" -ForegroundColor Gray
    Write-Host "  管理员 QQ  : $($j.ownerQQ)" -ForegroundColor Gray
    Write-Host "  白名单私聊 : $($j.allowPrivate -join ', ')" -ForegroundColor Gray
    Write-Host "  白名单群   : $($j.allowGroups -join ', ')" -ForegroundColor Gray
    if ($j.snowluma) {
        Write-Host "  SnowLuma   : connected=$($j.snowluma.connected) online=$($j.snowluma.accountOnline)" -ForegroundColor Gray
    }
} catch {
    Write-Host "自检失败：$($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ''
