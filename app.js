/**
 * 台股投資組合模擬器 — app.js  v2
 * 修復：股票名稱 API 過濾 + 價格載入狀態追蹤
 */

'use strict';

/* ============================================================
   CONFIG
============================================================ */
const CONFIG = {
  token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiam95c3Vubnk4NzY2NjZAZ21haWwuY29tIiwiZW1haWwiOiJqb3lzdW5ueTg3NjY2NkBnbWFpbC5jb20iLCJ0b2tlbl92ZXJzaW9uIjowfQ.sw211PcPgkUY6dj2cUAh760lWIjKJLHTf38ZW9B2vAA',
  apiBase: 'https://api.finmindtrade.com/api/v4/data',
  refreshIntervalMs: 30 * 60 * 1000,
  marketOpen:  { h: 9,  m: 0  },
  marketClose: { h: 13, m: 30 },
};

/* ============================================================
   UTILITIES
============================================================ */
const fmt = {
  currency(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('zh-TW', {
      style: 'currency', currency: 'TWD',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n);
  },
  price(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  pct(n) {
    if (n == null || isNaN(n)) return '—';
    return `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
  },
  change(n) {
    if (n == null || isNaN(n)) return '—';
    return `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}`;
  },
  time(d = new Date()) {
    return d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  },
  date(d = new Date()) {
    return d.toLocaleDateString('sv', { timeZone: 'Asia/Taipei' });
  },
  daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return this.date(d);
  },
};

function getTaipeiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

function isTaiwanMarketOpen() {
  const t = getTaipeiNow();
  const day = t.getDay();
  if (day === 0 || day === 6) return false;
  const total = t.getHours() * 60 + t.getMinutes();
  return total >= CONFIG.marketOpen.h * 60 + CONFIG.marketOpen.m
      && total <= CONFIG.marketClose.h * 60 + CONFIG.marketClose.m;
}

function isWeekday() {
  const d = getTaipeiNow().getDay();
  return d >= 1 && d <= 5;
}

/* ============================================================
   LOCAL STORAGE
============================================================ */
const Storage = (() => {
  const KEYS = { portfolio: 'twstock_portfolio_v2', history: 'twstock_history_v2' };
  return {
    getPortfolio() { try { return JSON.parse(localStorage.getItem(KEYS.portfolio)) || []; } catch { return []; } },
    savePortfolio(d) { localStorage.setItem(KEYS.portfolio, JSON.stringify(d)); },
    getHistory()   { try { return JSON.parse(localStorage.getItem(KEYS.history))  || {}; } catch { return {}; } },
    appendHistory(totalValue) {
      const today = fmt.date();
      const history = this.getHistory();
      if (!history[today]) history[today] = [];
      const entry = { time: fmt.time(), value: Math.round(totalValue) };
      const last = history[today].at(-1);
      if (!last || last.time.slice(0, 5) !== entry.time.slice(0, 5)) history[today].push(entry);
      const allDates = Object.keys(history).sort();
      while (allDates.length > 7) delete history[allDates.shift()];
      localStorage.setItem(KEYS.history, JSON.stringify(history));
      return history[today];
    },
    getTodayHistory() { return (this.getHistory()[fmt.date()]) || []; },
  };
})();

/* ============================================================
   FINMIND API
   ★ Fix 1: getStockName — filter data array by stock_id
   ★ Fix 2: attemptedSet — track fetch attempts to stop ∞ skeleton
============================================================ */
const FinMindAPI = (() => {
  const cache       = new Map();   // stockId → { name, price, change, changePct, date }
  const attemptedSet = new Set();  // stockIds that have been fetched (success OR fail)

  async function fetchJSON(params) {
    const qp = { ...params, token: CONFIG.token };

    // Build direct GET URL
    const getUrl = new URL(CONFIG.apiBase);
    Object.entries(qp).forEach(([k, v]) => getUrl.searchParams.set(k, v));
    const directUrl = getUrl.toString();

    // Build POST form body
    const postBody = new URLSearchParams(qp).toString();

    // Parse a FinMind response — throws on HTTP / API errors
    async function parse(res) {
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('FORMAT_ERR'); }
      if (json.status !== 200) throw new Error(`API_ERR: ${json.msg || json.status}`);
      return json.data;
    }

    // Four attempts in order — stop on first success
    const strategies = [
      {
        name: 'POST direct',
        exec: () => fetch(CONFIG.apiBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody,
        }),
      },
      {
        name: 'GET direct',
        exec: () => fetch(directUrl),
      },
      {
        name: 'allorigins proxy',
        exec: () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`),
      },
      {
        name: 'corsproxy.io',
        exec: () => fetch(`https://corsproxy.io/?${encodeURIComponent(directUrl)}`),
      },
    ];

    let lastErr = null;
    for (const { name, exec } of strategies) {
      try {
        const res  = await exec();
        const data = await parse(res);
        if (name !== 'POST direct' && name !== 'GET direct') {
          console.info(`[FinMind] 成功 via ${name}`);
        }
        return data;
      } catch (e) {
        lastErr = e;
        // Real API / HTTP errors: do NOT retry
        if (/^HTTP_|^API_ERR/.test(e.message)) {
          throw new Error(e.message.replace('HTTP_', 'HTTP ').replace('API_ERR: ', ''));
        }
        console.warn(`[FinMind] ${name} 失敗:`, e.message);
      }
    }

    // All 4 strategies failed
    throw new Error(`所有連線方式均失敗。請按 Ctrl+Shift+R 強制重載，或稍後再試。`);
  }

  // ★ Fix 1: filter by stock_id so we don't get the first stock in the whole list
  async function getStockName(stockId) {
    try {
      const data = await fetchJSON({ dataset: 'TaiwanStockInfo', stock_id: stockId });
      if (data && data.length > 0) {
        const match = data.find(d => String(d.stock_id) === String(stockId));
        if (match && match.stock_name) return match.stock_name;
        // Fallback: if API ignores filter, try searching manually
        console.warn(`[FinMind] TaiwanStockInfo filter may not work for ${stockId}, got ${data.length} rows`);
      }
    } catch (e) {
      console.warn('[FinMind] getStockName failed:', stockId, e.message);
    }
    return null; // null = unknown, will show stock_id instead
  }

  // ── TWSE STOCK_DAY_ALL cache (all listed stocks, no params needed) ─────────
  let _twseCache = null;
  let _twseCacheAt = 0;

  async function fetchTWSEAll() {
    // Refresh cache every 5 min
    if (_twseCache && Date.now() - _twseCacheAt < 5 * 60_000) return _twseCache;
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    if (!res.ok) throw new Error(`TWSE_ALL HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('TWSE_ALL: 空回應');
    _twseCache = data;
    _twseCacheAt = Date.now();
    return data;
  }

  // ① TWSE 官方（openapi.twse.com.tw）— 上市股票，含股票名稱
  async function getStockPriceTWSE(stockId) {
    const all = await fetchTWSEAll();
    const row = all.find(d => String(d.Code) === String(stockId));
    if (!row) throw new Error(`TWSE: ${stockId} 不在上市清單（可能為上櫃）`);

    const parseP = v => parseFloat(String(v || '0').replace(/,/g, '')) || 0;
    const close = parseP(row.ClosingPrice);
    if (!close) throw new Error(`TWSE: ${stockId} 收盤價無效`);

    const changeStr = String(row.Change || '0').replace(/,/g, '');
    const change    = /^[+\-]?\d/.test(changeStr) ? parseFloat(changeStr) : 0;
    const prevClose = close - change;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    console.info(`[TWSE] ${stockId}(${row.Name}) 收盤:${close} 漲跌:${change >= 0 ? '+' : ''}${change}`);
    return { price: close, change, changePct, date: fmt.date(), _twseName: row.Name || null };
  }

  // ② Yahoo Finance — 上市/上櫃皆可（.TW / .TWO）
  async function getStockPriceYahoo(stockId) {
    for (const suffix of ['.TW', '.TWO']) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/` +
                    `${stockId}${suffix}?interval=1d&range=5d&includePrePost=false`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) continue;

        const price     = meta.regularMarketPrice;
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change    = price - prevClose;
        const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
        console.info(`[Yahoo] ${stockId}${suffix} 現價:${price}`);
        return { price, change, changePct, date: fmt.date() };
      } catch { continue; }
    }
    throw new Error(`Yahoo: ${stockId} 查無資料`);
  }

  // ③ FinMind（備援，CORS 受限但有 proxy 保底）
  async function getStockPriceFinMind(stockId) {
    const data = await fetchJSON({
      dataset: 'TaiwanStockPrice',
      stock_id: stockId,
      start_date: fmt.daysAgo(10),
    });
    if (!data || data.length === 0) throw new Error(`FinMind: 查無 ${stockId} 近10日資料`);
    const sorted    = [...data].sort((a, b) => b.date.localeCompare(a.date));
    const latest    = sorted[0], prev = sorted[1] || latest;
    const close     = parseFloat(latest.close);
    const prevClose = parseFloat(prev.close);
    const change    = close - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    return { price: close, change, changePct, date: latest.date };
  }

  // 三層 cascade：TWSE → Yahoo → FinMind
  async function getStockPrice(stockId) {
    const methods = [
      { name: 'TWSE',   fn: () => getStockPriceTWSE(stockId)   },
      { name: 'Yahoo',  fn: () => getStockPriceYahoo(stockId)  },
      { name: 'FinMind', fn: () => getStockPriceFinMind(stockId) },
    ];
    let lastErr;
    for (const { name, fn } of methods) {
      try   { return await fn(); }
      catch (e) { console.warn(`[Price] ${name} failed for ${stockId}: ${e.message}`); lastErr = e; }
    }
    throw new Error(`無法取得 ${stockId} 股價：${lastErr?.message}`);
  }

  return {
    cache,
    attemptedSet,

    hasAttempted(stockId) { return attemptedSet.has(stockId); },

    async lookupName(stockId) {
      if (cache.has(stockId) && cache.get(stockId).name) return cache.get(stockId).name;
      const name = await getStockName(stockId);
      cache.set(stockId, { ...(cache.get(stockId) || {}), name: name || stockId });
      return name || stockId;
    },

    async fetchPrice(stockId) {
      const priceData = await getStockPrice(stockId);
      // Use name from TWSE response if available (saves an extra API call)
      const twseName = priceData._twseName;
      delete priceData._twseName;
      const name = twseName || await getStockName(stockId) || stockId;
      const result = { name, ...priceData };
      cache.set(stockId, result);
      attemptedSet.add(stockId);
      return result;
    },

    // ★ Fix 2: mark attempted even on failure
    async refreshAll(stockIds) {
      const results = {};
      await Promise.allSettled(
        stockIds.map(async id => {
          try {
            results[id] = await this.fetchPrice(id);
          } catch (e) {
            console.warn(`[FinMind] refreshAll failed for ${id}:`, e.message);
            attemptedSet.add(id); // mark attempted so skeleton stops
            if (cache.has(id)) results[id] = cache.get(id);
          }
        })
      );
      return results;
    },

    getCached(stockId) { return cache.get(stockId) || null; },
  };
})();

