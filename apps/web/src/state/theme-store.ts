import { create } from "zustand";

/** Light/dark theme, persisted. Applies the `dark` class to <html>. */
type Theme = "light" | "dark";

interface ThemeState {
  theme: Theme;
  toggle(): void;
  set(theme: Theme): void;
}

function apply(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("voltcad.theme", theme);
  } catch {
    /* private mode */
  }
}

function initial(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = localStorage.getItem("voltcad.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initial(),
  toggle() {
    get().set(get().theme === "dark" ? "light" : "dark");
  },
  set(theme) {
    set({ theme });
    apply(theme);
  },
}));

// apply persisted theme on module load (client only)
if (typeof window !== "undefined") apply(useThemeStore.getState().theme);
