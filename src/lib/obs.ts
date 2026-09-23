import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BackendContext, type BackendState } from "./backend";
import { setMicLevelValue } from "./micLevelStore";

export type ObsConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface ObsVideoSettings {
  outputWidth: number;
  outputHeight: number;
  fps: number;
}

export interface ObsState {
  status: ObsConnectionStatus;
  error: string | null;
  url: string;
  obsVersion: string | null;
  websocketVersion: string | null;
  replayBufferActive: boolean | null;
  micInputName: string | null;
  sceneName: string | null;
  sceneChangedAt: number;
  videoSettings: ObsVideoSettings | null;
  connect: (url?: string, password?: string) => void;
  disconnect: () => void;
  triggerManualCapture: () => Promise<string | null>;
  captureScreenshot: () => Promise<string | null>;
  getRecordDirectory: () => Promise<string | null>;
}

const DEFAULT_URL = "ws://127.0.0.1:4455";
const RECONNECT_DELAY_MS = 3000;
// Retrying every 3s forever while OBS simply isn't open yet (e.g. the
// streamer hasn't launched it, or won't this session) was continuous
// background CPU/log spam with no cap - back off exponentially instead,
// capping so a real OBS restart is still noticed reasonably quickly.
const MAX_RECONNECT_DELAY_MS = 60_000;

// OBS's built-in "Audio Input Capture" source kinds across platforms - used
// to auto-pick a mic input without needing a settings UI yet.
const MIC_INPUT_KINDS = [
  "wasapi_input_capture",
  "coreaudio_input_capture",
  "pulse_input_capture",
  "alsa_input_capture",
];

interface InputListItem {
  inputName: string;
  inputKind: string;
}

const ObsContext = createContext<ObsState | null>(null);

