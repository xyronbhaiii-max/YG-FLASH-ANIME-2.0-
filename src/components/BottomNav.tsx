import React from "react";
import { Home, Search, Clock, MoreHorizontal } from "lucide-react";
import { useApp } from "../context/AppContext";

export const BottomNav: React.FC = () => {
  const { currentView, navigateTo } = useApp();

  const navItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "search", label: "Search", icon: Search },
    { id: "history", label: "History", icon: Clock },
    { id: "more", label: "More", icon: MoreHorizontal },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 glass-panel border-t border-[var(--border-subtle)] pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="grid grid-cols-4 items-center h-16 max-w-lg mx-auto px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive =
            currentView === item.id ||
            (item.id === "more" && ["admin", "admin-login", "settings"].includes(currentView));

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id)}
              className="flex flex-col items-center justify-center min-h-[48px] py-1 transition-colors duration-100 active:scale-95"
            >
              <div
                className={`flex items-center justify-center w-9 h-7 rounded-full transition-colors duration-100 ${
                  isActive
                    ? "text-[var(--primary)]"
                    : "text-[var(--text-muted)] hover:text-white"
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? "stroke-[2.5]" : "stroke-[1.8]"}`} />
              </div>
              <span
                className={`text-[10px] font-medium tracking-tight mt-0.5 transition-colors ${
                  isActive ? "text-[var(--primary)] font-bold" : "text-[var(--text-muted)]"
                }`}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
