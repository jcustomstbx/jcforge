import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getSetting, setSetting } from "./settings";

const TWITCH_CHANNEL_KEY = "twitch_channel";
const RECORDING_BACKEND_KEY = "recording_backend";
const STREAMLABS_TOKEN_KEY = "streamlabs_token";
const STREAMLABS_REPLAY_FOLDER_KEY = "streamlabs_replay_folder";

export type RecordingBackendId = "obs" | "streamlabs";

interface SettingsState {
  twitchChannel: string | null;
  recordingBackend: RecordingBackendId;
  streamlabsToken: string | null;
  streamlabsReplayFolder: string | null;
  loading: boolean;
  setTwitchChannel: (channel: string) => Promise<void>;
  setRecordingBackend: (backend: RecordingBackendId) => Promise<void>;
  setStreamlabsToken: (token: string) => Promise<void>;
  setStreamlabsReplayFolder: (folder: string) => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [twitchChannel, setTwitchChannelState] = useState<string | null>(
    null,
  );
  const [recordingBackend, setRecordingBackendState] =
    useState<RecordingBackendId>("obs");
  const [streamlabsToken, setStreamlabsTokenState] = useState<string | null>(
    null,
  );
  const [streamlabsReplayFolder, setStreamlabsReplayFolderState] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getSetting(TWITCH_CHANNEL_KEY),
      getSetting(RECORDING_BACKEND_KEY),
      getSetting(STREAMLABS_TOKEN_KEY),
      getSetting(STREAMLABS_REPLAY_FOLDER_KEY),
    ])
      .then(([channel, backend, token, folder]) => {
        setTwitchChannelState(channel);
        if (backend === "obs" || backend === "streamlabs") {
          setRecordingBackendState(backend);
        }
        setStreamlabsTokenState(token);
        setStreamlabsReplayFolderState(folder);
      })
      .finally(() => setLoading(false));
  }, []);

  const setTwitchChannel = useCallback(async (channel: string) => {
    const trimmed = channel.trim().toLowerCase();
    await setSetting(TWITCH_CHANNEL_KEY, trimmed);
    setTwitchChannelState(trimmed);
  }, []);

  const setRecordingBackend = useCallback(
    async (backend: RecordingBackendId) => {
      await setSetting(RECORDING_BACKEND_KEY, backend);
      setRecordingBackendState(backend);
    },
    [],
  );

  const setStreamlabsToken = useCallback(async (token: string) => {
    const trimmed = token.trim();
    await setSetting(STREAMLABS_TOKEN_KEY, trimmed);
    setStreamlabsTokenState(trimmed);
  }, []);

  const setStreamlabsReplayFolder = useCallback(async (folder: string) => {
    const trimmed = folder.trim();
    await setSetting(STREAMLABS_REPLAY_FOLDER_KEY, trimmed);
    setStreamlabsReplayFolderState(trimmed);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        twitchChannel,
        recordingBackend,
        streamlabsToken,
        streamlabsReplayFolder,
        loading,
        setTwitchChannel,
        setRecordingBackend,
        setStreamlabsToken,
        setStreamlabsReplayFolder,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext);
  if (!ctx)
    throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
