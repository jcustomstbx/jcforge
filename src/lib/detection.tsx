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
import { useSettings } from "./settingsContext";
import { RollingNormalizer } from "./signal";
import { MotionDiffer } from "./motion";
import { TwitchChatConnection } from "./twitchChat";

// Detection model defaults per the README: threshold 0.72 composite,
// cooldown 45s, weights voice 0.85 / chat 0.70 / motion 0.55.
const THRESHOLD = 0.72;
const COOLDOWN_MS = 45_000;
const TICK_MS = 350; // ~3fps for motion sampling + chat rate recompute
const CHAT_WINDOW_MS = 5_000;
const HISTORY_MAX_POINTS = 1800; // ~30 min at ~1/sec

const WEIGHTS = { voice: 0.85, chat: 0.7, motion: 0.55 };

export interface ScorePoint {
  t: number;
  value: number;
}

interface DetectionState {
  voiceScore: number;
  chatScore: number;
  motionScore: number;
  composite: number;
  history: ScorePoint[];
  marks: number[];
  chatConnected: boolean;
}

const DetectionContext = createContext<DetectionState | null>(null);

export function DetectionProvider({ children }: { children: ReactNode }) {
  const obs = useObs();
  const capture = useCapture();
  const settings = useSettings();
  const { status, micLevel, sceneChangedAt, captureScreenshot } = obs;
  const { autoCapture } = capture;
  const { twitchChannel } = settings;

  const [voiceScore, setVoiceScore] = useState(0);
  const [chatScore, setChatScore] = useState(0);
  const [motionScore, setMotionScore] = useState(0);
  const [composite, setComposite] = useState(0);
  const [history, setHistory] = useState<ScorePoint[]>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [chatConnected, setChatConnected] = useState(false);

  const voiceNormRef = useRef<RollingNormalizer | null>(null);
  const chatNormRef = useRef<RollingNormalizer | null>(null);
  const motionNormRef = useRef<RollingNormalizer | null>(null);
  const motionDifferRef = useRef(new MotionDiffer());
  const lastTriggerRef = useRef(0);
  const voiceScoreRef = useRef(0);

  const chatTimestampsRef = useRef<number[]>([]);
  const chatEmotesRef = useRef<number[]>([]);

  // --- voice: recompute on every mic-level tick from OBS ---
  useEffect(() => {
    if (micLevel === null) return;
    if (!voiceNormRef.current) voiceNormRef.current = new RollingNormalizer();
    const n = voiceNormRef.current.push(micLevel);
    voiceScoreRef.current = n;
    setVoiceScore(n);
  }, [micLevel]);

  useEffect(() => {
    if (status !== "connected") {
      voiceNormRef.current = null;
      voiceScoreRef.current = 0;
      setVoiceScore(0);
    }
  }, [status]);

  // --- chat: connect anonymously to Twitch IRC for the configured channel ---
  useEffect(() => {
    if (!twitchChannel) {
      setChatConnected(false);
      return;
    }
    const conn = new TwitchChatConnection(twitchChannel);
    conn.onStatusChange = setChatConnected;
    conn.onMessage = (e) => {
      const now = Date.now();
      chatTimestampsRef.current.push(now);
      chatEmotesRef.current.push(e.emoteCount);
    };
    conn.connect();
    return () => conn.disconnect();
  }, [twitchChannel]);

  // suppress one motion diff right after a scene transition
  useEffect(() => {
    if (sceneChangedAt > 0) motionDifferRef.current.reset();
  }, [sceneChangedAt]);

  // --- motion sampling + chat rate + composite, on a shared tick ---
  useEffect(() => {
    if (status !== "connected") return;
    if (!motionNormRef.current) motionNormRef.current = new RollingNormalizer();
    if (!chatNormRef.current) chatNormRef.current = new RollingNormalizer();

    const interval = setInterval(async () => {
      let motionN = 0;
      const shot = await captureScreenshot();
      if (shot) {
        const delta = await motionDifferRef.current.diff(shot);
        motionN = motionNormRef.current!.push(delta);
        setMotionScore(motionN);
      }

      const now = Date.now();
      const cutoff = now - CHAT_WINDOW_MS;
      while (
        chatTimestampsRef.current.length &&
        chatTimestampsRef.current[0] < cutoff
      ) {
        chatTimestampsRef.current.shift();
        chatEmotesRef.current.shift();
      }
      const msgCount = chatTimestampsRef.current.length;
      const emoteCount = chatEmotesRef.current.reduce((a, b) => a + b, 0);
      const rate = msgCount / (CHAT_WINDOW_MS / 1000);
      const emoteDensity = msgCount > 0 ? emoteCount / msgCount : 0;
      const chatN = chatNormRef.current!.push(rate + emoteDensity);
      setChatScore(chatN);

      const comp =
        voiceScoreRef.current * WEIGHTS.voice +
        chatN * WEIGHTS.chat +
        motionN * WEIGHTS.motion;
      setComposite(comp);
      setHistory((h) => {
        const next = [...h, { t: now, value: comp }];
        return next.length > HISTORY_MAX_POINTS
          ? next.slice(next.length - HISTORY_MAX_POINTS)
          : next;
      });

      if (comp >= THRESHOLD && now - lastTriggerRef.current > COOLDOWN_MS) {
        lastTriggerRef.current = now;
        setMarks((m) => [...m, now].slice(-50));
        autoCapture("composite", `Moment detected (${comp.toFixed(2)})`);
      }
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [status, captureScreenshot, autoCapture]);

  return (
    <DetectionContext.Provider
      value={{
        voiceScore,
        chatScore,
        motionScore,
        composite,
        history,
        marks,
        chatConnected,
      }}
    >
      {children}
    </DetectionContext.Provider>
  );
}

export function useDetection(): DetectionState {
  const ctx = useContext(DetectionContext);
  if (!ctx)
    throw new Error("useDetection must be used within a DetectionProvider");
  return ctx;
}
