use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod mic_capture;
use mic_capture::{start_mic_capture, stop_mic_capture};

mod license;
use license::validate_license_key;

mod gemini;
use gemini::analyze_video_with_gemini;

mod elevenlabs;
use elevenlabs::{generate_music_with_elevenlabs, generate_sfx_with_elevenlabs};

mod claude;
use claude::{call_claude_messages, read_frame_as_base64};

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// One IPC round trip for a whole library instead of one per clip - the
// library reconciles against disk on every refresh (add/remove/resolve a
// clip), so this scales with library size otherwise.
#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).exists())
        .collect()
}

#[derive(serde::Serialize)]
struct DiskSpace {
    free_bytes: u64,
    total_bytes: u64,
}

// Raw kernel32 FFI rather than pulling in a crate (sysinfo, fs2, ...) just
// for one call - GetDiskFreeSpaceExW is always available on Windows, no
// new dependency needed. Resolves whatever drive `path` lives on, not
// necessarily the OS drive.
#[cfg(windows)]
#[tauri::command]
fn get_disk_space(path: String) -> Result<DiskSpace, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    if !std::path::Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let wide: Vec<u16> = OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();
    let mut free_bytes_available: u64 = 0;
    let mut total_bytes: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_bytes_available, &mut total_bytes, std::ptr::null_mut())
    };
    if ok == 0 {
        return Err(format!(
            "GetDiskFreeSpaceExW failed for {path}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(DiskSpace { free_bytes: free_bytes_available, total_bytes })
}

#[cfg(not(windows))]
#[tauri::command]
fn get_disk_space(_path: String) -> Result<DiskSpace, String> {
    Err("disk space lookup is only implemented on Windows".into())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

// Used to import SFX files into the app's own storage - creates the
// destination folder on first use rather than requiring the caller to set
// it up first.
#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    Ok(())
}

const VIDEO_EXTENSIONS: [&str; 6] = ["mp4", "mkv", "flv", "mov", "avi", "webm"];

// Streamlabs' remote-control API has no way to ask where a replay was just
// saved (confirmed: IStreamingState has no path field) - so after calling
// saveReplay() we watch its configured output folder for the newest video
// file that appeared after the call, the same workaround third-party tools
// use for this exact gap.
#[tauri::command]
fn find_newest_file_since(dir: String, after_epoch_ms: u64) -> Result<Option<String>, String> {
    let after = std::time::UNIX_EPOCH + std::time::Duration::from_millis(after_epoch_ms);
    let mut newest: Option<(std::time::SystemTime, String)> = None;

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_video = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < after {
            continue;
        }
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, path.to_string_lossy().to_string()));
        }
    }

    Ok(newest.map(|(_, path)| path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create clips table",
            // NOTE: this exact string (including whitespace) is hashed by
            // tauri-plugin-sql to verify an already-applied migration
            // wasn't changed - do not reformat/re-indent it.
            sql: "CREATE TABLE clips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            file_size_bytes INTEGER,
            duration_seconds REAL,
            trigger_reason TEXT NOT NULL,
            reviewed INTEGER NOT NULL DEFAULT 0
        );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create settings table",
            sql: "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add kept column to clips",
            sql: "ALTER TABLE clips ADD COLUMN kept INTEGER;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create sessions and signal_samples tables for backtesting",
            sql: "CREATE TABLE sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                ended_at TEXT
            );
            CREATE TABLE signal_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                t_ms INTEGER NOT NULL,
                voice REAL NOT NULL,
                chat REAL NOT NULL,
                motion REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );
            CREATE INDEX idx_signal_samples_session ON signal_samples(session_id);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create sfx_library table",
            sql: "CREATE TABLE sfx_library (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                display_name TEXT NOT NULL,
                tags TEXT NOT NULL,
                added_at TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create music_library table",
            sql: "CREATE TABLE music_library (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                display_name TEXT NOT NULL,
                tags TEXT NOT NULL,
                added_at TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "create vfx_library table",
            sql: "CREATE TABLE vfx_library (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                display_name TEXT NOT NULL,
                tags TEXT NOT NULL,
                blend_mode TEXT NOT NULL,
                added_at TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:jcforge.db", migrations)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut == &Shortcut::new(None, Code::F9)
                    {
                        let _ = app.emit("hotkey-f9", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            if let Err(e) = app.global_shortcut().register(Shortcut::new(None, Code::F9)) {
                eprintln!("Failed to register F9 global shortcut: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_file_size,
            get_disk_space,
            path_exists,
            paths_exist,
            delete_file,
            read_text_file,
            write_text_file,
            copy_file,
            find_newest_file_since,
            start_mic_capture,
            stop_mic_capture,
            validate_license_key,
            analyze_video_with_gemini,
            generate_sfx_with_elevenlabs,
            generate_music_with_elevenlabs,
            call_claude_messages,
            read_frame_as_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
