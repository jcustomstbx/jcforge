<#
.SYNOPSIS
  Mints a JCForge license key for a buyer. Seller-only tool - do not ship
  this alongside the app; it doesn't need to be, since key generation only
  needs to happen on your machine, not the customer's.

.DESCRIPTION
  Keys are "<id>-<signature>" where signature = the first 16 hex chars of
  HMAC-SHA256(secret, id.trim().ToLower()). The app validates the same way
  in src-tauri/src/license.rs - LICENSE_SECRET there MUST match $secret here,
  byte for byte. If you ever rotate the secret, update both places together,
  and every previously-issued key stops working.

.PARAMETER Id
  Whatever you want to tie the key to - typically the buyer's email or an
  order/receipt number. Case-insensitive, whitespace-trimmed.

.EXAMPLE
  .\generate-license-key.ps1 -Id "buyer@example.com"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Id
)

# Must match LICENSE_SECRET in src-tauri/src/license.rs exactly.
$secret = "jcforge-dev-secret-change-before-release"

$normalizedId = $Id.Trim().ToLowerInvariant()
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($secret)
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedId))
$hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
$signature = $hex.Substring(0, 16)

$key = "$($Id.Trim())-$signature"
Write-Host "License key for '$($Id.Trim())':"
Write-Host $key
