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

interface SettingsState {
  twitchChannel: string | null;
  loading: boolean;
  setTwitchChannel: (channel: string) => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [twitchChannel, setTwitchChannelState] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSetting(TWITCH_CHANNEL_KEY)
      .then(setTwitchChannelState)
      .finally(() => setLoading(false));
  }, []);

  const setTwitchChannel = useCallback(async (channel: string) => {
    const trimmed = channel.trim().toLowerCase();
    await setSetting(TWITCH_CHANNEL_KEY, trimmed);
    setTwitchChannelState(trimmed);
  }, []);

  return (
    <SettingsContext.Provider
      value={{ twitchChannel, loading, setTwitchChannel }}
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
