import type { ExtractedCoordinate } from "@renderer/lib/coordinate-parser";
import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";

interface FitBoundsProps {
  coordinates: ExtractedCoordinate[];
}

export function FitBounds({ coordinates }: FitBoundsProps) {
  const map = useMap();

  useEffect(() => {
    if (coordinates.length === 0) return;

    const bounds = L.latLngBounds(coordinates.map((c) => L.latLng(c.y, c.x)));

    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
  }, [coordinates, map]);

  return null;
}
