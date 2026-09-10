[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Password,

    [string]$DatabaseDumpPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups\meristream-pc-transfer-20260910.dump'),

    [string]$OutputPath,

    [switch]$ExcludeRuntimeData
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
    return $candidates[0]
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repositoryRoot '.env'
$runtimeDataPath = Join-Path $repositoryRoot 'data'
$transferDirectory = Join-Path $repositoryRoot 'transfer'
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw 'No se encontró .env. No se generó ningún paquete.'
}
if (-not (Test-Path -LiteralPath $DatabaseDumpPath -PathType Leaf)) {
    throw "No se encontró el dump de PostgreSQL: $DatabaseDumpPath"
}

if (-not $OutputPath) {
    $OutputPath = Join-Path $transferDirectory "Meristream-PC-Transfer-$stamp.7z"
}
$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)

New-Item -ItemType Directory -Force $transferDirectory | Out-Null
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "meristream-transfer-$stamp"
$payloadPath = Join-Path $temporaryRoot 'payload'

try {
    New-Item -ItemType Directory -Force $payloadPath | Out-Null
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $payloadPath '.env') -Force

    $databaseDirectory = Join-Path $payloadPath 'database'
    New-Item -ItemType Directory -Force $databaseDirectory | Out-Null
    Copy-Item -LiteralPath $DatabaseDumpPath -Destination (Join-Path $databaseDirectory 'meristream-transfer.dump') -Force

    $includedFiles = @('.env', 'database/meristream-transfer.dump')
    if (-not $ExcludeRuntimeData -and (Test-Path -LiteralPath $runtimeDataPath -PathType Container)) {
        $destinationDataPath = Join-Path $payloadPath 'data'
        New-Item -ItemType Directory -Force $destinationDataPath | Out-Null
        Get-ChildItem -LiteralPath $runtimeDataPath -Force | Where-Object { $_.Name -ne 'write-buffer.jsonl.tmp' } | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $destinationDataPath -Recurse -Force
        }
        $includedFiles += 'data/** (except the regenerated temporary write-buffer)'
    }

    $manifest = [ordered]@{
        format = 'meristream-pc-transfer-v2'
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        sourceDatabaseDump = (Split-Path -Leaf $DatabaseDumpPath)
        includes = $includedFiles
        encryption = '7z AES-256 with encrypted headers'
        splitSize = '90 MB'
    } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $payloadPath 'transfer-manifest.json'), $manifest, [System.Text.UTF8Encoding]::new($false))

    $sevenZip = Get-SevenZip
    Push-Location $payloadPath
    try {
        & $sevenZip a -t7z -mx=9 -mhe=on "-p$Password" -v90m $OutputPath '.env' 'database' 'data' 'transfer-manifest.json'
        if ($LASTEXITCODE -ne 0) { throw '7-Zip no pudo crear el paquete cifrado.' }
    } finally {
        Pop-Location
    }

    $parts = Get-ChildItem -LiteralPath $transferDirectory -Filter ((Split-Path -Leaf $OutputPath) + '.*')
    $totalMegabytes = [Math]::Round((($parts | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)
    Write-Output "Paquete cifrado creado: $($parts.Count) parte(s), $totalMegabytes MB en $transferDirectory"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
