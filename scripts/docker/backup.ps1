param(
  [string]$OutputPath = (Join-Path "backups" ("meristream-{0}.dump" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")))
)

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

docker compose exec -T db sh -c 'pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' |
  Set-Content -Path $OutputPath -AsByteStream
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

Write-Host "Backup written to $OutputPath"
