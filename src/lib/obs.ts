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

export type ObsConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface ObsState {
  status: ObsConnectionStatus;
  error: string | null;
  url: string;
  obsVersion: string | null;
  websocketVersion: string | null;
  replayBufferActive: boolean | null;
  micInputName: string | null;
  micLevel: number | null;
  sceneName: string | null;
  sceneChangedAt: number;
  connect: (url?: string, password?: string) => void;
  disconnect: () => void;
  triggerManualCapture: () => Promise<string | null>;
  captureScreenshot: () => Promise<string | null>;
}

const DEFAULT_URL = "ws://127.0.0.1:4455";

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
  const [micLevel, setMicLevel] = useState<number | null>(null);
  const [sceneName, setSceneNameState] = useState<string | null>(null);
  const [sceneChangedAt, setSceneChangedAt] = useState<number>(0);
  const sceneNameRef = useRef<string | null>(null);

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
      setMicLevel(null);
      setSceneName(null);
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
      setMicLevel(peak);
    });

    return () => {
      obs.disconnect();
      obsRef.current = null;
    };
  }, [setMicInputName, setSceneName]);

  const connect = useCallback((nextUrl?: string, password?: string) => {
    const obs = obsRef.current;
    if (!obs) return;
    const target = nextUrl ?? url;
    setUrl(target);
    setStatus("connecting");
    setError(null);

    obs
      .connect(target, password, {
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
      })
      .then(async () => {
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
      })
      .catch((err: unknown) => {
        setStatus("error");
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        console.error("[obs] connect failed:", target, err);
      });
  }, [url, setMicInputName, setSceneName]);

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
    obsRef.current?.disconnect();
    setStatus("disconnected");
    setObsVersion(null);
    setWebsocketVersion(null);
    setReplayBufferActive(null);
    setMicInputName(null);
    setMicLevel(null);
    setSceneName(null);
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
    micLevel,
    sceneName,
    sceneChangedAt,
    connect,
    disconnect,
    triggerManualCapture,
    captureScreenshot,
  };

  return createElement(ObsContext.Provider, { value }, children);
}

export function useObs(): ObsState {
  const ctx = useContext(ObsContext);
  if (!ctx) throw new Error("useObs must be used within an ObsProvider");
  return ctx;
}
