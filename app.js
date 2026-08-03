/**
 * 台股投資組合模擬器 — app.js
 * FinMind API + LocalStorage + Chart.js
 * 台股開市時段（09:00–13:30 週一至週五）每 30 分鐘自動更新
 */

'use strict';

/* ============================================================
   CONFIG
============================================================ */
const CONFIG = {
  token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiam95c3Vubnk4NzY2NjZAZ21haWwuY29tIiwiZW1haWwiOiJqb3lzdW5ueTg3NjY2NkBnbWFpbC5jb20iLCJ0b2tlbl92ZXJzaW9uIjowfQ.sw211PcPgkUY6dj2cUAh760lWIjKJLHTf38ZW9B2vAA',
  apiBase: 'https://api.finmindtrade.com/api/v4/data',
  refreshIntervalMs: 30 * 60 * 1000,   // 30 minutes
  marketOpen:  { h: 9,  m: 0  },       // 09:00 TST
  marketClose: { h: 13, m: 30 },       // 13:30 TST
};

/* ============================================================
   UTILITIES
============================================================ */
const fmt = {
  /** Format number as TWD currency string */
  currency(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
  },
  /** Format price with 2 decimals */
  price(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  /** Format percentage */
  pct(n) {
    if (n == null || isNaN(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${Number(n).toFixed(2)}%`;
  },
  /** Format change with sign */
  change(n) {
    if (n == null || isNaN(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${Number(n).toFixed(2)}`;
  },
  /** Format time HH:MM:SS */
  time(d = new Date()) {
    return d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  },
  /** Format date YYYY-MM-DD */
  date(d = new Date()) {
    return d.toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  },
  /** N days ago date string */
  daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return this.date(d);
  }
};

function getTaipeiNow() {
  const now = new Date();
  const ts = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' });
  return new Date(ts);
}

function isTaiwanMarketOpen() {
  const t = getTaipeiNow();
  const day = t.getDay();           // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const totalMin = t.getHours() * 60 + t.getMinutes();
  const openMin  = CONFIG.marketOpen.h  * 60 + CONFIG.marketOpen.m;
  const closeMin = CONFIG.marketClose.h * 60 + CONFIG.marketClose.m;
  return totalMin >= openMin && totalMin <= closeMin;
}

function isWeekday() {
  const day = getTaipeiNow().getDay();
  return day >= 1 && day <= 5;
}

/* ============================================================
   LOCAL STORAGE
============================================================ */
const Storage = (() => {
  const KEYS = {
    portfolio: 'twstock_portfolio_v2',
    history:   'twstock_history_v2',
  };

  return {
    getPortfolio() {
      try { return JSON.parse(localStorage.getItem(KEYS.portfolio)) || []; }
      catch { return []; }
    },
    savePortfolio(data) {
      localStorage.setItem(KEYS.portfolio, JSON.stringify(data));
    },
    getHistory() {
      try { return JSON.parse(localStorage.getItem(KEYS.history)) || {}; }
      catch { return {}; }
    },
    /** Append a history data point {time, value} for today */
    appendHistory(totalValue) {
      const today = fmt.date();
      const history = this.getHistory();
      if (!history[today]) history[today] = [];

      const entry = { time: fmt.time(), value: Math.round(totalValue) };
      // Avoid duplicates within 1 minute
      const last = history[today].at(-1);
      if (!last || last.time.slice(0,5) !== entry.time.slice(0,5)) {
        history[today].push(entry);
      }
      // Keep only last 7 days
      const allDates = Object.keys(history).sort();
      while (allDates.length > 7) {
        delete history[allDates.shift()];
      }
      localStorage.setItem(KEYS.history, JSON.stringify(history));
      return history[today];
    },
    getTodayHistory() {
      const history = this.getHistory();
      return history[fmt.date()] || [];
    }
  };
})();

/* ============================================================
   FINMIND API
============================================================ */
const FinMindAPI = (() => {
  const cache = new Map();           // stockId -> { name, price, change, changePct, date }

  async function fetchJSON(params) {
    const url = new URL(CONFIG.apiBase);
    Object.entries({ ...params, token: CONFIG.token }).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 200) throw new Error(json.msg || 'API error');
    return json.data;
  }

  async function getStockName(stockId) {
    try {
      const data = await fetchJSON({ dataset: 'TaiwanStockInfo', stock_id: stockId });
      if (data && data.length > 0) return data[0].stock_name || stockId;
    } catch { /* ignore */ }
    return stockId;
  }

  async function getStockPrice(stockId) {
    const startDate = fmt.daysAgo(7);  // look back 7 days to handle holidays
    const data = await fetchJSON({
      dataset: 'TaiwanStockPrice',
      stock_id: stockId,
      start_date: startDate,
    });
    if (!data || data.length === 0) throw new Error(`找不到 ${stockId} 的資料`);

    // Sort by date descending, pick latest
    const sorted = [...data].sort((a, b) => b.date.localeCompare(a.date));
    const latest = sorted[0];
    const prev   = sorted[1] || latest;

    const close  = parseFloat(latest.close);
    const prevClose = parseFloat(prev.close);
    const change = close - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return {
      price:     close,
      change:    change,
      changePct: changePct,
      date:      latest.date,
    };
  }

  return {
    cache,
    /**
     * Lookup name for a stockId (with cache)
     */
    async lookupName(stockId) {
      if (cache.has(stockId)) return cache.get(stockId).name || stockId;
      const name = await getStockName(stockId);
      const existing = cache.get(stockId) || {};
      cache.set(stockId, { ...existing, name });
      return name;
    },

    /**
     * Fetch latest price for a single stock
     */
    async fetchPrice(stockId) {
      const priceData = await getStockPrice(stockId);
      const name = await getStockName(stockId);
      const result = { name, ...priceData };
      cache.set(stockId, result);
      return result;
    },

    /**
     * Refresh prices for all given stockIds (in parallel)
     */
    async refreshAll(stockIds) {
      const results = {};
      await Promise.allSettled(
        stockIds.map(async id => {
          try {
            results[id] = await this.fetchPrice(id);
          } catch (e) {
            console.warn(`[FinMind] Failed for ${id}:`, e.message);
            // Use cached value if available
            if (cache.has(id)) results[id] = cache.get(id);
          }
        })
      );
      return results;
    },

    getCached(stockId) {
      return cache.get(stockId) || null;
    }
  };
})();

/* ============================================================
   PORTFOLIO STATE
============================================================ */
const Portfolio = (() => {
  let stocks = [];   // [{ id, name, shares, costPerShare }]
  let prices = {};   // { stockId: { price, change, changePct, date } }

  function load() {
    stocks = Storage.getPortfolio();
  }

  function save() {
    Storage.savePortfolio(stocks);
  }

  function add(entry) {
    const existing = stocks.findIndex(s => s.id === entry.id);
    if (existing >= 0) {
      stocks[existing] = { ...stocks[existing], ...entry };
    } else {
      stocks.push(entry);
    }
    save();
  }

  function remove(stockId) {
    stocks = stocks.filter(s => s.id !== stockId);
    save();
  }

  function update(originalId, entry) {
    const idx = stocks.findIndex(s => s.id === originalId);
    if (idx >= 0) {
      stocks[idx] = { ...stocks[idx], ...entry, id: entry.id };
      save();
    }
  }

  function getAll() { return [...stocks]; }

  function getPriceData(stockId) {
    return prices[stockId] || FinMindAPI.getCached(stockId) || null;
  }

  function setPrices(newPrices) {
    prices = { ...prices, ...newPrices };
  }

  function getStats() {
    let totalValue = 0;
    let totalCost  = 0;

    for (const s of stocks) {
      const p = getPriceData(s.id);
      if (p) {
        totalValue += s.shares * p.price;
      }
      totalCost += s.shares * s.costPerShare;
    }

    const totalPnL    = totalValue - totalCost;
    const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

    return { totalValue, totalCost, totalPnL, totalPnLPct, count: stocks.length };
  }

  function getStockIds() { return stocks.map(s => s.id); }

  return { load, save, add, remove, update, getAll, getPriceData, setPrices, getStats, getStockIds };
})();

/* ============================================================
   CHARTS
============================================================ */
const Charts = (() => {
  let pieChart = null;
  let lineChart = null;

  const palette = [
    '#6366f1', '#22d3ee', '#10b981', '#f59e0b', '#f43f5e',
    '#a855f7', '#3b82f6', '#ec4899', '#14b8a6', '#84cc16',
    '#f97316', '#06b6d4', '#8b5cf6', '#ef4444', '#78716c',
  ];

  function destroyPie() { if (pieChart) { pieChart.destroy(); pieChart = null; } }
  function destroyLine() { if (lineChart) { lineChart.destroy(); lineChart = null; } }

  function initPie(labels, values) {
    destroyPie();
    const ctx = document.getElementById('pie-chart').getContext('2d');
    pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: palette.slice(0, labels.length),
          borderWidth: 2,
          borderColor: 'rgba(6,11,24,0.8)',
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#94a3b8',
              padding: 12,
              font: { family: 'Inter', size: 11 },
              boxWidth: 12,
              usePointStyle: true,
              pointStyleWidth: 10,
            }
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                return ` ${ctx.label}: ${fmt.currency(ctx.raw)} (${pct}%)`;
              }
            },
            backgroundColor: 'rgba(17,29,53,0.95)',
            borderColor: 'rgba(255,255,255,0.12)',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#94a3b8',
            padding: 12,
          }
        },
        animation: { duration: 600 }
      }
    });
  }

  function initLine(labels, values) {
    destroyLine();
    const ctx = document.getElementById('line-chart').getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

    lineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '投資組合市值',
          data: values,
          borderColor: '#6366f1',
          backgroundColor: gradient,
          borderWidth: 2.5,
          pointRadius: 5,
          pointHoverRadius: 8,
          pointBackgroundColor: '#6366f1',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.35,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) { return ` ${fmt.currency(ctx.raw)}`; }
            },
            backgroundColor: 'rgba(17,29,53,0.95)',
            borderColor: 'rgba(255,255,255,0.12)',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#a5b4fc',
            padding: 12,
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#475569', font: { family: 'JetBrains Mono', size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              color: '#475569',
              font: { family: 'JetBrains Mono', size: 10 },
              callback(v) { return fmt.currency(v); }
            }
          }
        },
        animation: { duration: 500 },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  }

  function updatePie(stocks, getPriceData) {
    const pieEmpty = document.getElementById('pie-empty');
    const pieCanvas = document.getElementById('pie-chart');

    const validStocks = stocks.filter(s => getPriceData(s.id));
    if (validStocks.length === 0) {
      pieEmpty.style.display = '';
      pieCanvas.style.display = 'none';
      destroyPie();
      return;
    }

    pieEmpty.style.display = 'none';
    pieCanvas.style.display = 'block';

    const labels = validStocks.map(s => {
      const p = getPriceData(s.id);
      return `${s.id} ${p?.name || s.name || ''}`;
    });
    const values = validStocks.map(s => {
      const p = getPriceData(s.id);
      return Math.max(0, s.shares * (p?.price || 0));
    });

    if (!pieChart) {
      initPie(labels, values);
    } else {
      pieChart.data.labels = labels;
      pieChart.data.datasets[0].data = values;
      pieChart.data.datasets[0].backgroundColor = palette.slice(0, labels.length);
      pieChart.update('active');
    }
  }

  function updateLine(history) {
    const lineEmpty = document.getElementById('line-empty');
    const lineCanvas = document.getElementById('line-chart');

    if (!history || history.length === 0) {
      lineEmpty.style.display = '';
      lineCanvas.style.display = 'none';
      destroyLine();
      return;
    }

    lineEmpty.style.display = 'none';
    lineCanvas.style.display = 'block';

    const labels = history.map(h => h.time.slice(0, 5));
    const values = history.map(h => h.value);

    if (!lineChart) {
      initLine(labels, values);
    } else {
      lineChart.data.labels = labels;
      lineChart.data.datasets[0].data = values;
      lineChart.update('active');
    }
  }

  return { updatePie, updateLine };
})();

