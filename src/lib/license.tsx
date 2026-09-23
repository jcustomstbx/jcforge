import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getSetting, setSetting } from "./settings";
import { useSettings } from "./settingsContext";
import { LicenseLock } from "../screens/LicenseLock";

const FIRST_LAUNCH_KEY = "first_launch_at";
const TRIAL_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 30_000;

interface LicenseState {
  isLicensed: boolean;
  trialMsRemaining: number | null;
  activate: (key: string) => Promise<boolean>;
}

const LicenseContext = createContext<LicenseState | null>(null);

export function useLicense(): LicenseState {
  const ctx = useContext(LicenseContext);
  if (!ctx)
    throw new Error("useLicense must be used within a LicenseProvider");
  return ctx;
}

export function LicenseProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const [firstLaunchAt, setFirstLaunchAt] = useState<number | null>(null);
  const [isLicensed, setIsLicensed] = useState(false);
  const [checkingKey, setCheckingKey] = useState(true);
  const [now, setNow] = useState(Date.now());

  // Stamp the first-ever launch once, so the trial window has a fixed start.
  useEffect(() => {
    getSetting(FIRST_LAUNCH_KEY).then(async (stored) => {
      if (stored) {
        setFirstLaunchAt(new Date(stored).getTime());
        return;
      }
      const nowIso = new Date().toISOString();
      await setSetting(FIRST_LAUNCH_KEY, nowIso);
      setFirstLaunchAt(new Date(nowIso).getTime());
    });
  }, []);

  // Re-validate whatever key is stored (in case it was hand-edited) whenever
  // it changes, rather than trusting its mere presence.
  useEffect(() => {
    if (settings.loading) return;
    const key = settings.licenseKey;
    if (!key) {
      setIsLicensed(false);
      setCheckingKey(false);
      return;
    }
    setCheckingKey(true);
    invoke<boolean>("validate_license_key", { key })
      .then(setIsLicensed)
      .catch(() => setIsLicensed(false))
      .finally(() => setCheckingKey(false));
  }, [settings.loading, settings.licenseKey]);

  // Tick so the trial countdown (and the lock screen it triggers) updates
  // without needing a restart.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Time-limited keys can expire while the app is left running - re-check
  // the stored key on the same slow tick instead of only at launch, so an
  // expired key locks the app without needing a restart.
  useEffect(() => {
    const key = settings.licenseKey;
    if (!key) return;
    invoke<boolean>("validate_license_key", { key })
      .then(setIsLicensed)
      .catch(() => {});
  }, [now, settings.licenseKey]);

  const activate = useCallback(
    async (key: string): Promise<boolean> => {
      const trimmed = key.trim();
      const ok = await invoke<boolean>("validate_license_key", {
        key: trimmed,
      }).catch(() => false);
      if (ok) {
        await settings.setLicenseKey(trimmed);
        setIsLicensed(true);
      }
      return ok;
    },
    [settings],
  );

  const loading = settings.loading || checkingKey || firstLaunchAt === null;
  const trialMsRemaining =
    firstLaunchAt === null ? null : Math.max(0, firstLaunchAt + TRIAL_MS - now);
  const trialActive = trialMsRemaining !== null && trialMsRemaining > 0;

  if (loading) return null;

  if (!isLicensed && !trialActive) {
    return <LicenseLock onActivate={activate} />;
  }

  return (
    <LicenseContext.Provider value={{ isLicensed, trialMsRemaining, activate }}>
      {children}
    </LicenseContext.Provider>
  );
}
