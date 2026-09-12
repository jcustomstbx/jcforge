// Embedded AI editing: send a source video (plus its transcript and the
// user's own style notes) to Google's Gemini API and get back structured
// edit suggestions - clip ranges, captions, effect points - that the
// existing editor/render pipeline can then apply. Chosen over Claude
// specifically because Gemini ingests raw video directly (no frame
// extraction needed) and is the cheaper option, per the owner's call.
//
// The exact response envelope shape from Gemini's newer Interactions API
// is not fully nailed down from documentation alone (this is a live
// external API, not something verifiable ahead of time the way ffmpeg
// filters are) - this command deliberately returns the raw response body
// as-is rather than guessing at how to unwrap it, so the TypeScript side
// can adapt to whatever the real shape turns out to be without needing a
// Rust rebuild for every adjustment.
use serde_json::json;
use std::time::Duration;
use tokio::time::sleep;

const UPLOAD_START_URL: &str = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const INTERACTIONS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL: &str = "gemini-3.8-flash";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_POLL_ATTEMPTS: u32 = 60; // ~3 minutes

#[derive(serde::Deserialize, Debug)]
struct UploadedFile {
    name: String,
    uri: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(default)]
    state: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
struct UploadResponse {
    file: UploadedFile,
}

async fn upload_video(
    client: &reqwest::Client,
    api_key: &str,
    video_path: &str,
) -> Result<UploadedFile, String> {
    let bytes = tokio::fs::read(video_path)
        .await
        .map_err(|e| format!("failed to read video file: {e}"))?;
    let num_bytes = bytes.len();

    let start_resp = client
        .post(UPLOAD_START_URL)
        .header("x-goog-api-key", api_key)
        .header("X-Goog-Upload-Protocol", "resumable")
        .header("X-Goog-Upload-Command", "start")
        .header("X-Goog-Upload-Header-Content-Length", num_bytes.to_string())
        .header("X-Goog-Upload-Header-Content-Type", "video/mp4")
        .json(&json!({ "file": { "display_name": "jcforge-ai-edit" } }))
        .send()
        .await
        .map_err(|e| format!("upload start request failed: {e}"))?;

    if !start_resp.status().is_success() {
        let status = start_resp.status();
        let body = start_resp.text().await.unwrap_or_default();
        return Err(format!("upload start failed ({status}): {body}"));
    }

    let upload_url = start_resp
        .headers()
        .get("x-goog-upload-url")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "upload start response had no x-goog-upload-url header".to_string())?
        .to_string();

    let upload_resp = client
        .post(&upload_url)
        .header("Content-Length", num_bytes.to_string())
        .header("X-Goog-Upload-Offset", "0")
        .header("X-Goog-Upload-Command", "upload, finalize")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("upload body request failed: {e}"))?;

    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        return Err(format!("upload finalize failed ({status}): {body}"));
    }

    let parsed: UploadResponse = upload_resp
        .json()
        .await
        .map_err(|e| format!("failed to parse upload response: {e}"))?;
    Ok(parsed.file)
}

async fn wait_until_active(
    client: &reqwest::Client,
    api_key: &str,
    file: UploadedFile,
) -> Result<UploadedFile, String> {
    if file.state.as_deref() == Some("ACTIVE") {
        return Ok(file);
    }
    let get_url = format!("https://generativelanguage.googleapis.com/v1beta/{}", file.name);
    for _ in 0..MAX_POLL_ATTEMPTS {
        sleep(POLL_INTERVAL).await;
        let resp = client
            .get(&get_url)
            .header("x-goog-api-key", api_key)
            .send()
            .await
            .map_err(|e| format!("file status poll failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("file status poll failed ({status}): {body}"));
        }
        let current: UploadedFile = resp
            .json()
            .await
            .map_err(|e| format!("failed to parse file status response: {e}"))?;
        match current.state.as_deref() {
            Some("ACTIVE") => return Ok(current),
            Some("FAILED") => return Err("Gemini failed to process the uploaded video".into()),
            _ => continue,
        }
    }
    Err("timed out waiting for Gemini to finish processing the video".into())
}

#[tauri::command]
pub async fn analyze_video_with_gemini(
    video_path: String,
    api_key: String,
    prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let uploaded = upload_video(&client, &api_key, &video_path).await?;
    let active = wait_until_active(&client, &api_key, uploaded).await?;

    let body = json!({
        "model": GEMINI_MODEL,
        "input": [
            {
                "type": "video",
                "uri": active.uri,
                "mime_type": active.mime_type,
            },
            {
                "type": "text",
                "text": prompt,
            }
        ]
    });

    let resp = client
        .post(INTERACTIONS_URL)
        .header("x-goog-api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("interactions request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read interactions response body: {e}"))?;

    if !status.is_success() {
        return Err(format!("Gemini request failed ({status}): {text}"));
    }

    Ok(text)
}
