import './style.css'
import { initializeDuckDB, executeSql } from './duckdb'
import { initializeMap } from './map'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="sidebar">
    <h1>DuckDB-WASM + MapLibre</h1>

    <div class="card">
      <h3>Load Data from URL</h3>
      <div style="display: flex; gap: 10px; margin-bottom: 20px;">
        <input
          id="url-input"
          type="text"
          placeholder="Enter data URL (CSV, JSON, Parquet, etc.)"
          style="flex: 1; padding: 8px; font-size: 14px;"
          value="https://raw.githubusercontent.com/duckdb/duckdb/main/data/csv/weather.csv"
        />
        <input
          id="table-name"
          type="text"
          placeholder="Table name"
          style="width: 150px; padding: 8px; font-size: 14px;"
          value="data"
        />
        <button id="load-btn" type="button" disabled>Load Data</button>
      </div>

      <h3>SQL Query</h3>
      <textarea
        id="sql-input"
        placeholder="Enter SQL query (e.g., SELECT * FROM data LIMIT 10)"
        style="width: 100%; height: 100px; padding: 8px; font-size: 14px; font-family: monospace;"
      >SELECT * FROM data LIMIT 10</textarea>
      <button id="query-btn" type="button" style="margin-top: 10px;" disabled>Run Query</button>
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
const sqlInput = document.querySelector<HTMLTextAreaElement>('#sql-input')!
const queryBtn = document.querySelector<HTMLButtonElement>('#query-btn')!
const output = document.querySelector<HTMLDivElement>('#output')!

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

  // Rows
  results.forEach(row => {
    const rowStr = columns.map((col, i) =>
      String(row[col]).padEnd(maxWidths[i])
    ).join(' | ')
    log(rowStr)
  })

  log(`\n${results.length} rows returned`)
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
    log('\nReady to load data!')

    loadBtn.disabled = false
    queryBtn.disabled = false

    // Initialize Map
    initializeMap()
    log('✅ Map initialized successfully!')

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

    // Add to loaded tables list if not already there
    if (!loadedTables.includes(tableName)) {
      loadedTables.push(tableName)
    }

    // Update SQL input with sample query
    sqlInput.value = `SELECT * FROM ${tableName} LIMIT 10`

  } catch (error) {
    log(`❌ Error loading data: ${error}`)
  }
})

queryBtn.addEventListener('click', async () => {
  const sql = sqlInput.value.trim()

  if (!sql) {
    alert('Please enter a SQL query')
    return
  }

  try {
    clearOutput()
    log(`Executing query:\n${sql}\n`)

    const startTime = performance.now()
    const results = await executeSql(sql)
    const endTime = performance.now()

    log(`Query executed in ${(endTime - startTime).toFixed(2)}ms\n`)
    displayResults(results)

  } catch (error) {
    log(`❌ Error executing query: ${error}`)
  }
})

// Allow Enter key to submit in URL input
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !loadBtn.disabled) {
    loadBtn.click()
  }
})

// Allow Ctrl+Enter to run query in SQL textarea
sqlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !queryBtn.disabled) {
    e.preventDefault()
    queryBtn.click()
  }
})