/* ============================================================
   PORTFOLIO STATE
============================================================ */
const Portfolio = (() => {
  let stocks = [];
  let prices = {};

  return {
    load()          { stocks = Storage.getPortfolio(); },
    save()          { Storage.savePortfolio(stocks); },
    getAll()        { return [...stocks]; },
    getStockIds()   { return stocks.map(s => s.id); },

    add(entry) {
      const idx = stocks.findIndex(s => s.id === entry.id);
      if (idx >= 0) stocks[idx] = { ...stocks[idx], ...entry };
      else           stocks.push(entry);
      this.save();
    },

    remove(stockId) {
      stocks = stocks.filter(s => s.id !== stockId);
      this.save();
    },

    update(originalId, entry) {
      const idx = stocks.findIndex(s => s.id === originalId);
      if (idx >= 0) { stocks[idx] = { ...stocks[idx], ...entry, id: entry.id }; this.save(); }
    },

    // ★ Fix: update only the name field (called after API returns correct name)
    updateName(stockId, name) {
      if (!name || name === stockId) return;
      const idx = stocks.findIndex(s => s.id === stockId);
      if (idx >= 0 && stocks[idx].name !== name) {
        stocks[idx].name = name;
        this.save();
      }
    },

    setPrices(newPrices)      { prices = { ...prices, ...newPrices }; },
    getPriceData(stockId)     { return prices[stockId] || FinMindAPI.getCached(stockId) || null; },

    getStats() {
      let totalValue = 0, totalCost = 0;
      for (const s of stocks) {
        const p = this.getPriceData(s.id);
        if (p) totalValue += s.shares * p.price;
        totalCost += s.shares * s.costPerShare;
      }
      const totalPnL    = totalValue - totalCost;
      const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
      return { totalValue, totalCost, totalPnL, totalPnLPct, count: stocks.length };
    },
  };
})();

