import { createContext, useContext } from "react";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * The subset of recording-software state that detection/capture actually
 * need, satisfied by both the OBS and Streamlabs backends so that code
 * doesn't need to know which one is active. OBS-specific extras (version
 * info, which mic input, url) live only on ObsState, used directly by the
 * Sources/TitleBar screens for display.
 */
export interface BackendState {
  status: ConnectionStatus;
  error: string | null;
  replayBufferActive: boolean | null;
  sceneName: string | null;
  sceneChangedAt: number;
  /** False for Streamlabs - it has no screenshot/thumbnail API at all, so
   * motion detection can't run under that backend. */
  supportsMotion: boolean;
  triggerManualCapture: () => Promise<string | null>;
  captureScreenshot: () => Promise<string | null>;
}

export const BackendContext = createContext<BackendState | null>(null);

export function useBackend(): BackendState {
  const ctx = useContext(BackendContext);
  if (!ctx)
    throw new Error(
      "useBackend must be used within an ObsProvider or StreamlabsProvider",
    );
  return ctx;
}
