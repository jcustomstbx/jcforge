import Database from "@tauri-apps/plugin-sql";

export interface Clip {
  id: number;
  path: string;
  capturedAt: string;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  triggerReason: string;
  reviewed: boolean;
}

interface ClipRow {
  id: number;
  path: string;
  captured_at: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  trigger_reason: string;
  reviewed: number;
}

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:jcforge.db");
  return dbPromise;
}

export interface NewClip {
  path: string;
  capturedAt: string;
  fileSizeBytes: number | null;
  triggerReason: string;
}

export async function insertClip(input: NewClip): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO clips (path, captured_at, file_size_bytes, trigger_reason) VALUES ($1, $2, $3, $4)",
    [input.path, input.capturedAt, input.fileSizeBytes, input.triggerReason],
  );
}

function fromRow(row: ClipRow): Clip {
  return {
    id: row.id,
    path: row.path,
    capturedAt: row.captured_at,
    fileSizeBytes: row.file_size_bytes,
    durationSeconds: row.duration_seconds,
    triggerReason: row.trigger_reason,
    reviewed: row.reviewed !== 0,
  };
}

export async function listClips(): Promise<Clip[]> {
  const db = await getDb();
  const rows = await db.select<ClipRow[]>(
    "SELECT id, path, captured_at, file_size_bytes, duration_seconds, trigger_reason, reviewed FROM clips ORDER BY captured_at DESC",
  );
  return rows.map(fromRow);
}
