import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCapture } from "./capture";
import { useObs } from "./obs";
import { RollingNormalizer } from "./signal";

// Matches the detection model's defaults (README: threshold 0.72,
// cooldown 45s) applied to the voice signal alone until chat/motion join
// it as a composite score in a later milestone.
const THRESHOLD = 0.72;
const COOLDOWN_MS = 45_000;

interface VoiceSignalState {
  score: number;
}

const VoiceSignalContext = createContext<VoiceSignalState | null>(null);

export function VoiceSignalProvider({ children }: { children: ReactNode }) {
  const obs = useObs();
  const capture = useCapture();
  const [score, setScore] = useState(0);
  const normalizerRef = useRef<RollingNormalizer | null>(null);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (obs.micLevel === null) return;
    if (!normalizerRef.current) normalizerRef.current = new RollingNormalizer();
    const normalized = normalizerRef.current.push(obs.micLevel);
    setScore(normalized);

    const now = Date.now();
    if (
      normalized >= THRESHOLD &&
      now - lastTriggerRef.current > COOLDOWN_MS
    ) {
      lastTriggerRef.current = now;
      capture.autoCapture(
        "voice",
        `Voice spike detected (${normalized.toFixed(2)})`,
      );
    }
  }, [obs.micLevel, capture]);

  useEffect(() => {
    if (obs.status !== "connected") {
      normalizerRef.current = null;
      setScore(0);
    }
  }, [obs.status]);

  return (
    <VoiceSignalContext.Provider value={{ score }}>
      {children}
    </VoiceSignalContext.Provider>
  );
}

export function useVoiceSignal(): VoiceSignalState {
  const ctx = useContext(VoiceSignalContext);
  if (!ctx)
    throw new Error(
      "useVoiceSignal must be used within a VoiceSignalProvider",
    );
  return ctx;
}
