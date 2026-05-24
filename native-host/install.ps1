# XPort — Windows installer for the native messaging host (PowerShell).
# Usage:
#   .\install.ps1 -ExtensionId <chrome-extension-id>

param(
    [Parameter(Mandatory=$false, Position=0)]
    [string]$ExtensionId,

)

$ErrorActionPreference = "Stop"

$HostName = "com.xport.host"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostPy = Join-Path $ScriptDir "xport_host.py"
$BatPath = Join-Path $ScriptDir "xport_host.bat"
$ManifestPath = Join-Path $ScriptDir "$HostName.json"

if (-not $ExtensionId) {
    Write-Error "ExtensionId is required for Chrome installs (find it at chrome://extensions)."
    exit 1
}

$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

# Verify python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "python is required but not found in PATH"
    exit 1
}

# Write manifest (path must point to the .bat wrapper)
$manifestData = @{
    name = $HostName
    description = "XPort native messaging host -- bootstraps the local daemon token"
    path = $BatPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest = $manifestData | ConvertTo-Json -Depth 2

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8

# Create registry key pointing to manifest
if (-not (Test-Path (Split-Path $RegKey))) {
    New-Item -Path (Split-Path $RegKey) -Force | Out-Null
}
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath

Write-Host "Installed native messaging host:"
Write-Host "  Manifest: $ManifestPath"
Write-Host "  Registry: $RegKey"
Write-Host "  Host script: $HostPy"
Write-Host "  Extension ID: $ExtensionId"

# --- Install HTTP daemon via Scheduled Task ---
$DaemonPy = Join-Path $ScriptDir "xport_daemon.py"
$XtapDir = Join-Path $HOME ".xport"
$XtapSecret = Join-Path $XtapDir "secret"
$TaskName = "XPortDaemon"

# Create ~/.xport/ directory
if (-not (Test-Path $XtapDir)) {
    New-Item -ItemType Directory -Path $XtapDir -Force | Out-Null
}

# Generate auth token if not exists
if (-not (Test-Path $XtapSecret)) {
    $token = python -c "import secrets; print(secrets.token_urlsafe(32))"
    Set-Content -Path $XtapSecret -Value $token -Encoding ASCII
    Write-Host "Generated auth token: $XtapSecret"
} else {
    Write-Host "Auth token already exists: $XtapSecret"
}

# Find pythonw (preferred — no console window) or fall back to python
$PythonW = Get-Command pythonw -ErrorAction SilentlyContinue
if ($PythonW) {
    $PythonExe = $PythonW.Source
} else {
    $PythonExe = (Get-Command python).Source
}

function ConvertTo-PSLiteral([string]$Value) {
    return "'" + ($Value -replace "'", "''") + "'"
}

$XportLogLevel = if ($env:XPORT_LOG_LEVEL) { $env:XPORT_LOG_LEVEL } else { "info" }
$XportApiUrl = if ($env:XPORT_API_URL) { $env:XPORT_API_URL } else { "" }
$XportIngestToken = if ($env:XPORT_INGEST_TOKEN) { $env:XPORT_INGEST_TOKEN } else { "" }

# Remove existing scheduled task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create scheduled task: run at logon, restart on failure
$DaemonCommand = @(
    "`$env:XPORT_LOG_LEVEL=$(ConvertTo-PSLiteral $XportLogLevel)",
    "`$env:XPORT_API_URL=$(ConvertTo-PSLiteral $XportApiUrl)",
    "`$env:XPORT_INGEST_TOKEN=$(ConvertTo-PSLiteral $XportIngestToken)",
    "& $(ConvertTo-PSLiteral $PythonExe) $(ConvertTo-PSLiteral $DaemonPy)"
) -join "; "
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command $DaemonCommand"
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "XPort HTTP daemon" | Out-Null

# Start the task now
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "HTTP daemon installed:"
Write-Host "  Scheduled Task: $TaskName"
Write-Host "  Daemon: $DaemonPy"
Write-Host "  Python: $PythonExe"
Write-Host "  Listening on: 127.0.0.1:17381"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop-ScheduledTask -TaskName $TaskName"

Write-Host ""
$outputDir = if ($env:XPORT_OUTPUT_DIR) { $env:XPORT_OUTPUT_DIR } else { Join-Path $HOME "Downloads\xport" }
Write-Host "Media/debug directory (set XPORT_OUTPUT_DIR to change):"
Write-Host "  $outputDir"
if (-not $XportApiUrl -or -not $XportIngestToken) {
    Write-Host ""
    Write-Host "Warning: tweet capture requires XPORT_API_URL and XPORT_INGEST_TOKEN."
}
