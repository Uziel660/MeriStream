[CmdletBinding()]
param(
    [string]$BundlePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'transfer\Meristream-PC-Transfer-2026-09-10.7z.001'),

    [string]$Destination = (Split-Path -Parent $PSScriptRoot),

    [string]$Password,

    [switch]$OverwriteEnv,

    [switch]$RestoreDatabase,

    [switch]$SkipDependencies
)

$ErrorActionPreference = 'Stop'

function Get-SevenZip {
    $candidates = @(
        (Get-Command 7z -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\7zr.exe'),
        'E:\Appjoha\DockerDesktop\7zr.exe'
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

    if (-not $candidates) {
        throw 'No se encontró 7-Zip. Instala Docker Desktop o 7-Zip y vuelve a ejecutar el script.'
    }
    # A single pipeline result is unwrapped to a string by PowerShell. Wrap it
    # again before indexing so the full executable path is returned.
    return @($candidates)[0]
}

if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    throw "No se encontró la primera parte del paquete: $BundlePath"
}
if (-not $Password) {
    $securePassword = Read-Host 'Contraseña del paquete' -AsSecureString
    $credential = [System.Net.NetworkCredential]::new('', $securePassword)
    $Password = $credential.Password
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "meristream-restore-$stamp"

try {
    New-Item -ItemType Directory -Force $temporaryRoot | Out-Null
    $sevenZip = Get-SevenZip
    & $sevenZip x -y "-p$Password" "-o$temporaryRoot" $BundlePath
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo abrir el paquete: contraseña incorrecta o partes incompletas.' }

    if (-not (Test-Path -LiteralPath (Join-Path $temporaryRoot 'transfer-manifest.json'))) {
        throw 'El paquete no contiene un manifiesto válido.'
    }

    New-Item -ItemType Directory -Force $Destination | Out-Null
    $sourceEnv = Join-Path $temporaryRoot '.env'
    $targetEnv = Join-Path $Destination '.env'
    if ((Test-Path -LiteralPath $targetEnv) -and -not $OverwriteEnv) {
        throw 'Ya existe .env. Repite el comando con -OverwriteEnv solo si quieres reemplazarlo.'
    }
    Copy-Item -LiteralPath $sourceEnv -Destination $targetEnv -Force

    $sourceData = Join-Path $temporaryRoot 'data'
    if (Test-Path -LiteralPath $sourceData -PathType Container) {
        Copy-Item -LiteralPath $sourceData -Destination (Join-Path $Destination 'data') -Recurse -Force
    }

    $sourceDump = Join-Path $temporaryRoot 'database\meristream-transfer.dump'
    $backupDirectory = Join-Path $Destination 'backups'
    New-Item -ItemType Directory -Force $backupDirectory | Out-Null
    $targetDump = Join-Path $backupDirectory 'meristream-transfer.dump'
    Copy-Item -LiteralPath $sourceDump -Destination $targetDump -Force
    Write-Output "Configuración y datos locales restaurados en: $Destination"

    if ($RestoreDatabase) {
        Push-Location $Destination
        try {
            & docker compose up -d meristream-db
            if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar PostgreSQL con Docker.' }
            $healthy = $false
            for ($attempt = 0; $attempt -lt 24; $attempt++) {
                $health = & docker inspect -f '{{.State.Health.Status}}' meristream-db 2>$null
                if ($health -eq 'healthy') { $healthy = $true; break }
                Start-Sleep -Seconds 5
            }
            if (-not $healthy) { throw 'PostgreSQL no llegó a estado healthy.' }

            & docker cp $targetDump 'meristream-db:/tmp/meristream-transfer.dump'
            if ($LASTEXITCODE -ne 0) { throw 'No se pudo copiar el dump al contenedor PostgreSQL.' }
            & docker exec meristream-db pg_restore --clean --if-exists --no-owner --username voidstream --dbname voidstream /tmp/meristream-transfer.dump
            if ($LASTEXITCODE -ne 0) { throw 'La restauración de PostgreSQL falló.' }

            if (-not $SkipDependencies) {
                & npm ci
                if ($LASTEXITCODE -ne 0) { throw 'npm ci falló.' }
            }
            & npx prisma generate
            if ($LASTEXITCODE -ne 0) { throw 'prisma generate falló.' }
            & npx prisma db push --skip-generate
            if ($LASTEXITCODE -ne 0) { throw 'prisma db push falló.' }
            Write-Output 'Base de datos restaurada y esquema actualizado.'
        } finally {
            Pop-Location
        }
    } else {
        Write-Output 'El dump quedó en backups\\meristream-transfer.dump. Usa -RestoreDatabase para importarlo en PostgreSQL.'
    }
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
