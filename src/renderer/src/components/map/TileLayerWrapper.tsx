import { LatLngBounds } from "leaflet";
import { TileLayer, useMap } from "react-leaflet";

interface TileLayerWrapperProps {
  url: string;
  minZoom: number;
  maxZoom: number;
}

export function TileLayerWrapper({ url, minZoom, maxZoom }: TileLayerWrapperProps) {
  const map = useMap();
  return (
    <TileLayer
      key={url}
      keepBuffer={64}
      bounds={
        new LatLngBounds(
          map.unproject([0, 8192], map.getMaxZoom()),
          map.unproject([8192, 0], map.getMaxZoom()),
        )
      }
      noWrap
      url={url}
      minZoom={minZoom}
      maxZoom={maxZoom}
    />
  );
}
