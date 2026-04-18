import { NavLink, useLocation } from "react-router-dom";
import { CanopyIcon } from "./CanopyIcon";

const navItems = [
  { path: "/", icon: "🏠", label: "Dashboard" },
  { path: "/integrations", icon: "🔗", label: "Integrations", badge: "6" },
  { path: "/data-flows", icon: "🔄", label: "Data Flows", badge: "2" },
  { path: "/payments", icon: "💳", label: "Payments" },
  { path: "/security", icon: "🛡️", label: "Security" },
];

export function Sidebar() {
  const location = useLocation();

  return (
    <aside className="w-[220px] bg-canopy-surface border-r border-canopy-border flex flex-col p-3 gap-1">
      {/* Logo + drag region */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2.5 px-3 py-1 mb-5"
      >
        <CanopyIcon size={32} />
        <span className="text-lg font-bold text-canopy-text tracking-tight">
          Canopy
        </span>
      </div>

      {/* Navigation */}
      {navItems.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all text-sm ${
              isActive
                ? "bg-canopy-surface-hover text-canopy-text font-semibold"
                : "text-canopy-text-muted hover:bg-canopy-surface-hover/50"
            }`}
          >
            <span className="text-[15px] w-5 text-center">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.badge && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent">
                {item.badge}
              </span>
            )}
          </NavLink>
        );
      })}

      <div className="flex-1" />

      {/* OrbStack status */}
      <div className="px-3 py-2.5 bg-canopy-surface-hover rounded-lg border border-canopy-border">
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-1.5 h-1.5 rounded-full bg-canopy-active" />
          <span className="text-[10px] text-canopy-text-muted">OrbStack</span>
        </div>
        <div className="text-[10px] text-canopy-sleeping">
          4 containers · 1.2 GB RAM
        </div>
      </div>

      {/* Settings */}
      <NavLink
        to="/settings"
        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all text-sm ${
          location.pathname === "/settings"
            ? "bg-canopy-surface-hover text-canopy-text font-semibold"
            : "text-canopy-text-muted hover:bg-canopy-surface-hover/50"
        }`}
      >
        <span className="text-[15px] w-5 text-center">⚙️</span>
        <span>Settings</span>
      </NavLink>
    </aside>
  );
}
