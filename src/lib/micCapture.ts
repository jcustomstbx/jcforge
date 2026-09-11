import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { setMicLevelValue } from "./micLevelStore";

// Only used when Streamlabs is the active backend - OBS's own
// InputVolumeMeters event covers voice level without opening a second
// handle on the mic device.
export function useCpalMicCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const unlistenPromise = listen<number>("mic-level", (event) => {
      setMicLevelValue(event.payload);
    });

    invoke("start_mic_capture").catch((err) => {
      console.error("[mic] failed to start capture:", err);
    });

    return () => {
      unlistenPromise.then((fn) => fn());
      invoke("stop_mic_capture").catch(() => {});
      setMicLevelValue(null);
    };
  }, [active]);
}
