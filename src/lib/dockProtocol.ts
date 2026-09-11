// Event contract shared between the main window (source of truth for
// detection) and the floating dock window - Tauri broadcasts emit()/listen()
// across all windows in the app, so no server or shared state store needed.

export const DOCK_STATE_EVENT = "dock-state";
export const DOCK_ACTION_EVENT = "dock-action";

export interface DockProposal {
  clipId: number;
  score: number;
  at: number;
}

export interface DockState {
  obsStatus: string;
  replayBufferActive: boolean | null;
  voiceScore: number;
  chatScore: number;
  motionScore: number;
  voiceWave: number[];
  proposal: DockProposal | null;
  keptCount: number;
  skippedCount: number;
}

export interface DockAction {
  action: "keep" | "skip";
  clipId: number;
}
