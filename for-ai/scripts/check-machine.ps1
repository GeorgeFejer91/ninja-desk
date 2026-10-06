[CmdletBinding()]
param(
    [ValidateSet('Host', 'Controller')][string]$Role = 'Controller',
    [string]$ProjectRoot = (Join-Path $PSScriptRoot '../..'),
    [string]$GitHubRoot = (Join-Path $env:USERPROFILE 'Documents/GitHub'),
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedSourceSha,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedGuiHash,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedCliHash,
    [switch]$RequireConnection
)

$ErrorActionPreference = 'Stop'
$violations = [Collections.Generic.List[string]]::new()
$receipt = [ordered]@{
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    machine = $env:COMPUTERNAME
    role = $Role
    source = $null
    installed = $null
    startup = $null
    runtime = $null
    connectionReady = $false
    passed = $false
    violations = @()
}

function Read-Git([string[]]$GitArguments) {
    $result = @(& git -C $root @GitArguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Git inspection failed.' }
    return $result
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This receipt requires Windows.' }
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\', '/')
    $central = [IO.Path]::GetFullPath((Join-Path $GitHubRoot 'ninja-desk')).TrimEnd('\', '/')
    if (-not $root.Equals($central, [StringComparison]::OrdinalIgnoreCase)) {
        $violations.Add('Checkout is outside the selected central GitHub folder.')
    }
    $origin = (Read-Git @('remote', 'get-url', 'origin')) -join ''
    if ($origin -notmatch '^(https://github\.com/GeorgeFejer91/ninja-desk(?:\.git)?|git@github\.com:GeorgeFejer91/ninja-desk(?:\.git)?)$') {
        throw 'Origin is not the canonical Ninja Desk repository.'
    }
    $branch = (Read-Git @('branch', '--show-current')) -join ''
    if (-not $branch) { throw 'Choose the agreed branch; detached HEAD is not a shared checkout.' }
    $head = (Read-Git @('rev-parse', 'HEAD')) -join ''
    $remote = (Read-Git @('ls-remote', 'origin', "refs/heads/$branch")) -join ''
    $remoteSha = if ($remote) { ($remote -split '\s+')[0] } else { $null }
    $dirtyCount = @(Read-Git @('status', '--porcelain')).Count
    $receipt.source = [ordered]@{
        root = $root; centralFolder = $central; origin = $origin
        branch = $branch; head = $head; remoteHead = $remoteSha
        dirtyPaths = $dirtyCount; synchronized = ($head -eq $remoteSha)
    }
    if ($dirtyCount -gt 0) { $violations.Add('Working tree contains uncommitted work; preserve it before synchronization.') }
    if ($head -ne $remoteSha) { $violations.Add('Local HEAD does not match the published branch.') }
    if ($ExpectedSourceSha -and $head -ne $ExpectedSourceSha) { $violations.Add('Source SHA differs from the coordinating PC.') }

    $installRoot = Join-Path $env:LOCALAPPDATA 'Ninja Desk'
    $gui = Join-Path $installRoot 'ninja-desk.exe'
    $cli = Join-Path $installRoot 'ninja-desk-cli.exe'
    if (-not (Test-Path -LiteralPath $gui -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw 'Installed Ninja Desk GUI or CLI is missing.'
    }
    $guiHash = (Get-FileHash -LiteralPath $gui -Algorithm SHA256).Hash
    $cliHash = (Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='ninja-desk.exe'" |
        Where-Object { $_.ExecutablePath -eq $gui })
    $receipt.installed = [ordered]@{
        guiPath = $gui; cliPath = $cli; guiSha256 = $guiHash; cliSha256 = $cliHash
        processCount = $processes.Count; version = $null
    }
    if ($processes.Count -ne 1) { $violations.Add('Expected exactly one process from the installed path.') }
    if ($ExpectedGuiHash -and $guiHash -ne $ExpectedGuiHash) { $violations.Add('GUI bytes differ from the selected installer.') }
    if ($ExpectedCliHash -and $cliHash -ne $ExpectedCliHash) { $violations.Add('CLI bytes differ from the selected installer.') }

    $run = Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run' -ErrorAction SilentlyContinue
    $approval = Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/Run' -ErrorAction SilentlyContinue
    $entry = $run.'Ninja Desk'
    $approvalBytes = $approval.'Ninja Desk'
    $registered = ($entry -eq ('"' + $gui + '"'))
    $approved = ($null -eq $approvalBytes -or ($approvalBytes.Length -ge 4 -and $approvalBytes[0] -eq 2))
    $targetPath = Join-Path $env:APPDATA 'dev.local.vdoninjaremote/startup-controller-v1'
    $selected = $false
    if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
        $selected = ((Get-Item -LiteralPath $targetPath).Length -eq 32 -and
            (Get-Content -LiteralPath $targetPath -Raw) -match '^[0-9a-fA-F]{32}$')
    }
    $receipt.startup = [ordered]@{
        quietSignInRegistered = $registered
        approvedByWindows = $approved
        controllerTargetSelected = $selected
        crashSupervisor = 'not-inspected'
    }
    if (-not $registered -or -not $approved) { $violations.Add('Quiet Windows sign-in startup is missing or disabled.') }

    # The app CLI deliberately returns redacted status; never read its DPAPI endpoint here.
    $doctorText = @(& $cli doctor --json 2>$null) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Installed CLI cannot obtain a fresh native diagnostic.' }
    $doctor = ConvertFrom-Json $doctorText
    if (-not $doctor.ok) { throw 'Native diagnostic rejected the request.' }
    $data = $doctor.data
    $receipt.installed.version = $data.version
    $receipt.runtime = [ordered]@{
        native = $data.doctor
        hostTrustedPc = $data.host.trustedPc
        host = $data.host.runtime
        controllerSavedComputers = $data.controller.savedComputers
        controller = $data.controller.runtime
    }
    $runtime = if ($Role -eq 'Host') { $data.host.runtime } else { $data.controller.runtime }
    if ($Role -eq 'Host' -and -not $data.host.trustedPc) { $violations.Add('Host has no remembered controller.') }
    if ($Role -eq 'Controller' -and $data.controller.savedComputers -lt 1) { $violations.Add('Controller has no saved computer.') }
    if (-not $runtime -or $runtime.reportAgeMs -gt 5000) { $violations.Add('Renderer runtime report is missing or stale.') }
    $status = $runtime.status
    $receipt.connectionReady = [bool]($runtime -and $runtime.reportAgeMs -le 5000 -and
        $status.authenticated -and $status.mediaActive -and $status.frames -gt 0 -and
        $null -ne $status.lastFrameAgeMs -and $status.lastFrameAgeMs -le 5000)
    if ($RequireConnection -and -not $receipt.connectionReady) { $violations.Add('Fresh authenticated desktop media is unavailable.') }
} catch {
    # Fixed inspection errors only; avoid emitting native command output or credentials.
    $violations.Add(('Inspection failed: ' + $_.Exception.Message))
}

$receipt.violations = @($violations.ToArray())
$receipt.passed = ($violations.Count -eq 0)
$receipt | ConvertTo-Json -Depth 8
if (-not $receipt.passed) { exit 1 }
