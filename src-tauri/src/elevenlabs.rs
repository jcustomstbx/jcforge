// Fallback SFX/music generation for the AI editor: when nothing in the
// user's imported library fits a moment, Gemini can describe a sound in
// its own words and this generates it on demand instead of leaving the
// moment silent. Strictly opt-in - only reachable when the user has
// supplied their own ElevenLabs API key (bring-your-own-key/billing, same
// as Gemini), and only used as a fallback behind the library, never the
// first choice.
//
// Both endpoints return the generated audio as raw bytes (not JSON), per
// ElevenLabs' own API docs - confirmed before writing this, not assumed.
use serde_json::json;

const SOUND_GENERATION_URL: &str = "https://api.elevenlabs.io/v1/sound-generation";
const MUSIC_URL: &str = "https://api.elevenlabs.io/v1/music";

async fn write_audio_response(
    resp: reqwest::Response,
    output_path: &str,
    context: &str,
) -> Result<(), String> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{context} failed ({status}): {body}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("failed to read {context} response body: {e}"))?;
    tokio::fs::write(output_path, &bytes)
        .await
        .map_err(|e| format!("failed to write {context} output file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn generate_sfx_with_elevenlabs(
    api_key: String,
    prompt: String,
    output_path: String,
    duration_seconds: Option<f64>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut body = json!({ "text": prompt });
    if let Some(d) = duration_seconds {
        body["duration_seconds"] = json!(d.clamp(0.5, 30.0));
    }

    let resp = client
        .post(SOUND_GENERATION_URL)
        .header("xi-api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs sound-generation request failed: {e}"))?;

    write_audio_response(resp, &output_path, "ElevenLabs sound effect generation").await
}

#[tauri::command]
pub async fn generate_music_with_elevenlabs(
    api_key: String,
    prompt: String,
    output_path: String,
    music_length_ms: Option<u32>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut body = json!({ "prompt": prompt });
    if let Some(ms) = music_length_ms {
        body["music_length_ms"] = json!(ms.clamp(3000, 600_000));
    }

    let resp = client
        .post(MUSIC_URL)
        .header("xi-api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs music request failed: {e}"))?;

    write_audio_response(resp, &output_path, "ElevenLabs music generation").await
}
