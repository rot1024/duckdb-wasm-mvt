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
  columnTypes?: Record<string, string | null>;
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
 * Linear interpolation: z=0 -> 0.001, z=15+ -> 0
 */
function calculateSimplifyTolerance(zoom: number): number {
  if (zoom >= 15) return 0;
  const maxSimplify = 0.001; // z=0で最大、z=15で0へ線形
  const t = Math.max(0, Math.min(1, zoom / 15));
  return Number((maxSimplify * (1 - t)).toFixed(6));
}

/**
 * Check if a column type should be stringified for MVT
 * Complex types (STRUCT, LIST, MAP, etc.) need to be cast to VARCHAR
 */
function shouldStringifyColumn(columnType?: string | null): boolean {
  if (!columnType) return false;
  const t = columnType.toUpperCase();
  return (
    t.includes('STRUCT') ||
    t.includes('LIST') ||
    t.includes('[]') ||
    t.includes('MAP') ||
    t.includes('JSON') ||
    t.includes('UNION')
  );
}

/**
 * Get the target integer type for casting
 * Some integer types need to be cast to INTEGER or BIGINT for MVT compatibility
 */
function getIntegerCastTarget(columnType?: string | null): 'INTEGER' | 'BIGINT' | null {
  if (!columnType) return null;
  const t = columnType.toUpperCase();
  if (t === 'TINYINT' || t === 'SMALLINT' || t === 'UTINYINT' || t === 'USMALLINT') return 'INTEGER';
  if (t === 'HUGEINT' || t === 'UHUGEINT' || t === 'UINTEGER' || t === 'UBIGINT') return 'BIGINT';
  return null; // INTEGER, BIGINT はそのまま
}

/**
 * Generate native ST_AsMVT SQL query
 *
 * Key points:
 * 1. ST_Transform with always_xy=true (4th parameter) to force lon,lat order
 * 2. ST_Extent wraps ST_TileEnvelope to create BOX_2D type
 * 3. Smart type casting based on column types (complex types -> VARCHAR, some integers -> INTEGER/BIGINT)
 * 4. Two-step process: prepare features, then generate MVT
 */
function generateNativeMVTQuery(
  config: LayerConfig,
  zxy: TileCoordinates
): string {
  const { tableName, geometryColumn, propertyColumns, schema, columnTypes } = config;
  const { z, x, y } = zxy;

  const fullTableName = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;

  // Build property selection with smart type casting
  const propertySelection = propertyColumns
    .map((col) => {
      const type = columnTypes?.[col] ?? null;
      const key = col.replace(/'/g, "''"); // Escape single quotes in column name
      let expr: string;

      if (shouldStringifyColumn(type)) {
        // Complex types need to be stringified
        expr = `TRY_CAST("${col}" AS VARCHAR)`;
      } else {
        const intTarget = getIntegerCastTarget(type);
        if (intTarget) {
          // Some integer types need explicit casting
          expr = `TRY_CAST("${col}" AS ${intTarget})`;
        } else {
          // Supported types can be used as-is
          expr = `"${col}"`;
        }
      }
      return `'${key}': ${expr}`;
    })
    .join(',\n          ');

  const simplify = calculateSimplifyTolerance(z);

  const query = `
    WITH tile_data AS (
        SELECT {
            'geometry': ST_AsMVTGeom(
                -- Transform geometry to Web Mercator (EPSG:3857)
                -- CRITICAL: always_xy=true ensures lon,lat order
                ST_Transform(
                    ST_SimplifyPreserveTopology("${geometryColumn}", ${simplify}),
                    'EPSG:4326',
                    'EPSG:3857',
                    true  -- Force lon,lat order (always_xy)
                ),
                -- Create tile boundary as BOX_2D
                ST_Extent(ST_TileEnvelope(${z}, ${x}, ${y})),
                4096,  -- Tile resolution
                0,     -- Buffer in pixels
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
        LIMIT 50000  -- Prevent excessive features per tile
    )
    SELECT ST_AsMVT(
        feature,       -- Feature STRUCT
        'default',     -- Layer name in MVT
        4096,          -- Extent (must match ST_AsMVTGeom)
        'geometry'     -- Geometry column name in STRUCT
    ) AS mvt
    FROM tile_data
    WHERE feature.geometry IS NOT NULL AND NOT ST_IsEmpty(feature.geometry)  -- Exclude failed transformations and empty geometries
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
 * // Get column types from information_schema
 * const typeResults = await conn.query(`
 *   SELECT column_name, data_type
 *   FROM information_schema.columns
 *   WHERE table_name = 'buildings'
 * `);
 * const columnTypes: Record<string, string | null> = {};
 * for (const row of typeResults.toArray()) {
 *   columnTypes[row.column_name] = row.data_type;
 * }
 *
 * const config: LayerConfig = {
 *   tableName: 'buildings',
 *   geometryColumn: 'geom',
 *   propertyColumns: ['name', 'height', 'type'],
 *   columnTypes
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
