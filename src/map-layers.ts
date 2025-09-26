import maplibregl from 'maplibre-gl';
import { registerDuckDBLayer, unregisterDuckDBLayer } from './duckdb-protocol';
import { executeSql } from './duckdb';

export interface LayerInfo {
  id: string;
  tableName: string;
  geometryColumn: string;
  propertyColumns: string[];
  visible: boolean;
}

let layerIdCounter = 0;
const activeLayers = new Map<string, LayerInfo>();

/**
 * Detect geometry columns in a table
 */
export async function detectGeometryColumns(tableName: string): Promise<string[]> {
  try {
    const result = await executeSql(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
        AND data_type ILIKE '%geometry%'
    `);

    return result.map(row => row.column_name);
  } catch (error) {
    console.error('Error detecting geometry columns:', error);
    return [];
  }
}

/**
 * Get all columns of a table
 */
export async function getTableColumns(tableName: string): Promise<string[]> {
  try {
    const result = await executeSql(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `);

    return result.map(row => row.column_name);
  } catch (error) {
    console.error('Error getting table columns:', error);
    return [];
  }
}

/**
 * Add a DuckDB table as a map layer
 */
export async function addDuckDBLayer(
  map: maplibregl.Map,
  tableName: string,
  geometryColumn: string,
  propertyColumns: string[] = []
): Promise<string | null> {
  try {
    const layerId = `duckdb-layer-${layerIdCounter++}`;

    // Register the layer configuration
    registerDuckDBLayer(layerId, {
      tableName,
      geometryColumn,
      propertyColumns
    });

    // Add source to map
    map.addSource(layerId, {
      type: 'vector',
      tiles: [`duckdb://${layerId}/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: 22
    });

    // Determine layer type based on first geometry
    let layerType: 'fill' | 'line' | 'circle' = 'circle';
    try {
      const sampleResult = await executeSql(`
        SELECT ST_GeometryType("${geometryColumn}") as geom_type
        FROM "${tableName}"
        LIMIT 1
      `);

      if (sampleResult.length > 0) {
        const geomType = sampleResult[0].geom_type?.toLowerCase() || '';
        if (geomType.includes('polygon')) {
          layerType = 'fill';
        } else if (geomType.includes('line')) {
          layerType = 'line';
        } else {
          layerType = 'circle';
        }
      }
    } catch (error) {
      console.warn('Could not determine geometry type, defaulting to circle');
    }

    // Add appropriate layer based on geometry type with vibrant colors
    if (layerType === 'fill') {
      // Polygon layer - vibrant purple
      map.addLayer({
        id: `${layerId}-fill`,
        type: 'fill',
        source: layerId,
        'source-layer': 'v',
        paint: {
          'fill-color': '#9333ea',  // Vibrant purple
          'fill-opacity': 0.7
        }
      });

      map.addLayer({
        id: `${layerId}-outline`,
        type: 'line',
        source: layerId,
        'source-layer': 'v',
        paint: {
          'line-color': '#6b21a8',  // Darker purple
          'line-width': 2
        }
      });
    } else if (layerType === 'line') {
      // Line layer - vibrant green
      map.addLayer({
        id: `${layerId}-line`,
        type: 'line',
        source: layerId,
        'source-layer': 'v',
        paint: {
          'line-color': '#10b981',  // Vibrant green
          'line-width': 3
        }
      });
    } else {
      // Point layer - vibrant red/orange
      map.addLayer({
        id: `${layerId}-circle`,
        type: 'circle',
        source: layerId,
        'source-layer': 'v',
        paint: {
          'circle-radius': 8,
          'circle-color': '#f97316',  // Vibrant orange
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2
        }
      });
    }

    // Store layer info
    activeLayers.set(layerId, {
      id: layerId,
      tableName,
      geometryColumn,
      propertyColumns,
      visible: true
    });

    // Zoom to layer bounds
    try {
      const boundsResult = await executeSql(`
        SELECT
          ST_XMin(ST_Extent("${geometryColumn}")) as min_x,
          ST_YMin(ST_Extent("${geometryColumn}")) as min_y,
          ST_XMax(ST_Extent("${geometryColumn}")) as max_x,
          ST_YMax(ST_Extent("${geometryColumn}")) as max_y
        FROM "${tableName}"
      `);

      if (boundsResult.length > 0 && boundsResult[0].min_x !== null) {
        const bounds = boundsResult[0];
        map.fitBounds([
          [bounds.min_x, bounds.min_y],
          [bounds.max_x, bounds.max_y]
        ], { padding: 50 });
      }
    } catch (error) {
      console.warn('Could not fit bounds to layer');
    }

    console.log(`Added DuckDB layer: ${layerId} for table ${tableName}`);
    return layerId;

  } catch (error) {
    console.error('Error adding DuckDB layer:', error);
    return null;
  }
}

/**
 * Remove a DuckDB layer from the map
 */
export function removeDuckDBLayer(map: maplibregl.Map, layerId: string): void {
  const layerInfo = activeLayers.get(layerId);
  if (!layerInfo) return;

  // Remove all related map layers
  const mapLayers = [`${layerId}-fill`, `${layerId}-outline`, `${layerId}-line`, `${layerId}-circle`];
  for (const id of mapLayers) {
    if (map.getLayer(id)) {
      map.removeLayer(id);
    }
  }

  // Remove source
  if (map.getSource(layerId)) {
    map.removeSource(layerId);
  }

  // Unregister from protocol
  unregisterDuckDBLayer(layerId);

  // Remove from active layers
  activeLayers.delete(layerId);

  console.log(`Removed DuckDB layer: ${layerId}`);
}

/**
 * Toggle layer visibility
 */
export function toggleLayerVisibility(map: maplibregl.Map, layerId: string): void {
  const layerInfo = activeLayers.get(layerId);
  if (!layerInfo) return;

  const visibility = !layerInfo.visible;
  layerInfo.visible = visibility;

  const mapLayers = [`${layerId}-fill`, `${layerId}-outline`, `${layerId}-line`, `${layerId}-circle`];
  for (const id of mapLayers) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility ? 'visible' : 'none');
    }
  }
}

/**
 * Get all active layers
 */
export function getActiveLayers(): LayerInfo[] {
  return Array.from(activeLayers.values());
}