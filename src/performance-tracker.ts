export interface TileMetrics {
  tileId: string;
  fetchTime: number;
  convertTime: number;
  totalTime: number;
  features: number;
  tileSize: number;
  timestamp: number;
}

class PerformanceTracker {
  private metrics: TileMetrics[] = [];
  private maxMetrics = 100; // Keep last 100 tile metrics

  addMetric(metric: TileMetrics): void {
    this.metrics.push(metric);

    // Keep only the last maxMetrics entries
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }

    this.updateUI();
  }

  getAverages(): {
    avgTotal: number;
    avgFetch: number;
    avgConvert: number;
    totalTiles: number;
  } {
    if (this.metrics.length === 0) {
      return { avgTotal: 0, avgFetch: 0, avgConvert: 0, totalTiles: 0 };
    }

    const sum = this.metrics.reduce(
      (acc, m) => ({
        total: acc.total + m.totalTime,
        fetch: acc.fetch + m.fetchTime,
        convert: acc.convert + m.convertTime,
      }),
      { total: 0, fetch: 0, convert: 0 }
    );

    return {
      avgTotal: sum.total / this.metrics.length,
      avgFetch: sum.fetch / this.metrics.length,
      avgConvert: sum.convert / this.metrics.length,
      totalTiles: this.metrics.length,
    };
  }

  private updateUI(): void {
    const perfCard = document.getElementById('performance-stats');
    const totalTilesEl = document.getElementById('total-tiles');
    const avgTotalEl = document.getElementById('avg-total');
    const avgFetchEl = document.getElementById('avg-fetch');
    const avgConvertEl = document.getElementById('avg-convert');
    const perfDetailsEl = document.getElementById('perf-details');

    if (!perfCard || !totalTilesEl || !avgTotalEl || !avgFetchEl || !avgConvertEl || !perfDetailsEl) {
      return;
    }

    // Show the performance card
    perfCard.style.display = 'block';

    // Update averages
    const avgs = this.getAverages();
    totalTilesEl.textContent = avgs.totalTiles.toString();
    avgTotalEl.textContent = avgs.avgTotal.toFixed(2);
    avgFetchEl.textContent = avgs.avgFetch.toFixed(2);
    avgConvertEl.textContent = avgs.avgConvert.toFixed(2);

    // Update recent tiles list (show last 10)
    const recentMetrics = this.metrics.slice(-10).reverse();
    const detailsHtml = recentMetrics
      .map(m => {
        const time = new Date(m.timestamp).toLocaleTimeString();
        const method = m.tileId.startsWith('[Native]') ? '🔵 Native' : '🟢 GeoJSON';
        const cleanTileId = m.tileId.replace(/^\[(Native|GeoJSON)\]\s*/, '');
        return `<div style="margin-bottom: 5px; padding: 5px; background: rgba(255,255,255,0.05); border-radius: 3px;">
          <div><strong>${method} ${cleanTileId}</strong> @ ${time}</div>
          <div>Total: ${m.totalTime.toFixed(2)}ms | Fetch: ${m.fetchTime.toFixed(2)}ms | Convert: ${m.convertTime.toFixed(2)}ms</div>
          <div>${m.features >= 0 ? `Features: ${m.features} | ` : ''}Size: ${(m.tileSize / 1024).toFixed(2)}KB</div>
        </div>`;
      })
      .join('');

    perfDetailsEl.innerHTML = detailsHtml || '<div style="padding: 10px; color: #888;">No tile metrics yet</div>';
  }

  clear(): void {
    this.metrics = [];
    this.updateUI();
  }
}

export const performanceTracker = new PerformanceTracker();