export function ObsProvider({ children }: { children: ReactNode }) {
  const obsRef = useRef<OBSWebSocket | null>(null);
  const micInputNameRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ObsConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [obsVersion, setObsVersion] = useState<string | null>(null);
  const [websocketVersion, setWebsocketVersion] = useState<string | null>(
    null,
  );
  const [replayBufferActive, setReplayBufferActive] = useState<
    boolean | null
  >(null);
  const [micInputName, setMicInputNameState] = useState<string | null>(null);
  const [sceneName, setSceneNameState] = useState<string | null>(null);
  const [sceneChangedAt, setSceneChangedAt] = useState<number>(0);
  const [videoSettings, setVideoSettings] = useState<ObsVideoSettings | null>(
    null,
  );
  const sceneNameRef = useRef<string | null>(null);
  // Auto-reconnect after an unexpected drop (OBS closed/crashed, network
  // blip) - without this, one disconnect silently ends detection for the
  // rest of the session with no way back short of the manual retry click.
  // Only a deliberate disconnect() call suppresses it.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const deliberateDisconnectRef = useRef(false);
  const connectRef = useRef<(url?: string, password?: string) => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (deliberateDisconnectRef.current || reconnectTimerRef.current !== null) return;
    const delay = Math.min(
      RECONNECT_DELAY_MS * 2 ** reconnectAttemptRef.current,
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  }, []);

  const setMicInputName = useCallback((name: string | null) => {
    micInputNameRef.current = name;
    setMicInputNameState(name);
  }, []);

  const setSceneName = useCallback((name: string | null) => {
    sceneNameRef.current = name;
    setSceneNameState(name);
  }, []);

  useEffect(() => {
    const obs = new OBSWebSocket();
    obsRef.current = obs;

    obs.on("ConnectionClosed", () => {
      setStatus("disconnected");
      setObsVersion(null);
      setWebsocketVersion(null);
      setReplayBufferActive(null);
      setMicInputName(null);
      setMicLevelValue(null);
      setSceneName(null);
      setVideoSettings(null);
      scheduleReconnect();
    });

    obs.on("ReplayBufferStateChanged", (data) => {
      setReplayBufferActive(data.outputActive);
    });

    obs.on("CurrentProgramSceneChanged", (data) => {
      setSceneName(data.sceneName);
      setSceneChangedAt(Date.now());
    });

    obs.on("InputVolumeMeters", (data) => {
      const target = micInputNameRef.current;
      if (!target) return;
      const inputs = data.inputs as unknown as Array<{
        inputName: string;
        inputLevelsMul: number[][];
      }>;
      const match = inputs.find((i) => i.inputName === target);
      if (!match || match.inputLevelsMul.length === 0) return;
      // inputLevelsMul[channel] = [magnitude, peak, inputPeak] per the
      // obs-websocket protocol; take the loudest channel's peak.
      const peak = Math.max(
        ...match.inputLevelsMul.map((ch) => ch[1] ?? 0),
      );
      setMicLevelValue(peak);
    });

    return () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      obs.disconnect();
      obsRef.current = null;
    };
  }, [setMicInputName, setSceneName]);

  const connect = useCallback((nextUrl?: string, password?: string) => {
    const obs = obsRef.current;
    if (!obs) return;
    deliberateDisconnectRef.current = false;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const target = nextUrl ?? url;
    setUrl(target);
    setStatus("connecting");
    setError(null);

    obs
      .connect(target, password, {
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
      })
      .then(async () => {
        reconnectAttemptRef.current = 0;
        setStatus("connected");
        const version = await obs.call("GetVersion");
        setObsVersion(version.obsVersion);
        setWebsocketVersion(version.obsWebSocketVersion);
        try {
          const replayStatus = await obs.call("GetReplayBufferStatus");
          setReplayBufferActive(replayStatus.outputActive);
        } catch {
          // Replay buffer output doesn't exist until it's been started at
          // least once in OBS - that's not a connection failure.
          setReplayBufferActive(false);
        }
        try {
          const { inputs } = await obs.call("GetInputList");
          const mic = (inputs as unknown as InputListItem[]).find((i) =>
            MIC_INPUT_KINDS.includes(i.inputKind),
          );
          setMicInputName(mic?.inputName ?? null);
        } catch (err) {
          console.error("[obs] failed to list inputs:", err);
          setMicInputName(null);
        }
        try {
          const scene = await obs.call("GetCurrentProgramScene");
          setSceneName(scene.sceneName);
        } catch (err) {
          console.error("[obs] failed to get current scene:", err);
        }
        try {
          const v = await obs.call("GetVideoSettings");
          setVideoSettings({
            outputWidth: v.outputWidth,
            outputHeight: v.outputHeight,
            fps: v.fpsNumerator / v.fpsDenominator,
          });
        } catch (err) {
          console.error("[obs] failed to get video settings:", err);
        }
      })
      .catch((err: unknown) => {
        setStatus("error");
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        console.error("[obs] connect failed:", target, err);
        scheduleReconnect();
      });
  }, [url, setMicInputName, setSceneName, scheduleReconnect]);

  connectRef.current = connect;

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    const obs = obsRef.current;
    const scene = sceneNameRef.current;
    if (!obs || status !== "connected" || !scene) return null;
    try {
      const { imageData } = await obs.call("GetSourceScreenshot", {
        sourceName: scene,
        imageFormat: "jpg",
        imageWidth: 64,
        imageCompressionQuality: 30,
      });
      return imageData;
    } catch (err) {
      console.error("[obs] screenshot failed:", err);
      return null;
    }
  }, [status]);

  const getRecordDirectory = useCallback(async (): Promise<string | null> => {
    const obs = obsRef.current;
    if (!obs || status !== "connected") return null;
    try {
      const { recordDirectory } = await obs.call("GetRecordDirectory");
      return recordDirectory;
    } catch (err) {
      console.error("[obs] failed to get record directory:", err);
      return null;
    }
  }, [status]);

  const triggerManualCapture = useCallback(async (): Promise<string | null> => {
    const obs = obsRef.current;
    if (!obs || status !== "connected") return null;
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          obs.off("ReplayBufferSaved", onSaved);
          reject(
            new Error("Timed out waiting for OBS to save the replay buffer"),
          );
        }, 10000);
        const onSaved = (data: { savedReplayPath: string }) => {
          clearTimeout(timeout);
          resolve(data.savedReplayPath);
        };
        obs.once("ReplayBufferSaved", onSaved);
        obs.call("SaveReplayBuffer").catch((err: unknown) => {
          clearTimeout(timeout);
          obs.off("ReplayBufferSaved", onSaved);
          reject(err);
        });
      });
    } catch (err) {
      console.error("[obs] manual capture failed:", err);
      return null;
    }
  }, [status]);

  const disconnect = useCallback(() => {
    deliberateDisconnectRef.current = true;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    obsRef.current?.disconnect();
    setStatus("disconnected");
    setObsVersion(null);
    setWebsocketVersion(null);
    setReplayBufferActive(null);
    setMicInputName(null);
    setMicLevelValue(null);
    setSceneName(null);
    setVideoSettings(null);
  }, [setMicInputName, setSceneName]);

  useEffect(() => {
    connect(DEFAULT_URL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: ObsState = {
    status,
    error,
    url,
    obsVersion,
    websocketVersion,
    replayBufferActive,
    micInputName,
    sceneName,
    sceneChangedAt,
    videoSettings,
    connect,
    disconnect,
    triggerManualCapture,
    captureScreenshot,
    getRecordDirectory,
  };

  const backendValue: BackendState = {
    status,
    error,
    replayBufferActive,
    sceneName,
    sceneChangedAt,
    supportsMotion: true,
    triggerManualCapture,
    captureScreenshot,
  };

  return createElement(
    ObsContext.Provider,
    { value },
    createElement(BackendContext.Provider, { value: backendValue }, children),
  );
}

export function useObs(): ObsState {
  const ctx = useContext(ObsContext);
  if (!ctx) throw new Error("useObs must be used within an ObsProvider");
  return ctx;
}

/** Non-throwing variant for components (e.g. NavRail) that render
 * regardless of which recording backend is active - BackendRouter mounts
 * only one of ObsProvider/StreamlabsProvider at a time, so a component
 * shown in both cases can't assume ObsContext exists. */
export function useObsOptional(): ObsState | null {
  return useContext(ObsContext);
}
