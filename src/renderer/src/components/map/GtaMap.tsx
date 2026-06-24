import "leaflet/dist/leaflet.css";
import type { CoordinateType, ExtractedCoordinate } from "@renderer/lib/coordinate-parser";
import { MapPin, Ruler, Type } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { MapContainer } from "react-leaflet";
import { ClickCopyCoords } from "./ClickCopyCoords";
import { CustomCRS } from "./CustomCRS";
import { DistanceTool } from "./DistanceTool";
import { ExportCoords } from "./ExportCoords";
import { FitBounds } from "./FitBounds";
import { MarkerLayer } from "./MarkerLayer";
import { RightClickPlace } from "./RightClickPlace";
import { StreetNameOverlay } from "./StreetNameOverlay";
import { TileLayerWrapper } from "./TileLayerWrapper";
import { ZonePolygonLayer } from "./ZonePolygonLayer";

type MapStyle = "atlas" | "satellite" | "grid";

// Tile-source base. Defaults to the locally-bundled tiles under
// public/assets/maps. The open-source client ships WITHOUT the GTA map tiles
// (that imagery is Rockstar's), so set VITE_MAP_TILE_BASE_URL to a tile server
// — or drop your own tiles under public/assets/maps — to light up the map.
// Trailing slashes are trimmed; "{z}/{x}/{y}" stay literal for Leaflet.
const TILE_BASE = (import.meta.env.VITE_MAP_TILE_BASE_URL ?? "assets/maps").replace(/\/+$/, "");

const MAP_STYLES: Array<{
  id: MapStyle;
  label: string;
  url: string;
}> = [
  { id: "atlas", label: "Atlas", url: `${TILE_BASE}/atlas/{z}/{x}/{y}.jpg` },
  {
    id: "satellite",
    label: "Satellite",
    url: `${TILE_BASE}/satellite/{z}/{x}/{y}.jpg`,
  },
  { id: "grid", label: "Grid", url: `${TILE_BASE}/grid/{z}/{x}/{y}.png` },
];

const LAYER_CONFIG: Array<{
  type: CoordinateType;
  color: string;
  label: string;
}> = [
  { type: "blip", color: "#3b82f6", label: "Blips" },
  { type: "spawn", color: "#22c55e", label: "Spawns" },
  { type: "zone", color: "#f97316", label: "Zones" },
  { type: "shop", color: "#a855f7", label: "Shops" },
  { type: "generic", color: "#6b7280", label: "Other" },
];

interface GtaMapProps {
  coordinates: ExtractedCoordinate[];
  onMarkerClick?: (coord: ExtractedCoordinate) => void;
}

export function GtaMap({ coordinates, onMarkerClick }: GtaMapProps) {
  const [mapStyle, setMapStyle] = useState<MapStyle>("atlas");
  const [hiddenTypes, setHiddenTypes] = useState<Set<CoordinateType>>(new Set());
  const [distanceMode, setDistanceMode] = useState(false);
  const [showStreetNames, setShowStreetNames] = useState(false);

  const toggleType = (type: CoordinateType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const filteredCoords = useMemo(
    () => coordinates.filter((c) => !hiddenTypes.has(c.type)),
    [coordinates, hiddenTypes],
  );

  const presentTypes = useMemo(() => {
    const types = new Set<CoordinateType>();
    for (const c of coordinates) types.add(c.type);
    return types;
  }, [coordinates]);

  const activeStyle = MAP_STYLES.find((s) => s.id === mapStyle)!;

  const handleMarkerClick = useCallback(
    (coord: ExtractedCoordinate) => {
      onMarkerClick?.(coord);
    },
    [onMarkerClick],
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Controls bar — above the map, no overlap */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-elevated px-2 py-1">
        {/* Map style switcher */}
        <div className="flex rounded-md border border-border-subtle bg-surface">
          {MAP_STYLES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMapStyle(id)}
              className={`px-2.5 py-0.5 font-mono text-[10px] transition-colors first:rounded-l-md last:rounded-r-md ${
                mapStyle === id
                  ? "bg-accent-blue/15 text-accent-blue"
                  : "text-text-dim hover:bg-hover hover:text-text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="h-3 w-px bg-border-subtle" />

        {/* Layer toggles */}
        {LAYER_CONFIG.filter(({ type }) => presentTypes.has(type)).map(({ type, color, label }) => {
          const isHidden = hiddenTypes.has(type);
          const count = coordinates.filter((c) => c.type === type).length;
          return (
            <button
              key={type}
              type="button"
              onClick={() => toggleType(type)}
              className={`flex items-center gap-1 font-mono text-[10px] transition-opacity ${
                isHidden ? "opacity-30" : "opacity-100"
              }`}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-text-muted">{label}</span>
              <span className="text-text-dim">({count})</span>
            </button>
          );
        })}

        <div className="h-3 w-px bg-border-subtle" />

        {/* Tool toggles */}
        <button
          type="button"
          onClick={() => {
            setDistanceMode((prev) => !prev);
          }}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
            distanceMode
              ? "bg-red-500/15 text-red-400"
              : "text-text-dim hover:bg-hover hover:text-text-primary"
          }`}
          title="Measure distance between two points"
        >
          <Ruler className="size-3" />
          Measure
        </button>

        <button
          type="button"
          onClick={() => setShowStreetNames((prev) => !prev)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
            showStreetNames
              ? "bg-accent-blue/15 text-accent-blue"
              : "text-text-dim hover:bg-hover hover:text-text-primary"
          }`}
          title="Toggle area/street names"
        >
          <Type className="size-3" />
          Names
        </button>

        <div className="flex-1" />

        {/* Export buttons */}
        <ExportCoords coordinates={filteredCoords} />

        {/* Coord count + hints */}
        <span className="font-mono text-[9px] text-text-dim">
          {distanceMode
            ? "click 2 points to measure"
            : coordinates.length > 0
              ? `${filteredCoords.length} coords`
              : "L-click copy · R-click pin"}
        </span>
      </div>

      {/* Map fills remaining space */}
      <div
        className="relative min-h-0 flex-1"
        style={{
          backgroundColor: mapStyle === "grid" ? "#1a1a2e" : "#0fa7d0",
        }}
      >
        <MapContainer
          style={{ height: "100%", width: "100%" }}
          crs={CustomCRS}
          minZoom={0}
          maxZoom={5}
          center={[0, 0]}
          preferCanvas
          zoom={3}
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayerWrapper url={activeStyle.url} minZoom={0} maxZoom={5} />
          <MarkerLayer coordinates={filteredCoords} onMarkerClick={handleMarkerClick} />
          <ZonePolygonLayer coordinates={filteredCoords} />
          <StreetNameOverlay visible={showStreetNames} />
          {filteredCoords.length > 0 && <FitBounds coordinates={filteredCoords} />}
          {!distanceMode && <ClickCopyCoords />}
          <RightClickPlace />
          <DistanceTool active={distanceMode} />
        </MapContainer>

        {/* Empty state */}
        {coordinates.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-black/60 px-4 py-3 text-center backdrop-blur-sm">
              <MapPin className="mx-auto mb-1.5 size-5 text-text-dim" />
              <p className="font-mono text-xs text-text-dim">No coordinates found</p>
              <p className="mt-1 font-mono text-[9px] text-text-dim/50">
                L-click to copy coords · R-click to place pins
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
