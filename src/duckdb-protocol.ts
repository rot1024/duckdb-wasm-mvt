import maplibregl from 'maplibre-gl';
import { createConnection, executeWithConnection } from './duckdb';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import {
  getTileEnvelope,
  calculateSimplifyTolerance,
  geojsonToVectorTile,
  parseGeoJSON,
  type TileCoordinates
} from './mvt';
import type { Feature, Geometry, GeoJsonProperties } from 'geojson';
import { performanceTracker } from './performance-tracker';

export interface DuckDBLayerConfig {
  tableName: string;
  geometryColumn: string;
  propertyColumns: string[];
  schema?: string;
}

const activeConfigs = new Map<string, DuckDBLayerConfig>();

/**
 * Generate optimized SQL query for tile data
 */
function generateTileQuery(
  config: DuckDBLayerConfig,
  zxy: TileCoordinates
): { query: string; params: number[] } {
  const { tableName, geometryColumn, propertyColumns, schema } = config;
  const bounds = getTileEnvelope(zxy.z, zxy.x, zxy.y);
  const simplify = calculateSimplifyTolerance(zxy.z);

  const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;

  // Build column selection with JSON conversion for complex types
  const columnSelection = propertyColumns.length > 0
    ? ', ' + propertyColumns.map(col =>
        `to_json("${col}")::VARCHAR as "${col}"`
      ).join(', ')
    : '';

  // Build the query
  let query: string;

  if (simplify > 0) {
    // With simplification
    query = `
      WITH filtered AS (
        SELECT
          "${geometryColumn}" as geom
          ${propertyColumns.length > 0 ? ', ' + propertyColumns.map(col => `"${col}"`).join(', ') : ''}
        FROM ${fullTableName}
        WHERE ST_Intersects(
          "${geometryColumn}",
          ST_MakeEnvelope(CAST(? AS DOUBLE), CAST(? AS DOUBLE), CAST(? AS DOUBLE), CAST(? AS DOUBLE))
        )
      )
      SELECT
        ST_AsGeoJSON(
          ST_Simplify(geom, ${simplify})
        ) AS geojson
        ${columnSelection}
      FROM filtered
    `;
  } else {
    // Without simplification
    query = `
      WITH filtered AS (
        SELECT
          "${geometryColumn}" as geom
          ${propertyColumns.length > 0 ? ', ' + propertyColumns.map(col => `"${col}"`).join(', ') : ''}
        FROM ${fullTableName}
        WHERE ST_Intersects(
          "${geometryColumn}",
          ST_MakeEnvelope(CAST(? AS DOUBLE), CAST(? AS DOUBLE), CAST(? AS DOUBLE), CAST(? AS DOUBLE))
        )
      )
      SELECT
        ST_AsGeoJSON(geom) AS geojson
        ${columnSelection}
      FROM filtered
    `;
  }

  const params = [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat];

  return { query, params };
}

/**
 * Execute tile query and convert results to GeoJSON features
 */
async function fetchTileData(
  config: DuckDBLayerConfig,
  zxy: TileCoordinates
): Promise<Feature<Geometry, GeoJsonProperties>[]> {
  let conn: AsyncDuckDBConnection | null = null;
  const timings: { [key: string]: number } = {};

  try {
    // Create a new connection with spatial extension loaded
    const connStartTime = performance.now();
    conn = await createConnection();
    if (!conn) {
      console.error('Failed to create connection for tile query');
      return [];
    }
    timings.createConnection = performance.now() - connStartTime;

    const { query, params } = generateTileQuery(config, zxy);

    // Replace ? placeholders with actual values
    let finalQuery = query;
    for (const param of params) {
      finalQuery = finalQuery.replace('?', param.toString());
    }

    // Execute SQL query
    const queryStartTime = performance.now();
    const results = await executeWithConnection(conn, finalQuery);
    timings.sqlQuery = performance.now() - queryStartTime;

    if (!results || results.length === 0) {
      return [];
    }

    // Parse results to GeoJSON features
    const parseStartTime = performance.now();
    const features: Feature<Geometry, GeoJsonProperties>[] = [];

    for (const row of results) {
      const geojson = parseGeoJSON(row.geojson);
      if (!geojson) continue;

      // Build properties from other columns
      const properties: GeoJsonProperties = {};
      for (const col of config.propertyColumns) {
        if (col in row && row[col] !== null) {
          try {
            // Try to parse as JSON if it's a string that looks like JSON
            const value = row[col];
            if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
              properties[col] = JSON.parse(value);
            } else {
              properties[col] = value;
            }
          } catch {
            properties[col] = row[col];
          }
        }
      }

      features.push({
        type: 'Feature',
        geometry: geojson,
        properties
      });
    }
    timings.parseGeoJSON = performance.now() - parseStartTime;

    // Log detailed fetch timings
    console.log(`⚡ Tile ${zxy.z}/${zxy.x}/${zxy.y} Fetch Details:`, {
      connection: `${timings.createConnection.toFixed(2)}ms`,
      sqlQuery: `${timings.sqlQuery.toFixed(2)}ms`,
      parseGeoJSON: `${timings.parseGeoJSON.toFixed(2)}ms`,
      totalFetch: `${(timings.createConnection + timings.sqlQuery + timings.parseGeoJSON).toFixed(2)}ms`,
      resultRows: results.length,
      features: features.length
    });

    return features;

  } catch (error) {
    console.error(`Error fetching tile data: ${error}`);
    return [];
  } finally {
    // Close the connection
    if (conn) {
      try {
        await conn.close();
      } catch (error) {
        console.error('Error closing connection:', error);
      }
    }
  }
}

