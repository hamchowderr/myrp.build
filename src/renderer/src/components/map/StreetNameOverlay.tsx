import L from "leaflet";
import { Marker } from "react-leaflet";

interface AreaLabel {
  name: string;
  x: number;
  y: number;
}

// Major GTA V neighborhoods/areas with approximate center coordinates
const AREA_LABELS: AreaLabel[] = [
  // Los Santos core
  { name: "Downtown", x: 134, y: -725 },
  { name: "Vinewood", x: 300, y: -950 },
  { name: "Rockford Hills", x: -500, y: -800 },
  { name: "Vespucci", x: -1100, y: -1450 },
  { name: "Del Perro", x: -1600, y: -900 },
  { name: "Little Seoul", x: -700, y: -950 },
  { name: "Strawberry", x: 200, y: -1250 },
  { name: "Davis", x: 100, y: -1700 },
  { name: "Rancho", x: 500, y: -1600 },
  { name: "La Mesa", x: 800, y: -1100 },
  { name: "El Burro Heights", x: 1600, y: -1200 },
  { name: "Cypress Flats", x: 700, y: -1700 },
  { name: "Terminal", x: 900, y: -2400 },
  { name: "LSIA", x: -900, y: -2950 },
  { name: "Elysian Island", x: 250, y: -2900 },
  { name: "Pacific Bluffs", x: -2200, y: -400 },
  { name: "Chumash", x: -3200, y: 50 },
  { name: "Tongva Hills", x: -2000, y: 200 },
  { name: "Banham Canyon", x: -2900, y: -500 },
  // Vinewood Hills / north
  { name: "Vinewood Hills", x: -100, y: 350 },
  { name: "Mirror Park", x: 1100, y: -700 },
  { name: "Tataviam Mountains", x: -400, y: 1200 },
  // Blaine County
  { name: "Sandy Shores", x: 1800, y: 3700 },
  { name: "Grapeseed", x: 1700, y: 4800 },
  { name: "Paleto Bay", x: -200, y: 6400 },
  { name: "Mt. Chiliad", x: 500, y: 5700 },
  { name: "Harmony", x: 550, y: 2700 },
  { name: "Grand Senora Desert", x: -300, y: 2600 },
  { name: "Zancudo", x: -2200, y: 3200 },
  { name: "Fort Zancudo", x: -2500, y: 3300 },
  { name: "Lago Zancudo", x: -1800, y: 4200 },
  { name: "Paleto Forest", x: -700, y: 5500 },
  { name: "Mt. Gordo", x: 2800, y: 5700 },
  { name: "Raton Canyon", x: -1300, y: 4700 },
  // Cayo Perico
  { name: "Cayo Perico", x: 4700, y: -5700 },
];

function createLabelIcon(name: string) {
  return L.divIcon({
    html: `<span style="
      font-family:monospace;font-size:9px;color:rgba(255,255,255,0.55);
      text-shadow:0 1px 3px rgba(0,0,0,0.8);white-space:nowrap;
      pointer-events:none;letter-spacing:0.5px;
    ">${name}</span>`,
    className: "",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

interface StreetNameOverlayProps {
  visible: boolean;
}

export function StreetNameOverlay({ visible }: StreetNameOverlayProps) {
  if (!visible) return null;

  return (
    <>
      {AREA_LABELS.map((area) => (
        <Marker
          key={area.name}
          position={[area.y, area.x]}
          icon={createLabelIcon(area.name)}
          interactive={false}
        />
      ))}
    </>
  );
}
