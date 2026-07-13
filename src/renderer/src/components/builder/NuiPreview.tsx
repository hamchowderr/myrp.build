import { useEffect, useMemo, useRef, useState } from "react";
import { buildInlinedHtml } from "./nui-preview-builder";

// The virtual game resolution NUIs are authored against. We render the iframe at
// this fixed size (so absolute / vw-vh / fixed layouts look exactly as in-game),
// then scale the rendered UI to fit the pane.
const STAGE_W = 1920;
const STAGE_H = 1080;

type Rect = { x: number; y: number; w: number; h: number };
type Screen = { id: string; label: string; overlay?: boolean };

export function NuiPreview({ absolutePath, content }: { absolutePath: string; content: string }) {
  const [inlinedHtml, setInlinedHtml] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // The rendered UI's bounding box inside the stage, reported by the preview iframe
  // — lets us fit the ACTUAL content, not the whole transparent 1920×1080 stage.
  const [contentRect, setContentRect] = useState<Rect | null>(null);
  // Detected screens (tab panels / menus / modals) for the switcher (step 4).
  const [screens, setScreens] = useState<Screen[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBuilding(true);
    setContentRect(null);
    setScreens([]);
    setSelected(null);
    buildInlinedHtml(content, absolutePath).then((html) => {
      if (!cancelled) {
        setInlinedHtml(html);
        setBuilding(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content, absolutePath]);

  // Track the pane size so the fit recomputes on resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width && height) setPane({ w: width, h: height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Receive content bounds + the screen list from the preview iframe.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        source?: string;
        type?: string;
        rect?: Rect;
        screens?: Screen[];
      } | null;
      if (!d || d.source !== "nui-preview") return;
      if (d.type === "bounds" && d.rect) setContentRect(d.rect);
      if (d.type === "screens" && Array.isArray(d.screens)) {
        setScreens(d.screens);
        setSelected((cur) => cur ?? d.screens?.[0]?.id ?? null);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const showScreen = (id: string) => {
    setSelected(id);
    iframeRef.current?.contentWindow?.postMessage(
      { source: "nui-preview-host", type: "showScreen", id },
      "*",
    );
  };

  // Scale + center the rendered UI (or the whole stage until bounds arrive) to fit
  // the pane. Capped so a tiny HUD isn't blown up to an absurd size.
  const transform = useMemo(() => {
    if (!pane.w || !pane.h) return "scale(0.5)";
    const rect = contentRect ?? { x: 0, y: 0, w: STAGE_W, h: STAGE_H };
    const s = Math.min((pane.w / rect.w) * 0.94, (pane.h / rect.h) * 0.94, 1.6);
    const tx = pane.w / 2 - (rect.x + rect.w / 2) * s;
    const ty = pane.h / 2 - (rect.y + rect.h / 2) * s;
    return `translate(${tx}px, ${ty}px) scale(${s})`;
  }, [pane, contentRect]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      // Dark checkerboard backdrop — transparent NUIs (HUDs/overlays) read as
      // overlays, and the checker signals "this area is transparent" (step 3).
      style={{
        backgroundColor: "#0b0b0e",
        backgroundImage: "repeating-conic-gradient(#16161c 0% 25%, #0b0b0e 0% 50%)",
        backgroundSize: "22px 22px",
      }}
    >
      {/* Screen switcher — pick which screen/modal to view (step 4). */}
      {screens.length > 1 && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-md border border-white/10 bg-black/60 px-2 py-1 backdrop-blur-sm">
          <span className="text-[10px] text-white/50 uppercase tracking-wide">Screen</span>
          <select
            value={selected ?? ""}
            onChange={(e) => showScreen(e.target.value)}
            className="max-w-[160px] rounded bg-transparent text-[11px] text-white/90 outline-none [&>option]:bg-neutral-900"
          >
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.overlay ? " ·modal" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {building ? (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-muted-foreground text-xs">
          Building preview…
        </div>
      ) : (
        <div
          className="absolute top-0 left-0 overflow-hidden"
          style={{
            width: STAGE_W,
            height: STAGE_H,
            transform,
            transformOrigin: "0 0",
            transition: "transform 180ms ease",
          }}
        >
          <iframe
            ref={iframeRef}
            srcDoc={inlinedHtml ?? ""}
            className="border-0"
            style={{ width: STAGE_W, height: STAGE_H, backgroundColor: "transparent" }}
            sandbox="allow-scripts"
            title="NUI Preview"
          />
        </div>
      )}
    </div>
  );
}
