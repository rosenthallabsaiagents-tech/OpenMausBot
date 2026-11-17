$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ($env:PATH -notlike "*$env:USERPROFILE*") {
    $env:PATH = "$env:USERPROFILE;$env:PATH"
}

$nodeExe = Join-Path $env:USERPROFILE 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { throw 'node.exe was not found.' }
    $nodeExe = $nodeCmd.Source
}

$pnpmCmd = Join-Path $env:USERPROFILE 'pnpm.cmd'
if (-not (Test-Path -LiteralPath $pnpmCmd)) {
    $pnpmFound = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $pnpmFound) { throw 'pnpm.cmd was not found.' }
    $pnpmCmd = $pnpmFound.Source
}

$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) {
    throw "Electron binary not found at $electronExe. Run pnpm install first."
}

$logDir = Join-Path $env:APPDATA 'openmausbot\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverLog = Join-Path $logDir 'dev-server.log'
$serverErrLog = Join-Path $logDir 'dev-server.err.log'
$viteLog = Join-Path $logDir 'dev-vite.log'
$viteErrLog = Join-Path $logDir 'dev-vite.err.log'
$launcherLog = Join-Path $logDir 'launcher.log'

function Write-LauncherLog {
    param([string]$Message)
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    Add-Content -LiteralPath $launcherLog -Value "[$ts] $Message" -ErrorAction SilentlyContinue
}

function Test-PortListening {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(250, $false)) {
            $client.EndConnect($iar)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-PortListening {
    param(
        [int]$Port,
        [System.Diagnostics.Process]$Process,
        [string]$Name,
        [int]$TimeoutSeconds = 120
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            throw "$Name exited early with code $($Process.ExitCode). Check logs in $logDir."
        }
        if (Test-PortListening -Port $Port) {
            return
        }
        Start-Sleep -Milliseconds 300
    }
    throw "Timed out waiting for $Name on 127.0.0.1:$Port. Check logs in $logDir."
}

function Stop-ProcessTree {
    param([System.Diagnostics.Process]$Process)
    if ($Process -and -not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F *> $null
    }
}

$startedServer = $null
$startedVite = $null

try {
    $serverPort = if ($env:OMB_PORT) { [int]$env:OMB_PORT } else { 8799 }
    $uiPort = if ($env:OMB_UI_PORT) { [int]$env:OMB_UI_PORT } else { 5199 }
    Write-LauncherLog "Starting launcher (serverPort=$serverPort uiPort=$uiPort)"

    if (-not (Test-PortListening -Port $serverPort)) {
        Write-LauncherLog "Starting dev-server.ts"
        $startedServer = Start-Process -FilePath $nodeExe `
            -ArgumentList @('--experimental-strip-types', 'server/dev-server.ts') `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $serverLog `
            -RedirectStandardError $serverErrLog `
            -PassThru
    }

    if (-not (Test-PortListening -Port $uiPort)) {
        Write-LauncherLog "Starting vite preview"
        $viteBin = Join-Path $repoRoot 'node_modules\vite\bin\vite.js'
        $distHtml = Join-Path $repoRoot 'dist\index.html'
        if (-not (Test-Path -LiteralPath $distHtml)) {
            & $nodeExe $viteBin 'build' | Out-Null
        }
        $startedVite = Start-Process -FilePath $nodeExe `
            -ArgumentList @($viteBin, 'preview', '--host', '127.0.0.1', '--port', "$uiPort", '--strictPort') `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $viteLog `
            -RedirectStandardError $viteErrLog `
            -PassThru
    }

    if ($startedServer) {
        Wait-PortListening -Port $serverPort -Process $startedServer -Name 'OpenMausBot dev server'
        Write-LauncherLog "dev-server ready"
    }
    if ($startedVite) {
        Wait-PortListening -Port $uiPort -Process $startedVite -Name 'Vite UI server'
        Write-LauncherLog "vite preview ready"
    }

    $cfWin = Join-Path $repoRoot 'dist-native\cloudflared\win32-x64\cloudflared.exe'
    if (-not (Test-Path -LiteralPath $cfWin)) {
        & $nodeExe 'scripts/prepare-cloudflared.mjs' '--current' | Out-Null
    }

    Write-LauncherLog "Launching electron.exe"
    $electronProc = Start-Process -FilePath $electronExe `
        -ArgumentList @('.') `
        -WorkingDirectory $repoRoot `
        -PassThru
    $electronProc.WaitForExit()
    Write-LauncherLog "electron.exe exited with code $($electronProc.ExitCode)"
} catch {
    Write-LauncherLog "ERROR: $($_.Exception.Message)"
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        'OpenMausBot Launcher Error',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
} finally {
    Stop-ProcessTree -Process $startedVite
    Stop-ProcessTree -Process $startedServer
}
