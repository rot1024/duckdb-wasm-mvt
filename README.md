# DuckDB-WASM MVT Rendering on MapLibre GL JS

A performance comparison and implementation reference for generating Mapbox Vector Tiles (MVT) from DuckDB-WASM in the browser. This project demonstrates two approaches and benchmarks their performance differences.

## 🎯 Project Purpose

1. **Demonstrate MVT generation techniques** using DuckDB-WASM in the browser
2. **Benchmark performance differences** between native and GeoJSON approaches
3. **Provide reference implementations** for both methods
4. **Document SQL patterns** for spatial data processing in DuckDB

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Type check
npm run typecheck
```

## 📊 Performance Results

Based on real-world testing with 100 tile requests:

| Approach | Total Time | Fetch Time | Convert Time | Speed |
|----------|------------|------------|--------------|-------|
| **ST_AsGeoJSON + geojson-vt** | 213.13ms | 212.00ms | 1.12ms | 1x (baseline) |
| **Native ST_AsMVT** | 31.34ms | 31.33ms | 0.00ms | **6.8x faster** |

### Key Findings:
- SQL query execution dominates performance (99%+ of total time)
- Client-side GeoJSON→MVT conversion adds minimal overhead (1.12ms)
- Native MVT generation is significantly more efficient in DuckDB

## 🔧 Implementation Approaches

### 1. Native ST_AsMVT Approach (Recommended)

**File:** [`src/tile-generation-native.ts`](src/tile-generation-native.ts)

Uses DuckDB's native `ST_AsMVT` and `ST_AsMVTGeom` functions to generate MVT directly.

#### SQL Query Pattern:

```sql
WITH tile_data AS (
    SELECT {
        'geometry': ST_AsMVTGeom(
            -- Transform to Web Mercator with simplification
            ST_Transform(
                ST_SimplifyPreserveTopology("geom", 0.0001),
                'EPSG:4326',
                'EPSG:3857',
                true  -- CRITICAL: always_xy=true for lon,lat order
            ),
            -- Tile boundary as BOX_2D
            ST_Extent(ST_TileEnvelope(z, x, y)),
            4096,  -- tile extent
            256,   -- buffer
            false  -- clip_geom
        ),
        -- Properties with safe type conversion
        'name': TRY_CAST("name" AS VARCHAR),
        'value': TRY_CAST("value" AS VARCHAR)
    } AS feature
    FROM your_table
    WHERE "geom" IS NOT NULL
        AND ST_Intersects(
            ST_Transform("geom", 'EPSG:4326', 'EPSG:3857', true),
            ST_TileEnvelope(z, x, y)
        )
    LIMIT 10000
)
SELECT ST_AsMVT(
    feature,      -- feature STRUCT
    'v',          -- layer name
    4096,         -- extent
    'geometry'    -- geometry column name
) AS mvt
FROM tile_data
WHERE feature.geometry IS NOT NULL
```

#### Key SQL Components:

- **`ST_AsMVTGeom`**: Prepares geometry for MVT format
  - Transforms coordinates to tile-relative positions
  - Applies clipping and buffering
  - Optimizes geometry for the tile

- **`ST_TileEnvelope`**: Returns tile boundary in Web Mercator
  - Used for spatial filtering with `ST_Intersects`
  - Wrapped with `ST_Extent` to create BOX_2D type

- **`ST_Transform`**: Coordinate system transformation
  - **Must use `always_xy=true`** to ensure lon,lat order
  - Converts from WGS84 (EPSG:4326) to Web Mercator (EPSG:3857)

- **`TRY_CAST`**: Safe type conversion for properties
  - Prevents errors from incompatible types
  - Converts all properties to VARCHAR for MVT

### 2. GeoJSON + geojson-vt Approach

**File:** [`src/tile-generation-geojson.ts`](src/tile-generation-geojson.ts)

Fetches GeoJSON from DuckDB and converts to MVT using JavaScript libraries.

#### SQL Query Pattern:

```sql
WITH filtered AS (
    SELECT
        "geom" as geom,
        "name",
        "value"
    FROM your_table
    WHERE ST_Intersects(
        "geom",
        ST_MakeEnvelope(
            CAST(min_lng AS DOUBLE),
            CAST(min_lat AS DOUBLE),
            CAST(max_lng AS DOUBLE),
            CAST(max_lat AS DOUBLE)
        )
    )
)
SELECT
    ST_AsGeoJSON(
        ST_Simplify(geom, 0.0001)
    ) AS geojson,
    to_json("name")::VARCHAR as "name",
    to_json("value")::VARCHAR as "value"
