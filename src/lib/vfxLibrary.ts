import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  insertVfxEntry,
  listVfxLibrary,
  deleteVfxEntry,
  type VfxEntry,
  type VfxBlendMode,
} from "./db";

export type { VfxEntry, VfxBlendMode } from "./db";

const KEYWORD_TAGS: [RegExp, string[]][] = [
  [/leak|flare|bokeh|glow/, ["light-leak", "cinematic"]],
  [/glitch|distort|rgb.?split|datamosh/, ["glitch", "transition"]],
  [/burn|scratch|dust|grain|film/, ["film-burn", "texture"]],
  [/particle|dust|spark|confetti|snow/, ["particles", "ambient"]],
  [/smoke|fog|mist/, ["smoke", "atmosphere"]],
  [/zoom|whip|speed.?ramp/, ["zoom", "transition"]],
  [/static|noise|tv|vhs/, ["static", "retro"]],
  [/fire|flame|explosion/, ["fire", "dramatic"]],
  [/transition|wipe|swipe/, ["transition"]],
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

function deriveDisplayName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// Free stock overlay packs are near-universally delivered as plain H.264
// MP4 on a black background (confirmed against the two starter clips this
// pulled in) - MP4 has no alpha channel at all, so "screen" (additive
// blend, black contributes nothing) is the only mode that makes sense for
// it. .mov/.webm are the formats actually capable of carrying real
// transparency (ProRes 4444, VP9 alpha), so default to that only there;
// still just a default; nothing stops re-importing with the other mode if
// a specific file guesses wrong.
function guessBlendMode(filename: string): VfxBlendMode {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return ext === "mov" || ext === "webm" ? "alpha" : "screen";
}

export async function getVfxDir(): Promise<string> {
  return join(await appDataDir(), "vfx");
}

export interface VfxImportResult {
  imported: number;
  skipped: number;
}

/** Copies each file into the app's own vfx storage folder and records it in
 * the library, skipping any filename already imported - same pattern as
 * importSfxFiles/importMusicFiles. */
export async function importVfxFiles(paths: string[]): Promise<VfxImportResult> {
  const existing = await listVfxLibrary();
  const existingFilenames = new Set(existing.map((e) => e.filename));
  const vfxDir = await getVfxDir();

  let imported = 0;
  let skipped = 0;
  for (const sourcePath of paths) {
    const filename = basename(sourcePath);
    if (existingFilenames.has(filename)) {
      skipped++;
      continue;
    }
    const destPath = await join(vfxDir, filename);
    await invoke("copy_file", { from: sourcePath, to: destPath });
    const displayName = deriveDisplayName(filename);
    try {
      await insertVfxEntry(filename, displayName, guessTags(displayName), guessBlendMode(filename));
    } catch (err) {
      // Don't leave a copied file with no matching library row - a bare
      // file already in the vfx folder would otherwise silently mismatch
      // "skip if filename already imported" on a later retry.
      await invoke("delete_file", { path: destPath }).catch(() => {});
      throw err;
    }
    existingFilenames.add(filename);
    imported++;
  }
  return { imported, skipped };
}

export async function removeVfxEntry(entry: VfxEntry): Promise<void> {
  const vfxDir = await getVfxDir();
  const path = await join(vfxDir, entry.filename);
  try {
    await invoke("delete_file", { path });
  } catch (err) {
    console.error("[vfxLibrary] failed to delete file:", err);
  }
  await deleteVfxEntry(entry.id);
}

export async function resolveVfxPath(entry: VfxEntry): Promise<string> {
  return join(await getVfxDir(), entry.filename);
}

export { listVfxLibrary };
