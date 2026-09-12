import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  deleteClip,
  insertClip,
  listClips,
  setClipDecision,
  type Clip,
  type NewClip,
} from "./db";

interface ClipsState {
  clips: Clip[];
  loading: boolean;
  addClip: (input: NewClip) => Promise<number>;
  removeClip: (id: number, deleteFile: boolean) => Promise<void>;
  resolveClip: (id: number, kept: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const ClipsContext = createContext<ClipsState | null>(null);

async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return true; // don't prune on an inconclusive check
  }
}

export function ClipsProvider({ children }: { children: ReactNode }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const rows = await listClips();
    // Reconcile against disk: a clip whose file was removed outside the
    // app (or from the library) shouldn't keep showing up here. A skipped
    // clip's file is deleted deliberately (see resolveClip below) - its row
    // stays so kept/skipped stats stay accurate, so a missing file there
    // isn't a sign of an external deletion to reconcile away.
    const existence = await Promise.all(
      rows.map((r) => (r.kept === false ? true : pathExists(r.path))),
    );
    const missing = rows.filter((_, i) => !existence[i]);
    if (missing.length > 0) {
      await Promise.all(missing.map((r) => deleteClip(r.id)));
    }
    setClips(rows.filter((_, i) => existence[i]));
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const addClip = useCallback(
    async (input: NewClip) => {
      const id = await insertClip(input);
      await refresh();
      return id;
    },
    [refresh],
  );

  const removeClip = useCallback(
    async (id: number, deleteFile: boolean) => {
      if (deleteFile) {
        const clip = clips.find((c) => c.id === id);
        if (clip) {
          try {
            await invoke("delete_file", { path: clip.path });
          } catch (err) {
            console.error("[clips] failed to delete file:", err);
          }
        }
      }
      await deleteClip(id);
      await refresh();
    },
    [clips, refresh],
  );

  const resolveClip = useCallback(
    async (id: number, kept: boolean) => {
      // Skipped clips delete their video immediately to save disk - the
      // proposal was noise, no reason to keep the file around.
      if (!kept) {
        const clip = clips.find((c) => c.id === id);
        if (clip) {
          try {
            await invoke("delete_file", { path: clip.path });
          } catch (err) {
            console.error("[clips] failed to delete skipped clip file:", err);
          }
        }
      }
      await setClipDecision(id, kept);
      await refresh();
    },
    [clips, refresh],
  );

  return (
    <ClipsContext.Provider
      value={{ clips, loading, addClip, removeClip, resolveClip, refresh }}
    >
      {children}
    </ClipsContext.Provider>
  );
}

export function useClips(): ClipsState {
  const ctx = useContext(ClipsContext);
  if (!ctx) throw new Error("useClips must be used within a ClipsProvider");
  return ctx;
}
