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
use tokio::io::AsyncReadExt;
use tokio::time::sleep;

const UPLOAD_START_URL: &str = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const INTERACTIONS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL: &str = "gemini-3.8-flash";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
// Confirmed live: a real stream VOD (longer, and now sampled at 2fps
// server-side instead of the old 1fps default) can genuinely take longer
// than 3 minutes for Gemini to finish processing before it's ACTIVE - this
// hit a real timeout, not a stuck/broken upload. ~10 minutes gives long
// VODs real room without waiting forever on a truly stuck one.
const MAX_POLL_ATTEMPTS: u32 = 200; // ~10 minutes
// A single network blip during polling (not a real processing failure)
// previously aborted the whole wait immediately - allow a few consecutive
// failed status checks before giving up, same spirit as the interactions
// call's own retry handling.
const MAX_CONSECUTIVE_POLL_ERRORS: u32 = 5;

// A full stream VOD can be hundreds of MB to multiple GB - sending it as one
// giant POST body previously hit Google's edge with a 408 (the client took
// too long delivering a single request). Chunking keeps each individual
// request short regardless of total file size. Must be a multiple of
// 256 KiB per the resumable upload protocol's alignment requirement.
const UPLOAD_CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8 MiB
const GEMINI_FREE_TIER_UPLOAD_LIMIT_BYTES: u64 = 2_147_483_648; // 2 GiB

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
    let mut file = tokio::fs::File::open(video_path)
        .await
        .map_err(|e| format!("failed to open video file: {e}"))?;
    let num_bytes = file
        .metadata()
        .await
        .map_err(|e| format!("failed to read video file metadata: {e}"))?
        .len();

    // Confirmed live: Gemini rejects uploads over exactly 2 GiB with a 413
    // ("Media is too large. Limit: 2147483648") on this key's tier - fail
    // immediately rather than spending minutes uploading gigabytes only to
    // hit that same wall right before the finalize step.
    if num_bytes > GEMINI_FREE_TIER_UPLOAD_LIMIT_BYTES {
        let mb = num_bytes / 1_000_000;
        return Err(format!(
            "This video is {mb} MB, over Gemini's 2 GB upload limit on the free tier. \
             Either trim it to a shorter segment before analyzing, or enable billing on \
             the Google Cloud project behind this API key (raises the limit to 20 GB)."
        ));
    }

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

    // Upload in fixed-size chunks rather than one request for the whole
    // file - each chunk (except the last, which also finalizes) gets its
    // own offset and a plain "upload" command so a slow overall transfer
    // never turns into one single long-lived request. Google's API rejects
    // any non-final chunk that isn't an exact multiple of the chunk size
    // (confirmed live: a single `read()` call returned only 2 MiB of an
    // 8 MiB buffer, well short of EOF - tokio's file reads aren't
    // guaranteed to fill the buffer in one call), so each chunk is
    // assembled by looping reads until the buffer is full or true EOF.
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; UPLOAD_CHUNK_SIZE];
    let upload_json: UploadResponse = loop {
        let mut filled = 0usize;
        while filled < UPLOAD_CHUNK_SIZE {
            let n = file.read(&mut buf[filled..]).await.map_err(|e| {
                format!("failed to read video chunk at offset {}: {e}", offset + filled as u64)
            })?;
            if n == 0 {
                break; // true EOF - only allowed on the final, possibly partial chunk
            }
            filled += n;
        }
        if filled == 0 && offset < num_bytes {
            return Err(format!(
                "unexpected end of file at offset {offset} of {num_bytes} bytes"
            ));
        }
        let is_last = offset + filled as u64 >= num_bytes;
        let command = if is_last { "upload, finalize" } else { "upload" };

        let chunk_resp = client
            .post(&upload_url)
            .header("Content-Length", filled.to_string())
            .header("X-Goog-Upload-Offset", offset.to_string())
            .header("X-Goog-Upload-Command", command)
            .body(buf[..filled].to_vec())
            .send()
            .await
            .map_err(|e| format!("upload chunk request failed at offset {offset}: {e}"))?;

        if !chunk_resp.status().is_success() {
            let status = chunk_resp.status();
            let body = chunk_resp.text().await.unwrap_or_default();
            return Err(format!("upload chunk failed at offset {offset} ({status}): {body}"));
        }

        offset += filled as u64;

        if is_last {
            break chunk_resp
                .json()
                .await
                .map_err(|e| format!("failed to parse upload response: {e}"))?;
        }
    };

    Ok(upload_json.file)
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
    let mut consecutive_errors = 0u32;
    for _ in 0..MAX_POLL_ATTEMPTS {
        sleep(POLL_INTERVAL).await;
        let resp = match client.get(&get_url).header("x-goog-api-key", api_key).send().await {
            Ok(resp) => resp,
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                    return Err(format!("file status poll failed repeatedly: {e}"));
                }
                continue;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            consecutive_errors += 1;
            if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                return Err(format!("file status poll failed ({status}): {body}"));
            }
            continue;
        }
        let current: UploadedFile = match resp.json().await {
            Ok(current) => current,
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                    return Err(format!("failed to parse file status response: {e}"));
                }
                continue;
            }
        };
        consecutive_errors = 0;
        match current.state.as_deref() {
            Some("ACTIVE") => return Ok(current),
            Some("FAILED") => return Err("Gemini failed to process the uploaded video".into()),
            _ => continue,
        }
    }
    Err("timed out waiting for Gemini to finish processing the video".into())
}

// 5xx from this endpoint (confirmed live: "gemini-3.8-flash is currently
// experiencing high demand... try again later") is Google's own capacity
// for THAT model, not a request problem - a different model tier is
// usually on separate capacity, so it's worth falling back to one rather
// than only ever retrying the same overloaded model. gemini-3.5-flash is
// the closest same-tier (cost/speed) alternative that also supports video.
const FALLBACK_GEMINI_MODEL: &str = "gemini-3.5-flash";

