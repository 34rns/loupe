<#
.SYNOPSIS
  Bump the Loupe version, build the release zip and publish it with the GitHub CLI.

.DESCRIPTION
  1. writes the new version into manifest.json, the popup footer and the docs
  2. stages the files that actually ship and zips them as loupe.zip
  3. commits and pushes the bump
  4. runs `gh release create v<version>` with --latest

  The asset is ALWAYS named loupe.zip, so this link never changes:
  https://github.com/34rns/loupe/releases/latest/download/loupe.zip

.EXAMPLE
  .\release.ps1 0.1.1

.NOTES
  Requires: PowerShell 5.1+, git, and a logged-in GitHub CLI (`gh auth status`).
  The tag is created from the pushed commit, so the push happens before the release.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root  = $PSScriptRoot
$asset = 'loupe.zip'
$repo  = '34rns/loupe'
$noBom = New-Object System.Text.UTF8Encoding($false)

function Write-TextFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $noBom)
  Write-Host ("  bumped  " + (Split-Path $Path -Leaf)) -ForegroundColor DarkGray
}

# --- 0. preconditions -------------------------------------------------------
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ then run: gh auth login"
}
Write-Host "Checking GitHub CLI ..." -ForegroundColor Cyan
& gh auth status
if ($LASTEXITCODE -ne 0) { throw "gh is not logged in. Run: gh auth login" }

if (-not (Test-Path (Join-Path $root '.git'))) {
  throw "Not a git repository. Run 'git init' in $root first."
}

# --- 1. bump the version everywhere it appears ------------------------------
Write-Host "`nBumping to v$Version ..." -ForegroundColor Cyan

$manifestPath = Join-Path $root 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath)
$manifest = $manifest -replace '("version"\s*:\s*")[^"]+(")', ('${1}' + $Version + '${2}')
Write-TextFile $manifestPath $manifest

$popupPath = Join-Path $root 'popup\popup.html'
$popup = [System.IO.File]::ReadAllText($popupPath)
$popup = $popup -replace '(id="ver">)[^<]+(<)', ('${1}' + $Version + '${2}')
Write-TextFile $popupPath $popup

foreach ($doc in @('docs\INSTALL.md', 'docs\USE.md')) {
  $docPath = Join-Path $root $doc
  if (-not (Test-Path $docPath)) { continue }
  $text = [System.IO.File]::ReadAllText($docPath)
  # Keep the existing style: **v0.1.1** stays v-prefixed, **0.1.1** does not.
  $text = $text -replace '(\*\*)v\d+\.\d+\.\d+(\*\*)', ('${1}v' + $Version + '${2}')
  $text = $text -replace '(\*\*)\d+\.\d+\.\d+(\*\*)', ('${1}' + $Version + '${2}')
  Write-TextFile $docPath $text
}

# --- 2. stage and zip exactly what ships ------------------------------------
Write-Host "`nBuilding $asset ..." -ForegroundColor Cyan

$stage = Join-Path $root '.release-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($item in @('manifest.json', 'content', 'popup', 'shared', 'icons', 'docs', 'README.md', 'LICENSE')) {
  $source = Join-Path $root $item
  if (Test-Path $source) { Copy-Item $source (Join-Path $stage $item) -Recurse -Force }
}

# Dev-only material must never reach a release zip.
$releasing = Join-Path $stage 'docs\releasing.md'
if (Test-Path $releasing) { Remove-Item $releasing -Force }

$zipPath = Join-Path $root $asset
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -Force
Remove-Item $stage -Recurse -Force

$zipInfo = Get-Item $zipPath
Write-Host ("  {0}  {1:N1} KB" -f $asset, ($zipInfo.Length / 1KB)) -ForegroundColor Green

# --- 3. commit and push the bump -------------------------------------------
Write-Host "`nCommitting the version bump ..." -ForegroundColor Cyan
& git -C $root add -- manifest.json popup/popup.html docs/INSTALL.md docs/USE.md
& git -C $root diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & git -C $root commit -m "v$Version"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
  & git -C $root push
  if ($LASTEXITCODE -ne 0) { throw "git push failed." }
} else {
  Write-Host "  nothing new to commit (already bumped?)" -ForegroundColor Yellow
}

# --- 4. publish -------------------------------------------------------------
Write-Host "`nCreating release v$Version ..." -ForegroundColor Cyan
$notes = @"
## Loupe v$Version

Download **$asset**, extract it, then load the extracted folder with
**Load unpacked** on your browser's extensions page.

An unpacked extension cannot update itself, so to move to this version:
download the zip again, replace the old folder, and click the reload arrow
on the Loupe card.

The latest build always lives at
https://github.com/$repo/releases/latest/download/$asset
"@

& gh release create "v$Version" $zipPath --repo $repo --latest --title "v$Version" --notes $notes
if ($LASTEXITCODE -ne 0) { throw "gh release create failed." }

Write-Host "`nDone. v$Version published." -ForegroundColor Green
Write-Host "Stable download: https://github.com/$repo/releases/latest/download/$asset" -ForegroundColor Cyan
