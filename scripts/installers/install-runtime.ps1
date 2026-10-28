param([Parameter(Mandatory=$true)][string]$Stage, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
# The installer holds the installation lock. Only program-owned entries move.
$manifest = Join-Path $Stage 'package-files.json'
$entries = @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json)
$oldManifest = Join-Path $Destination 'package-files.json'
$oldEntries = if (Test-Path -LiteralPath $oldManifest) {
    @(Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json)
} else { @() }
$owned = @($entries + $oldEntries | Sort-Object -Unique)
foreach ($name in $owned) {
    if ($name -ne [IO.Path]::GetFileName($name) -or $name -in @('', '.', '..')) {
        throw "Invalid program entry: $name"
    }
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$backup = Join-Path (Split-Path -Parent $Destination) ('.achbit-previous-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
$moved = [Collections.Generic.List[string]]::new()
$installed = [Collections.Generic.List[string]]::new()
try {
    foreach ($name in $owned) {
        $target = Join-Path $Destination $name
        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination (Join-Path $backup $name)
            $moved.Add($name)
        }
    }
    foreach ($name in $entries) {
        Move-Item -LiteralPath (Join-Path $Stage $name) -Destination (Join-Path $Destination $name)
        $installed.Add($name)
    }
} catch {
    $failure = $_
    foreach ($name in $installed) {
        Move-Item -LiteralPath (Join-Path $Destination $name) -Destination (Join-Path $Stage $name)
    }
    foreach ($name in $moved) {
        Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $Destination $name)
    }
    throw $failure
}
Remove-Item -LiteralPath $backup -Recurse
