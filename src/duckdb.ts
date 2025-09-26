import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?worker';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

export async function initializeDuckDB(): Promise<{
  db: duckdb.AsyncDuckDB;
  connection: duckdb.AsyncDuckDBConnection;
}> {
  if (db && conn) {
    return { db, connection: conn };
  }

  const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
      mainModule: duckdb_wasm,
      mainWorker: mvp_worker as any,
    },
    eh: {
      mainModule: duckdb_wasm_eh,
      mainWorker: eh_worker as any,
    },
  };

  // Select appropriate bundle
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);

  // Create worker
  const worker = new (bundle.mainWorker as any)();

  // Create logger
  const logger = new duckdb.ConsoleLogger();

  // Instantiate DuckDB
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  // Create connection
  conn = await db.connect();

  // Load spatial extension in the main connection
  try {
    await conn.query(`INSTALL spatial; LOAD spatial;`);
    console.log('Spatial extension loaded in main connection');
  } catch (error) {
    console.error('Could not load spatial extension:', error);
  }

  console.log('DuckDB-WASM initialized successfully');

  return { db, connection: conn };
}

export async function executeSql(sql: string): Promise<any[]> {
  if (!conn) {
    throw new Error('DuckDB not initialized. Call initializeDuckDB first.');
  }

  const result = await conn.query(sql);
  return result.toArray();
}

export async function createConnection(): Promise<duckdb.AsyncDuckDBConnection | null> {
  if (!db) {
    console.error('DuckDB not initialized');
    return null;
  }

  const newConn = await db.connect();

  // Load spatial extension for this connection
  try {
    await newConn.query(`LOAD spatial;`);
    console.log('Spatial extension loaded in new connection');
  } catch (error) {
    console.error('Could not load spatial extension in new connection:', error);
  }

  return newConn;
}

export async function executeWithConnection(
  conn: duckdb.AsyncDuckDBConnection,
  sql: string
): Promise<any[]> {
  const result = await conn.query(sql);
  return result.toArray();
}

