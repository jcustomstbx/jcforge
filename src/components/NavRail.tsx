import {
  Activity,
  CircleDot,
  Disc,
  Film,
  PanelRight,
  Plug,
  Scissors,
  type LucideIcon,
} from "lucide-react";
import type { ScreenId } from "../types";
import "./NavRail.css";

interface NavItem {
  id: ScreenId;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
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
      { id: "library", label: "Clip library", icon: Film },
      { id: "editor", label: "Clip editor", icon: Scissors },
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

interface NavRailProps {
  active: ScreenId;
  onNavigate: (id: ScreenId) => void;
}

export function NavRail({ active, onNavigate }: NavRailProps) {
  return (
    <nav className="nav-rail">
      {NAV_GROUPS.map((group) => (
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
          <span className="nav-rail__footer-value">—</span>
        </div>
        <div className="nav-rail__footer-track">
          <div className="nav-rail__footer-fill" style={{ width: "0%" }} />
        </div>
        <div className="nav-rail__footer-caption">
          — min of 1440p120 headroom
        </div>
      </div>
    </nav>
  );
}
