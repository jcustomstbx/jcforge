// 24-hour trial gate, per the owner's decision: a one-off license purchase,
// with a 24-hour no-purchase trial window. Keys are locally verified (no
// server, no internet needed) via HMAC-SHA256 over a seller-chosen id
// (e.g. a buyer's email or order number), so Jack can mint keys himself
// with scripts/generate-license-key.ps1 without standing up a license
// server. This is a speed bump, not DRM - anyone who extracts LICENSE_SECRET
// from the shipped binary can mint their own keys. Rotate the secret (in
// both this file and generate-license-key.ps1) before a real release if
// this repo's source ever stops being private.
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

const LICENSE_SECRET: &[u8] = b"jcforge-dev-secret-change-before-release";
const SIGNATURE_HEX_LEN: usize = 16;

type HmacSha256 = Hmac<Sha256>;

fn compute_signature(id: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(LICENSE_SECRET).expect("HMAC accepts any key length");
    mac.update(id.trim().to_lowercase().as_bytes());
    let digest = mac.finalize().into_bytes();
    hex::encode(digest)[..SIGNATURE_HEX_LEN].to_string()
}

/// Keys look like `<id>-<signature>` (e.g. `buyer@example.com-a1b2c3d4e5f6a7b8`).
/// Split on the LAST '-' since an id (an email, say) may itself contain one.
#[tauri::command]
pub fn validate_license_key(key: String) -> bool {
    let trimmed = key.trim();
    let Some(dash) = trimmed.rfind('-') else {
        return false;
    };
    let id = &trimmed[..dash];
    let sig = &trimmed[dash + 1..];
    if id.is_empty() || sig.is_empty() {
        return false;
    }
    compute_signature(id).eq_ignore_ascii_case(sig)
}
