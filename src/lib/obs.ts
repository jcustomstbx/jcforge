import OBSWebSocket from "obs-websocket-js";
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
  connect: (url?: string, password?: string) => void;
  disconnect: () => void;
}

const DEFAULT_URL = "ws://127.0.0.1:4455";

const ObsContext = createContext<ObsState | null>(null);

export function ObsProvider({ children }: { children: ReactNode }) {
  const obsRef = useRef<OBSWebSocket | null>(null);
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

  useEffect(() => {
    const obs = new OBSWebSocket();
    obsRef.current = obs;

    obs.on("ConnectionClosed", () => {
      setStatus("disconnected");
      setObsVersion(null);
      setWebsocketVersion(null);
      setReplayBufferActive(null);
    });

    obs.on("ReplayBufferStateChanged", (data) => {
      setReplayBufferActive(data.outputActive);
    });

    return () => {
      obs.disconnect();
      obsRef.current = null;
    };
  }, []);

  const connect = useCallback((nextUrl?: string, password?: string) => {
    const obs = obsRef.current;
    if (!obs) return;
    const target = nextUrl ?? url;
    setUrl(target);
    setStatus("connecting");
    setError(null);

    obs
      .connect(target, password)
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
      })
      .catch((err: unknown) => {
        setStatus("error");
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        console.error("[obs] connect failed:", target, err);
      });
  }, [url]);

  const disconnect = useCallback(() => {
    obsRef.current?.disconnect();
    setStatus("disconnected");
    setObsVersion(null);
    setWebsocketVersion(null);
    setReplayBufferActive(null);
  }, []);

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
    connect,
    disconnect,
  };

  return createElement(ObsContext.Provider, { value }, children);
}

export function useObs(): ObsState {
  const ctx = useContext(ObsContext);
  if (!ctx) throw new Error("useObs must be used within an ObsProvider");
  return ctx;
}
