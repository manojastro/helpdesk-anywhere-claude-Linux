<#
.SYNOPSIS
  Collect everything MT-06 needs, in one pass, from a Windows test machine.

.DESCRIPTION
  Phase 5 spans four processes across two Windows sessions, and every interesting
  failure is silent. The first MT-06 attempt produced a black technician canvas
  and no other evidence, which cost a whole test cycle. This script answers, in
  one run, which stage of the chain broke:

      service missing / service stopped / watcher in the wrong session /
      helper missing / desktop switch never detected / pipe disconnected /
      capture producing nothing

  Run it AS ADMINISTRATOR, ideally WHILE a UAC prompt is on screen (see -Watch),
  because the helper only exists while a non-default desktop is active.

  It reads only this project's own service, processes and logs. It changes
  nothing, and it prints no credentials: the applet, service, watcher and helper
  never write one to a log (CLAUDE.md constraint #6), and this script does not go
  looking for one either.

.PARAMETER Watch
  Sample once a second for N seconds instead of once. Use this, then trigger a
  UAC prompt: the helper lives only while the Secure Desktop is up, so a single
  snapshot taken afterwards will always say "helper missing".

.PARAMETER Clear
  Delete the collected diagnostic logs afterwards.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\mt06-diagnostics.ps1 -Watch 40
#>
[CmdletBinding()]
param(
    [int]$Watch = 0,
    [switch]$Clear
)

$ErrorActionPreference = 'Continue'
$ServiceName  = 'HelpdeskAnywhereSvc'
$StagingDir   = Join-Path $env:ProgramData 'HelpdeskAnywhere'
$ElevatedLogs = Join-Path $StagingDir 'logs'
$AppletLogs   = Join-Path $env:LOCALAPPDATA 'HelpdeskAnywhere\logs'

function Section($title) {
    Write-Host ''
    Write-Host ("=" * 72) -ForegroundColor DarkGray
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor DarkGray
}

function Verdict($ok, $text) {
    if ($ok -eq $true)      { Write-Host "  [ OK ]  $text" -ForegroundColor Green }
    elseif ($ok -eq $false) { Write-Host "  [FAIL]  $text" -ForegroundColor Red }
    else                    { Write-Host "  [ ?? ]  $text" -ForegroundColor Yellow }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run this in an ADMINISTRATOR PowerShell: service state and other' -ForegroundColor Yellow
    Write-Host 'sessions'' processes are not readable otherwise.' -ForegroundColor Yellow
    Write-Host ''
}

Section 'Interactive session'
$consoleSession = (Get-Process -Id $PID).SessionId
Write-Host "  this PowerShell is in session : $consoleSession"
try {
    $sessions = quser 2>$null
    if ($sessions) { $sessions | ForEach-Object { Write-Host "  $_" } }
} catch { }
Write-Host '  (the watcher and the helper must both be in the interactive session, never 0)'

Section 'Service'
$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if (-not $svc) {
    Verdict $false "$ServiceName is NOT INSTALLED — elevation never got as far as creating it"
} else {
    Write-Host "  state      : $($svc.State)"
    Write-Host "  start mode : $($svc.StartMode)   (must be Manual — nothing auto-starts, constraint #4)"
    Write-Host "  account    : $($svc.StartName)   (must be LocalSystem)"
    Write-Host "  pid        : $($svc.ProcessId)"
    Write-Host "  path       : $($svc.PathName)"
    Verdict ($svc.State -eq 'Running') "service state is $($svc.State)"
    Verdict ($svc.StartName -eq 'LocalSystem') "service account is $($svc.StartName)"
    Verdict ($svc.StartMode -eq 'Manual') "start mode is $($svc.StartMode)"
    if ($svc.ProcessId) {
        $s0 = (Get-Process -Id $svc.ProcessId -ErrorAction SilentlyContinue).SessionId
        Verdict ($s0 -eq 0) "service process is in session $s0 (expected 0)"
    }
}

function Show-Processes {
    $procs = Get-CimInstance Win32_Process -Filter "Name='HelpdeskAnywhere.exe' OR Name='Applet.exe'" -ErrorAction SilentlyContinue
    if (-not $procs) { Write-Host '  (no Helpdesk Anywhere processes running)'; return @() }

    $rows = foreach ($p in $procs) {
        $mode =
            if ($p.CommandLine -match '--desktop-helper') { 'helper' }
            elseif ($p.CommandLine -match '--desktop-watch') { 'watcher' }
            elseif ($p.CommandLine -match '--run-service') { 'service' }
            elseif ($p.CommandLine -match '--install-service') { 'installer' }
            else { 'applet' }

        $desktop = if ($p.CommandLine -match '--desktop\s+(\S+)') { $Matches[1] } else { '-' }
        $session = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).SessionId

        [pscustomobject]@{
            Mode = $mode; PID = $p.ProcessId; Session = $session; Desktop = $desktop
        }
    }

    $rows | Sort-Object Mode | Format-Table -AutoSize | Out-String | Write-Host
    return $rows
}

Section 'Processes'
$rows = Show-Processes

