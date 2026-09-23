import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  insertMusicEntry,
  listMusicLibrary,
  deleteMusicEntry,
  type MusicEntry,
} from "./db";

export type { MusicEntry } from "./db";

// Keyword -> mood tags, checked against the cleaned-up filename - same
// approach as sfxLibrary's tag guessing, just tuned for background-music
// moods (energetic/calm/emotional) instead of SFX categories.
const KEYWORD_TAGS: [RegExp, string[]][] = [
  [/high.?octane|extreme|action|damage|going.?higher/, ["energetic", "action"]],
  [/dubstep|electronic|synth/, ["energetic", "electronic"]],
  [/beyond.?the.?line|epic|cinematic/, ["energetic", "cinematic"]],
  [/sad|sorrow|echo.?of.?sadness/, ["sad", "emotional"]],
  [/slow|chill|calm|relax/, ["calm", "chill"]],
  [/yesterday|nostalgi|memor/, ["emotional", "calm"]],
  [/upbeat|happy|fun/, ["positive", "energetic"]],
];

function guessTags(cleanedName: string): string[] {
  const lower = cleanedName.toLowerCase();
  const tags = new Set<string>();
  for (const [pattern, matchedTags] of KEYWORD_TAGS) {
    if (pattern.test(lower)) matchedTags.forEach((t) => tags.add(t));
  }
  if (tags.size === 0) tags.add("misc");
  return Array.from(tags);
}

// "bensound-extremeaction.mp3" -> "Extremeaction" -> spaced out below.
// Bensound filenames run words together with no separator, unlike mixkit's
// hyphenated names, so this only strips the "bensound-" prefix rather than
// trying to split compound words it can't reliably segment.
function deriveDisplayName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const withoutPrefix = stem.replace(/^bensound-/i, "");
  const words = withoutPrefix.split(/[-_]+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function getMusicDir(): Promise<string> {
  return join(await appDataDir(), "music");
}

export interface MusicImportResult {
  imported: number;
  skipped: number;
}

/** Copies each file into the app's own music storage folder and records it
 * in the library, skipping any filename already imported. */
export async function importMusicFiles(paths: string[]): Promise<MusicImportResult> {
  const existing = await listMusicLibrary();
  const existingFilenames = new Set(existing.map((e) => e.filename));
  const musicDir = await getMusicDir();

  let imported = 0;
  let skipped = 0;
  for (const sourcePath of paths) {
    const filename = basename(sourcePath);
    if (existingFilenames.has(filename)) {
      skipped++;
      continue;
    }
    const destPath = await join(musicDir, filename);
    await invoke("copy_file", { from: sourcePath, to: destPath });
    const displayName = deriveDisplayName(filename);
    try {
      await insertMusicEntry(filename, displayName, guessTags(displayName));
    } catch (err) {
      await invoke("delete_file", { path: destPath }).catch(() => {});
      throw err;
    }
    existingFilenames.add(filename);
    imported++;
  }
  return { imported, skipped };
}

export async function removeMusicEntry(entry: MusicEntry): Promise<void> {
  const musicDir = await getMusicDir();
  const path = await join(musicDir, entry.filename);
  try {
    await invoke("delete_file", { path });
  } catch (err) {
    console.error("[musicLibrary] failed to delete file:", err);
  }
  await deleteMusicEntry(entry.id);
}

export async function resolveMusicPath(entry: MusicEntry): Promise<string> {
  return join(await getMusicDir(), entry.filename);
}

export { listMusicLibrary };
