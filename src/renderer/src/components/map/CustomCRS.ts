import type { LatLng } from "leaflet";
import L from "leaflet";

const center_x = 117.3;
const center_y = 172.8;
const scale_x = 0.02072;
const scale_y = 0.0205;

export const CustomCRS = L.extend({}, L.CRS.Simple, {
  projection: L.Projection.LonLat,
  scale(zoom: number) {
    return 2 ** zoom;
  },
  zoom(sc: number) {
    return Math.log(sc) / Math.LN2;
  },
  distance(pos1: LatLng, pos2: LatLng) {
    const dx = pos2.lng - pos1.lng;
    const dy = pos2.lat - pos1.lat;
    return Math.sqrt(dx * dx + dy * dy);
  },
  transformation: new L.Transformation(scale_x, center_x, -scale_y, center_y),
  infinite: true,
});
