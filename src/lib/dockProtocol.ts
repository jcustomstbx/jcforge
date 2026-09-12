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

export interface DockResolution {
  type: "kept" | "skipped";
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
  /** The most recent Keep/Skip resolution (manual or auto-approved) - the
   * dock flashes a brief confirmation off this rather than staying silent,
   * since a click that just silently reverts to "Watching for moments…"
   * with no feedback is hard to trust actually registered. */
  lastResolution: DockResolution | null;
  keptCount: number;
  skippedCount: number;
}

export interface DockAction {
  action: "keep" | "skip";
  clipId: number;
}
