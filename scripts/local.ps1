$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Candidates = [System.Collections.Generic.List[string]]::new()

if ($env:KV_SIM_NODE) { $Candidates.Add($env:KV_SIM_NODE) }
$OnPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($OnPath) { $Candidates.Add($OnPath.Source) }
foreach ($Directory in @($env:NODE_HOME, $env:NVM_SYMLINK)) {
    if ($Directory) { $Candidates.Add((Join-Path $Directory 'node.exe')) }
}
if ($env:ProgramFiles) { $Candidates.Add((Join-Path $env:ProgramFiles 'nodejs/node.exe')) }
if ($env:LOCALAPPDATA) { $Candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe')) }
foreach ($Manager in @('.workbuddy', '.codebuddy')) {
    $Versions = Join-Path $env:USERPROFILE "$Manager/binaries/node/versions"
    if (Test-Path -LiteralPath $Versions) {
        Get-ChildItem -LiteralPath $Versions -Directory |
            Where-Object { $_.Name -match '^22\.\d+\.\d+$' } |
            Sort-Object { [version]$_.Name } -Descending |
            ForEach-Object { $Candidates.Add((Join-Path $_.FullName 'node.exe')) }
    }
}

$Node = $null
foreach ($Candidate in ($Candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { continue }
    try {
        $VersionText = (& $Candidate --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch '^v(22\.\d+\.\d+)$') { continue }
        if ([version]$Matches[1] -lt [version]'22.22.2') { continue }
        $Node = (Resolve-Path -LiteralPath $Candidate).Path
        break
    } catch { continue }
}
if (-not $Node) {
    Write-Host 'Node.js 22.22.2 or later in the 22.x series is required.' -ForegroundColor Red
    Write-Host 'Install Node.js with npm, add it to PATH, or set KV_SIM_NODE to node.exe.'
    exit 1
}

$env:PATH = (Split-Path -Parent $Node) + [IO.Path]::PathSeparator + $env:PATH
Push-Location -LiteralPath $Root
try {
    Write-Host "Node: $Node"
    & $Node (Join-Path $PSScriptRoot 'local.mjs') @args
    $Code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $Code
