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

const SESSION_RETENTION_DAYS = 30;

/** signal_samples accumulates a row roughly every 350ms for the entire time
 * the recording backend is connected, with nothing previously deleting old
 * rows - a daily streamer builds an ever-growing table (hundreds of
 * thousands of rows within weeks) that every backtest run then has to load
 * in full. Sessions past the retention window are unlikely to still be
 * useful for tuning (scenes/setup drift over time anyway), so drop them -
 * called once per new session start rather than on a timer, since that's
 * naturally an infrequent, low-stakes point to do database cleanup. */
export async function pruneOldSessions(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stale = await db.select<{ id: number }[]>(
    "SELECT id FROM sessions WHERE started_at < $1",
    [cutoff],
  );
  if (stale.length === 0) return;
  const ids = stale.map((s) => s.id);
  await db.execute(
    `DELETE FROM signal_samples WHERE session_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
    ids,
  );
  await db.execute(
    `DELETE FROM sessions WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
    ids,
  );
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

export interface SfxEntry {
  id: number;
  /** Filename only, relative to the app's sfx storage folder - never a
   * full path, so moving/renaming that folder can't orphan stored rows. */
  filename: string;
  displayName: string;
  tags: string[];
  addedAt: string;
}

interface SfxRow {
  id: number;
  filename: string;
  display_name: string;
  tags: string;
  added_at: string;
}

function sfxFromRow(row: SfxRow): SfxEntry {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.display_name,
    tags,
    addedAt: row.added_at,
  };
}

export async function insertSfxEntry(
  filename: string,
  displayName: string,
  tags: string[],
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO sfx_library (filename, display_name, tags, added_at) VALUES ($1, $2, $3, $4)",
    [filename, displayName, JSON.stringify(tags), new Date().toISOString()],
  );
  return result.lastInsertId ?? 0;
}

export async function listSfxLibrary(): Promise<SfxEntry[]> {
  const db = await getDb();
  const rows = await db.select<SfxRow[]>(
    "SELECT id, filename, display_name, tags, added_at FROM sfx_library ORDER BY display_name ASC",
  );
  return rows.map(sfxFromRow);
}

export async function deleteSfxEntry(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM sfx_library WHERE id = $1", [id]);
}

export interface MusicEntry {
  id: number;
  /** Filename only, relative to the app's music storage folder. */
  filename: string;
  displayName: string;
  tags: string[];
  addedAt: string;
}

interface MusicRow {
  id: number;
  filename: string;
  display_name: string;
  tags: string;
  added_at: string;
}

function musicFromRow(row: MusicRow): MusicEntry {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.display_name,
    tags,
    addedAt: row.added_at,
  };
}

export async function insertMusicEntry(
  filename: string,
  displayName: string,
  tags: string[],
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO music_library (filename, display_name, tags, added_at) VALUES ($1, $2, $3, $4)",
    [filename, displayName, JSON.stringify(tags), new Date().toISOString()],
  );
  return result.lastInsertId ?? 0;
}

export async function listMusicLibrary(): Promise<MusicEntry[]> {
  const db = await getDb();
  const rows = await db.select<MusicRow[]>(
    "SELECT id, filename, display_name, tags, added_at FROM music_library ORDER BY display_name ASC",
  );
  return rows.map(musicFromRow);
}

export async function deleteMusicEntry(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM music_library WHERE id = $1", [id]);
}

export type VfxBlendMode = "screen" | "alpha";

export interface VfxEntry {
  id: number;
  /** Filename only, relative to the app's vfx storage folder. */
  filename: string;
  displayName: string;
  tags: string[];
  /** "screen" for a black-background additive overlay (the common case for
   * free stock light-leak/glitch packs - pure black contributes nothing,
   * so it reads as transparent without a real alpha channel). "alpha" for
   * a file that actually carries transparency (ProRes 4444 MOV, alpha
   * WebM). */
  blendMode: VfxBlendMode;
  addedAt: string;
}

interface VfxRow {
  id: number;
  filename: string;
  display_name: string;
  tags: string;
  blend_mode: string;
  added_at: string;
}

function vfxFromRow(row: VfxRow): VfxEntry {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    filename: row.filename,
    displayName: row.display_name,
    tags,
    blendMode: row.blend_mode === "alpha" ? "alpha" : "screen",
    addedAt: row.added_at,
  };
}

export async function insertVfxEntry(
  filename: string,
  displayName: string,
  tags: string[],
  blendMode: VfxBlendMode,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO vfx_library (filename, display_name, tags, blend_mode, added_at) VALUES ($1, $2, $3, $4, $5)",
    [filename, displayName, JSON.stringify(tags), blendMode, new Date().toISOString()],
  );
  return result.lastInsertId ?? 0;
}

export async function listVfxLibrary(): Promise<VfxEntry[]> {
  const db = await getDb();
  const rows = await db.select<VfxRow[]>(
    "SELECT id, filename, display_name, tags, blend_mode, added_at FROM vfx_library ORDER BY display_name ASC",
  );
  return rows.map(vfxFromRow);
}

export async function deleteVfxEntry(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM vfx_library WHERE id = $1", [id]);
}
