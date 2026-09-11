import { useSyncExternalStore } from "react";

// Mic level updates at 10-20Hz (from OBS's InputVolumeMeters, or from
// direct cpal capture when Streamlabs is the selected backend). Routing
// that through React context/state would re-render every consumer that
// many times a second even though only the detection pipeline actually
// needs it - measurably laggy, including input lag while typing elsewhere
// in the app. This tiny external store keeps the update path outside
// React's normal render cycle: only components that call useMicLevel()
// (just DetectionProvider) re-render on each tick. Shared by both mic
// sources since only one is ever active at a time.
let micLevelValue: number | null = null;
const micLevelListeners = new Set<() => void>();

export function setMicLevelValue(value: number | null): void {
  micLevelValue = value;
  for (const listener of micLevelListeners) listener();
}

function subscribeMicLevel(listener: () => void): () => void {
  micLevelListeners.add(listener);
  return () => micLevelListeners.delete(listener);
}

function getMicLevelSnapshot(): number | null {
  return micLevelValue;
}

export function useMicLevel(): number | null {
  return useSyncExternalStore(subscribeMicLevel, getMicLevelSnapshot);
}
