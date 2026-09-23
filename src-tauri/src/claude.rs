// A one-shot (non-agentic) alternative to gemini.rs's video-understanding
// path: Claude has no native video ingestion (confirmed - Anthropic's
// vision API only accepts images/PDFs), so this feeds it a handful of
// extracted frames plus a Whisper transcript instead of the raw video file,
// in a single Messages API call with no tool use. Deliberately NOT the
// agentic tool-use loop this app already tried and removed earlier after
// real crashes/cost - this is a single bounded request, same risk profile
// as the existing Gemini call, not a multi-turn loop.
use serde_json::Value;

const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[tauri::command]
pub async fn call_claude_messages(api_key: String, body: Value) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(MESSAGES_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read Claude response body: {e}"))?;

    if !status.is_success() {
        return Err(format!("Claude request failed ({status}): {text}"));
    }
    Ok(text)
}

/// Reads a local file (an extracted video frame) and returns it as base64
/// for a Claude vision image content block.
#[tauri::command]
pub fn read_frame_as_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
