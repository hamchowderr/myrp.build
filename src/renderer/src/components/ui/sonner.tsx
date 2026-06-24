/**
 * App-themed sonner Toaster (the Foreman-style action feedback). Tracks the
 * app's dark/light state (the `.dark` class AppContent toggles on <html>) and
 * maps toast surfaces to the existing shadcn tokens so toasts match whatever
 * theme/preset is active. Mounted once at the App root.
 */

import { useEffect, useState } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function useHtmlTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() =>
      setTheme(el.classList.contains("dark") ? "dark" : "light"),
    );
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export function Toaster(props: ToasterProps) {
  const theme = useHtmlTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{ classNames: { toast: "font-mono text-xs", description: "text-text-muted" } }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
