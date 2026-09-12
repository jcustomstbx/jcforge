use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod mic_capture;
use mic_capture::{start_mic_capture, stop_mic_capture};

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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
            path_exists,
            delete_file,
            read_text_file,
            write_text_file,
            find_newest_file_since,
            start_mic_capture,
            stop_mic_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
