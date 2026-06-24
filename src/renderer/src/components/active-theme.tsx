import { DEFAULT_THEME, type ThemeType } from "@renderer/lib/themes";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

type ThemeContextType = {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function loadTheme(): ThemeType {
  try {
    const stored = localStorage.getItem("fivem-studio-theme");
    if (stored) {
      const parsed = JSON.parse(stored);
      return { preset: "default", radius: "default", scale: "none", ...parsed };
    }
  } catch {}
  return { ...DEFAULT_THEME };
}

export function ActiveThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeType>(loadTheme);

  function setTheme(next: ThemeType) {
    setThemeState(next);
    localStorage.setItem("fivem-studio-theme", JSON.stringify(next));
  }

  useEffect(() => {
    const body = document.body;

    if (theme.preset !== "default") {
      body.setAttribute("data-theme-preset", theme.preset);
    } else {
      body.removeAttribute("data-theme-preset");
    }

    if (theme.radius !== "default") {
      body.setAttribute("data-theme-radius", theme.radius);
    } else {
      body.removeAttribute("data-theme-radius");
    }

    // Scale
    if (theme.scale !== "none") {
      body.setAttribute("data-theme-scale", theme.scale);
    } else {
      body.removeAttribute("data-theme-scale");
    }
  }, [theme.preset, theme.radius, theme.scale]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useThemeConfig() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useThemeConfig must be used within an ActiveThemeProvider");
  }
  return context;
}
