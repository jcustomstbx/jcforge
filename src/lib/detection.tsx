import { emit, listen } from "@tauri-apps/api/event";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCapture } from "./capture";
import { useClips } from "./clips";
import { useBackend } from "./backend";
import { useMicLevel } from "./micLevelStore";
import { useSettings } from "./settingsContext";
import { RollingNormalizer } from "./signal";
import { MotionDiffer } from "./motion";
import { TwitchChatConnection } from "./twitchChat";
import { createSession, endSession, insertSignalSample } from "./db";
import {
  DOCK_ACTION_EVENT,
  DOCK_STATE_EVENT,
  type DockAction,
  type DockProposal,
} from "./dockProtocol";

const TICK_MS = 350; // ~3fps for motion sampling + chat rate recompute
const CHAT_WINDOW_MS = 5_000;
const HISTORY_MAX_POINTS = 1800; // ~30 min at ~1/sec
const WAVE_MAX_POINTS = 32;

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
  proposal: DockProposal | null;
  keptCount: number;
  skippedCount: number;
  resolveProposal: (kept: boolean) => void;
}

const DetectionContext = createContext<DetectionState | null>(null);

export function DetectionProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const capture = useCapture();
  const settings = useSettings();
  const clips = useClips();
  const {
    status,
    sceneChangedAt,
    captureScreenshot,
    replayBufferActive,
    supportsMotion,
  } = backend;
  const micLevel = useMicLevel();
  const { autoCapture } = capture;
  const { twitchChannel, detectionThreshold, detectionCooldownMs, detectionWeights } =
    settings;
  const { clips: clipList, resolveClip } = clips;

  const [voiceScore, setVoiceScore] = useState(0);
  const [chatScore, setChatScore] = useState(0);
  const [motionScore, setMotionScore] = useState(0);
  const [composite, setComposite] = useState(0);
  const [history, setHistory] = useState<ScorePoint[]>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [chatConnected, setChatConnected] = useState(false);
  const [proposal, setProposal] = useState<DockProposal | null>(null);

  const voiceNormRef = useRef<RollingNormalizer | null>(null);
  const chatNormRef = useRef<RollingNormalizer | null>(null);
  const motionNormRef = useRef<RollingNormalizer | null>(null);
  const motionDifferRef = useRef(new MotionDiffer());
  const lastTriggerRef = useRef(0);
  const voiceScoreRef = useRef(0);
  const voiceWaveRef = useRef<number[]>([]);
  const proposalRef = useRef<DockProposal | null>(null);
  const sessionIdRef = useRef<number | null>(null);

  const chatTimestampsRef = useRef<number[]>([]);
  const chatEmotesRef = useRef<number[]>([]);

  const keptCount = clipList.filter((c) => c.kept === true).length;
  const skippedCount = clipList.filter((c) => c.kept === false).length;

  const resolveProposal = (kept: boolean) => {
    const current = proposalRef.current;
    if (!current) return;
    proposalRef.current = null;
    setProposal(null);
    resolveClip(current.clipId, kept);
  };

  // --- voice: recompute on every mic-level tick from OBS ---
  useEffect(() => {
    if (micLevel === null) return;
    if (!voiceNormRef.current) voiceNormRef.current = new RollingNormalizer();
    const n = voiceNormRef.current.push(micLevel);
    voiceScoreRef.current = n;
    setVoiceScore(n);
    voiceWaveRef.current = [...voiceWaveRef.current, n].slice(
      -WAVE_MAX_POINTS,
    );
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

  // --- listen for Keep/Skip actions coming from the floating dock window ---
  useEffect(() => {
    const unlisten = listen<DockAction>(DOCK_ACTION_EVENT, (event) => {
      const current = proposalRef.current;
      if (!current || current.clipId !== event.payload.clipId) return;
      resolveProposal(event.payload.action === "keep");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveClip]);

  // --- record a session row for the duration this backend is connected, so
  // the raw signal history can be backtested later against different
  // weights/threshold - keyed only on `status` so it isn't torn down and
  // restarted by the tick effect below re-running for unrelated reasons
  // (e.g. a slider moving mid-stream). ---
  useEffect(() => {
    if (status !== "connected") return;
    let active = true;
    createSession(new Date().toISOString())
      .then((id) => {
        if (active) sessionIdRef.current = id;
      })
      .catch((err) => console.error("[detection] failed to start session:", err));

    return () => {
      active = false;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id !== null) {
        endSession(id, new Date().toISOString()).catch((err) =>
          console.error("[detection] failed to end session:", err),
        );
      }
    };
  }, [status]);

  // --- motion sampling + chat rate + composite, on a shared tick ---
  useEffect(() => {
    if (status !== "connected") return;
    if (!motionNormRef.current) motionNormRef.current = new RollingNormalizer();
    if (!chatNormRef.current) chatNormRef.current = new RollingNormalizer();

    const interval = setInterval(async () => {
      let motionN = 0;
      if (supportsMotion) {
        const shot = await captureScreenshot();
        if (shot) {
          const delta = await motionDifferRef.current.diff(shot);
          motionN = motionNormRef.current!.push(delta);
          setMotionScore(motionN);
        }
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
        voiceScoreRef.current * detectionWeights.voice +
        chatN * detectionWeights.chat +
        motionN * detectionWeights.motion;
      setComposite(comp);
      setHistory((h) => {
        const next = [...h, { t: now, value: comp }];
        return next.length > HISTORY_MAX_POINTS
          ? next.slice(next.length - HISTORY_MAX_POINTS)
          : next;
      });

      if (sessionIdRef.current !== null) {
        insertSignalSample(sessionIdRef.current, {
          tMs: now,
          voice: voiceScoreRef.current,
          chat: chatN,
          motion: motionN,
        }).catch((err) =>
          console.error("[detection] failed to log signal sample:", err),
        );
      }

      if (
        comp >= detectionThreshold &&
        now - lastTriggerRef.current > detectionCooldownMs &&
        !proposalRef.current
      ) {
        lastTriggerRef.current = now;
        setMarks((m) => [...m, now].slice(-50));
        const clipId = await autoCapture(
          "composite",
          `Moment detected (${comp.toFixed(2)})`,
        );
        if (clipId !== null) {
          const next = { clipId, score: comp, at: now };
          proposalRef.current = next;
          setProposal(next);
        }
      }

      emit(DOCK_STATE_EVENT, {
        obsStatus: status,
        replayBufferActive,
        voiceScore: voiceScoreRef.current,
        chatScore: chatN,
        motionScore: motionN,
        voiceWave: voiceWaveRef.current,
        proposal: proposalRef.current,
        keptCount,
        skippedCount,
      });
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [
    status,
    captureScreenshot,
    autoCapture,
    replayBufferActive,
    keptCount,
    skippedCount,
    supportsMotion,
    detectionThreshold,
    detectionCooldownMs,
    detectionWeights,
  ]);

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
        proposal,
        keptCount,
        skippedCount,
        resolveProposal,
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
