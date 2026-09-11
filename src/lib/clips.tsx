import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { insertClip, listClips, type Clip, type NewClip } from "./db";

interface ClipsState {
  clips: Clip[];
  loading: boolean;
  addClip: (input: NewClip) => Promise<void>;
  refresh: () => Promise<void>;
}

const ClipsContext = createContext<ClipsState | null>(null);

export function ClipsProvider({ children }: { children: ReactNode }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const rows = await listClips();
    setClips(rows);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const addClip = useCallback(
    async (input: NewClip) => {
      await insertClip(input);
      await refresh();
    },
    [refresh],
  );

  return (
    <ClipsContext.Provider value={{ clips, loading, addClip, refresh }}>
      {children}
    </ClipsContext.Provider>
  );
}

export function useClips(): ClipsState {
  const ctx = useContext(ClipsContext);
  if (!ctx) throw new Error("useClips must be used within a ClipsProvider");
  return ctx;
}
