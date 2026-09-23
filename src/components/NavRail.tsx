import { useEffect, useState } from "react";
import {
  Activity,
  CircleDot,
  Disc,
  Film,
  PanelRight,
  Plug,
  Scissors,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useClips } from "../lib/clips";
import { useSettings } from "../lib/settingsContext";
import { useObsOptional } from "../lib/obs";
import type { ScreenId } from "../types";
import "./NavRail.css";

interface DiskSpace {
  free_bytes: number;
  total_bytes: number;
}

// No API exposes the streamer's actual encoder bitrate short of parsing
// OBS profile config files, so this is a labeled estimate for a
// commonly-used high-quality capture setting, not a live reading of the
// user's real settings - matches what the original placeholder caption
// text ("1440p120 headroom") already implied: a reference tier, not
// "your exact current bitrate".
const ESTIMATED_1440P120_MBPS = 50;
const ESTIMATED_BYTES_PER_SECOND = (ESTIMATED_1440P120_MBPS * 1_000_000) / 8;
const DISK_SPACE_POLL_MS = 60_000;

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(0)} GB free`;
}

function formatMinutes(bytes: number): string {
  const minutes = bytes / ESTIMATED_BYTES_PER_SECOND / 60;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} hr`;
  return `${Math.round(minutes)} min`;
}

interface NavItem {
  id: ScreenId;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

interface NavRailProps {
  active: ScreenId;
  onNavigate: (id: ScreenId) => void;
}

export function NavRail({ active, onNavigate }: NavRailProps) {
  const { clips } = useClips();
  const settings = useSettings();
  const obs = useObsOptional();
  const [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const folder =
        settings.recordingBackend === "streamlabs"
          ? settings.streamlabsReplayFolder
          : await obs?.getRecordDirectory().catch(() => null);
      if (!folder) {
        if (!cancelled) setDiskSpace(null);
        return;
      }
      try {
        const space = await invoke<DiskSpace>("get_disk_space", { path: folder });
        if (!cancelled) setDiskSpace(space);
      } catch {
        if (!cancelled) setDiskSpace(null);
      }
    };

    refresh();
    // Free space changes slowly relative to a UI element sitting in the
    // sidebar the whole session - a minute-scale poll is plenty fresh
    // without adding meaningful background cost.
    const interval = setInterval(refresh, DISK_SPACE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [settings.recordingBackend, settings.streamlabsReplayFolder, obs]);

  const navGroups: { label: string; items: NavItem[] }[] = [
    {
      label: "CAPTURE",
      items: [
        { id: "live", label: "Live session", icon: CircleDot },
        { id: "sources", label: "Sources", icon: Plug },
        { id: "dock", label: "OBS dock", icon: PanelRight },
      ],
    },
    {
      label: "PRODUCE",
      items: [
        {
          id: "library",
          label: "Clip library",
          icon: Film,
          badge: clips.length > 0 ? String(clips.length) : undefined,
        },
        { id: "editor", label: "Clip editor", icon: Scissors },
        { id: "ai-edit", label: "AI edit", icon: Sparkles },
      ],
    },
    {
      label: "SETUP",
      items: [
        { id: "detection", label: "Detection", icon: Activity },
        { id: "recording", label: "Recording", icon: Disc },
      ],
    },
  ];

  return (
    <nav className="nav-rail">
      {navGroups.map((group) => (
        <div key={group.label} className="nav-rail__group">
          <div className="nav-rail__group-label">{group.label}</div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <div
                key={item.id}
                className={
                  "nav-rail__item" +
                  (isActive ? " nav-rail__item--active" : "")
                }
                onClick={() => onNavigate(item.id)}
              >
                <span className="nav-rail__icon">
                  <Icon size={14} strokeWidth={2} />
                </span>
                <span className="nav-rail__label">{item.label}</span>
                <div className="nav-rail__spacer" />
                {item.badge && (
                  <span className="nav-rail__badge">{item.badge}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="nav-rail__spacer" />
      <div className="nav-rail__footer">
        <div className="nav-rail__footer-row">
          <span>SSD buffer</span>
          <span className="nav-rail__footer-value">
            {diskSpace ? formatGb(diskSpace.free_bytes) : "—"}
          </span>
        </div>
        <div className="nav-rail__footer-track">
          <div
            className="nav-rail__footer-fill"
            style={{
              width: diskSpace
                ? `${Math.min(100, (1 - diskSpace.free_bytes / diskSpace.total_bytes) * 100)}%`
                : "0%",
            }}
          />
        </div>
        <div className="nav-rail__footer-caption">
          {diskSpace ? formatMinutes(diskSpace.free_bytes) : "—"} of 1440p120 headroom
        </div>
      </div>
    </nav>
  );
}
