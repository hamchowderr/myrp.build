import type { CoordinateType, ExtractedCoordinate } from "@renderer/lib/coordinate-parser";
import L from "leaflet";
import { Marker, Popup } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";

const MARKER_COLORS: Record<CoordinateType, string> = {
  blip: "#3b82f6", // blue
  spawn: "#22c55e", // green
  zone: "#f97316", // orange
  shop: "#a855f7", // purple
  generic: "#6b7280", // gray
};

function createIcon(type: CoordinateType) {
  const color = MARKER_COLORS[type];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
    <circle cx="6" cy="6" r="5" fill="${color}" stroke="#000" stroke-width="1.5" opacity="0.9"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -8],
  });
}

function createClusterIcon(cluster: { getChildCount(): number }) {
  const count = cluster.getChildCount();
  const size = count < 10 ? 28 : count < 50 ? 34 : 40;
  return L.divIcon({
    html: `<div style="
      display:flex;align-items:center;justify-content:center;
      width:${size}px;height:${size}px;border-radius:50%;
      background:rgba(59,130,246,0.8);border:2px solid rgba(255,255,255,0.6);
      color:#fff;font-family:monospace;font-size:11px;font-weight:600;
    ">${count}</div>`,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const iconCache = new Map<CoordinateType, L.DivIcon>();
function getIcon(type: CoordinateType) {
  if (!iconCache.has(type)) iconCache.set(type, createIcon(type));
  return iconCache.get(type)!;
}

interface MarkerLayerProps {
  coordinates: ExtractedCoordinate[];
  onMarkerClick?: (coord: ExtractedCoordinate) => void;
}

export function MarkerLayer({ coordinates, onMarkerClick }: MarkerLayerProps) {
  return (
    <MarkerClusterGroup
      chunkedLoading
      maxClusterRadius={40}
      spiderfyOnMaxZoom
      iconCreateFunction={createClusterIcon}
    >
      {coordinates.map((coord, i) => (
        <Marker
          key={`${coord.x},${coord.y},${coord.z}-${i}`}
          position={[coord.y, coord.x]}
          icon={getIcon(coord.type)}
          eventHandlers={{
            click: () => onMarkerClick?.(coord),
          }}
        >
          <Popup>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.4,
                minWidth: 180,
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: 4,
                  textTransform: "capitalize",
                }}
              >
                {coord.type}
              </div>
              <div>
                <span style={{ color: "#888" }}>x:</span> {coord.x.toFixed(2)},{" "}
                <span style={{ color: "#888" }}>y:</span> {coord.y.toFixed(2)},{" "}
                <span style={{ color: "#888" }}>z:</span> {coord.z.toFixed(2)}
              </div>
              <div style={{ marginTop: 4, color: "#888" }}>
                {coord.source.file}:{coord.source.line}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  color: "#aaa",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 220,
                }}
              >
                {coord.source.context}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MarkerClusterGroup>
  );
}