/* ============================================================
   CHARTS
============================================================ */
const Charts = (() => {
  let pieChart = null, lineChart = null;

  const palette = [
    '#6366f1','#22d3ee','#10b981','#f59e0b','#f43f5e',
    '#a855f7','#3b82f6','#ec4899','#14b8a6','#84cc16',
    '#f97316','#06b6d4','#8b5cf6','#ef4444','#78716c',
  ];

  return {
    updatePie(stocks, getPriceData) {
      const empty  = document.getElementById('pie-empty');
      const canvas = document.getElementById('pie-chart');
      const valid  = stocks.filter(s => getPriceData(s.id));

      if (valid.length === 0) {
        empty.style.display = ''; canvas.style.display = 'none';
        if (pieChart) { pieChart.destroy(); pieChart = null; } return;
      }
      empty.style.display = 'none'; canvas.style.display = 'block';

      const labels = valid.map(s => {
        const p = getPriceData(s.id);
        return `${s.id} ${p?.name || s.name || ''}`;
      });
      const values = valid.map(s => {
        const p = getPriceData(s.id);
        return Math.max(0, s.shares * (p?.price || 0));
      });

      if (!pieChart) {
        if (pieChart) pieChart.destroy();
        pieChart = new Chart(canvas.getContext('2d'), {
          type: 'doughnut',
          data: {
            labels,
            datasets: [{
              data: values,
              backgroundColor: palette.slice(0, labels.length),
              borderWidth: 2,
              borderColor: 'rgba(6,11,24,0.8)',
              hoverOffset: 8,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: true, cutout: '62%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: { color: '#94a3b8', padding: 12, font: { family: 'Inter', size: 11 }, boxWidth: 12, usePointStyle: true },
              },
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                    return ` ${ctx.label}: ${fmt.currency(ctx.raw)} (${total>0?((ctx.raw/total)*100).toFixed(1):0}%)`;
                  },
                },
                backgroundColor:'rgba(17,29,53,0.95)', borderColor:'rgba(255,255,255,0.12)', borderWidth:1,
                titleColor:'#f1f5f9', bodyColor:'#94a3b8', padding:12,
              },
            },
            animation: { duration: 600 },
          },
        });
      } else {
        pieChart.data.labels = labels;
        pieChart.data.datasets[0].data = values;
        pieChart.data.datasets[0].backgroundColor = palette.slice(0, labels.length);
        pieChart.update('active');
      }
    },

    updateLine(history) {
      const empty  = document.getElementById('line-empty');
      const canvas = document.getElementById('line-chart');

      if (!history || history.length === 0) {
        empty.style.display = ''; canvas.style.display = 'none';
        if (lineChart) { lineChart.destroy(); lineChart = null; } return;
      }
      empty.style.display = 'none'; canvas.style.display = 'block';

      const labels = history.map(h => h.time.slice(0, 5));
      const values = history.map(h => h.value);

      if (!lineChart) {
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 250);
        gradient.addColorStop(0, 'rgba(99,102,241,0.4)');
        gradient.addColorStop(1, 'rgba(99,102,241,0)');

        lineChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: '投資組合市值', data: values,
              borderColor: '#6366f1', backgroundColor: gradient,
              borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 8,
              pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 2,
              fill: true, tension: 0.35,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: { label(ctx) { return ` ${fmt.currency(ctx.raw)}`; } },
                backgroundColor:'rgba(17,29,53,0.95)', borderColor:'rgba(255,255,255,0.12)',
                borderWidth:1, titleColor:'#f1f5f9', bodyColor:'#a5b4fc', padding:12,
              },
            },
            scales: {
              x: { grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#475569', font:{family:'JetBrains Mono',size:10}} },
              y: { grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#475569', font:{family:'JetBrains Mono',size:10}, callback(v){ return fmt.currency(v); }} },
            },
            animation: { duration: 500 },
            interaction: { intersect: false, mode: 'index' },
          },
        });
      } else {
        lineChart.data.labels = labels;
        lineChart.data.datasets[0].data = values;
        lineChart.update('active');
      }
    },
  };
})();

