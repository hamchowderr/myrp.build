import { useCallback, useState } from "react";
import { useMapEvents } from "react-leaflet";

export function ClickCopyCoords() {
  const [copied, setCopied] = useState<string | null>(null);

  const handleClick = useCallback((e: { latlng: { lat: number; lng: number } }) => {
    const x = e.latlng.lng.toFixed(2);
    const y = e.latlng.lat.toFixed(2);
    const text = `vector3(${x}, ${y}, 0.0)`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  useMapEvents({ click: handleClick });

  if (!copied) return null;

  return (
    <div className="absolute top-2 right-2 z-[1000] rounded bg-black/80 px-2 py-1 font-mono text-[10px] text-accent-green backdrop-blur-sm">
      Copied: {copied}
    </div>
  );
}
