import { useState, type ComponentType, type ReactNode } from "react";
import { TitleBar } from "./components/TitleBar";
import { NavRail } from "./components/NavRail";
import { ObsProvider } from "./lib/obs";
import { StreamlabsProvider } from "./lib/streamlabs";
import { useCpalMicCapture } from "./lib/micCapture";
import { ClipsProvider } from "./lib/clips";
import { CaptureProvider } from "./lib/capture";
import { SettingsProvider, useSettings } from "./lib/settingsContext";
import { LicenseProvider } from "./lib/license";
import { DetectionProvider } from "./lib/detection";
import { NavigationProvider } from "./lib/navigation";
import { LiveSession } from "./screens/LiveSession";
import { Sources } from "./screens/Sources";
import { ObsDock } from "./screens/ObsDock";
import { ClipLibrary } from "./screens/ClipLibrary";
import { ClipEditor } from "./screens/ClipEditor";
import { Detection } from "./screens/Detection";
import { Recording } from "./screens/Recording";
import { AiEdit } from "./screens/AiEdit";
import type { ScreenId } from "./types";
import "./App.css";

const SCREENS: Record<ScreenId, ComponentType> = {
  live: LiveSession,
  sources: Sources,
  dock: ObsDock,
  library: ClipLibrary,
  editor: ClipEditor,
  detection: Detection,
  recording: Recording,
  "ai-edit": AiEdit,
};

// Mounts whichever recording backend is selected in settings, defaulting to
// OBS while settings are still loading. Direct mic capture (cpal) only runs
// under Streamlabs - OBS's own InputVolumeMeters event covers voice level.
function BackendRouter({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const useStreamlabs =
    !settings.loading && settings.recordingBackend === "streamlabs";

  useCpalMicCapture(useStreamlabs);

  if (useStreamlabs) {
    return <StreamlabsProvider>{children}</StreamlabsProvider>;
  }
  return <ObsProvider>{children}</ObsProvider>;
}

function App() {
  const [screen, setScreen] = useState<ScreenId>("live");
  const Screen = SCREENS[screen];

  return (
    <SettingsProvider>
      <LicenseProvider>
        <BackendRouter>
          <ClipsProvider>
            <CaptureProvider>
              <DetectionProvider>
                <NavigationProvider navigate={setScreen}>
                  <div className="app-shell">
                    <TitleBar />
                    <div className="app-shell__body">
                      <NavRail active={screen} onNavigate={setScreen} />
                      <main className="app-shell__content">
                        <Screen />
                      </main>
                    </div>
                  </div>
                </NavigationProvider>
              </DetectionProvider>
            </CaptureProvider>
          </ClipsProvider>
        </BackendRouter>
      </LicenseProvider>
    </SettingsProvider>
  );
}

export default App;
