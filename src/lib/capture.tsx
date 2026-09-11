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
import { useObs } from "./obs";
import "./capture.css";

type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface CaptureState {
  triggerCapture: () => Promise<void>;
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
  const obs = useObs();
  const clips = useClips();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToastId = useRef(0);

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = nextToastId.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => {
      setToasts((t) => t.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  const triggerCapture = useCallback(async () => {
    if (obs.status !== "connected") {
      pushToast("error", "Not connected to OBS");
      return;
    }
    if (obs.replayBufferActive === false) {
      pushToast("error", "Replay buffer isn't running in OBS");
      return;
    }
    try {
      const path = await obs.triggerManualCapture();
      if (!path) {
        pushToast("error", "Couldn't save a clip — check OBS");
        return;
      }
      const fileSizeBytes = await getFileSize(path);
      await clips.addClip({
        path,
        capturedAt: new Date().toISOString(),
        fileSizeBytes,
        triggerReason: "manual",
      });
      const filename = path.split(/[\\/]/).pop() ?? path;
      pushToast("success", `Clip saved: ${filename}`);
    } catch (err) {
      console.error("[capture] failed to record clip:", err);
      pushToast(
        "error",
        "OBS saved the clip, but JCForge failed to record it — see console",
      );
    }
  }, [obs, clips, pushToast]);

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
    <CaptureContext.Provider value={{ triggerCapture }}>
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
