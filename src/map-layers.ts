import maplibregl from 'maplibre-gl';
import { registerDuckDBLayer, unregisterDuckDBLayer } from './duckdb-protocol';
import { executeSql } from './duckdb';

export interface LayerInfo {
  id: string;
  tableName: string;
  geometryColumn: string;
  propertyColumns: string[];
  visible: boolean;
  indexName?: string;
}

let spatialIndexEnabled = true;

export function setSpatialIndexEnabled(enabled: boolean): void {
  spatialIndexEnabled = enabled;
}

export function isSpatialIndexEnabled(): boolean {
  return spatialIndexEnabled;
}

/**
 * Toggle spatial indexes for all active layers
 */
export async function toggleSpatialIndexes(enabled: boolean): Promise<void> {
  spatialIndexEnabled = enabled;

  if (enabled) {
    // Create indexes for all active layers that don't have them
    for (const layer of activeLayers.values()) {
      if (!layer.indexName) {
        const indexName = await createSpatialIndex(layer.tableName, layer.geometryColumn);
        if (indexName) {
          layer.indexName = indexName;
        }
      }
    }
  } else {
    // Drop all indexes
    for (const layer of activeLayers.values()) {
      if (layer.indexName) {
        await dropSpatialIndex(layer.indexName);
        layer.indexName = undefined;
      }
    }
  }
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
 * Create a spatial index on a geometry column
 */
async function createSpatialIndex(
  tableName: string,
  geometryColumn: string
): Promise<string | null> {
  if (!spatialIndexEnabled) {
    return null;
  }

  try {
    const indexName = `idx_${tableName}_${geometryColumn}`;

    // Check if index already exists
    const existingIndexResult = await executeSql(`
      SELECT index_name
      FROM duckdb_indexes()
      WHERE table_name = '${tableName}' AND index_name = '${indexName}'
    `);

    if (existingIndexResult.length > 0) {
      console.log(`Spatial index ${indexName} already exists`);
      return indexName;
    }

    // Create R-Tree spatial index
    await executeSql(`
      CREATE INDEX ${indexName} ON "${tableName}" USING RTREE("${geometryColumn}")
    `);

    console.log(`✅ Created spatial index: ${indexName}`);
    return indexName;
  } catch (error) {
    console.error('Failed to create spatial index:', error);
    return null;
  }
}

/**
 * Drop a spatial index
 */
async function dropSpatialIndex(indexName: string): Promise<void> {
  try {
    await executeSql(`DROP INDEX IF EXISTS ${indexName}`);
    console.log(`Dropped spatial index: ${indexName}`);
  } catch (error) {
    console.error('Failed to drop spatial index:', error);
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

    // Create spatial index if enabled
    const indexName = await createSpatialIndex(tableName, geometryColumn);

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
      visible: true,
      indexName: indexName || undefined
    });

    // Add click handler for popups
    setupFeatureInteraction(map, layerId, layerType);

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
export async function removeDuckDBLayer(map: maplibregl.Map, layerId: string): Promise<void> {
  const layerInfo = activeLayers.get(layerId);
  if (!layerInfo) return;

  // Remove popup if exists
  const popup = layerPopups.get(layerId);
  if (popup) {
    popup.remove();
    layerPopups.delete(layerId);
  }

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

  // Drop spatial index if it exists
  if (layerInfo.indexName) {
    await dropSpatialIndex(layerInfo.indexName);
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

/**
 * Setup feature interaction (click for popup, hover for cursor)
 */
function setupFeatureInteraction(
  map: maplibregl.Map,
  layerId: string,
  layerType: 'fill' | 'line' | 'circle'
): void {
  // Determine the actual layer ID based on type
  const interactiveLayerId = layerType === 'fill' ? `${layerId}-fill` :
                             layerType === 'line' ? `${layerId}-line` :
                             `${layerId}-circle`;

  // Create popup instance
  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,  // Close on map click
    maxWidth: '400px'
  });

  // Add click event for popup
  map.on('click', interactiveLayerId, (e) => {
    if (!e.features || e.features.length === 0) return;

    const feature = e.features[0];
    const coordinates = e.lngLat;

    // For polygon/line features, ensure popup appears at click location
    if (layerType === 'fill' || layerType === 'line') {
      // Use click coordinates directly
    } else if (feature.geometry.type === 'Point') {
      // For points, use the feature's coordinates
      const point = feature.geometry as any;
      if (point.coordinates) {
        coordinates.lng = point.coordinates[0];
        coordinates.lat = point.coordinates[1];
      }
    }

    // Build popup content with explicit text color and scrollable container
    const properties = feature.properties || {};
    let popupContent = '<div style="max-height: 400px; overflow-y: auto; padding: 5px; color: #333;">';

    if (Object.keys(properties).length === 0) {
      popupContent += '<p style="margin: 0; color: #666;">No properties</p>';
    } else {
      popupContent += '<table style="width: 100%; border-collapse: collapse;">';
      for (const [key, value] of Object.entries(properties)) {
        // Format the value (handle objects/arrays)
        let displayValue = value;
        if (typeof value === 'object' && value !== null) {
          displayValue = JSON.stringify(value, null, 2);
        }
        popupContent += `
          <tr>
            <td style="padding: 4px; border-bottom: 1px solid #eee; font-weight: bold; vertical-align: top; color: #000; min-width: 80px;">${key}</td>
            <td style="padding: 4px; border-bottom: 1px solid #eee; word-break: break-word; color: #333;">
              ${typeof value === 'object' ?
                `<pre style="margin: 0; white-space: pre-wrap; color: #333; max-width: 250px; overflow-x: auto;">${displayValue}</pre>` :
                displayValue}
            </td>
          </tr>
        `;
      }
      popupContent += '</table>';
    }
    popupContent += '</div>';

    // Set popup content and display
    popup.setLngLat(coordinates)
         .setHTML(popupContent)
         .addTo(map);
  });

  // Change cursor on hover
  map.on('mouseenter', interactiveLayerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', interactiveLayerId, () => {
    map.getCanvas().style.cursor = '';
  });

  // Store popup reference for cleanup
  layerPopups.set(layerId, popup);
}

// Store popups for cleanup when removing layers
const layerPopups = new Map<string, maplibregl.Popup>();