/**
 * Initialize DuckDB protocol handler for MapLibre
 */
export function initializeDuckDBProtocol(): void {
  maplibregl.addProtocol('duckdb', async (params) => {
    try {
      // Parse URL: duckdb://config_id/{z}/{x}/{y}.pbf
      const url = params.url;
      const match = url.match(/^duckdb:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/);

      if (!match) {
        console.error('Invalid DuckDB protocol URL:', url);
        return { data: new Uint8Array() };
      }

      const [, configId, z, x, y] = match;
      const zxy: TileCoordinates = {
        z: parseInt(z),
        x: parseInt(x),
        y: parseInt(y)
      };

      // Get configuration for this layer
      const config = activeConfigs.get(configId);
      if (!config) {
        console.error(`No configuration found for: ${configId}`);
        return { data: new Uint8Array() };
      }

      // Start performance timing
      const startTime = performance.now();
      const timings: { [key: string]: number } = {};

      // Fetch data from DuckDB
      const fetchStartTime = performance.now();
      const features = await fetchTileData(config, zxy);
      timings.fetchData = performance.now() - fetchStartTime;

      // Convert to vector tile
      const convertStartTime = performance.now();
      const vectorTile = geojsonToVectorTile(features, zxy.z, zxy.x, zxy.y);
      timings.convertToMVT = performance.now() - convertStartTime;

      // Calculate total time
      timings.total = performance.now() - startTime;

      // Log performance metrics
      const tileId = `${zxy.z}/${zxy.x}/${zxy.y}`;
      console.log(`📊 Tile ${tileId} Performance:`, {
        fetchData: `${timings.fetchData.toFixed(2)}ms`,
        convertToMVT: `${timings.convertToMVT.toFixed(2)}ms`,
        total: `${timings.total.toFixed(2)}ms`,
        features: features.length,
        tileSize: `${(vectorTile.length / 1024).toFixed(2)}KB`
      });

      // Track metrics in UI
      performanceTracker.addMetric({
        tileId,
        fetchTime: timings.fetchData,
        convertTime: timings.convertToMVT,
        totalTime: timings.total,
        features: features.length,
        tileSize: vectorTile.length,
        timestamp: Date.now()
      });

      return { data: vectorTile };

    } catch (error) {
      console.error('Error in DuckDB protocol handler:', error);
      return { data: new Uint8Array() };
    }
  });

  console.log('DuckDB protocol registered for MapLibre');
}

/**
 * Register a table configuration for use with the DuckDB protocol
 */
export function registerDuckDBLayer(id: string, config: DuckDBLayerConfig): void {
  activeConfigs.set(id, config);
  console.log(`Registered DuckDB layer: ${id}`, config);
}

/**
 * Unregister a table configuration
 */
export function unregisterDuckDBLayer(id: string): void {
  activeConfigs.delete(id);
  console.log(`Unregistered DuckDB layer: ${id}`);
}

/**
 * Get all registered configurations
 */
export function getRegisteredLayers(): Map<string, DuckDBLayerConfig> {
  return activeConfigs;
}