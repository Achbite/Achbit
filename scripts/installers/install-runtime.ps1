param(
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$Destination,
    [string]$ErrorLog
)
$ErrorActionPreference = 'Stop'
try {
    # The installer holds the installation lock. Only program-owned entries move.
    $manifest = Join-Path $Stage 'package-files.json'
    # Windows PowerShell 5.1 emits a JSON array as one pipeline object. Assign it
    # directly before combining entries; @(... | ConvertFrom-Json) nests that array.
    $entries = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $oldManifest = Join-Path $Destination 'package-files.json'
    $oldEntries = if (Test-Path -LiteralPath $oldManifest) {
        Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json
    } else { @() }
    $owned = @(@($entries) + @($oldEntries) | Sort-Object -Unique)
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
        $recoveryErrors = [Collections.Generic.List[string]]::new()
        foreach ($name in $installed) {
            try {
                Move-Item -LiteralPath (Join-Path $Destination $name) -Destination (Join-Path $Stage $name)
            } catch { $recoveryErrors.Add($_.Exception.Message) }
        }
        foreach ($name in $moved) {
            try {
                Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $Destination $name)
            } catch { $recoveryErrors.Add($_.Exception.Message) }
        }
        if ($recoveryErrors.Count) {
            throw "Program replacement failed: $($failure.Exception.Message). Recovery files: $backup. Recovery errors: $($recoveryErrors -join '; ')"
        }
        throw $failure
    }
    Remove-Item -LiteralPath $backup -Recurse
} catch {
    $failure = $_
    if ($ErrorLog) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ErrorLog) | Out-Null
            $failure | Out-String | Set-Content -LiteralPath $ErrorLog -Encoding UTF8
        } catch { Write-Warning "Cannot write installer error log: $($_.Exception.Message)" }
    }
    throw $failure
}
