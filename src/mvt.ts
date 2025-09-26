import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import type { Feature, Geometry, GeoJsonProperties } from 'geojson';

export interface TileBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface TileCoordinates {
  z: number;
  x: number;
  y: number;
}

/**
 * Calculate tile bounds in WGS84 coordinates
 */
export function getTileEnvelope(zoom: number, x: number, y: number): TileBounds {
  const n = 1 << zoom; // 2^zoom
  const invN = 1 / n;
  const _180_PI = 180 / Math.PI;

  // Calculate longitude
  const west = x * invN * 360 - 180;
  const east = (x + 1) * invN * 360 - 180;

  // Calculate latitude (Web Mercator to WGS84 conversion)
  const y1 = 1 - 2 * y * invN;
  const y2 = 1 - 2 * (y + 1) * invN;
  const north = Math.atan(Math.sinh(Math.PI * y1)) * _180_PI;
  const south = Math.atan(Math.sinh(Math.PI * y2)) * _180_PI;

  return {
    minLng: west,
    minLat: Math.min(north, south),
    maxLng: east,
    maxLat: Math.max(north, south)
  };
}

/**
 * Calculate simplification tolerance based on zoom level
 */
export function calculateSimplifyTolerance(zoomLevel: number): number {
  // No simplification for zoom level 15 and above
  if (zoomLevel >= 15) return 0;

  // Linear interpolation from 0.001 at zoom 0 to 0 at zoom 15
  const maxSimplify = 0.001;
  const minZoom = 0;
  const maxZoom = 15;

  const m = (0 - maxSimplify) / (maxZoom - minZoom);
  const b = maxSimplify;

  return Number((m * zoomLevel + b).toFixed(6));
}

/**
 * Convert GeoJSON features to Mapbox Vector Tile format
 */
export function geojsonToVectorTile(
  features: Feature<Geometry, GeoJsonProperties>[],
  z: number,
  x: number,
  y: number
): Uint8Array {
  if (!features || features.length === 0) {
    return new Uint8Array();
  }

  try {
    // Create tile index from GeoJSON
    const tileIndex = geojsonvt({
      type: 'FeatureCollection',
      features: features
    }, {
      generateId: true,
      indexMaxZoom: z,
      maxZoom: z,
      buffer: 0,
      tolerance: 0,
      extent: 4096  // Standard MVT resolution
    });

    // Get the specific tile
    const tile = tileIndex.getTile(z, x, y);
    if (!tile) {
      return new Uint8Array();
    }

    // Convert to Protocol Buffers format
    // Use "v" as the source-layer name
    return vtpbf.fromGeojsonVt({ "v": tile });
  } catch (error) {
    console.error('Error converting GeoJSON to vector tile:', error);
    return new Uint8Array();
  }
}

/**
 * Parse GeoJSON string and handle errors
 */
export function parseGeoJSON(geojsonStr: string): any {
  try {
    const parsed = JSON.parse(geojsonStr);
    // Validate basic GeoJSON structure
    if (!parsed || !parsed.type) {
      console.warn('Invalid GeoJSON structure');
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Error parsing GeoJSON:', error);
    return null;
  }
}