fn build_interactions_body(model: &str, video_uri: &str, mime_type: &str, prompt: &str) -> serde_json::Value {
    json!({
        "model": model,
        "input": [
            {
                "type": "video",
                "uri": video_uri,
                "mime_type": mime_type,
                // REVERTED: a "processing": {"type": "static", "fps": 2.0}
                // field was added here based on documentation research
                // (never a confirmed-live successful call with it present)
                // to address a real color-mislabeling bug at the default
                // 1fps sampling. A real request using this exact field
                // just came back "400 Request contains an invalid
                // argument" - the field itself was never actually
                // confirmed valid for this endpoint/model, so it's
                // removed rather than guessed at again. The color-mislabel
                // issue is still real; it's being addressed via the
                // prompt-side grounding instructions in aiEdit.ts instead
                // for now.
            },
            {
                "type": "text",
                "text": prompt,
            }
        ]
    })
}

// Retrying costs nothing extra beyond the wait (the video's already
// uploaded, this only redoes the analysis call itself). A 429 (confirmed
// live: "Quota exceeded... model: gemini-3.8-flash... retry in 46s") is
// tracked per-model, so waiting on THIS model is strictly worse than
// switching to the fallback model's separate quota bucket immediately -
// treated as an instant fall-through (no wasted delay), same as 5xx
// exhausting its retries. Any other 4xx (bad key, malformed request) is
// never going to succeed on retry OR a different model, so it still fails
// immediately. Returns Ok, a definitive Err (other 4xx), or None (5xx
// exhausted retries, or a 429 - caller falls back to another model).
async fn try_model_with_retries(
    client: &reqwest::Client,
    api_key: &str,
    body: &serde_json::Value,
    retry_delays: &[Duration],
    model_label: &str,
) -> Result<String, Option<String>> {
    let mut last_err = String::new();
    for (attempt, delay) in std::iter::once(None)
        .chain(retry_delays.iter().copied().map(Some))
        .enumerate()
    {
        if let Some(delay) = delay {
            sleep(delay).await;
        }

        // A transport-level failure (confirmed live: "error sending
        // request" with no HTTP status at all - a dropped connection or
        // DNS blip, not a response from Gemini) previously skipped both
        // retries AND the fallback model entirely, since it wasn't a
        // status code this loop knew how to classify. Treated the same as
        // a 5xx now: retry this model first, and if that's exhausted, let
        // the caller fall back to the other model rather than giving up
        // outright on what's very likely a transient local network issue.
        let resp = match client
            .post(INTERACTIONS_URL)
            .header("x-goog-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                last_err = format!("interactions request failed: {e}");
                eprintln!(
                    "[gemini] {model_label} attempt {} failed to send, retrying: {last_err}",
                    attempt + 1
                );
                continue;
            }
        };

        let status = resp.status();
        let text = match resp.text().await {
            Ok(text) => text,
            Err(e) => {
                last_err = format!("failed to read interactions response body: {e}");
                eprintln!(
                    "[gemini] {model_label} attempt {} failed to read response, retrying: {last_err}",
                    attempt + 1
                );
                continue;
            }
        };

        if status.is_success() {
            return Ok(text);
        }
        last_err = format!("Gemini request failed ({status}): {text}");
        if status.as_u16() == 429 {
            eprintln!("[gemini] {model_label} hit its quota (429), falling back immediately: {last_err}");
            return Err(None);
        }
        if !status.is_server_error() {
            return Err(Some(last_err));
        }
        eprintln!(
            "[gemini] {model_label} attempt {} hit a server error, retrying: {last_err}",
            attempt + 1
        );
    }

    eprintln!("[gemini] {model_label} exhausted all retries: {last_err}");
    Err(None)
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

    const RETRY_DELAYS: [Duration; 4] = [
        Duration::from_secs(5),
        Duration::from_secs(15),
        Duration::from_secs(30),
        Duration::from_secs(60),
    ];

    let primary_body = build_interactions_body(GEMINI_MODEL, &active.uri, &active.mime_type, &prompt);
    match try_model_with_retries(&client, &api_key, &primary_body, &RETRY_DELAYS, GEMINI_MODEL).await {
        Ok(text) => return Ok(text),
        Err(Some(err)) => return Err(err),
        Err(None) => {} // exhausted retries on 5xx - fall through to the fallback model
    }

    eprintln!("[gemini] falling back to {FALLBACK_GEMINI_MODEL} after {GEMINI_MODEL} stayed unavailable");
    let fallback_body =
        build_interactions_body(FALLBACK_GEMINI_MODEL, &active.uri, &active.mime_type, &prompt);
    // Shorter retry schedule than the primary, not none - confirmed live
    // that giving the fallback zero retries was a real gap: a 429 on the
    // primary falls through here almost instantly (no time spent waiting
    // at all), so the fallback can hit its own transient 500 with no
    // cushion whatsoever. A capped, shorter schedule still gives it a real
    // chance without doubling the worst-case total wait to ~4 minutes.
    const FALLBACK_RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(15)];
    match try_model_with_retries(
        &client,
        &api_key,
        &fallback_body,
        &FALLBACK_RETRY_DELAYS,
        FALLBACK_GEMINI_MODEL,
    )
    .await
    {
        Ok(text) => Ok(text),
        Err(Some(err)) => Err(err),
        Err(None) => Err(format!(
            "Both {GEMINI_MODEL} and the {FALLBACK_GEMINI_MODEL} fallback are currently \
             unavailable (Google-side capacity or quota limits, not this app) - please try \
             again in a few minutes, or check your plan's quota at ai.dev/rate-limit."
        )),
    }
}