/* ============================================================
   UI RENDERING
   ★ Fix 3: renderTable — after fetch attempted, show — not skeleton
============================================================ */
const UI = (() => {
  function escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function setEl(id, content) {
    const el = document.getElementById(id);
    if (el) el.textContent = content;
  }

  return {
    renderStatCards({ totalValue, totalCost, totalPnL, totalPnLPct, count }) {
      setEl('stat-total-value', fmt.currency(totalValue));
      setEl('stat-total-cost',  fmt.currency(totalCost));
      setEl('stat-count',       String(count));

      const pnlEl    = document.getElementById('stat-pnl');
      const pnlPctEl = document.getElementById('stat-pnl-pct');
      if (pnlEl) {
        pnlEl.textContent = totalCost > 0 ? fmt.currency(totalPnL) : '—';
        pnlEl.className = 'stat-value' + (totalCost > 0 ? (totalPnL >= 0 ? ' positive' : ' negative') : '');
      }
      if (pnlPctEl) {
        pnlPctEl.textContent = totalCost > 0 ? fmt.pct(totalPnLPct) : '—';
        pnlPctEl.className = 'stat-sub' + (totalCost > 0 ? (totalPnL >= 0 ? ' positive' : ' negative') : '');
      }
    },

    renderTable(stocks, getPriceData) {
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
        const p          = getPriceData(s.id);
        const price      = p ? p.price     : null;
        const change     = p ? p.change    : null;
        const changePct  = p ? p.changePct : null;
        // ★ Fix 1 result: name comes from API (correct) or localStorage (may have old wrong value)
        const name       = (p && p.name && p.name !== s.id) ? p.name : (s.name || s.id);

        const marketValue = price != null ? s.shares * price   : null;
        const totalCost   = s.shares * s.costPerShare;
        const pnl         = marketValue != null ? marketValue - totalCost : null;
        const pnlPct      = totalCost > 0 && pnl != null ? (pnl / totalCost) * 100 : null;

        const changeClass = change == null ? 'neutral' : change >= 0 ? 'positive' : 'negative';
        const pnlClass    = pnl    == null ? ''        : pnl    >= 0 ? 'positive' : 'negative';

        // ★ Fix 3: stop skeleton after fetch attempted
        const attempted   = FinMindAPI.hasAttempted(s.id);
        const priceCell   = price != null
          ? `<span class="price-cell">${fmt.price(price)}</span>`
          : attempted
            ? `<span style="color:var(--text-muted)">無資料</span>`
            : `<span class="skeleton" style="width:60px;height:16px;display:inline-block;border-radius:4px"></span>`;

        const changeCell = price != null
          ? `<span class="change-pill ${changeClass}">${change >= 0 ? '▲' : '▼'} ${fmt.change(Math.abs(change))} (${fmt.pct(changePct)})</span>`
          : attempted
            ? `<span class="change-pill neutral">—</span>`
            : `<span class="skeleton" style="width:90px;height:22px;display:inline-block;border-radius:999px"></span>`;

        return `
          <tr data-id="${escHtml(s.id)}">
            <td>
              <div class="stock-info">
                <span class="stock-name">${escHtml(name)}</span>
                <span class="stock-code">${escHtml(s.id)}</span>
              </div>
            </td>
            <td>${priceCell}</td>
            <td>${changeCell}</td>
            <td>${Number(s.shares).toLocaleString()}</td>
            <td style="font-family:'JetBrains Mono',monospace">${fmt.price(s.costPerShare)}</td>
            <td style="font-family:'JetBrains Mono',monospace">${fmt.currency(totalCost)}</td>
            <td style="font-family:'JetBrains Mono',monospace">${marketValue != null ? fmt.currency(marketValue) : (attempted ? '—' : '<span class="skeleton" style="width:70px;height:16px;display:inline-block;border-radius:4px"></span>')}</td>
            <td class="pnl-cell ${pnlClass}">${pnl != null ? fmt.currency(pnl) : (attempted ? '—' : '')}</td>
            <td class="pnl-cell ${pnlClass}">${pnlPct != null ? fmt.pct(pnlPct) : (attempted ? '—' : '')}</td>
            <td>
              <div class="actions-cell">
                <button class="action-btn edit"   data-action="edit"   data-id="${escHtml(s.id)}" title="編輯"   aria-label="編輯 ${escHtml(name)}"><i class="fas fa-pen-to-square"></i></button>
                <button class="action-btn delete" data-action="delete" data-id="${escHtml(s.id)}" title="刪除"   aria-label="刪除 ${escHtml(name)}"><i class="fas fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
      }).join('');
    },

    updateMarketStatus(isOpen) {
      const badge = document.getElementById('market-badge');
      const label = document.getElementById('market-label');
      if (!badge || !label) return;
      if (isOpen) {
        badge.className = 'market-badge open';
        label.textContent = '台股開市中';
      } else {
        badge.className = 'market-badge closed';
        const h = getTaipeiNow().getHours();
        if (!isWeekday())   label.textContent = '週末休市';
        else if (h < 9)     label.textContent = '盤前';
        else                label.textContent = '已收盤';
      }
    },

    updateLastUpdated() {
      const el = document.getElementById('last-updated');
      if (el) el.textContent = '更新：' + fmt.time();
    },

    flashValues() {
      document.querySelectorAll('.price-cell, .pnl-cell, .stat-value').forEach(el => {
        el.classList.remove('value-updating');
        void el.offsetWidth;
        el.classList.add('value-updating');
      });
    },

    showNotification(message, type = 'info') {
      const el = document.getElementById('notification');
      if (!el) return;
      const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
      el.className = type;
      el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
      el.classList.remove('hidden');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
    },
  };
})();

/* ============================================================
   MODAL
============================================================ */
const Modal = (() => {
  let lookupTimer = null;
  let editMode    = false;
  let editOrigId  = null;

  function open(mode = 'add', stock = null) {
    editMode   = mode === 'edit';
    editOrigId = editMode ? stock.id : null;

    document.getElementById('modal-title').textContent  = editMode ? '編輯持股' : '新增股票';
    document.getElementById('modal-submit').textContent = editMode ? '確認修改' : '確認新增';

    const idIn     = document.getElementById('input-stock-id');
    const sharesIn = document.getElementById('input-shares');
    const costIn   = document.getElementById('input-cost');
    const hint     = document.getElementById('stock-name-hint');

    if (editMode && stock) {
      idIn.value = stock.id; idIn.readOnly = true;
      sharesIn.value = stock.shares;
      costIn.value   = stock.costPerShare;
      const cached = FinMindAPI.getCached(stock.id);
      hint.textContent = cached?.name ? `✓ ${cached.name}` : stock.name || stock.id;
      hint.className = 'input-hint found';
    } else {
      idIn.value = ''; idIn.readOnly = false;
      sharesIn.value = ''; costIn.value = '';
      hint.textContent = '輸入代號後自動查詢公司名稱';
      hint.className = 'input-hint';
    }

    document.getElementById('stock-modal').classList.remove('hidden');
    setTimeout(() => (editMode ? sharesIn : idIn).focus(), 100);
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

    document.getElementById('input-stock-id').addEventListener('input', function () {
      const val  = this.value.trim().toUpperCase();
      const hint = document.getElementById('stock-name-hint');
      clearTimeout(lookupTimer);
      if (!val) { hint.textContent = '輸入代號後自動查詢公司名稱'; hint.className = 'input-hint'; return; }
      hint.textContent = '查詢中...'; hint.className = 'input-hint loading';
      lookupTimer = setTimeout(async () => {
        try {
          const name = await FinMindAPI.lookupName(val);
          if (name && name !== val) { hint.textContent = `✓ ${name}`; hint.className = 'input-hint found'; }
          else                       { hint.textContent = '⚠ 找不到此代號'; hint.className = 'input-hint error'; }
        } catch { hint.textContent = '⚠ 查詢失敗'; hint.className = 'input-hint error'; }
      }, 600);
    });

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
          UI.showNotification('請填寫所有欄位（數值需大於 0）', 'error'); return;
        }

        let name = stockId;
        UI.showNotification('正在取得股票資料...', 'info');
        const data = await FinMindAPI.fetchPrice(stockId);
        name = data.name || stockId;
        Portfolio.setPrices({ [stockId]: data });

        const entry = { id: stockId, name, shares, costPerShare: cost };
        if (editMode) { Portfolio.update(editOrigId, entry); UI.showNotification(`已更新 ${name}`, 'success'); }
        else          { Portfolio.add(entry);                UI.showNotification(`已新增 ${name}`, 'success'); }

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
    UI.updateMarketStatus(isTaiwanMarketOpen());
    if (ids.length === 0) { UI.updateLastUpdated(); return; }

    const btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('spinning');

    try {
      const prices = await FinMindAPI.refreshAll(ids);
      Portfolio.setPrices(prices);

      // ★ Fix: update correct names in localStorage
      Object.entries(prices).forEach(([id, data]) => {
        if (data?.name) Portfolio.updateName(id, data.name);
      });

      const stats  = Portfolio.getStats();
      const stocks = Portfolio.getAll();

      UI.renderStatCards(stats);
      UI.renderTable(stocks, id => Portfolio.getPriceData(id));
      Charts.updatePie(stocks, id => Portfolio.getPriceData(id));

      if (stats.totalValue > 0) {
        Charts.updateLine(Storage.appendHistory(stats.totalValue));
      }

      if (showFlash) UI.flashValues();
      UI.updateLastUpdated();
    } catch (err) {
      console.error('[Refresher]', err);
      UI.showNotification('更新失敗：' + err.message, 'error');
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  }

  function start() {
    stop();
    intervalId = setInterval(() => {
      UI.updateMarketStatus(isTaiwanMarketOpen());
      if (isTaiwanMarketOpen()) {
        const m = getTaipeiNow().getMinutes();
        if (m === 0 || m === 30) refresh(true);
      }
    }, 60_000);
  }

  function stop() { if (intervalId) { clearInterval(intervalId); intervalId = null; } }

  return { refresh, start, stop };
})();

/* ============================================================
   EVENT BINDINGS
============================================================ */
function bindEvents() {
  document.getElementById('refresh-btn').addEventListener('click', () => Refresher.refresh(true));
  document.getElementById('add-stock-btn').addEventListener('click', () => Modal.open('add'));

  document.getElementById('portfolio-tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { id, action } = btn.dataset;
    if (action === 'delete') {
      const stock = Portfolio.getAll().find(s => s.id === id);
      if (confirm(`確定要刪除 ${stock?.name || id}（${id}）嗎？`)) {
        Portfolio.remove(id);
        UI.showNotification(`已刪除 ${stock?.name || id}`, 'success');
        renderAll();
      }
    } else if (action === 'edit') {
      const stock = Portfolio.getAll().find(s => s.id === id);
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
  UI.renderStatCards(Portfolio.getStats());
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

  if (Portfolio.getStockIds().length > 0) {
    UI.showNotification('正在取得最新股價...', 'info');
    await Refresher.refresh(false);
  }

  Refresher.start();
  UI.updateLastUpdated();
}

document.addEventListener('DOMContentLoaded', init);
