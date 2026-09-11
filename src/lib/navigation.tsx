import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { ScreenId } from "../types";

interface NavigationState {
  navigate: (screen: ScreenId) => void;
  editingClipId: number | null;
  openEditor: (clipId: number) => void;
}

const NavigationContext = createContext<NavigationState | null>(null);

export function NavigationProvider({
  navigate,
  children,
}: {
  navigate: (screen: ScreenId) => void;
  children: ReactNode;
}) {
  const [editingClipId, setEditingClipId] = useState<number | null>(null);

  const openEditor = useCallback(
    (clipId: number) => {
      setEditingClipId(clipId);
      navigate("editor");
    },
    [navigate],
  );

  return (
    <NavigationContext.Provider
      value={{ navigate, editingClipId, openEditor }}
    >
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationState {
  const ctx = useContext(NavigationContext);
  if (!ctx)
    throw new Error("useNavigation must be used within a NavigationProvider");
  return ctx;
}