if ($Watch -gt 0) {
    Section "Watching for $Watch seconds — trigger a UAC prompt NOW"
    Write-Host '  (the helper exists only while a non-default desktop is active)'
    $seen = @{}
    for ($i = 0; $i -lt $Watch; $i++) {
        foreach ($r in (Get-CimInstance Win32_Process -Filter "Name='HelpdeskAnywhere.exe'" -ErrorAction SilentlyContinue)) {
            if ($r.CommandLine -match '--desktop-helper') {
                $d = if ($r.CommandLine -match '--desktop\s+(\S+)') { $Matches[1] } else { '?' }
                $sess = (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue).SessionId
                $key = "$($r.ProcessId)/$d"
                if (-not $seen.ContainsKey($key)) {
                    $seen[$key] = $true
                    Write-Host ("  t+{0,3}s  helper pid={1} session={2} desktop={3}" -f $i, $r.ProcessId, $sess, $d) -ForegroundColor Green
                }
            }
        }
        Start-Sleep -Seconds 1
    }
    if ($seen.Count -eq 0) {
        Verdict $false 'no DesktopHelper appeared at all during the watch window'
    } else {
        Verdict $true "helpers seen: $($seen.Keys -join ', ')"
    }
    $rows = Show-Processes
}

Section 'Staging directory'
if (Test-Path $StagingDir) {
    Get-ChildItem $StagingDir -Recurse -ErrorAction SilentlyContinue |
        Select-Object FullName, Length, LastWriteTime |
        Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "  $StagingDir does not exist (correct once the session has ended)"
}

Section 'Named pipes'
$pipes = [System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -match 'HelpdeskAnywhere' }
if ($pipes) { $pipes | ForEach-Object { Write-Host "  $_" } }
else { Write-Host '  (no HelpdeskAnywhere pipe — the applet is not listening)' }
Verdict ([bool]$pipes) 'applet pipe present'

Section 'Diagnostic logs'
$logFiles = @()
foreach ($dir in @($AppletLogs, $ElevatedLogs)) {
    if (Test-Path $dir) {
        $found = Get-ChildItem $dir -Filter 'hda-*.log' -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending
        if ($found) {
            Write-Host "  $dir"
            $found | Select-Object -First 6 | ForEach-Object {
                Write-Host ("    {0}  {1,8} bytes  {2}" -f $_.LastWriteTime.ToString('HH:mm:ss'), $_.Length, $_.Name)
            }
            $logFiles += $found
        }
    } else {
        Write-Host "  $dir  (absent)"
    }
}

if (-not $logFiles) {
    Verdict $false 'no diagnostic logs at all — is this the rebuilt .exe?'
} else {
    $newest = $logFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Section "Chain, from $($newest.Name)"
    $text = Get-Content $newest.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { $text = '' }

    $stages = [ordered]@{
        'elevation requested'                = 'applet.elevate.*elevation requested'
        'elevated installer exited'          = 'applet.bootstrap.*installer exited'
        'service main running'               = 'service.start.*service main running'
        'service supervisor started'         = 'service.watch.*supervisor started'
        'session watcher launched'           = 'service.launch.*session watcher started'
        'session watcher running in-session' = 'watcher.start.*session watcher running'
        'watcher connected to applet'        = 'watcher.pipe.*connected'
        'input desktop change detected'      = 'watcher.detect.*input desktop changed'
        'helper launched'                    = 'watcher.launch.*helper started'
        'helper bound to desktop'            = 'helper.desktop.*bound to desktop'
        'helper connected to applet'         = 'helper.pipe.*connected'
        'helper capture initialised'         = 'helper.capture.*GDI capture initialised'
        'helper produced frames'             = 'helper.capture.*frame report.*sent=[1-9]'
        'applet switched stream source'      = 'applet.source.*stream source changed'
    }

    $lastReached = $null
    foreach ($k in $stages.Keys) {
        $hit = $text -match $stages[$k]
        Verdict $hit $k
        if ($hit) { $lastReached = $k }
    }

    Write-Host ''
    Write-Host "  furthest stage reached: $lastReached" -ForegroundColor Cyan

    $problems = @(
        @{ pattern = 'SESSION MISMATCH';                    say = 'the watcher landed in the WRONG SESSION' },
        @{ pattern = 'OpenInputDesktop FAILED';             say = 'desktop detection failed — check which process logged it' },
        @{ pattern = 'CreateProcess FAILED';                say = 'the helper could not be launched' },
        @{ pattern = 'CreateProcessAsUser FAILED';          say = 'the watcher could not be launched into the session' },
        @{ pattern = 'SetThreadDesktop FAILED';             say = 'the helper could not bind to its desktop' },
        @{ pattern = 'OpenDesktop FAILED';                  say = 'the helper could not open its desktop' },
        @{ pattern = 'capture bounds are ZERO';             say = 'the helper captured a 0x0 desktop' },
        @{ pattern = 'elevation NOT usable';                say = 'elevation never became usable' }
    )
    $any = $false
    foreach ($p in $problems) {
        if ($text -match $p.pattern) {
            if (-not $any) { Write-Host ''; Write-Host '  Problems found:' -ForegroundColor Red; $any = $true }
            Write-Host "    - $($p.say)" -ForegroundColor Red
            ($text -split "`n" | Select-String $p.pattern | Select-Object -First 3) |
                ForEach-Object { Write-Host "        $_" -ForegroundColor DarkRed }
        }
    }

    Section 'Last 40 diagnostic lines'
    Get-Content $newest.FullName -Tail 40 | ForEach-Object { Write-Host "  $_" }

    Write-Host ''
    Write-Host "  Full log: $($newest.FullName)" -ForegroundColor Cyan
    Write-Host '  Attach that file to the MT-06 result.' -ForegroundColor Cyan
}

if ($Clear) {
    Section 'Clearing logs'
    foreach ($dir in @($AppletLogs, $ElevatedLogs)) {
        if (Test-Path $dir) {
            Remove-Item (Join-Path $dir 'hda-*.log') -Force -ErrorAction SilentlyContinue
            Write-Host "  cleared $dir"
        }
    }
}
