import { LatLngBounds } from "leaflet";
import { useEffect, useMemo } from "react";
import { TileLayer, useMap } from "react-leaflet";

interface TileLayerWrapperProps {
  url: string;
  minZoom: number;
  maxZoom: number;
}

export function TileLayerWrapper({ url, minZoom, maxZoom }: TileLayerWrapperProps) {
  const map = useMap();

  // The GTA map occupies pixels [0,0]–[8192,8192] at max zoom. Project that to the
  // CRS's lat/lng so both the tile layer and the view constraints share one extent.
  const bounds = useMemo(
    () =>
      new LatLngBounds(
        map.unproject([0, 8192], map.getMaxZoom()),
        map.unproject([8192, 0], map.getMaxZoom()),
      ),
    [map],
  );

  // Fence the view to that extent. The CRS is `infinite`, so without this the user
  // can pan/zoom out into the empty space around the map — a tiny map adrift in
  // unloadable/empty tiles. maxBounds (hard viscosity) stops panning off the map,
  // and minZoom is pinned to the zoom where the whole map just fits the viewport,
  // so you can never zoom out past the full map. Recomputed on resize (e.g. when
  // the chat panel is toggled).
  useEffect(() => {
    map.options.maxBoundsViscosity = 1.0;
    const apply = () => {
      map.setMaxBounds(bounds);
      const fit = map.getBoundsZoom(bounds, false);
      if (Number.isFinite(fit)) map.setMinZoom(Math.max(0, fit));
    };
    apply();
    map.on("resize", apply);
    return () => {
      map.off("resize", apply);
    };
  }, [map, bounds]);

  return (
    <TileLayer key={url} bounds={bounds} noWrap url={url} minZoom={minZoom} maxZoom={maxZoom} />
  );
}
