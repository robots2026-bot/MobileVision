param(
    [string]$SigningDirectory = (Join-Path $PSScriptRoot "..\android\.signing")
)

$ErrorActionPreference = "Stop"
$credentialsPath = Join-Path $SigningDirectory "release-signing.local.json"
$keystorePath = Join-Path $SigningDirectory "mobilevision-release.jks"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is not installed. Install it and run 'gh auth login' first."
}
if (-not (Test-Path -LiteralPath $credentialsPath) -or -not (Test-Path -LiteralPath $keystorePath)) {
    throw "Local Android signing files were not found in $SigningDirectory."
}

$credentials = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
$keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystorePath))

$keystoreBase64 | gh secret set ANDROID_KEYSTORE_BASE64
$credentials.storePassword | gh secret set ANDROID_KEYSTORE_PASSWORD
$credentials.keyAlias | gh secret set ANDROID_KEY_ALIAS
$credentials.keyPassword | gh secret set ANDROID_KEY_PASSWORD

Write-Host "Android release signing secrets are configured for the current GitHub repository."