FROM filtered
```

#### Key SQL Components:

- **`ST_AsGeoJSON`**: Converts geometry to GeoJSON format
  - Returns text representation of geometry
  - Preserves full coordinate precision

- **`ST_MakeEnvelope`**: Creates bounding box for filtering
  - Requires explicit `CAST` to DOUBLE for parameters
  - Defines rectangular area in WGS84

- **`ST_SimplifyPreserveTopology`**: Reduces geometry complexity while preserving topology
  - Tolerance varies by zoom level (0.01 to 0.00001)
  - **CRITICAL**: Always use this instead of `ST_Simplify` to prevent "Unsupported GEOS geometry type" errors
  - Maintains polygon validity during simplification
  - Prevents creation of invalid geometries that cause GEOS errors

- **`to_json()::VARCHAR`**: Handles complex property types
  - Safely converts arrays, objects to strings
  - Preserves data structure for client-side parsing

## 🏗️ Architecture

```
┌─────────────────┐
│   MapLibre GL   │
└────────┬────────┘
         │ tile request
         │ duckdb://.../z/x/y.pbf
         ▼
┌─────────────────┐
│ Protocol Handler│
└────────┬────────┘
         │
    ┌────▼────┐
    │ Switch  │
    └─┬─────┬─┘
      │     │
      │     └─────────────┐
      ▼                   ▼
┌──────────────┐    ┌──────────────┐
│ Native MVT   │    │   GeoJSON    │
│              │    │              │
│ ST_AsMVT     │    │ ST_AsGeoJSON │
│     ↓        │    │     ↓        │
│ Binary MVT   │    │   GeoJSON    │
└──────────────┘    │     ↓        │
                    │ geojson-vt   │
                    │     ↓        │
                    │   MVT        │
                    └──────────────┘
```

## 📁 Project Structure

```
src/
├── tile-generation-native.ts   # Native ST_AsMVT implementation
├── tile-generation-geojson.ts  # GeoJSON + geojson-vt implementation
├── duckdb-protocol.ts          # MapLibre protocol handler
├── duckdb.ts                   # DuckDB-WASM initialization
├── map.ts                      # MapLibre setup
├── map-layers.ts              # Layer management
├── performance-tracker.ts     # Performance metrics UI
└── main.ts                    # Application entry point
```

## 🔑 Key Insights

### Why Native MVT is Faster

1. **No serialization overhead**: Direct binary generation vs JSON text
2. **Optimized spatial operations**: Built-in tile-aware geometry processing
3. **Single-pass processing**: No intermediate format conversion
4. **Reduced data transfer**: Binary format is more compact than JSON

### When to Use Each Approach

**Use Native ST_AsMVT when:**
- Performance is critical
- Using DuckDB-WASM ≥ 1.30.1-dev7.0
- Standard MVT output is sufficient

**Use GeoJSON approach when:**
- Need to inspect/debug geometry data
- Using older DuckDB versions
- Need custom client-side processing
- Require feature-level manipulation

## 🛠️ Technical Requirements

- **DuckDB-WASM**: 1.30.1-dev7.0+ (for native MVT support)
- **Spatial Extension**: Must be loaded per connection
- **Browser**: Modern browser with WebAssembly support

## 📝 Common Issues & Solutions

### Issue 1: "No function matches ST_MakeEnvelope"
**Solution:** Load spatial extension for each connection:
```javascript
await conn.query('LOAD spatial;');
```

### Issue 2: Coordinates appear flipped
**Solution:** Use `always_xy=true` in ST_Transform:
```sql
ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', true)
```

### Issue 3: "Unsupported GEOS geometry type" errors
**Solution:** Use `ST_SimplifyPreserveTopology` instead of `ST_Simplify`:
```sql
-- Wrong - can create invalid geometries
ST_Simplify(geom, 0.0001)

-- Correct - preserves topology
ST_SimplifyPreserveTopology(geom, 0.0001)
```

### Issue 4: Empty tiles
**Check:**
- ST_TileEnvelope bounds are correct
- Coordinate system matches your data
- NULL geometries are filtered

### Issue 5: Properties missing in MVT
**Solution:** Use TRY_CAST for safe type conversion:
```sql
'property': TRY_CAST("column" AS VARCHAR)
```

## 📈 Performance Optimization Tips

1. **Use appropriate simplification**: Adjust tolerance by zoom level
2. **Limit features per tile**: Use `LIMIT 10000` to prevent huge tiles
3. **Index geometry columns**: Create spatial indexes when possible
4. **Filter early**: Use WHERE clause before complex operations
5. **Cache connections**: Reuse DuckDB connections when possible

## 🔗 Resources

- [DuckDB Spatial Extension](https://duckdb.org/docs/extensions/spatial)
- [Mapbox Vector Tile Specification](https://docs.mapbox.com/vector-tiles/specification/)
- [MapLibre GL JS](https://maplibre.org/)
- [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm)

## 📄 License

MIT
