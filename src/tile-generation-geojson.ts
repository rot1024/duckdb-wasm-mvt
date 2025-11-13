/**
 * GeoJSON Approach for MVT Generation
 *
 * This approach:
 * 1. Fetches GeoJSON data from DuckDB using ST_AsGeoJSON
 * 2. Converts GeoJSON to MVT on the client-side using geojson-vt and vt-pbf
 *
 * Pros:
 * - Works with older DuckDB versions
 * - Feature properties are easily accessible
 * - Good for debugging (can inspect GeoJSON)
 *
 * Cons:
 * - Requires client-side conversion (slower)
 * - Larger data transfer (GeoJSON is verbose)
 * - Additional CPU usage on client
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { Feature, Geometry, GeoJsonProperties } from 'geojson';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

export interface TileCoordinates {
  z: number;
  x: number;
  y: number;
}

export interface LayerConfig {
  tableName: string;
  geometryColumn: string;
  propertyColumns: string[];
  schema?: string;
}

/**
 * Main function: Generate MVT from DuckDB using GeoJSON approach
 *
 * @param conn - Active DuckDB connection with spatial extension loaded
 * @param config - Layer configuration
 * @param zxy - Tile coordinates (z, x, y)
 * @returns MVT binary data and performance metrics
 */
export async function generateMVTFromGeoJSON(
  conn: AsyncDuckDBConnection,
  config: LayerConfig,
  zxy: TileCoordinates
): Promise<{
  data: Uint8Array;
  metrics: {
    connectionTime: number;
    queryTime: number;
    parseTime: number;
    convertTime: number;
    totalTime: number;
    featureCount: number;
    tileSize: number;
  };
}> {
  const startTime = performance.now();
  const metrics = {
    connectionTime: 0,
    queryTime: 0,
    parseTime: 0,
    convertTime: 0,
    totalTime: 0,
    featureCount: 0,
    tileSize: 0
  };

  try {
    // Step 1: Generate and execute SQL query
    const query = generateTileQuery(config, zxy);

    const queryStartTime = performance.now();
    const results = (await conn.query(query)).toArray();
    metrics.queryTime = performance.now() - queryStartTime;

    if (!results || results.length === 0) {
      return {
        data: new Uint8Array(),
        metrics: { ...metrics, totalTime: performance.now() - startTime }
      };
    }

    // Step 2: Parse results to GeoJSON features
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
    metrics.parseTime = performance.now() - parseStartTime;
    metrics.featureCount = features.length;

    // Step 3: Convert GeoJSON to MVT
    const convertStartTime = performance.now();
    const mvtData = geojsonToVectorTile(features, zxy.z, zxy.x, zxy.y);
    metrics.convertTime = performance.now() - convertStartTime;

    metrics.tileSize = mvtData.length;
    metrics.totalTime = performance.now() - startTime;

    return {
      data: mvtData,
      metrics
    };

  } catch (error) {
    console.error(`Error generating MVT from GeoJSON: ${error}`);
    return {
      data: new Uint8Array(),
      metrics: { ...metrics, totalTime: performance.now() - startTime }
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate simplification tolerance based on zoom level
 */
function calculateSimplifyTolerance(z: number): number {
  if (z <= 5) return 0.01;
  if (z <= 10) return 0.001;
  if (z <= 15) return 0.0001;
  return 0.00001;
}

/**
 * Parse GeoJSON string to Geometry object
 */
function parseGeoJSON(geojsonStr: string): Geometry | null {
  try {
    return JSON.parse(geojsonStr) as Geometry;
  } catch (error) {
    console.error('Failed to parse GeoJSON:', error);
    return null;
  }
}

/**
 * Convert GeoJSON features to MVT using geojson-vt
 */
function geojsonToVectorTile(
  features: Feature<Geometry, GeoJsonProperties>[],
  z: number,
  x: number,
  y: number
): Uint8Array {
  if (features.length === 0) {
    return new Uint8Array();
  }

  // Create a GeoJSON FeatureCollection
  const featureCollection = {
    type: 'FeatureCollection' as const,
    features: features
  };

  // Create vector tile index
  const tileIndex = geojsonvt(featureCollection, {
    maxZoom: z,
    indexMaxZoom: z,
    indexMaxPoints: 0,
    tolerance: 0,
    extent: 4096,
    buffer: 0,
    generateId: true
  });

  // Get the specific tile
  const tile = tileIndex.getTile(z, x, y);

  if (!tile) {
    return new Uint8Array();
  }

  // Convert to MVT format
  const buff = vtpbf.fromGeojsonVt({ 'default': tile });
  return new Uint8Array(buff);
}

/**
 * Escape SQL identifier (table/column names) for safe use in double quotes
 * Double quotes in identifiers need to be escaped as ""
 */
function escapeIdentifier(identifier: string): string {
  return identifier.replace(/"/g, '""');
}

/**
 * Generate SQL query for fetching GeoJSON data
 */
function generateTileQuery(
  config: LayerConfig,
  zxy: TileCoordinates
): string {
  const { tableName, geometryColumn, propertyColumns, schema } = config;
  const simplify = calculateSimplifyTolerance(zxy.z);
  const { z, x, y } = zxy;

  // Safely escape identifiers
  const escapedTableName = escapeIdentifier(tableName);
  const escapedGeomColumn = escapeIdentifier(geometryColumn);
  const fullTableName = schema
    ? `"${escapeIdentifier(schema)}"."${escapedTableName}"`
    : `"${escapedTableName}"`;

  // Build column selection with JSON conversion for complex types
  const columnSelection = propertyColumns.length > 0
    ? ', ' + propertyColumns.map(col => {
        const escapedCol = escapeIdentifier(col);
        return `to_json("${escapedCol}")::VARCHAR as "${escapedCol}"`;
      }).join(', ')
    : '';

  // Build the query using ST_TileEnvelope
  // Note: Numeric values (z, x, y, simplify) are safe to embed directly
  // as they come from JavaScript number types with no injection risk.
  // Identifiers are escaped using escapeIdentifier().
  let query: string;

  const escapedColList = propertyColumns.length > 0
    ? ', ' + propertyColumns.map(col => `"${escapeIdentifier(col)}"`).join(', ')
    : '';

  if (simplify > 0) {
    // With simplification
    query = `
      WITH filtered AS (
        SELECT
          "${escapedGeomColumn}" as geom
          ${escapedColList}
        FROM ${fullTableName}
        WHERE ST_Intersects(
          ST_Transform("${escapedGeomColumn}", 'EPSG:4326', 'EPSG:3857', true),
          ST_TileEnvelope(${z}, ${x}, ${y})
        )
      )
      SELECT
        ST_AsGeoJSON(
          ST_SimplifyPreserveTopology(geom, ${simplify})
        ) AS geojson
        ${columnSelection}
      FROM filtered
    `;
  } else {
    // Without simplification
    query = `
      WITH filtered AS (
        SELECT
          "${escapedGeomColumn}" as geom
          ${escapedColList}
        FROM ${fullTableName}
        WHERE ST_Intersects(
          ST_Transform("${escapedGeomColumn}", 'EPSG:4326', 'EPSG:3857', true),
          ST_TileEnvelope(${z}, ${x}, ${y})
        )
      )
      SELECT
        ST_AsGeoJSON(geom) AS geojson
        ${columnSelection}
      FROM filtered
    `;
  }

  return query;
}

/**
 * Example usage:
 *
 * // Assuming you have an active DuckDB connection with spatial extension
 * const conn = await db.connect();
 * await conn.query('LOAD spatial;');
 *
 * const config = {
 *   tableName: 'buildings',
 *   geometryColumn: 'geom',
 *   propertyColumns: ['name', 'height', 'type']
 * };
 *
 * const tile = await generateMVTFromGeoJSON(conn, config, { z: 14, x: 8192, y: 5460 });
 *
 * console.log('Tile size:', tile.data.length);
 * console.log('Performance:', tile.metrics);
 *
 * await conn.close();
 */