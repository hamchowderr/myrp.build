import type { ExtractedCoordinate } from "@renderer/lib/coordinate-parser";
import type { LatLngExpression } from "leaflet";
import { useMemo } from "react";
import { Polygon, Tooltip } from "react-leaflet";

interface ZonePolygonLayerProps {
  coordinates: ExtractedCoordinate[];
}

/**
 * Groups zone-type coordinates by source file and renders them as polygons.
 * If a file has 3+ zone coords, they form a polygon. Otherwise they're just markers.
 */
export function ZonePolygonLayer({ coordinates }: ZonePolygonLayerProps) {
  const polygons = useMemo(() => {
    const zoneCoords = coordinates.filter((c) => c.type === "zone");

    // Group by source file
    const byFile = new Map<string, ExtractedCoordinate[]>();
    for (const c of zoneCoords) {
      const key = c.source.file;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)?.push(c);
    }

    // Only files with 3+ zone coords can form polygons
    const result: Array<{
      file: string;
      positions: LatLngExpression[];
      count: number;
    }> = [];

    for (const [file, coords] of byFile) {
      if (coords.length < 3) continue;
      // Sort by line number to maintain definition order
      const sorted = [...coords].sort((a, b) => a.source.line - b.source.line);
      result.push({
        file,
        positions: sorted.map((c) => [c.y, c.x] as LatLngExpression),
        count: sorted.length,
      });
    }

    return result;
  }, [coordinates]);

  if (polygons.length === 0) return null;

  return (
    <>
      {polygons.map((poly) => (
        <Polygon
          key={poly.file}
          positions={poly.positions}
          pathOptions={{
            color: "#f97316",
            weight: 2,
            opacity: 0.7,
            fillColor: "#f97316",
            fillOpacity: 0.15,
          }}
        >
          <Tooltip sticky>
            <span style={{ fontFamily: "monospace", fontSize: 10 }}>
              {poly.file} ({poly.count} points)
            </span>
          </Tooltip>
        </Polygon>
      ))}
    </>
  );
}
