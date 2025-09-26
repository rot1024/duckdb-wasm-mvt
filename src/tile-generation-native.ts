/**
 * Native MVT Approach for Tile Generation
 *
 * This approach uses DuckDB's native ST_AsMVT function to generate MVT directly.
 * Requires DuckDB-WASM version 1.30.1-dev7.0 or later.
 *
 * Pros:
 * - Faster than GeoJSON approach
 * - Minimal data transfer (binary MVT)
 * - DuckDB-internal MVT generation
 * - Less client CPU usage
 *
 * Cons:
 * - Requires newer DuckDB version
 * - Less flexibility for debugging
 * - Feature count not easily accessible
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

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
 * Main function: Generate MVT using native ST_AsMVT
 *
 * @param conn - Active DuckDB connection with spatial extension loaded
 * @param config - Layer configuration
 * @param zxy - Tile coordinates (z, x, y)
 * @returns MVT binary data and performance metrics
 */
export async function generateMVTNative(
  conn: AsyncDuckDBConnection,
  config: LayerConfig,
  zxy: TileCoordinates
): Promise<{
  data: Uint8Array;
  metrics: {
    connectionTime: number;
    queryTime: number;
    totalTime: number;
    tileSize: number;
  };
}> {
  const startTime = performance.now();
  const metrics = {
    connectionTime: 0,
    queryTime: 0,
    totalTime: 0,
    tileSize: 0
  };

  try {
    // Step 1: Generate and execute native MVT query
    const query = generateNativeMVTQuery(config, zxy);

    const queryStartTime = performance.now();
    const results = (await conn.query(query)).toArray();
    metrics.queryTime = performance.now() - queryStartTime;

    if (!results || results.length === 0 || !results[0].mvt) {
      return {
        data: new Uint8Array(),
        metrics: { ...metrics, totalTime: performance.now() - startTime }
      };
    }

    // Step 2: MVT data is already Uint8Array from DuckDB-WASM
    const mvtData = results[0].mvt as Uint8Array;

    metrics.tileSize = mvtData.length;
    metrics.totalTime = performance.now() - startTime;

    return {
      data: mvtData,
      metrics
    };

  } catch (error) {
    console.error(`Error generating native MVT: ${error}`);
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
 * Generate native ST_AsMVT SQL query
 *
 * Key points:
 * 1. ST_Transform with always_xy=true (4th parameter) to force lon,lat order
 * 2. ST_Extent wraps ST_TileEnvelope to create BOX_2D type
 * 3. TRY_CAST for safe property conversion to VARCHAR
 * 4. Two-step process: prepare features, then generate MVT
 */
function generateNativeMVTQuery(
  config: LayerConfig,
  zxy: TileCoordinates
): string {
  const { tableName, geometryColumn, propertyColumns, schema } = config;
  const { z, x, y } = zxy;

  const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;

  // Build property selection with TRY_CAST for safety
  const propertySelection = propertyColumns.length > 0
    ? propertyColumns.map(col => `'${col}': TRY_CAST("${col}" AS VARCHAR)`).join(',\n          ')
    : '';

  const query = `
    WITH tile_data AS (
        SELECT {
            'geometry': ST_AsMVTGeom(
                -- Transform geometry to Web Mercator (EPSG:3857)
                -- CRITICAL: always_xy=true ensures lon,lat order
                ST_Transform(
                    ST_SimplifyPreserveTopology("${geometryColumn}", ${calculateSimplifyTolerance(z)}),
                    'EPSG:4326',
                    'EPSG:3857',
                    true  -- Force lon,lat order (always_xy)
                ),
                -- Create tile boundary as BOX_2D
                ST_Extent(ST_TileEnvelope(${z}, ${x}, ${y})),
                4096,  -- Tile resolution
                256,   -- Buffer in pixels
                false  -- Don't clip geometry
            )${propertySelection ? ',\n            ' + propertySelection : ''}
        } AS feature
        FROM ${fullTableName}
        WHERE "${geometryColumn}" IS NOT NULL
            AND ST_Intersects(
                -- Transform to Web Mercator for intersection test
                ST_Transform("${geometryColumn}", 'EPSG:4326', 'EPSG:3857', true),
                ST_TileEnvelope(${z}, ${x}, ${y})
            )
        LIMIT 10000  -- Prevent excessive features per tile
    )
    SELECT ST_AsMVT(
        feature,       -- Feature STRUCT
        'v',          -- Layer name in MVT
        4096,         -- Extent (must match ST_AsMVTGeom)
        'geometry'    -- Geometry column name in STRUCT
    ) AS mvt
    FROM tile_data
    WHERE feature.geometry IS NOT NULL  -- Exclude failed transformations
  `;

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
 * const tile = await generateMVTNative(conn, config, { z: 14, x: 8192, y: 5460 });
 *
 * console.log('Tile size:', tile.data.length);
 * console.log('Performance:', tile.metrics);
 *
 * await conn.close();
 */

/**
 * Common issues and solutions:
 *
 * 1. "No function matches ST_MakeEnvelope"
 *    Solution: Load spatial extension for each connection
 *    await conn.query('LOAD spatial;')
 *
 * 2. Coordinates appear flipped
 *    Solution: Use always_xy=true in ST_Transform
 *
 * 3. Empty tiles
 *    Check: ST_TileEnvelope bounds, coordinate system, NULL geometries
 *
 * 4. Properties missing
 *    Solution: Use TRY_CAST to handle type conversion errors
 */
