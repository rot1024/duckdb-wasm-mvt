import './style.css'
import { initializeDuckDB, executeSql } from './duckdb'
import { initializeMap, getMap } from './map'
import { initializeDuckDBProtocol } from './duckdb-protocol'
import {
  addDuckDBLayer,
  detectGeometryColumns,
  getTableColumns,
  removeDuckDBLayer,
  getActiveLayers,
  toggleLayerVisibility
} from './map-layers'
import { performanceTracker } from './performance-tracker'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="sidebar">
    <h1>DuckDB-WASM + MapLibre</h1>

    <div class="card">
      <h3>Load Data</h3>
      <div style="margin-bottom: 10px;">
        <input
          id="url-input"
          type="text"
          placeholder="Enter data URL (CSV, JSON, Parquet, GeoJSON, etc.)"
          style="width: 100%; padding: 8px; font-size: 14px; box-sizing: border-box; margin-bottom: 10px;"
          value=""
        />
        <input
          id="table-name"
          type="text"
          placeholder="Table name"
          style="width: 100%; padding: 8px; font-size: 14px; box-sizing: border-box;"
          value="data"
        />
      </div>
      <div style="display: flex; gap: 10px;">
        <button id="load-btn" type="button" style="flex: 1;" disabled>Load Data</button>
        <button id="load-sample-btn" type="button" style="flex: 1;" disabled>Load Sample Points</button>
      </div>
    </div>

    <div class="card" id="map-layers" style="display: none;">
      <h3>Map Layers</h3>
      <div id="layer-list"></div>
    </div>

    <div class="card" id="performance-stats" style="display: none;">
      <h3>Performance Metrics</h3>
      <div id="perf-summary" style="margin-bottom: 10px; font-size: 14px;">
        <div>Total Tiles: <span id="total-tiles">0</span></div>
        <div>Avg Total Time: <span id="avg-total">-</span>ms</div>
        <div>Avg Fetch Time: <span id="avg-fetch">-</span>ms</div>
        <div>Avg Convert Time: <span id="avg-convert">-</span>ms</div>
      </div>
      <div id="perf-details" style="max-height: 200px; overflow-y: auto; font-size: 12px; font-family: monospace;"></div>
      <button id="clear-perf-btn" type="button" style="margin-top: 10px; padding: 4px 8px; font-size: 12px;">Clear Metrics</button>
    </div>

    <div id="output" style="margin-top: 20px; padding: 10px; border: 1px solid #ccc; min-height: 100px; white-space: pre-wrap; font-family: monospace; overflow-x: auto;"></div>
  </div>

  <div class="map-container">
    <div id="map"></div>
  </div>
`

const urlInput = document.querySelector<HTMLInputElement>('#url-input')!
const tableNameInput = document.querySelector<HTMLInputElement>('#table-name')!
const loadBtn = document.querySelector<HTMLButtonElement>('#load-btn')!
const loadSampleBtn = document.querySelector<HTMLButtonElement>('#load-sample-btn')!
const output = document.querySelector<HTMLDivElement>('#output')!
const mapLayersCard = document.querySelector<HTMLDivElement>('#map-layers')!
const layerList = document.querySelector<HTMLDivElement>('#layer-list')!

let loadedTables: string[] = []

function log(message: string) {
  output.textContent += message + '\n'
  console.log(message)
}

function clearOutput() {
  output.textContent = ''
}

function displayResults(results: any[]) {
  if (results.length === 0) {
    log('No results returned')
    return
  }

  // Create a simple table display
  const columns = Object.keys(results[0])
  const maxWidths = columns.map(col =>
    Math.max(col.length, ...results.map(row => String(row[col]).length))
  )

  // Header
  const header = columns.map((col, i) => col.padEnd(maxWidths[i])).join(' | ')
  const separator = maxWidths.map(w => '-'.repeat(w)).join('-+-')

  log(header)
  log(separator)

  // Rows (limit display to 20 rows)
  const displayRows = Math.min(results.length, 20)
  for (let i = 0; i < displayRows; i++) {
    const row = results[i]
    const rowStr = columns.map((col, i) =>
      String(row[col]).padEnd(maxWidths[i])
    ).join(' | ')
    log(rowStr)
  }

  if (results.length > displayRows) {
    log(`... and ${results.length - displayRows} more rows`)
  }

  log(`\n${results.length} rows returned`)
}

function updateLayerList() {
  const layers = getActiveLayers()
  if (layers.length === 0) {
    mapLayersCard.style.display = 'none'
    return
  }

  mapLayersCard.style.display = 'block'
  layerList.innerHTML = layers.map(layer => `
    <div style="display: flex; align-items: center; margin: 5px 0;">
      <input type="checkbox" id="vis-${layer.id}" ${layer.visible ? 'checked' : ''}
        style="margin-right: 10px;">
      <label for="vis-${layer.id}" style="flex: 1; cursor: pointer;">
        ${layer.tableName} (${layer.geometryColumn})
      </label>
      <button class="remove-layer" data-id="${layer.id}"
        style="padding: 4px 8px; font-size: 12px;">Remove</button>
    </div>
  `).join('')

  // Add event listeners
  layers.forEach(layer => {
    const checkbox = document.querySelector(`#vis-${layer.id}`) as HTMLInputElement
    checkbox?.addEventListener('change', () => {
      const map = getMap()
      if (map) toggleLayerVisibility(map, layer.id)
    })
  })

  document.querySelectorAll('.remove-layer').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).getAttribute('data-id')
      if (id) {
        const map = getMap()
        if (map) {
          removeDuckDBLayer(map, id)
          updateLayerList()
        }
      }
    })
  })
}

