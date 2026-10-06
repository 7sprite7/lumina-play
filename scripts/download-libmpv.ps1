# download-libmpv.ps1
# ──────────────────────────────────────────────────────────────────────────────
# Pre-build step: fetches the libmpv shared libs archive from the shinchiro/
# mpv-winbuild-cmake GitHub releases and drops the two files the plugin needs:
#
#   src-tauri/binaries/libmpv-2.dll          <- bundled, loaded at runtime
#   src-tauri/binaries/lib/libmpv.dll.a      <- import lib for rustc to link
#
# Idempotent: skips if both files already exist and -Force isn't passed.
#
# Sourceforge was tried first but kept returning HTML landing pages / "no" when
# scripted, so we go straight at the mirror that ships the identical build.
#
# Run from repo root:  pwsh scripts/download-libmpv.ps1

[CmdletBinding()]
param(
    # Overwrite existing files.
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$BinariesDir = Join-Path $RepoRoot 'src-tauri\binaries'
$LibDir      = Join-Path $BinariesDir 'lib'
$DllTarget   = Join-Path $BinariesDir 'libmpv-2.dll'
# `libmpv.dll.a` is the import library name used by the mpv-winbuild build.
# libmpv2 crate finds it via rustc's search path.
$LibTarget   = Join-Path $LibDir      'libmpv.dll.a'

if (-not $Force -and (Test-Path $DllTarget) -and (Test-Path $LibTarget)) {
    Write-Host "libmpv already present:" -ForegroundColor Green
    Write-Host "  $DllTarget"
    Write-Host "  $LibTarget"
    Write-Host "Pass -Force to re-download."
    exit 0
}

New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null
New-Item -ItemType Directory -Force -Path $LibDir      | Out-Null

Write-Host "Querying shinchiro/mpv-winbuild-cmake latest release..." -ForegroundColor Cyan

# GitHub Releases API — unauthenticated access has 60 req/hour per IP, more
# than enough for a one-time dev setup. We use `Invoke-RestMethod` so the
# response is already parsed JSON.
$releaseUrl = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'
$release = Invoke-RestMethod -Uri $releaseUrl -UseBasicParsing -Headers @{
    'User-Agent' = 'lumina-play-build-script'
}

$asset = $release.assets | Where-Object {
    $_.name -match '^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$'
} | Select-Object -First 1

if (-not $asset) {
    throw "No mpv-dev-x86_64 asset in release $($release.tag_name). Check: $($release.html_url)"
}

Write-Host "Release: $($release.tag_name) ($([math]::Round($asset.size/1MB, 1)) MB)" -ForegroundColor Green
Write-Host "Asset:   $($asset.name)" -ForegroundColor Green

# Fetch asset.
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lumina-libmpv-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
$ArchivePath = Join-Path $TempDir $asset.name

Write-Host "Downloading to $ArchivePath ..." -ForegroundColor Cyan
# Invoke-WebRequest handles HTTPS redirects from GitHub release URLs cleanly;
# the actual file is served from objects.githubusercontent.com.
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes it 10x slower on PS 5.1
Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $ArchivePath
$ProgressPreference = 'Continue'

$dlSize = (Get-Item $ArchivePath).Length
Write-Host "Downloaded $([math]::Round($dlSize/1MB, 1)) MB" -ForegroundColor Green

# Sanity check: 7z magic bytes are 37 7A BC AF 27 1C.
$magic = [System.IO.File]::ReadAllBytes($ArchivePath)[0..5]
if (-not ($magic[0] -eq 0x37 -and $magic[1] -eq 0x7A -and $magic[2] -eq 0xBC)) {
    throw "Downloaded file is not a .7z archive (first bytes: $([BitConverter]::ToString($magic))). GitHub release format may have changed."
}

# Extract: 7-Zip CLI preferred; WinRAR as fallback.
# UnRAR.exe is skipped — it ships with WinRAR but doesn't handle .7z (exit 10).
$extractor = $null
$extractorArgs = $null
$needsStartProcess = $false
foreach ($candidate in @(
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
)) {
    if (Test-Path $candidate) {
        $extractor = $candidate
        $extractorArgs = @('x', "-o$TempDir", $ArchivePath, '-y')
        break
    }
}
if (-not $extractor -and (Get-Command 7z -ErrorAction SilentlyContinue)) {
    $extractor = '7z'
    $extractorArgs = @('x', "-o$TempDir", $ArchivePath, '-y')
}
if (-not $extractor) {
    foreach ($candidate in @(
        "$env:ProgramFiles\WinRAR\WinRAR.exe",
        "${env:ProgramFiles(x86)}\WinRAR\WinRAR.exe"
    )) {
        if (Test-Path $candidate) {
            $extractor = $candidate
            # WinRAR.exe is a GUI app that forks a background worker when
            # invoked with `& ...` — our pipeline would see $LASTEXITCODE
            # before the worker finishes writing files. Start-Process -Wait
            # with a hidden window actually waits for the worker to exit.
            $extractorArgs = @('x', '-inul', '-o+', '-y', $ArchivePath, "$TempDir\")
            $needsStartProcess = $true
            break
        }
    }
}
if (-not $extractor) {
    throw @"
No 7z-capable archiver found. Install one of:
    winget install -e --id 7zip.7zip
    winget install -e --id RARLab.WinRAR
"@
}

Write-Host "Extracting with $extractor ..." -ForegroundColor Cyan
if ($needsStartProcess) {
    $proc = Start-Process -FilePath $extractor -ArgumentList $extractorArgs `
        -Wait -PassThru -WindowStyle Hidden
    $exit = $proc.ExitCode
} else {
    & $extractor @extractorArgs | Out-Null
    $exit = $LASTEXITCODE
}
if ($exit -ne 0) {
    throw "Extractor exited with code $exit. Archive: $ArchivePath"
}

# Collect the files we actually need.
$dllSource = Get-ChildItem -Path $TempDir -Recurse -Filter 'libmpv-2.dll' |
    Select-Object -First 1
$libSource = Get-ChildItem -Path $TempDir -Recurse -Filter 'libmpv.dll.a' |
    Select-Object -First 1

if (-not $dllSource) {
    throw "libmpv-2.dll not found in extracted archive. Contents: $(Get-ChildItem -Recurse $TempDir | Select-Object -First 20 -ExpandProperty Name)"
}
if (-not $libSource) {
    throw "libmpv.dll.a not found in extracted archive. Contents: $(Get-ChildItem -Recurse $TempDir | Select-Object -First 20 -ExpandProperty Name)"
}

Write-Host "Copying DLL         -> $DllTarget" -ForegroundColor Cyan
Copy-Item -Force -Path $dllSource.FullName -Destination $DllTarget

Write-Host "Copying import lib  -> $LibTarget" -ForegroundColor Cyan
Copy-Item -Force -Path $libSource.FullName -Destination $LibTarget

Remove-Item -Recurse -Force -Path $TempDir -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. libmpv ready at:" -ForegroundColor Green
Write-Host "  $DllTarget   ($([math]::Round((Get-Item $DllTarget).Length / 1MB, 1)) MB)"
Write-Host "  $LibTarget"