/* ============================================================
   UI RENDERING
============================================================ */
const UI = (() => {
  function renderStatCards(stats) {
    const { totalValue, totalCost, totalPnL, totalPnLPct, count } = stats;

    // Total value
    setEl('stat-total-value', fmt.currency(totalValue));

    // Total cost
    setEl('stat-total-cost', fmt.currency(totalCost));

    // PnL
    const pnlEl = document.getElementById('stat-pnl');
    const pnlPctEl = document.getElementById('stat-pnl-pct');
    if (pnlEl) {
      pnlEl.textContent = totalCost > 0 ? fmt.currency(totalPnL) : '—';
      pnlEl.className = 'stat-value ' + (totalPnL >= 0 ? 'positive' : 'negative');
    }
    if (pnlPctEl) {
      pnlPctEl.textContent = totalCost > 0 ? fmt.pct(totalPnLPct) : '—';
      pnlPctEl.className = 'stat-sub ' + (totalPnL >= 0 ? 'positive' : 'negative');
    }

    // Count
    setEl('stat-count', String(count));
  }

  function renderTable(stocks, getPriceData) {
    const tbody = document.getElementById('portfolio-tbody');
    if (!tbody) return;

    if (stocks.length === 0) {
      tbody.innerHTML = `
        <tr id="empty-row">
          <td colspan="10" class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>尚無持股，點擊「新增股票」開始</div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = stocks.map(s => {
      const p = getPriceData(s.id);
      const price     = p ? p.price     : null;
      const change    = p ? p.change    : null;
      const changePct = p ? p.changePct : null;
      const name      = (p && p.name) || s.name || s.id;

      const marketValue = price != null ? s.shares * price : null;
      const totalCost   = s.shares * s.costPerShare;
      const pnl         = marketValue != null ? marketValue - totalCost : null;
      const pnlPct      = totalCost > 0 && pnl != null ? (pnl / totalCost) * 100 : null;

      const changeClass = change == null ? 'neutral' : change >= 0 ? 'positive' : 'negative';
      const pnlClass    = pnl    == null ? ''        : pnl    >= 0 ? 'positive' : 'negative';
      const changeSign  = change >= 0 ? '▲' : '▼';

      return `
        <tr data-id="${s.id}">
          <td>
            <div class="stock-info">
              <span class="stock-name">${escHtml(name)}</span>
              <span class="stock-code">${escHtml(s.id)}</span>
            </div>
          </td>
          <td class="price-cell">${price != null ? fmt.price(price) : '<span class="skeleton" style="width:60px;height:16px;display:inline-block"></span>'}</td>
          <td>
            <span class="change-pill ${changeClass}">
              ${change != null ? `${changeSign} ${fmt.change(Math.abs(change))} (${fmt.pct(changePct)})` : '—'}
            </span>
          </td>
          <td>${Number(s.shares).toLocaleString()}</td>
          <td class="price-cell">${fmt.price(s.costPerShare)}</td>
          <td class="price-cell">${fmt.currency(totalCost)}</td>
          <td class="price-cell">${marketValue != null ? fmt.currency(marketValue) : '—'}</td>
          <td class="pnl-cell ${pnlClass}">${pnl != null ? fmt.currency(pnl) : '—'}</td>
          <td class="pnl-cell ${pnlClass}">${pnlPct != null ? fmt.pct(pnlPct) : '—'}</td>
          <td>
            <div class="actions-cell">
              <button class="action-btn edit" data-action="edit" data-id="${s.id}" title="編輯" aria-label="編輯 ${escHtml(name)}">
                <i class="fas fa-pen-to-square"></i>
              </button>
              <button class="action-btn delete" data-action="delete" data-id="${s.id}" title="刪除" aria-label="刪除 ${escHtml(name)}">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  function updateMarketStatus(isOpen) {
    const badge = document.getElementById('market-badge');
    const label = document.getElementById('market-label');
    if (!badge || !label) return;

    if (isOpen) {
      badge.className = 'market-badge open';
      label.textContent = '台股開市中';
    } else {
      badge.className = 'market-badge closed';
      const now = getTaipeiNow();
      const h = now.getHours();
      if (!isWeekday()) {
        label.textContent = '週末休市';
      } else if (h < 9) {
        label.textContent = '盤前';
      } else {
        label.textContent = '收盤';
      }
    }
  }

  function updateLastUpdated() {
    const el = document.getElementById('last-updated');
    if (el) el.textContent = '更新：' + fmt.time();
  }

  function flashValues() {
    document.querySelectorAll('.price-cell, .pnl-cell, .stat-value').forEach(el => {
      el.classList.remove('value-updating');
      void el.offsetWidth;
      el.classList.add('value-updating');
    });
  }

  function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showNotification(message, type = 'info') {
    const el = document.getElementById('notification');
    if (!el) return;
    el.className = `${type}`;
    el.innerHTML = `<i class="fas ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info'}"></i> ${message}`;
    el.classList.remove('hidden');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  return { renderStatCards, renderTable, updateMarketStatus, updateLastUpdated, flashValues, showNotification };
})();

/* ============================================================
   MODAL
============================================================ */
const Modal = (() => {
  let lookupTimer = null;
  let editMode = false;
  let editOriginalId = null;

  function open(mode = 'add', stock = null) {
    editMode = (mode === 'edit');
    editOriginalId = editMode ? stock.id : null;

    document.getElementById('modal-title').textContent = editMode ? '編輯持股' : '新增股票';
    document.getElementById('modal-submit').textContent = editMode ? '確認修改' : '確認新增';

    const idInput   = document.getElementById('input-stock-id');
    const sharesIn  = document.getElementById('input-shares');
    const costIn    = document.getElementById('input-cost');
    const hintEl    = document.getElementById('stock-name-hint');

    if (editMode && stock) {
      idInput.value   = stock.id;
      idInput.readOnly = true;
      sharesIn.value  = stock.shares;
      costIn.value    = stock.costPerShare;

      const cached = FinMindAPI.getCached(stock.id);
      if (cached) {
        hintEl.textContent = `✓ ${cached.name}`;
        hintEl.className = 'input-hint found';
      } else {
        hintEl.textContent = stock.name || stock.id;
        hintEl.className = 'input-hint found';
      }
    } else {
      idInput.value    = '';
      idInput.readOnly = false;
      sharesIn.value   = '';
      costIn.value     = '';
      hintEl.textContent = '輸入代號後自動查詢公司名稱';
      hintEl.className = 'input-hint';
    }

    document.getElementById('stock-modal').classList.remove('hidden');
    setTimeout(() => (editMode ? sharesIn : idInput).focus(), 100);
  }

  function close() {
    document.getElementById('stock-modal').classList.add('hidden');
    clearTimeout(lookupTimer);
  }

  function bindEvents() {
    document.getElementById('modal-close').addEventListener('click', close);
    document.getElementById('modal-cancel').addEventListener('click', close);
    document.getElementById('stock-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('stock-modal')) close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    // Auto-lookup on stock ID input
    document.getElementById('input-stock-id').addEventListener('input', function() {
      const val = this.value.trim().toUpperCase();
      const hint = document.getElementById('stock-name-hint');
      clearTimeout(lookupTimer);

      if (!val) {
        hint.textContent = '輸入代號後自動查詢公司名稱';
        hint.className = 'input-hint';
        return;
      }

      hint.textContent = '查詢中...';
      hint.className = 'input-hint loading';

      lookupTimer = setTimeout(async () => {
        try {
          const name = await FinMindAPI.lookupName(val);
          if (name && name !== val) {
            hint.textContent = `✓ ${name}`;
            hint.className = 'input-hint found';
          } else {
            hint.textContent = '⚠ 未找到，請確認代號';
            hint.className = 'input-hint error';
          }
        } catch {
          hint.textContent = '⚠ 查詢失敗';
          hint.className = 'input-hint error';
        }
      }, 600);
    });

    // Form submit
    document.getElementById('stock-form').addEventListener('submit', async e => {
      e.preventDefault();
      const submitBtn = document.getElementById('modal-submit');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 處理中...';

      try {
        const stockId = document.getElementById('input-stock-id').value.trim().toUpperCase();
        const shares  = parseInt(document.getElementById('input-shares').value, 10);
        const cost    = parseFloat(document.getElementById('input-cost').value);

        if (!stockId || isNaN(shares) || shares <= 0 || isNaN(cost) || cost <= 0) {
          UI.showNotification('請填寫所有欄位（數值需大於 0）', 'error');
          return;
        }

        // Fetch price if not cached
        let name = stockId;
        if (!FinMindAPI.getCached(stockId)) {
          UI.showNotification('正在取得股票資料...', 'info');
          const data = await FinMindAPI.fetchPrice(stockId);
          name = data.name || stockId;
          Portfolio.setPrices({ [stockId]: data });
        } else {
          name = FinMindAPI.getCached(stockId).name || stockId;
        }

        const entry = { id: stockId, name, shares, costPerShare: cost };

        if (editMode) {
          Portfolio.update(editOriginalId, entry);
          UI.showNotification(`已更新 ${name}`, 'success');
        } else {
          Portfolio.add(entry);
          UI.showNotification(`已新增 ${name}`, 'success');
        }

        close();
        renderAll();

      } catch (err) {
        UI.showNotification(`操作失敗：${err.message}`, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = editMode ? '確認修改' : '確認新增';
      }
    });
  }

  return { open, close, bindEvents };
})();

/* ============================================================
   REFRESH ENGINE
============================================================ */
const Refresher = (() => {
  let intervalId = null;

  async function refresh(showFlash = true) {
    const ids = Portfolio.getStockIds();
    if (ids.length === 0) {
      UI.updateMarketStatus(isTaiwanMarketOpen());
      UI.updateLastUpdated();
      return;
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      const prices = await FinMindAPI.refreshAll(ids);
      Portfolio.setPrices(prices);

      const stats = Portfolio.getStats();
      const stocks = Portfolio.getAll();

      UI.renderStatCards(stats);
      UI.renderTable(stocks, id => Portfolio.getPriceData(id));
      Charts.updatePie(stocks, id => Portfolio.getPriceData(id));

      // Append history and update line chart only if we have value
      if (stats.totalValue > 0) {
        const todayHistory = Storage.appendHistory(stats.totalValue);
        Charts.updateLine(todayHistory);
      }

      if (showFlash) UI.flashValues();
      UI.updateMarketStatus(isTaiwanMarketOpen());
      UI.updateLastUpdated();

    } catch (err) {
      console.error('[Refresher] Error:', err);
      UI.showNotification('更新失敗：' + err.message, 'error');
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  }

  function start() {
    stop();
    // Check every minute if it's time to auto-refresh
    intervalId = setInterval(() => {
      if (isTaiwanMarketOpen()) {
        const now = getTaipeiNow();
        const m = now.getMinutes();
        // Fire at :00 and :30 minutes
        if (m === 0 || m === 30) {
          refresh(true);
        }
        // Update market badge every minute
        UI.updateMarketStatus(true);
      } else {
        UI.updateMarketStatus(false);
      }
    }, 60 * 1000);
  }

  function stop() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  return { refresh, start, stop };
})();

/* ============================================================
   EVENT BINDINGS
============================================================ */
function bindEvents() {
  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => Refresher.refresh(true));

  // Add stock button
  document.getElementById('add-stock-btn').addEventListener('click', () => Modal.open('add'));

  // Table action buttons (event delegation)
  document.getElementById('portfolio-tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const stockId = btn.dataset.id;
    const action  = btn.dataset.action;

    if (action === 'delete') {
      const stock = Portfolio.getAll().find(s => s.id === stockId);
      const name  = stock?.name || stockId;
      if (confirm(`確定要刪除 ${name}（${stockId}）嗎？`)) {
        Portfolio.remove(stockId);
        UI.showNotification(`已刪除 ${name}`, 'success');
        renderAll();
      }
    } else if (action === 'edit') {
      const stock = Portfolio.getAll().find(s => s.id === stockId);
      if (stock) Modal.open('edit', stock);
    }
  });

  Modal.bindEvents();
}

/* ============================================================
   RENDER ALL
============================================================ */
function renderAll() {
  const stocks = Portfolio.getAll();
  const stats  = Portfolio.getStats();

  UI.renderStatCards(stats);
  UI.renderTable(stocks, id => Portfolio.getPriceData(id));
  Charts.updatePie(stocks, id => Portfolio.getPriceData(id));
  Charts.updateLine(Storage.getTodayHistory());
  UI.updateMarketStatus(isTaiwanMarketOpen());
}

/* ============================================================
   INIT
============================================================ */
async function init() {
  Portfolio.load();
  bindEvents();
  renderAll();

  // Initial price fetch
  if (Portfolio.getStockIds().length > 0) {
    UI.showNotification('正在取得最新股價...', 'info');
    await Refresher.refresh(false);
  }

  // Start scheduler
  Refresher.start();
  UI.updateLastUpdated();
}

document.addEventListener('DOMContentLoaded', init);