// Initialize everything on page load
(async () => {
  try {
    // Initialize DuckDB
    log('Initializing DuckDB-WASM...')
    const { connection } = await initializeDuckDB()

    log('✅ DuckDB-WASM initialized successfully!')
    const version = (await connection.query('SELECT version()')).toArray()[0].version
    log(`Database version: ${version}`)

    // Load spatial extension
    try {
      await executeSql(`INSTALL spatial; LOAD spatial;`)
      log('✅ Spatial extension loaded')
    } catch (error) {
      log('❌ Could not load spatial extension')
    }

    log('\nReady to load data!')

    loadBtn.disabled = false
    loadSampleBtn.disabled = false

    // Initialize Map and protocol
    initializeMap()
    initializeDuckDBProtocol()
    log('✅ Map and DuckDB protocol initialized!')

    // Set up performance metrics clear button
    const clearPerfBtn = document.getElementById('clear-perf-btn')
    if (clearPerfBtn) {
      clearPerfBtn.addEventListener('click', () => {
        performanceTracker.clear()
        log('Performance metrics cleared')
      })
    }

  } catch (error) {
    log(`❌ Error initializing: ${error}`)
  }
})()

loadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  const tableName = tableNameInput.value.trim() || 'data'

  if (!url) {
    alert('Please enter a URL')
    return
  }

  try {
    clearOutput()
    log(`Loading data from: ${url}`)
    log(`Creating table: ${tableName}`)

    // Determine file type from URL
    let query = ''
    if (url.endsWith('.csv') || url.includes('.csv?')) {
      query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${url}')`
    } else if (url.endsWith('.json') || url.includes('.json?')) {
      query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_json_auto('${url}')`
    } else if (url.endsWith('.parquet') || url.includes('.parquet?')) {
      query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet('${url}')`
    } else if (url.endsWith('.geojson') || url.includes('geojson')) {
      // For GeoJSON, use ST_Read
      query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM ST_Read('${url}')`
    } else {
      // Try to auto-detect
      query = `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM '${url}'`
    }

    await executeSql(query)

    // Get row count
    const countResult = await executeSql(`SELECT COUNT(*) as count FROM ${tableName}`)
    const rowCount = countResult[0].count

    // Get column info
    const schemaResult = await executeSql(`DESCRIBE ${tableName}`)

    log(`✅ Table '${tableName}' created successfully!`)
    log(`Rows: ${rowCount}`)
    log('\nSchema:')
    displayResults(schemaResult)

    // Check for geometry columns and auto-visualize
    const geomColumns = await detectGeometryColumns(tableName)
    if (geomColumns.length > 0) {
      log(`\n🗺️ Spatial data detected! Geometry columns: ${geomColumns.join(', ')}`)

      // Auto-visualize spatial data
      const map = getMap()
      if (map) {
        log('Auto-visualizing spatial data...')

        // Get all columns
        const allColumns = await getTableColumns(tableName)
        const propertyColumns = allColumns.filter(col => !geomColumns.includes(col))

        // Use the first geometry column
        const geomColumn = geomColumns[0]
        const layerId = await addDuckDBLayer(map, tableName, geomColumn, propertyColumns)

        if (layerId) {
          log(`✅ Layer automatically added to map: ${layerId}`)
          updateLayerList()
        }
      }
    }

    // Add to loaded tables list if not already there
    if (!loadedTables.includes(tableName)) {
      loadedTables.push(tableName)
    }

  } catch (error) {
    log(`❌ Error loading data: ${error}`)
  }
})

// Allow Enter key to submit in URL input
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !loadBtn.disabled) {
    loadBtn.click()
  }
})

loadSampleBtn.addEventListener('click', async () => {
  try {
    clearOutput()
    log('Creating sample spatial data...')

    // Create sample points table
    const sampleQuery = `
      CREATE OR REPLACE TABLE sample_points AS
      SELECT
        id,
        name,
        ST_Point(lng, lat) as geometry,
        population
      FROM (
        VALUES
          (1, 'Tokyo', 139.6917, 35.6895, 37400068),
          (2, 'Yokohama', 139.6380, 35.4437, 3776264),
          (3, 'Osaka', 135.5022, 34.6937, 2728811),
          (4, 'Nagoya', 136.9066, 35.1815, 2331080),
          (5, 'Sapporo', 141.3545, 43.0642, 1973832),
          (6, 'Fukuoka', 130.4017, 33.5904, 1612392),
          (7, 'Kobe', 135.1951, 34.6901, 1522188),
          (8, 'Kyoto', 135.7681, 35.0116, 1466937),
          (9, 'Kawasaki', 139.7172, 35.5208, 1539522),
          (10, 'Saitama', 139.6566, 35.8617, 1332854)
      ) AS t(id, name, lng, lat, population)
    `

    await executeSql(sampleQuery)

    log('✅ Sample points table created!')

    // Show sample data
    const results = await executeSql('SELECT id, name, ST_AsText(geometry) as geom_wkt, population FROM sample_points ORDER BY population DESC')
    log('\nSample data:')
    displayResults(results)

    // Auto-visualize sample points
    const map = getMap()
    if (map) {
      log('\n🗺️ Auto-visualizing sample points...')

      const allColumns = await getTableColumns('sample_points')
      const geomColumns = ['geometry']
      const propertyColumns = allColumns.filter(col => !geomColumns.includes(col))

      const layerId = await addDuckDBLayer(map, 'sample_points', 'geometry', propertyColumns)

      if (layerId) {
        log(`✅ Sample points automatically added to map!`)
        updateLayerList()
      }
    }

  } catch (error) {
    log(`❌ Error creating sample data: ${error}`)
  }
})