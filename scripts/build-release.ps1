$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
Push-Location $releaseRoot
try {
    $manifest = Get-Content fish-bot/companion-source.json -Raw | ConvertFrom-Json
    $archive = Join-Path $releaseRoot '.companion-build/plugin.tgz'
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Missing .companion-build/plugin.tgz. Download the deployment build kit from Releases.' }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.sha256) { throw 'Companion archive SHA256 mismatch.' }
    docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Compose validation failed.' }
    docker compose build fish-bot
    if ($LASTEXITCODE -ne 0) { throw 'Docker build failed.' }
    Write-Host 'Build complete. No running containers were changed. See docs/PUBLIC-RELEASE.md before first startup.'
} finally { Pop-Location }
