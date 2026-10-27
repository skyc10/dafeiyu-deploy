# Consistent offline backup. No credentials or volume contents belong in Git.
param([string]$Destination = (Join-Path 'D:\deepseek_flash\backup\volumes' (Get-Date -Format 'yyyyMMdd-HHmmss')))
$ErrorActionPreference = 'Stop'
$Docker = 'D:\deepseek_flash\DockerDesktop\resources\bin\docker.exe'
$volumes = @('qq-gateway-data', 'qq-client-config', 'qq-client-data', 'fish-bot-dsh')
foreach ($volume in $volumes) {
    $users = & $Docker ps --filter "volume=$volume" --format '{{.Names}}'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect volume users' }
    if ($users) { throw "Stop volume writers before backup: $volume ($users)" }
    & $Docker volume inspect $volume --format '{{.Name}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Missing volume: $volume" }
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$images = foreach ($name in @('fish-bot','snowluma')) {
    $raw = & $Docker inspect $name --format '{{json .}}'
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $name" }
    $info = $raw | ConvertFrom-Json
    @{ container=$name; imageId=$info.Image; configuredImage=$info.Config.Image; state=$info.State.Status }
}
$files = foreach ($volume in $volumes) {
    & $Docker run --rm --network none --mount "type=volume,source=$volume,target=/source,readonly" --mount "type=bind,source=$Destination,target=/backup" alpine:3.21 sh -c "cd /source && tar czf /backup/$volume.tar.gz ."
    if ($LASTEXITCODE -ne 0) { throw "Backup failed: $volume" }
    $file = Join-Path $Destination "$volume.tar.gz"
    if (!(Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw "Empty backup: $volume" }
    & $Docker run --rm --network none --mount "type=bind,source=$Destination,target=/backup,readonly" alpine:3.21 sh -c "tar tzf /backup/$volume.tar.gz >/dev/null"
    if ($LASTEXITCODE -ne 0) { throw "Backup archive validation failed: $volume" }
    @{ volume=$volume; file="$volume.tar.gz"; sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash; bytes=(Get-Item -LiteralPath $file).Length }
}
@{ timestamp=(Get-Date).ToString('o'); images=@($images); files=@($files); consistentOffline=$true } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Destination 'manifest.json') -Encoding utf8
Write-Host "Verified offline backup: $Destination"
