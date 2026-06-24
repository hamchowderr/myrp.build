import L from "leaflet";
import { useCallback, useState } from "react";
import { Marker, Popup, useMapEvents } from "react-leaflet";

interface PlacedPin {
  lat: number;
  lng: number;
  id: number;
}

const pinIcon = L.divIcon({
  html: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6" fill="#ef4444" stroke="#fff" stroke-width="2" opacity="0.9"/>
    <circle cx="8" cy="8" r="2" fill="#fff"/>
  </svg>`,
  className: "",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  popupAnchor: [0, -10],
});

let nextId = 1;

export function RightClickPlace() {
  const [pins, setPins] = useState<PlacedPin[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleContextMenu = useCallback((e: L.LeafletMouseEvent) => {
    const pin: PlacedPin = {
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      id: nextId++,
    };
    setPins((prev) => [...prev, pin]);
  }, []);

  useMapEvents({ contextmenu: handleContextMenu });

  const copyVector3 = useCallback((pin: PlacedPin) => {
    const x = pin.lng.toFixed(2);
    const y = pin.lat.toFixed(2);
    const text = `vector3(${x}, ${y}, 0.0)`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(pin.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  const copyAllAsTable = useCallback(() => {
    if (pins.length === 0) return;
    const lines = pins.map((p) => `    vector3(${p.lng.toFixed(2)}, ${p.lat.toFixed(2)}, 0.0),`);
    const text = `{\n${lines.join("\n")}\n}`;
    navigator.clipboard.writeText(text);
  }, [pins]);

  const removePin = useCallback((id: number) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setPins([]);
  }, []);

  return (
    <>
      {pins.map((pin) => (
        <Marker key={pin.id} position={[pin.lat, pin.lng]} icon={pinIcon}>
          <Popup>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.6,
                minWidth: 200,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Placed Pin</div>
              <div>
                <span style={{ color: "#888" }}>x:</span> {pin.lng.toFixed(2)},{" "}
                <span style={{ color: "#888" }}>y:</span> {pin.lat.toFixed(2)}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                <button
                  type="button"
                  onClick={() => copyVector3(pin)}
                  style={{
                    background: copiedId === pin.id ? "#22c55e" : "#3b82f6",
                    color: "#fff",
                    border: "none",
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontSize: 10,
                    cursor: "pointer",
                    fontFamily: "monospace",
                  }}
                >
                  {copiedId === pin.id ? "Copied!" : "Copy vector3"}
                </button>
                <button
                  type="button"
                  onClick={() => removePin(pin.id)}
                  style={{
                    background: "transparent",
                    color: "#ef4444",
                    border: "1px solid #ef4444",
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontSize: 10,
                    cursor: "pointer",
                    fontFamily: "monospace",
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* Floating controls when pins are placed */}
      {pins.length > 0 && (
        <div className="absolute bottom-2 right-2 z-[1000] flex items-center gap-1.5 rounded bg-black/80 px-2 py-1 backdrop-blur-sm">
          <span className="font-mono text-[9px] text-text-dim">
            {pins.length} pin{pins.length !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={copyAllAsTable}
            className="rounded bg-accent-blue/80 px-2 py-0.5 font-mono text-[9px] text-white hover:bg-accent-blue"
          >
            Copy Lua table
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="rounded px-1.5 py-0.5 font-mono text-[9px] text-red-400 hover:bg-red-500/20"
          >
            Clear
          </button>
        </div>
      )}
    </>
  );
}
