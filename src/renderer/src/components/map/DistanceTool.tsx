import type { LatLng } from "leaflet";
import { useCallback, useState } from "react";
import { CircleMarker, Polyline, Tooltip, useMapEvents } from "react-leaflet";

interface DistanceToolProps {
  active: boolean;
}

/**
 * When active, click two points to measure GTA V distance between them.
 * Shows a line and the distance in game units.
 */
export function DistanceTool({ active }: DistanceToolProps) {
  const [points, setPoints] = useState<LatLng[]>([]);

  const handleClick = useCallback(
    (e: { latlng: LatLng }) => {
      if (!active) return;
      setPoints((prev) => {
        if (prev.length >= 2) return [e.latlng]; // Reset after 2 points
        return [...prev, e.latlng];
      });
    },
    [active],
  );

  useMapEvents({ click: handleClick });

  if (!active || points.length === 0) return null;

  // Calculate GTA V distance (Leaflet latlng = gameY, gameX)
  const distance =
    points.length === 2
      ? Math.sqrt((points[1].lng - points[0].lng) ** 2 + (points[1].lat - points[0].lat) ** 2)
      : 0;

  return (
    <>
      {points.map((p, i) => (
        <CircleMarker
          key={i}
          center={p}
          radius={4}
          pathOptions={{
            color: "#ef4444",
            fillColor: "#ef4444",
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]}>
            <span style={{ fontFamily: "monospace", fontSize: 9 }}>
              {p.lng.toFixed(1)}, {p.lat.toFixed(1)}
            </span>
          </Tooltip>
        </CircleMarker>
      ))}

      {points.length === 2 && (
        <>
          <Polyline
            positions={points}
            pathOptions={{
              color: "#ef4444",
              weight: 2,
              dashArray: "6 4",
              opacity: 0.8,
            }}
          />
          <CircleMarker
            center={[(points[0].lat + points[1].lat) / 2, (points[0].lng + points[1].lng) / 2]}
            radius={0}
          >
            <Tooltip permanent direction="top" offset={[0, -4]}>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#ef4444",
                }}
              >
                {distance.toFixed(1)} units
              </span>
            </Tooltip>
          </CircleMarker>
        </>
      )}
    </>
  );
}
