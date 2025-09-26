import maplibregl from 'maplibre-gl';
import { performanceTracker } from './performance-tracker';
import { generateMVTFromGeoJSON } from './tile-generation-geojson';
import { generateMVTNative } from './tile-generation-native';
import { createConnection } from './duckdb';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { TileCoordinates, LayerConfig } from './tile-generation-geojson';

export interface DuckDBLayerConfig {
  tableName: string;
  geometryColumn: string;
  propertyColumns: string[];
  schema?: string;
}

const activeConfigs = new Map<string, DuckDBLayerConfig>();

// Global flag to switch between MVT generation methods (default to native)
let useNativeMVT = true;

export function setMVTMethod(native: boolean): void {
  useNativeMVT = native;
  console.log(`MVT generation method switched to: ${native ? 'Native ST_AsMVT' : 'GeoJSON + geojson-vt'}`);
}

export function getMVTMethod(): boolean {
  return useNativeMVT;
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

      // Create a new connection with spatial extension loaded
      let conn: AsyncDuckDBConnection | null = null;
      const connStartTime = performance.now();

      try {
        conn = await createConnection();
        if (!conn) {
          console.error('Failed to create connection for tile query');
          return { data: new Uint8Array() };
        }
        const connectionTime = performance.now() - connStartTime;

        // Convert config to LayerConfig format
        const layerConfig: LayerConfig = {
          tableName: config.tableName,
          geometryColumn: config.geometryColumn,
          propertyColumns: config.propertyColumns,
          schema: config.schema
        };

        const tileId = `${zxy.z}/${zxy.x}/${zxy.y}`;

        // Use native MVT or GeoJSON method based on flag
        if (useNativeMVT) {
          // Use native ST_AsMVT method
          const result = await generateMVTNative(conn, layerConfig, zxy);

          console.log(`📊 Native MVT Tile ${tileId}:`, {
            connection: `${connectionTime.toFixed(2)}ms`,
            query: `${result.metrics.queryTime.toFixed(2)}ms`,
            total: `${(connectionTime + result.metrics.totalTime).toFixed(2)}ms`,
            tileSize: `${(result.metrics.tileSize / 1024).toFixed(2)}KB`
          });

          // Track metrics in UI
          performanceTracker.addMetric({
            tileId: `[Native] ${tileId}`,
            fetchTime: connectionTime + result.metrics.queryTime,
            convertTime: 0,
            totalTime: connectionTime + result.metrics.totalTime,
            features: -1,
            tileSize: result.metrics.tileSize,
            timestamp: Date.now()
          });

          return { data: result.data };

        } else {
          // Use GeoJSON + geojson-vt method
          const result = await generateMVTFromGeoJSON(conn, layerConfig, zxy);

          console.log(`📊 GeoJSON Tile ${tileId}:`, {
            connection: `${connectionTime.toFixed(2)}ms`,
            query: `${result.metrics.queryTime.toFixed(2)}ms`,
            parse: `${result.metrics.parseTime.toFixed(2)}ms`,
            convert: `${result.metrics.convertTime.toFixed(2)}ms`,
            total: `${(connectionTime + result.metrics.totalTime).toFixed(2)}ms`,
            features: result.metrics.featureCount,
            tileSize: `${(result.metrics.tileSize / 1024).toFixed(2)}KB`
          });

          // Track metrics in UI
          performanceTracker.addMetric({
            tileId: `[GeoJSON] ${tileId}`,
            fetchTime: connectionTime + result.metrics.queryTime + result.metrics.parseTime,
            convertTime: result.metrics.convertTime,
            totalTime: connectionTime + result.metrics.totalTime,
            features: result.metrics.featureCount,
            tileSize: result.metrics.tileSize,
            timestamp: Date.now()
          });

          return { data: result.data };
        }

      } finally {
        // Always close the connection
        if (conn) {
          try {
            await conn.close();
          } catch (error) {
            console.error('Error closing connection:', error);
          }
        }
      }

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