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
const DETECTION_THRESHOLD_KEY = "detection_threshold";
const DETECTION_COOLDOWN_MS_KEY = "detection_cooldown_ms";
const DETECTION_WEIGHTS_KEY = "detection_weights";
const LICENSE_KEY_KEY = "license_key";
const AUTO_APPROVE_DETECTIONS_KEY = "auto_approve_detections";
const GEMINI_API_KEY_KEY = "gemini_api_key";

export type RecordingBackendId = "obs" | "streamlabs";

export interface DetectionWeights {
  voice: number;
  chat: number;
  motion: number;
}

// Defaults from the design doc's detection model.
export const DEFAULT_DETECTION_THRESHOLD = 0.72;
export const DEFAULT_DETECTION_COOLDOWN_MS = 45_000;
export const DEFAULT_DETECTION_WEIGHTS: DetectionWeights = {
  voice: 0.85,
  chat: 0.7,
  motion: 0.55,
};

function parseWeights(raw: string | null): DetectionWeights {
  if (!raw) return DEFAULT_DETECTION_WEIGHTS;
  try {
    const parsed = JSON.parse(raw);
    return {
      voice: typeof parsed.voice === "number" ? parsed.voice : DEFAULT_DETECTION_WEIGHTS.voice,
      chat: typeof parsed.chat === "number" ? parsed.chat : DEFAULT_DETECTION_WEIGHTS.chat,
      motion: typeof parsed.motion === "number" ? parsed.motion : DEFAULT_DETECTION_WEIGHTS.motion,
    };
  } catch {
    return DEFAULT_DETECTION_WEIGHTS;
  }
}

interface SettingsState {
  twitchChannel: string | null;
  recordingBackend: RecordingBackendId;
  streamlabsToken: string | null;
  streamlabsReplayFolder: string | null;
  detectionThreshold: number;
  detectionCooldownMs: number;
  detectionWeights: DetectionWeights;
  licenseKey: string | null;
  /** true = a detected moment is captured and kept immediately, no dock
   * Keep/Skip prompt. false (default) = the existing behaviour: capture,
   * then wait for a Keep/Skip decision in the dock. */
  autoApproveDetections: boolean;
  /** User's own Gemini API key for the embedded AI-editing feature - brings
   * their own key/billing, JCForge never ships a shared one. */
  geminiApiKey: string | null;
  loading: boolean;
  setTwitchChannel: (channel: string) => Promise<void>;
  setRecordingBackend: (backend: RecordingBackendId) => Promise<void>;
  setStreamlabsToken: (token: string) => Promise<void>;
  setStreamlabsReplayFolder: (folder: string) => Promise<void>;
  setDetectionThreshold: (threshold: number) => Promise<void>;
  setDetectionCooldownMs: (cooldownMs: number) => Promise<void>;
  setDetectionWeights: (weights: DetectionWeights) => Promise<void>;
  setLicenseKey: (key: string) => Promise<void>;
  setAutoApproveDetections: (auto: boolean) => Promise<void>;
  setGeminiApiKey: (key: string) => Promise<void>;
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
  const [detectionThreshold, setDetectionThresholdState] = useState(
    DEFAULT_DETECTION_THRESHOLD,
  );
  const [detectionCooldownMs, setDetectionCooldownMsState] = useState(
    DEFAULT_DETECTION_COOLDOWN_MS,
  );
  const [detectionWeights, setDetectionWeightsState] = useState<DetectionWeights>(
    DEFAULT_DETECTION_WEIGHTS,
  );
  const [licenseKey, setLicenseKeyState] = useState<string | null>(null);
  const [autoApproveDetections, setAutoApproveDetectionsState] = useState(false);
  const [geminiApiKey, setGeminiApiKeyState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getSetting(TWITCH_CHANNEL_KEY),
      getSetting(RECORDING_BACKEND_KEY),
      getSetting(STREAMLABS_TOKEN_KEY),
      getSetting(STREAMLABS_REPLAY_FOLDER_KEY),
      getSetting(DETECTION_THRESHOLD_KEY),
      getSetting(DETECTION_COOLDOWN_MS_KEY),
      getSetting(DETECTION_WEIGHTS_KEY),
      getSetting(LICENSE_KEY_KEY),
      getSetting(AUTO_APPROVE_DETECTIONS_KEY),
      getSetting(GEMINI_API_KEY_KEY),
    ])
      .then(
        ([
          channel,
          backend,
          token,
          folder,
          threshold,
          cooldown,
          weights,
          license,
          autoApprove,
          geminiKey,
        ]) => {
          setTwitchChannelState(channel);
          if (backend === "obs" || backend === "streamlabs") {
            setRecordingBackendState(backend);
          }
          setStreamlabsTokenState(token);
          setStreamlabsReplayFolderState(folder);
          if (threshold) setDetectionThresholdState(Number(threshold));
          if (cooldown) setDetectionCooldownMsState(Number(cooldown));
          setDetectionWeightsState(parseWeights(weights));
          setLicenseKeyState(license);
          setAutoApproveDetectionsState(autoApprove === "true");
          setGeminiApiKeyState(geminiKey);
        },
      )
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

  const setDetectionThreshold = useCallback(async (threshold: number) => {
    await setSetting(DETECTION_THRESHOLD_KEY, String(threshold));
    setDetectionThresholdState(threshold);
  }, []);

  const setDetectionCooldownMs = useCallback(async (cooldownMs: number) => {
    await setSetting(DETECTION_COOLDOWN_MS_KEY, String(cooldownMs));
    setDetectionCooldownMsState(cooldownMs);
  }, []);

  const setDetectionWeights = useCallback(async (weights: DetectionWeights) => {
    await setSetting(DETECTION_WEIGHTS_KEY, JSON.stringify(weights));
    setDetectionWeightsState(weights);
  }, []);

  const setLicenseKey = useCallback(async (key: string) => {
    const trimmed = key.trim();
    await setSetting(LICENSE_KEY_KEY, trimmed);
    setLicenseKeyState(trimmed);
  }, []);

  const setAutoApproveDetections = useCallback(async (auto: boolean) => {
    await setSetting(AUTO_APPROVE_DETECTIONS_KEY, String(auto));
    setAutoApproveDetectionsState(auto);
  }, []);

  const setGeminiApiKey = useCallback(async (key: string) => {
    const trimmed = key.trim();
    await setSetting(GEMINI_API_KEY_KEY, trimmed);
    setGeminiApiKeyState(trimmed);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        twitchChannel,
        recordingBackend,
        streamlabsToken,
        streamlabsReplayFolder,
        detectionThreshold,
        detectionCooldownMs,
        detectionWeights,
        licenseKey,
        autoApproveDetections,
        geminiApiKey,
        loading,
        setTwitchChannel,
        setRecordingBackend,
        setStreamlabsToken,
        setStreamlabsReplayFolder,
        setDetectionThreshold,
        setDetectionCooldownMs,
        setDetectionWeights,
        setLicenseKey,
        setAutoApproveDetections,
        setGeminiApiKey,
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
