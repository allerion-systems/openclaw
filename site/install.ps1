# Allerion installer (Windows) — installs the Allerion build of OpenClaw from source.
# Usage: iwr -useb <site>/install.ps1 | iex
$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ALLERION_REPO) { $env:ALLERION_REPO } else { "https://github.com/allerion-systems/openclaw.git" }
$Branch  = if ($env:ALLERION_BRANCH) { $env:ALLERION_BRANCH } else { "main" }
$Home2   = if ($env:ALLERION_HOME) { $env:ALLERION_HOME } else { Join-Path $env:USERPROFILE ".allerion" }
$SrcDir  = Join-Path $Home2 "openclaw"
$BinDir  = if ($env:ALLERION_BIN) { $env:ALLERION_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }

function Say($msg) { Write-Host "[allerion] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "[allerion] $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required. Install from https://git-scm.com and re-run." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js 22.19+ is required. Install from https://nodejs.org and re-run." }
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) { Die "Node.js 22.19+ required (found $(node -v))." }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Say "enabling pnpm via corepack"
  corepack enable pnpm
}

if (Test-Path (Join-Path $SrcDir ".git")) {
  Say "updating existing checkout in $SrcDir"
  git -C $SrcDir fetch origin $Branch
  git -C $SrcDir checkout -B $Branch "origin/$Branch"
} else {
  Say "cloning $RepoUrl ($Branch) into $SrcDir"
  New-Item -ItemType Directory -Force -Path $Home2 | Out-Null
  git clone --depth 1 --branch $Branch $RepoUrl $SrcDir
}

Say "installing dependencies (this can take a few minutes)"
Push-Location $SrcDir
pnpm install --prod=false
Say "building"
pnpm build
Pop-Location

Say "linking CLI into $BinDir\openclaw.cmd"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Set-Content -Path (Join-Path $BinDir "openclaw.cmd") -Value "@echo off`r`nnode `"$SrcDir\openclaw.mjs`" %*"

if (($env:Path -split ";") -notcontains $BinDir) {
  Say "note: add $BinDir to your PATH to use 'openclaw' directly."
}

Say "done. Next: run 'openclaw onboard' to set up your assistant."
Say "Allerion is built on OpenClaw (MIT). License: $SrcDir\LICENSE"
