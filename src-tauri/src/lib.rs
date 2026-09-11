use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create clips table",
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
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        .invoke_handler(tauri::generate_handler![get_file_size])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
