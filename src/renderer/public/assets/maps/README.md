# Map tiles

The in-app GTA coordinate/map tool (`src/renderer/src/components/map/`) renders
Leaflet tiles from this folder by default. **Tiles are not shipped with the
open-source client** — that map imagery is Rockstar's, and we don't redistribute
it. The map feature still works; you just provide the tiles.

## Turn the map on

Pick either option:

**A. Point at a tile host.** Set `VITE_MAP_TILE_BASE_URL` in your `.env` to a
server that serves `{z}/{x}/{y}` tiles, e.g. your own Supabase Storage bucket:

```
VITE_MAP_TILE_BASE_URL=https://<your-project>.supabase.co/storage/v1/object/public/map-tiles
```

**B. Drop tiles in here.** Leave `VITE_MAP_TILE_BASE_URL` blank and place tile
pyramids in this folder so the paths resolve:

```
assets/maps/atlas/{z}/{x}/{y}.jpg
assets/maps/satellite/{z}/{x}/{y}.jpg
assets/maps/grid/{z}/{x}/{y}.png
```

This folder (except this README) is gitignored, so your tiles won't be committed.
