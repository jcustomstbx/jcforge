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

const LICENSE_SECRET: &[u8] = b"6809842c668be410b6870c7913d4ee46f9cac34c2859feef50d30e1160bd77e5";
const SIGNATURE_HEX_LEN: usize = 16;

type HmacSha256 = Hmac<Sha256>;

fn compute_signature(id: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(LICENSE_SECRET).expect("HMAC accepts any key length");
    mac.update(id.trim().to_lowercase().as_bytes());
    let digest = mac.finalize().into_bytes();
    hex::encode(digest)[..SIGNATURE_HEX_LEN].to_string()
}

const EXPIRY_MARKER: &str = "~exp=";

/// Keys look like `<id>-<signature>` (e.g. `buyer@example.com-a1b2c3d4e5f6a7b8`).
/// Split on the LAST '-' since an id (an email, say) may itself contain one.
///
/// A time-limited key just has `~exp=<unix seconds>` at the end of its id
/// (e.g. `milly~exp=1790000000-<sig>`). The signature covers the whole id
/// including that suffix, so the expiry can't be edited without invalidating
/// the key. Keys without the suffix never expire, exactly as before. Older
/// builds don't know about the suffix and treat such a key as permanent.
fn validate_at(key: &str, now_secs: u64) -> bool {
    let trimmed = key.trim();
    let Some(dash) = trimmed.rfind('-') else {
        return false;
    };
    let id = &trimmed[..dash];
    let sig = &trimmed[dash + 1..];
    if id.is_empty() || sig.is_empty() {
        return false;
    }
    if !compute_signature(id).eq_ignore_ascii_case(sig) {
        return false;
    }
    match id.rfind(EXPIRY_MARKER) {
        None => true,
        Some(pos) => match id[pos + EXPIRY_MARKER.len()..].parse::<u64>() {
            Ok(expires_at) => now_secs <= expires_at,
            Err(_) => false,
        },
    }
}

#[tauri::command]
pub fn validate_license_key(key: String) -> bool {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    validate_at(&key, now_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_for(id: &str) -> String {
        format!("{id}-{}", compute_signature(id))
    }

    #[test]
    fn permanent_key_never_expires() {
        assert!(validate_at(&key_for("buyer@example.com"), u64::MAX));
    }

    #[test]
    fn timed_key_valid_until_expiry_then_rejected() {
        let key = key_for("milly~exp=1000");
        assert!(validate_at(&key, 999));
        assert!(validate_at(&key, 1000));
        assert!(!validate_at(&key, 1001));
    }

    #[test]
    fn editing_the_expiry_breaks_the_signature() {
        let key = key_for("milly~exp=1000");
        let tampered = key.replace("exp=1000", "exp=9999999999");
        assert!(!validate_at(&tampered, 5000));
    }

    #[test]
    fn garbage_expiry_is_rejected() {
        assert!(!validate_at(&key_for("milly~exp=soon"), 0));
    }

    // Signature produced by scripts/generate-license-key.ps1 for this id -
    // keeps the script and this file from silently drifting apart.
    #[test]
    fn matches_powershell_generator() {
        assert!(validate_at(
            "scriptcheck~exp=4102444800-d25a6bbd1382441a",
            0
        ));
    }
}
