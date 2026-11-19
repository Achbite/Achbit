param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$programRoot = Split-Path -Parent $PSScriptRoot

function Test-WebView2 {
    $client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in @("HKCU:\Software\$client", "HKLM:\Software\WOW6432Node\$client")) {
        $version = Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue
        if ($version -and $version.pv -and $version.pv -ne '0.0.0.0') { return $true }
    }
    return $false
}

if (-not $Remove) {
    if (-not (Test-WebView2)) {
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ('Achbit-setup-' + [Guid]::NewGuid())
        [IO.Directory]::CreateDirectory($scratch) | Out-Null
        try {
            $bootstrap = Join-Path $scratch 'MicrosoftEdgeWebview2Setup.exe'
            Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrap
            $process = Start-Process -FilePath $bootstrap -ArgumentList '/silent', '/install' -Wait -PassThru
            if ($process.ExitCode -ne 0 -or -not (Test-WebView2)) {
                throw "WebView2 installation failed (exit $($process.ExitCode))."
            }
        } finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    # The Host owns platform directory creation, configuration validation and backups.
    & (Join-Path $programRoot 'achbit-kernel.exe') --prepare-user-config
    if ($LASTEXITCODE -ne 0) {
        throw "Achbit user configuration preparation failed (exit $LASTEXITCODE)."
    }
}

$environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $installation = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Achbit')
    try {
        & (Join-Path $PSScriptRoot 'windows-command-path.ps1') $environment $installation $programRoot -Remove:$Remove
    } finally { $installation.Dispose() }
} finally { $environment.Dispose() }
