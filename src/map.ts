import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

let map: maplibregl.Map | null = null;

export function initializeMap(): maplibregl.Map {
  if (map) {
    return map;
  }

  // Initialize the map
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        'osm-tiles': {
          type: 'raster',
          tiles: [
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors'
        }
      },
      layers: [
        {
          id: 'osm-tiles',
          type: 'raster',
          source: 'osm-tiles',
          minzoom: 0,
          maxzoom: 19
        }
      ]
    },
    center: [139.7, 35.7], // Tokyo
    zoom: 10
  });

  // Add navigation controls
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Add scale control
  map.addControl(new maplibregl.ScaleControl({
    maxWidth: 200,
    unit: 'metric'
  }), 'bottom-left');

  // Add fullscreen control
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');

  console.log('Map initialized');

  return map;
}

export function getMap(): maplibregl.Map | null {
  return map;
}