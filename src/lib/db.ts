import Database from "@tauri-apps/plugin-sql";

export interface Clip {
  id: number;
  path: string;
  capturedAt: string;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  triggerReason: string;
  reviewed: boolean;
  kept: boolean | null;
}

interface ClipRow {
  id: number;
  path: string;
  captured_at: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  trigger_reason: string;
  reviewed: number;
  kept: number | null;
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

export async function insertClip(input: NewClip): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO clips (path, captured_at, file_size_bytes, trigger_reason) VALUES ($1, $2, $3, $4)",
    [input.path, input.capturedAt, input.fileSizeBytes, input.triggerReason],
  );
  return result.lastInsertId ?? 0;
}

export async function deleteClip(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM clips WHERE id = $1", [id]);
}

export async function setClipDecision(
  id: number,
  kept: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE clips SET reviewed = 1, kept = $1 WHERE id = $2",
    [kept ? 1 : 0, id],
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
    kept: row.kept === null ? null : row.kept !== 0,
  };
}

export async function listClips(): Promise<Clip[]> {
  const db = await getDb();
  const rows = await db.select<ClipRow[]>(
    "SELECT id, path, captured_at, file_size_bytes, duration_seconds, trigger_reason, reviewed, kept FROM clips ORDER BY captured_at DESC",
  );
  return rows.map(fromRow);
}
