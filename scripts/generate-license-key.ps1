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

.PARAMETER Days
  Optional. Makes a time-limited key that stops working this many days from
  now (the expiry is baked into the key and covered by its signature, so it
  can't be edited). Omit for a permanent key. Only builds from 2026-09-21
  onward enforce the expiry - an older installer treats the key as permanent.

.EXAMPLE
  .\generate-license-key.ps1 -Id "buyer@example.com"

.EXAMPLE
  .\generate-license-key.ps1 -Id "milly" -Days 7
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Id,

    [int]$Days = 0
)

# Must match LICENSE_SECRET in src-tauri/src/license.rs exactly.
$secret = "6809842c668be410b6870c7913d4ee46f9cac34c2859feef50d30e1160bd77e5"

$fullId = $Id.Trim()
$expiryNote = ""
if ($Days -gt 0) {
    $expiresAt = [DateTimeOffset]::UtcNow.AddDays($Days)
    $fullId = "$fullId~exp=$($expiresAt.ToUnixTimeSeconds())"
    $expiryNote = " (expires $($expiresAt.ToLocalTime().ToString('yyyy-MM-dd HH:mm')))"
}

$normalizedId = $fullId.ToLowerInvariant()
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($secret)
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedId))
$hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
$signature = $hex.Substring(0, 16)

$key = "$fullId-$signature"
Write-Host "License key for '$($Id.Trim())'${expiryNote}:"
Write-Host $key
