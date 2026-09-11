// Direct microphone capture via cpal, used when Streamlabs is the selected
// recording backend - unlike OBS, Streamlabs' external API exposes no way
// to read live input volume meters, so voice detection needs its own
// audio source in that case. Not used when OBS is selected (OBS's own
// InputVolumeMeters event covers it more simply, without opening a second
// handle on the mic device).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

const EMIT_INTERVAL_MS: u128 = 50;

#[tauri::command]
pub fn start_mic_capture(app: AppHandle) -> Result<(), String> {
    if CAPTURE_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    thread::spawn(move || {
        if let Err(e) = run_capture(app) {
            eprintln!("[mic] capture failed: {e}");
        }
        CAPTURE_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

#[tauri::command]
pub fn stop_mic_capture() {
    CAPTURE_RUNNING.store(false, Ordering::SeqCst);
}

fn run_capture(app: AppHandle) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| e.to_string())?;
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();

    let peak_accum = Arc::new(Mutex::new(0f32));
    let last_emit = Arc::new(Mutex::new(Instant::now()));

    let emit_if_due = {
        let peak_accum = peak_accum.clone();
        let last_emit = last_emit.clone();
        let app = app.clone();
        move || {
            let mut last = last_emit.lock().unwrap();
            if last.elapsed().as_millis() < EMIT_INTERVAL_MS {
                return;
            }
            *last = Instant::now();
            let mut acc = peak_accum.lock().unwrap();
            let level = *acc;
            *acc = 0.0;
            let _ = app.emit("mic-level", level);
        }
    };

    let err_fn = |err: cpal::Error| eprintln!("[mic] stream error: {err}");
    let stream_config: cpal::StreamConfig = config.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let peak_accum = peak_accum.clone();
            let emit_if_due = emit_if_due.clone();
            device.build_input_stream(
                stream_config,
                move |data: &[f32], _| {
                    accumulate_peak(&peak_accum, data.iter().map(|s| s.abs()), channels);
                    emit_if_due();
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let peak_accum = peak_accum.clone();
            let emit_if_due = emit_if_due.clone();
            device.build_input_stream(
                stream_config.clone(),
                move |data: &[i16], _| {
                    accumulate_peak(
                        &peak_accum,
                        data.iter().map(|s| (*s as f32 / i16::MAX as f32).abs()),
                        channels,
                    );
                    emit_if_due();
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;

    while CAPTURE_RUNNING.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }

    Ok(())
}

fn accumulate_peak(
    peak_accum: &Arc<Mutex<f32>>,
    samples: impl Iterator<Item = f32>,
    _channels: usize,
) {
    let mut local_peak = 0f32;
    for s in samples {
        if s > local_peak {
            local_peak = s;
        }
    }
    let mut acc = peak_accum.lock().unwrap();
    if local_peak > *acc {
        *acc = local_peak;
    }
}
