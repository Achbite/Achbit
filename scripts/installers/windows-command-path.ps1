param(
    [Parameter(Mandatory=$true)][Microsoft.Win32.RegistryKey]$EnvironmentKey,
    [Parameter(Mandatory=$true)][Microsoft.Win32.RegistryKey]$InstallKey,
    [Parameter(Mandatory=$true)][string]$ProgramRoot,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$commands = Join-Path $ProgramRoot 'libexec\commands'
$registeredRoot = $InstallKey.GetValue('InstallDir', '')
if ($Remove -and $registeredRoot -ine $ProgramRoot) { return }

# Older installers always appended their registered installation directory.
# An empty CommandPath records that a newer installation found an existing user entry.
$owned = $InstallKey.GetValue('CommandPath', $null)
$legacy = $null -eq $owned
if ($legacy) { $owned = $registeredRoot }
$raw = $EnvironmentKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$entries = [Collections.Generic.List[string]]::new()
if ($raw) { $entries.AddRange([string[]]($raw -split ';')) }

if ($owned -and ($Remove -or $owned -ine $commands)) {
    # Only one entry belongs to setup. Legacy setup appended its entry last.
    $matchOwned = { param($entry) $entry.TrimEnd('\') -ieq $owned.TrimEnd('\') }
    $index = if ($legacy) { $entries.FindLastIndex($matchOwned) } else { $entries.FindIndex($matchOwned) }
    if ($index -ge 0) { $entries.RemoveAt($index) }
    $owned = ''
}

if (-not $Remove) {
    # Expand variables only for comparison. Other entries keep their exact registry representation.
    $commandIndex = $entries.FindIndex({ param($entry) [Environment]::ExpandEnvironmentVariables($entry.Trim('"')).TrimEnd('\') -ieq $commands })
    $rootIndex = $entries.FindIndex({ param($entry) [Environment]::ExpandEnvironmentVariables($entry.Trim('"')).TrimEnd('\') -ieq $ProgramRoot })
    # A manually added program root still needs our launcher ahead of its Achbit.exe.
    if ($commandIndex -lt 0 -or ($rootIndex -ge 0 -and $rootIndex -lt $commandIndex)) {
        if ($rootIndex -lt 0) { $rootIndex = $entries.Count }
        $entries.Insert($rootIndex, $commands)
        $owned = $commands
    }
}

$updated = $entries -join ';'
if ($updated -cne [string]$raw) {
    $kind = if ($null -eq $raw) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $EnvironmentKey.GetValueKind('Path') }
    $EnvironmentKey.SetValue('Path', $updated, $kind)
}
$InstallKey.SetValue('CommandPath', [string]$owned)
