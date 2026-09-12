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
  durationSeconds?: number | null;
  triggerReason: string;
}

export async function insertClip(input: NewClip): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO clips (path, captured_at, file_size_bytes, duration_seconds, trigger_reason) VALUES ($1, $2, $3, $4, $5)",
    [
      input.path,
      input.capturedAt,
      input.fileSizeBytes,
      input.durationSeconds ?? null,
      input.triggerReason,
    ],
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

export interface SessionSummary {
  id: number;
  startedAt: string;
  endedAt: string | null;
  sampleCount: number;
}

export interface SignalSample {
  tMs: number;
  voice: number;
  chat: number;
  motion: number;
}

export async function createSession(startedAt: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO sessions (started_at) VALUES ($1)",
    [startedAt],
  );
  return result.lastInsertId ?? 0;
}

export async function endSession(
  id: number,
  endedAt: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE sessions SET ended_at = $1 WHERE id = $2", [
    endedAt,
    id,
  ]);
}

export async function insertSignalSample(
  sessionId: number,
  sample: SignalSample,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO signal_samples (session_id, t_ms, voice, chat, motion) VALUES ($1, $2, $3, $4, $5)",
    [sessionId, sample.tMs, sample.voice, sample.chat, sample.motion],
  );
}

export async function listSessions(): Promise<SessionSummary[]> {
  const db = await getDb();
  const rows = await db.select<
    { id: number; started_at: string; ended_at: string | null; sample_count: number }[]
  >(
    `SELECT s.id, s.started_at, s.ended_at, COUNT(sig.id) as sample_count
     FROM sessions s
     LEFT JOIN signal_samples sig ON sig.session_id = s.id
     GROUP BY s.id
     HAVING sample_count > 0
     ORDER BY s.started_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    sampleCount: r.sample_count,
  }));
}

export async function getSignalSamples(
  sessionId: number,
): Promise<SignalSample[]> {
  const db = await getDb();
  const rows = await db.select<
    { t_ms: number; voice: number; chat: number; motion: number }[]
  >(
    "SELECT t_ms, voice, chat, motion FROM signal_samples WHERE session_id = $1 ORDER BY t_ms ASC",
    [sessionId],
  );
  return rows.map((r) => ({
    tMs: r.t_ms,
    voice: r.voice,
    chat: r.chat,
    motion: r.motion,
  }));
}
