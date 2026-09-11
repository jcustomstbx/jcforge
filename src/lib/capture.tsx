import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useClips } from "./clips";
import { useBackend } from "./backend";
import { useSettings } from "./settingsContext";
import { probeDuration } from "./ffmpeg";
import "./capture.css";

type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface CaptureState {
  triggerCapture: () => Promise<void>;
  autoCapture: (reason: string, label: string) => Promise<number | null>;
}

const CaptureContext = createContext<CaptureState | null>(null);

async function getFileSize(path: string): Promise<number | null> {
  try {
    return await invoke<number>("get_file_size", { path });
  } catch {
    return null;
  }
}

export function CaptureProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const clips = useClips();
  const settings = useSettings();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToastId = useRef(0);

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = nextToastId.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => {
      setToasts((t) => t.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  // Depend on the specific fields/callbacks actually used, not the whole
  // backend/clips context objects - those get a new identity on every
  // render of their provider (e.g. every mic-level tick, 10-20x/sec until
  // that was moved out of context - keeping this narrow either way), which
  // would otherwise make `capture` (and everything derived from it,
  // including the F9 hotkey listener below) churn at that same frequency.
  const { status, replayBufferActive, triggerManualCapture } = backend;
  const { addClip } = clips;
  const backendLabel =
    settings.recordingBackend === "streamlabs" ? "Streamlabs" : "OBS";

  const capture = useCallback(
    async (reason: string, successLabel: string): Promise<number | null> => {
      if (status !== "connected") {
        pushToast("error", `Not connected to ${backendLabel}`);
        return null;
      }
      if (replayBufferActive === false) {
        pushToast("error", `Replay buffer isn't running in ${backendLabel}`);
        return null;
      }
      try {
        const path = await triggerManualCapture();
        if (!path) {
          pushToast("error", `Couldn't save a clip — check ${backendLabel}`);
          return null;
        }
        const [fileSizeBytes, durationSeconds] = await Promise.all([
          getFileSize(path),
          probeDuration(path),
        ]);
        const id = await addClip({
          path,
          capturedAt: new Date().toISOString(),
          fileSizeBytes,
          durationSeconds,
          triggerReason: reason,
        });
        const filename = path.split(/[\\/]/).pop() ?? path;
        pushToast("success", `${successLabel}: ${filename}`);
        return id;
      } catch (err) {
        console.error("[capture] failed to record clip:", err);
        pushToast(
          "error",
          "OBS saved the clip, but JCForge failed to record it — see console",
        );
        return null;
      }
    },
    [
      status,
      replayBufferActive,
      triggerManualCapture,
      addClip,
      pushToast,
      backendLabel,
    ],
  );

  const triggerCapture = useCallback(async () => {
    await capture("manual", "Clip saved");
  }, [capture]);

  const autoCapture = useCallback(
    (reason: string, label: string) => capture(reason, label),
    [capture],
  );

  useEffect(() => {
    const unlisten = listen("hotkey-f9", () => {
      triggerCapture();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerCapture]);

  return (
    <CaptureContext.Provider value={{ triggerCapture, autoCapture }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </CaptureContext.Provider>
  );
}

export function useCapture(): CaptureState {
  const ctx = useContext(CaptureContext);
  if (!ctx)
    throw new Error("useCapture must be used within a CaptureProvider");
  return ctx;
}
