import { useState, type ComponentType } from "react";
import { TitleBar } from "./components/TitleBar";
import { NavRail } from "./components/NavRail";
import { ObsProvider } from "./lib/obs";
import { ClipsProvider } from "./lib/clips";
import { CaptureProvider } from "./lib/capture";
import { NavigationProvider } from "./lib/navigation";
import { LiveSession } from "./screens/LiveSession";
import { Sources } from "./screens/Sources";
import { ObsDock } from "./screens/ObsDock";
import { ClipLibrary } from "./screens/ClipLibrary";
import { ClipEditor } from "./screens/ClipEditor";
import { Detection } from "./screens/Detection";
import { Recording } from "./screens/Recording";
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
};

function App() {
  const [screen, setScreen] = useState<ScreenId>("live");
  const Screen = SCREENS[screen];

  return (
    <ObsProvider>
      <ClipsProvider>
        <CaptureProvider>
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
        </CaptureProvider>
      </ClipsProvider>
    </ObsProvider>
  );
}

export default App;
