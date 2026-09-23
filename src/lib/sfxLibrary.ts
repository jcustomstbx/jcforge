import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  insertSfxEntry,
  listSfxLibrary,
  deleteSfxEntry,
  type SfxEntry,
} from "./db";

export type { SfxEntry } from "./db";

// Keyword -> tags, checked against the cleaned-up filename. Order matters
// only in that a file can match several keywords - all matching tags are
// kept, since a "cinematic laser gun thunder" file is legitimately both an
// impact and sci-fi cue.
const KEYWORD_TAGS: [RegExp, string[]][] = [
  [/laugh|giggle|chuckle/, ["laugh", "comedy"]],
  [/whoosh|swoosh|swipe|sweep/, ["whoosh", "transition"]],
  [/beep|bleep/, ["beep", "game"]],
  [/alarm|buzzer|wrong|error/, ["alarm", "negative"]],
  [/ding|notification|chime/, ["ding", "notification"]],
  [/glitch/, ["glitch", "transition"]],
  [/heartbeat|suspense|horror/, ["suspense", "cinematic"]],
  [/impact|hit|thunder|explosion/, ["impact", "dramatic"]],
  [/trombone|game.?over|sad/, ["sad", "negative"]],
  [/countdown|clock/, ["countdown", "game"]],
  [/whistle|toy/, ["whistle", "comedy"]],
  [/crowd|cheer/, ["crowd", "positive"]],
  [/bird|nature/, ["ambient", "nature"]],
  [/flute|melodical|music/, ["music", "positive"]],
  [/retro|arcade/, ["retro", "game"]],
  [/vacuum/, ["whoosh", "transition"]],
  [/eating|cereal/, ["comedy"]],
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

// "mixkit-cartoon-monkey-mocking-laugh-107.wav" -> "Cartoon Monkey Mocking Laugh"
function deriveDisplayName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const withoutPrefix = stem.replace(/^mixkit-/i, "");
  const withoutTrailingId = withoutPrefix.replace(/-\(?\d+\)?$/, "");
  return withoutTrailingId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function getSfxDir(): Promise<string> {
  return join(await appDataDir(), "sfx");
}

export interface SfxImportResult {
  imported: number;
  skipped: number;
}

/** Copies each file into the app's own sfx storage folder and records it
 * in the library, skipping any filename already imported so re-dropping
 * the same pack doesn't create duplicate rows. */
export async function importSfxFiles(paths: string[]): Promise<SfxImportResult> {
  const existing = await listSfxLibrary();
  const existingFilenames = new Set(existing.map((e) => e.filename));
  const sfxDir = await getSfxDir();

  let imported = 0;
  let skipped = 0;
  for (const sourcePath of paths) {
    const filename = basename(sourcePath);
    if (existingFilenames.has(filename)) {
      skipped++;
      continue;
    }
    const destPath = await join(sfxDir, filename);
    await invoke("copy_file", { from: sourcePath, to: destPath });
    const displayName = deriveDisplayName(filename);
    try {
      await insertSfxEntry(filename, displayName, guessTags(displayName));
    } catch (err) {
      await invoke("delete_file", { path: destPath }).catch(() => {});
      throw err;
    }
    existingFilenames.add(filename);
    imported++;
  }
  return { imported, skipped };
}

export async function removeSfxEntry(entry: SfxEntry): Promise<void> {
  const sfxDir = await getSfxDir();
  const path = await join(sfxDir, entry.filename);
  try {
    await invoke("delete_file", { path });
  } catch (err) {
    console.error("[sfxLibrary] failed to delete file:", err);
  }
  await deleteSfxEntry(entry.id);
}

export async function resolveSfxPath(entry: SfxEntry): Promise<string> {
  return join(await getSfxDir(), entry.filename);
}

export { listSfxLibrary };
