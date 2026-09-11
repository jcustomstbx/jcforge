import { invoke } from "@tauri-apps/api/core";
import SockJS from "sockjs-client";
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
import { useSettings } from "./settingsContext";

export type StreamlabsConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface StreamlabsState {
  status: StreamlabsConnectionStatus;
  error: string | null;
  replayBufferActive: boolean | null;
  sceneName: string | null;
  sceneChangedAt: number;
  triggerManualCapture: () => Promise<string | null>;
}

const STREAMLABS_URL = "http://127.0.0.1:59650/api";
const POLL_MS = 2000;
const SAVE_TIMEOUT_MS = 15000;

// Streamlabs' JSON-RPC 2.0 protocol over a SockJS socket - confirmed against
// their own example client (index.html in the remote-control docs). Not
// obs-websocket-compatible; this is a completely separate wire format.
interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

class StreamlabsClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private authed = false;

  onOpenError: ((err: unknown) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    private url: string,
    private token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // sockjs-client's typings model it as a WebSocket-shaped object.
      const socket = new SockJS(this.url) as unknown as WebSocket;
      this.socket = socket;

      socket.onmessage = (event: MessageEvent) => {
        let message: RpcResponse;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.error) {
          waiting.reject(new Error(message.error.message ?? "Streamlabs RPC error"));
        } else {
          waiting.resolve(message.result);
        }
      };

      socket.onclose = () => {
        this.authed = false;
        this.onClose?.();
      };

      socket.onerror = (err: unknown) => {
        if (!this.authed) reject(err);
        this.onOpenError?.(err);
      };

      socket.onopen = () => {
        this.request("TcpServerService", "auth", [this.token])
          .then(() => {
            this.authed = true;
            resolve();
          })
          .catch(reject);
      };
    });
  }

  disconnect(): void {
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.authed = false;
  }

  request(resource: string, method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) {
        reject(new Error("Streamlabs socket is not open"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: { resource, args },
        }),
      );
    });
  }
}

// Streamlabs' external API gives no live audio meters, no screenshot API,
// and no saved-replay-path field on IStreamingState - all confirmed by
// reading their published interfaces/source. Scene name and replay-buffer
// state are read by polling getModel()/activeScene() rather than wiring up
// their observable-subscription mechanism, since no concrete example of
// that wire protocol could be found without a live instance to test
// against; this may need adjustment once tested against a real install.
const REPLAY_INACTIVE_STATUSES = ["offline", "stopping"];

function isReplayActive(status: unknown): boolean | null {
  if (typeof status !== "string" || status.length === 0) return null;
  return !REPLAY_INACTIVE_STATUSES.includes(status.toLowerCase());
}

const StreamlabsContext = createContext<StreamlabsState | null>(null);

export function StreamlabsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const { streamlabsToken, streamlabsReplayFolder } = settings;
  const clientRef = useRef<StreamlabsClient | null>(null);

  const [status, setStatus] = useState<StreamlabsConnectionStatus>(
    "disconnected",
  );
  const [error, setError] = useState<string | null>(null);
  const [replayBufferActive, setReplayBufferActive] = useState<
    boolean | null
  >(null);
  const [sceneName, setSceneNameState] = useState<string | null>(null);
  const [sceneChangedAt, setSceneChangedAt] = useState(0);
  const sceneNameRef = useRef<string | null>(null);

  const setSceneName = useCallback((name: string | null) => {
    if (name !== sceneNameRef.current) {
      sceneNameRef.current = name;
      setSceneNameState(name);
      setSceneChangedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!streamlabsToken) {
      setStatus("disconnected");
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const client = new StreamlabsClient(STREAMLABS_URL, streamlabsToken);
    clientRef.current = client;
    setStatus("connecting");
    setError(null);

    client.onClose = () => {
      if (cancelled) return;
      setStatus("disconnected");
      setReplayBufferActive(null);
      setSceneName(null);
    };

    client
      .connect()
      .then(() => {
        if (cancelled) return;
        setStatus("connected");
        pollTimer = setInterval(async () => {
          try {
            const model = (await client.request(
              "StreamingService",
              "getModel",
            )) as { replayBufferStatus?: unknown } | null;
            setReplayBufferActive(isReplayActive(model?.replayBufferStatus));
          } catch (err) {
            console.error("[streamlabs] getModel poll failed:", err);
          }
          try {
            const scene = (await client.request(
              "ScenesService",
              "activeScene",
            )) as { name?: string } | null;
            if (scene?.name) setSceneName(scene.name);
          } catch (err) {
            console.error("[streamlabs] activeScene poll failed:", err);
          }
        }, POLL_MS);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        console.error("[streamlabs] connect failed:", err);
      });

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      client.disconnect();
      clientRef.current = null;
    };
  }, [streamlabsToken, setSceneName]);

  const triggerManualCapture = useCallback(async (): Promise<string | null> => {
    const client = clientRef.current;
    if (!client || status !== "connected") return null;
    if (!streamlabsReplayFolder) {
      console.error("[streamlabs] no replay folder configured");
      return null;
    }
    const requestedAt = Date.now();
    try {
      await client.request("StreamingService", "saveReplay");
    } catch (err) {
      console.error("[streamlabs] saveReplay failed:", err);
      return null;
    }

    const deadline = Date.now() + SAVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const found = await invoke<string | null>("find_newest_file_since", {
          dir: streamlabsReplayFolder,
          afterEpochMs: requestedAt,
        });
        if (found) return found;
      } catch (err) {
        console.error("[streamlabs] find_newest_file_since failed:", err);
        return null;
      }
    }
    console.error("[streamlabs] timed out waiting for saved replay file");
    return null;
  }, [status, streamlabsReplayFolder]);

  const captureScreenshot = useCallback(
    async (): Promise<string | null> => null,
    [],
  );

  const value: StreamlabsState = {
    status,
    error,
    replayBufferActive,
    sceneName,
    sceneChangedAt,
    triggerManualCapture,
  };

  const backendValue: BackendState = {
    status,
    error,
    replayBufferActive,
    sceneName,
    sceneChangedAt,
    supportsMotion: false,
    triggerManualCapture,
    captureScreenshot,
  };

  return createElement(
    StreamlabsContext.Provider,
    { value },
    createElement(BackendContext.Provider, { value: backendValue }, children),
  );
}

export function useStreamlabs(): StreamlabsState {
  const ctx = useContext(StreamlabsContext);
  if (!ctx)
    throw new Error("useStreamlabs must be used within a StreamlabsProvider");
  return ctx;
}
