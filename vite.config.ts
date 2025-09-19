import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/duckdb-wasm-mvt/',
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm']
  }
})