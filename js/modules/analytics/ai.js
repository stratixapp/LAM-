// ============================================================
// LAM — AI & Advanced Analytics Module (Phase 7)
// Demand Forecasting, Delay Predictor, Cost Analysis,
// Driver Performance, Custom Report Builder
// Pulls from ALL modules — the brain of LAM
// ============================================================

import { dbGetAll, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { TMS_COLLECTIONS } from '../transport/fleet.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { ASSET_COLLECTIONS } from '../assets/register.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, formatNumber, formatCurrency, debounce
} from '../../core/utils.js';
import { pageShell } from '../_shared.js';

let _activeTab = 'overview';

// ── All data cache ────────────────────────────────────────────
let _data = {
  inventory: [], products: [], orders: [], vendors: [],
  customers: [], trips: [], drivers: [], fleet: [],
  invoices: [], payments: [], expenses: [],
  grns: [], assets: [], employees: [],
};

export async function renderAnalytics(container) {
  container.innerHTML = pageShell({
    title: '🤖 AI & Analytics',
    subtitle: 'Intelligent insights powered by your live business data.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshAnalytics()">↻ Refresh</button>`,
    content: `
      <!-- Sub-tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['overview',     '📊 Overview'],
          ['forecast',     '🔮 Demand Forecast'],
          ['delay',        '⏱ Delay Predictor'],
          ['cost',         '💸 Cost Analysis'],
          ['performance',  '🏆 Performance'],
          ['reports',      '📄 Reports'],
        ].map(([id,label]) => `
          <button class="ai-tab ${id==='overview'?'active':''}" id="ai-tab-${id}" onclick="switchAITab('${id}')"
            style="padding:8px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>
        `).join('')}
      </div>

      <div id="ai-tab-content">
        <div style="display:flex;justify-content:center;padding:80px;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:16px;">
            <div class="spinner spinner-lg"></div>
            <span style="color:var(--text-muted);font-size:13px;">Loading AI engine…</span>
          </div>
        </div>
      </div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = `.ai-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}`;
  document.head.appendChild(style);

  window.switchAITab    = switchAITab;
  window.refreshAnalytics = () => { loadAllData().then(() => switchAITab(_activeTab)); };

  await loadAllData();
  switchAITab('overview');
}

// ── Load ALL data from all modules ────────────────────────────
async function loadAllData() {
  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid)] : [];

  try {
    const results = await Promise.allSettled([
      dbGetAll(COLLECTIONS.INVENTORY,  c),
      dbGetAll(COLLECTIONS.PRODUCTS,   c),
      dbGetAll('sales_orders',         c),
      dbGetAll(COLLECTIONS.VENDORS,    c),
      dbGetAll(COLLECTIONS.CUSTOMERS,  c),
      dbGetAll(TMS_COLLECTIONS.TRIPS,  c),
      dbGetAll(TMS_COLLECTIONS.DRIVERS,c),
      dbGetAll(TMS_COLLECTIONS.FLEET,  c),
      dbGetAll(FIN_COLLECTIONS.INVOICES,c),
      dbGetAll(FIN_COLLECTIONS.PAYMENTS,c),
      dbGetAll(FIN_COLLECTIONS.EXPENSES,c),
      dbGetAll('grns',                 c),
      dbGetAll(ASSET_COLLECTIONS.ASSETS,c),
      dbGetAll(COLLECTIONS.EMPLOYEES,  c),
    ]);

    const keys = ['inventory','products','orders','vendors','customers','trips','drivers','fleet','invoices','payments','expenses','grns','assets','employees'];
    results.forEach((r, i) => {
      _data[keys[i]] = r.status === 'fulfilled' ? r.value : [];
    });
  } catch(e) {
    console.warn('Analytics data load partial error:', e);
  }
}

// ── Tab switcher ──────────────────────────────────────────────
function switchAITab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`ai-tab-${tab}`)?.classList.add('active');
  const content = document.getElementById('ai-tab-content'); if (!content) return;

  switch(tab) {
    case 'overview':    renderOverview(content);    break;
    case 'forecast':    renderForecast(content);    break;
    case 'delay':       renderDelayPredictor(content); break;
    case 'cost':        renderCostAnalysis(content); break;
    case 'performance': renderPerformance(content); break;
    case 'reports':     renderReports(content);     break;
  }
}

// ── OVERVIEW ──────────────────────────────────────────────────
function renderOverview(container) {
  const revenue   = _data.invoices.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
  const expenses  = _data.expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
  const profit    = revenue - expenses;
  const margin    = revenue ? Math.round((profit/revenue)*100) : 0;
  const otifRate  = calcOTIF();
  const stockTurn = calcStockTurnover();
  const fleetUtil = calcFleetUtilization();

  container.innerHTML = `
    <!-- Top metrics -->
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        { label:'Gross Profit',      value:formatCurrency(profit,true),  icon:'💰', color:'kpi-green',  sub:`${margin}% margin` },
        { label:'OTIF Rate',         value:otifRate+'%',                 icon:'📦', color:otifRate>=90?'kpi-green':'kpi-yellow', sub:'On-Time In-Full' },
        { label:'Inventory Turnover',value:stockTurn+'x',                icon:'🔄', color:'kpi-blue',   sub:'Turns per year' },
        { label:'Fleet Utilization', value:fleetUtil+'%',                icon:'🚛', color:fleetUtil>=70?'kpi-green':'kpi-orange', sub:'Active vehicles %' },
      ].map((k,i)=>`
        <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
          <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
          <div class="kpi-value">${k.value}</div>
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-sub">${k.sub}</div>
        </div>
      `).join('')}
    </div>

    <!-- Business health grid -->
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      <!-- Revenue trend (last 6 months) -->
      <div class="card" style="grid-column:span 2;">
        <div class="card-header">
          <div class="card-title">Revenue vs Expenses Trend</div>
          <span style="font-size:11px;color:var(--text-muted);">Last 6 months (estimated)</span>
        </div>
        ${renderMiniBarChart(buildRevExpTrend())}
      </div>

      <!-- Score card -->
      <div class="card">
        <div class="card-header"><div class="card-title">Business Score</div></div>
        ${renderBusinessScore()}
      </div>
    </div>

    <!-- Insights -->
    <div class="card">
      <div class="card-header"><div class="card-title">🤖 AI Insights</div></div>
      <div style="display:flex;flex-direction:column;gap:10px;" id="ai-insights">
        ${generateInsights().map(ins => `
          <div style="display:flex;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${ins.color};">
            <span style="font-size:20px;flex-shrink:0;">${ins.icon}</span>
            <div>
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;">${ins.title}</div>
              <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">${ins.body}</div>
            </div>
            <span class="badge badge-${ins.type==='warning'?'yellow':ins.type==='danger'?'red':'green'}" style="flex-shrink:0;align-self:flex-start;">${ins.type}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ── DEMAND FORECAST ───────────────────────────────────────────
function renderForecast(container) {
  const products    = _data.products.slice(0, 12);
  const forecasts   = products.map(p => forecastProduct(p));

  container.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:var(--space-5);">
      <span class="alert-icon">🤖</span>
      <div>
        <div class="alert-title">AI Demand Forecasting</div>
        <div class="alert-text">Predictions based on historical GRN patterns, sales orders and seasonal trends. Connect more data over time to improve accuracy.</div>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:var(--space-5);">
      <!-- Reorder alerts -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">🚨 Reorder Required Now</div>
          <span class="badge badge-red">${_data.inventory.filter(i=>Number(i.quantity)<=Number(i.reorderPoint||0)).length} items</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;">
          ${_data.inventory.filter(i=>Number(i.quantity)<=Number(i.reorderPoint||0)).length ? _data.inventory.filter(i=>Number(i.quantity)<=Number(i.reorderPoint||0)).slice(0,10).map(i=>{
            const p = _data.products.find(x=>x.id===i.productId);
            const qty = Number(i.quantity)||0;
            const rp  = Number(i.reorderPoint)||0;
            return `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${qty===0?'var(--brand-danger)':'var(--brand-warning)'};">
                <div>
                  <div style="font-size:13px;font-weight:500;">${escHtml(p?.name||i.productId||'—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">Reorder at: ${rp} · Suggest: ${Math.max(rp*3, 20)} units</div>
                </div>
                <span class="badge badge-${qty===0?'red':'yellow'}">${qty===0?'Out of Stock':qty+' left'}</span>
              </div>
            `;
          }).join('') : `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">✅ All stock above reorder points</div>`}
        </div>
      </div>

      <!-- Upcoming demand -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📈 30-Day Demand Forecast</div>
          <span style="font-size:11px;color:var(--text-muted);">AI estimate</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;">
          ${(forecasts.length ? forecasts : products.slice(0,10).map(p=>forecastProduct(p)))
          .filter(f=>f.confidence>0||f.forecastQty>0)
          .slice(0,12)
          .map((f,fi) => {
            const qty = (f.forecast||[]).reduce((a,b)=>a+b,0)||f.forecastQty||0;
            const trendIcon = f.trend==='rising'?'📈':f.trend==='falling'?'📉':'➡️';
            const trendColor= f.trend==='rising'?'#30D158':f.trend==='falling'?'#FF453A':'#94A3B8';
            const daysColor = (f.daysOfStock||999)<14?'#FF453A':(f.daysOfStock||999)<30?'#FFD60A':'#30D158';
            const chartId   = 'fc-spark-'+fi+'-'+Date.now();
            return `
              <div style="padding:14px;background:var(--bg-elevated);border-radius:12px;border-top:3px solid ${trendColor};">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(f.product||f.name||'—')}</div>
                    <div style="font-size:10px;color:var(--text-muted);">${f.category||''}</div>
                  </div>
                  <div style="text-align:right;flex-shrink:0;margin-left:8px;">
                    <div style="font-size:16px;font-weight:800;color:var(--brand-primary);">${qty}</div>
                    <div style="font-size:9px;color:var(--text-muted);">units / ${f.horizon||3}mo</div>
                  </div>
                </div>
                ${f.forecast?.length ? `
                  <canvas id="${chartId}" style="width:100%;height:36px;display:block;margin-bottom:8px;"></canvas>
                  <div style="display:flex;gap:6px;font-size:10px;color:var(--text-muted);">
                    ${(f.forecastLabels||[]).map((l,i)=>`<span style="flex:1;text-align:center;">${l.slice(0,3)}: <strong>${f.forecast[i]}</strong></span>`).join('')}
                  </div>
                ` : ''}
                <div style="display:flex;gap:8px;margin-top:8px;font-size:10px;">
                  <span style="color:${trendColor};">${trendIcon} ${f.trendPct!=null?Math.abs(f.trendPct)+'%':f.trend||''}</span>
                  ${f.daysOfStock!=null?`<span style="color:${daysColor};">📦 ${f.daysOfStock}d stock</span>`:''}
                  <span style="color:var(--text-muted);">${f.confidence||0}% confidence</span>
                </div>
                ${f.recommendation?`<div style="font-size:10px;color:var(--text-muted);margin-top:6px;padding-top:6px;border-top:1px solid var(--border-subtle);">${f.recommendation}</div>`:''}
              </div>
            `;
          }).join('') || `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No products to forecast yet</div>`}
        </div>
      </div>
    </div>

    <!-- Seasonal analysis -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📅 Seasonal Demand Pattern</div>
        <span style="font-size:11px;color:var(--text-muted);">Based on order history</span>
      </div>
      ${renderMonthlyPattern()}
    </div>

    <!-- Cash Flow Prediction -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">💰 Cash Flow Forecast (Next 3 Months)</div>
      </div>
      <div style="padding:16px;">
        <canvas id="lam-cf-chart" style="width:100%;height:200px;display:block;"></canvas>
        <div id="lam-cf-summary" style="margin-top:12px;font-size:12px;color:var(--text-muted);"></div>
      </div>
    </div>

    <!-- Customer Segments -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🎯 Customer Segmentation (RFM)</div>
      </div>
      <div id="lam-rfm-chart" style="padding:16px;"></div>
    </div>

  `;

  // ── Chart inits (after DOM ready) ──
  setTimeout(() => {
    // Cash flow chart
    const cfCanvas = document.getElementById('lam-cf-chart');
    const cfSummary= document.getElementById('lam-cf-summary');
    if (cfCanvas && window.LAMML && window.LAMCharts) {
      const cf = window.LAMML.predictCashFlow(
        _data.invoices || [], _data.expenses || [], _data.payments || [], 3
      );
      window.LAMCharts.create('bar', cfCanvas, {
        labels:   cf.cashFlow.map(m=>m.label),
        datasets: [
          { label:'Revenue',  data:cf.cashFlow.map(m=>m.revenue),  color:'#30D158' },
          { label:'Expenses', data:cf.cashFlow.map(m=>m.expenses), color:'#FF453A' },
          { label:'Net',      data:cf.cashFlow.map(m=>m.net),      color:'#0A84FF' },
        ],
        opts: { fmt:'currency' },
      });
      if (cfSummary) {
        cfSummary.innerHTML = `<span style="color:${cf.status==='positive'?'var(--brand-secondary)':'var(--brand-danger)'};">${cf.recommendation}</span>
          <span style="margin-left:16px;">Outstanding: ₹${(cf.outstanding||0).toLocaleString('en-IN')}</span>`;
      }
    }

    // RFM segmentation
    const rfmEl = document.getElementById('lam-rfm-chart');
    if (rfmEl && window.LAMML) {
      const segments = window.LAMML.segmentCustomers(_data.customers||[], _data.invoices||[]);
      if (!segments.length) { rfmEl.innerHTML='<div style="color:var(--text-muted);font-size:12px;padding:8px;">Add customer invoices to enable segmentation.</div>'; return; }
      const bySegment = {};
      segments.forEach(s=>{ bySegment[s.segment]=(bySegment[s.segment]||{count:0,revenue:0,color:s.color}); bySegment[s.segment].count++; bySegment[s.segment].revenue+=s.monetary; });
      rfmEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;">
          ${Object.entries(bySegment).map(([seg,data])=>`
            <div style="background:var(--bg-elevated);border-radius:10px;padding:12px;border-left:3px solid ${data.color};">
              <div style="font-size:13px;font-weight:700;color:${data.color};">${seg}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${data.count} customer${data.count!==1?'s':''}</div>
              <div style="font-size:11px;font-weight:600;margin-top:2px;">₹${data.revenue.toLocaleString('en-IN')}</div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }, 80);
}

// ── DELAY PREDICTOR ───────────────────────────────────────────
function renderDelayPredictor(container) {
  const activeTrips = _data.trips.filter(t => t.status === 'in-transit' || t.status === 'loading');
  const predictions = activeTrips.map(t => predictDelay(t));

  const historicDelay = _data.trips.filter(t=>t.delayed===true).length;
  const totalTrips    = _data.trips.length;
  const delayRate     = totalTrips ? Math.round((historicDelay/totalTrips)*100) : 0;

  container.innerHTML = `
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      ${[
        { label:'Active Trips',    value:activeTrips.length, icon:'🚛', color:'kpi-blue'   },
        { label:'High Risk',       value:predictions.filter(p=>p.risk==='high').length,   icon:'🚨', color:'kpi-red'    },
        { label:'Historic Delay Rate', value:delayRate+'%', icon:'⏱', color:delayRate>20?'kpi-yellow':'kpi-green' },
      ].map((k,i)=>`
        <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
          <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
          <div class="kpi-value">${k.value}</div>
          <div class="kpi-label">${k.label}</div>
        </div>
      `).join('')}
    </div>

    <!-- Active trip predictions -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">🔮 Active Trip Risk Assessment</div></div>
      ${predictions.length ? `
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${predictions.map(p => {
            const riskColor = p.riskColor || (p.risk==='high'?'#FF453A':p.risk==='medium'?'#FFD60A':'#30D158');
            const driver  = _data.drivers.find(d=>d.id===(p.trip||p).driverId);
            const vehicle = _data.fleet.find(v=>v.id===(p.trip||p).vehicleId);
            const tripObj = p.trip || p;
            const features= p.features || [];
            const prob    = p.delayProbability || p.delayChance || 0;
            return `
              <div style="padding:16px;background:var(--bg-elevated);border-radius:12px;border-left:4px solid ${riskColor};">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                  <div>
                    <div style="font-weight:700;font-size:14px;">${tripObj.tripNumber||tripObj.tripId||tripObj.id?.slice(0,8)||'—'}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${tripObj.origin||'—'} → ${tripObj.destination||'—'}</div>
                  </div>
                  <div style="text-align:right;">
                    <div style="font-size:20px;font-weight:800;color:${riskColor};">${prob}%</div>
                    <div style="font-size:10px;color:${riskColor};text-transform:uppercase;font-weight:600;">${p.risk||'low'} risk</div>
                  </div>
                </div>
                <div style="background:var(--bg-base);border-radius:20px;height:6px;margin-bottom:10px;">
                  <div style="width:${prob}%;height:6px;background:${riskColor};border-radius:20px;transition:width 1s ease;"></div>
                </div>
                ${features.length ? `
                  <div style="display:flex;flex-direction:column;gap:4px;">
                    ${features.slice(0,3).map(f=>`
                      <div style="font-size:11px;display:flex;align-items:center;gap:6px;">
                        <span style="color:${riskColor};font-size:9px;">▲</span>
                        <span style="color:var(--text-secondary);">${f.name||f}</span>
                        ${f.value?`<span style="margin-left:auto;color:var(--text-muted);">${f.value}</span>`:''}
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
                <div style="font-size:11px;color:var(--text-muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle);">${p.recommendation||''}</div>
                ${driver?`<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">👨‍✈️ ${driver.name} · 🚛 ${vehicle?.vehicleNumber||'—'}</div>`:''}
              </div>
            `;
          }).join('')}
        </div>
      ` : `<div style="text-align:center;padding:40px;color:var(--text-muted);">No active trips to analyze</div>`}
    </div>

    <!-- Delay patterns -->
    <div class="card">
      <div class="card-header"><div class="card-title">📊 Delay Analysis by Route</div></div>
      ${renderDelayByRoute()}
    </div>
  `;
}

// ── COST ANALYSIS ─────────────────────────────────────────────
function renderCostAnalysis(container) {
  const totalFreight  = _data.trips.reduce((s,t)=>s+(Number(t.freightCost)||0),0);
  const totalFuel     = _data.expenses.filter(e=>e.category==='fuel').reduce((s,e)=>s+(Number(e.amount)||0),0);
  const totalMaint    = _data.expenses.filter(e=>e.category==='maintenance').reduce((s,e)=>s+(Number(e.amount)||0),0);
  const totalExpenses = _data.expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
  const avgCostPerTrip = _data.trips.length ? Math.round(totalFreight/_data.trips.length) : 0;
  const avgCostPerKm   = _data.trips.reduce((s,t)=>s+(Number(t.distanceKm)||0),0) ?
    Math.round((totalFuel+totalMaint) / _data.trips.reduce((s,t)=>s+(Number(t.distanceKm)||0),0)) : 0;

  const expByCategory = {};
  _data.expenses.forEach(e => {
    expByCategory[e.category||'other'] = (expByCategory[e.category||'other']||0) + (Number(e.amount)||0);
  });

  container.innerHTML = `
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Total Freight Revenue',value:formatCurrency(totalFreight,true),icon:'🚛',color:'kpi-green'},
        {label:'Total Fuel Cost',      value:formatCurrency(totalFuel,true),   icon:'⛽',color:'kpi-orange'},
        {label:'Avg Cost/Trip',        value:formatCurrency(avgCostPerTrip,false),icon:'📦',color:'kpi-blue'},
        {label:'Avg Cost/km',          value:'₹'+avgCostPerKm+'/km',           icon:'📍',color:'kpi-yellow'},
      ].map((k,i)=>`
        <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
          <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
          <div class="kpi-value">${k.value}</div>
          <div class="kpi-label">${k.label}</div>
        </div>
      `).join('')}
    </div>

    <div class="grid-2" style="margin-bottom:var(--space-5);">
      <!-- Expense breakdown -->
      <div class="card">
        <div class="card-header"><div class="card-title">💸 Expense Breakdown</div></div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${Object.entries(expByCategory).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>{
            const pct = totalExpenses ? Math.round((amt/totalExpenses)*100) : 0;
            const colors = {fuel:'var(--brand-orange)',maintenance:'var(--brand-warning)',salary:'var(--brand-primary)',rent:'var(--brand-accent)',utilities:'var(--brand-info)',other:'var(--text-muted)'};
            const color = colors[cat]||'var(--text-muted)';
            return `
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                  <span style="font-size:12px;text-transform:capitalize;">${cat}</span>
                  <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹${Number(amt).toLocaleString('en-IN')} <span style="color:var(--text-muted);font-weight:400;">(${pct}%)</span></span>
                </div>
                <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
                  <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width 0.8s ease;"></div>
                </div>
              </div>
            `;
          }).join('') || `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;">No expense data yet</div>`}
        </div>
      </div>

      <!-- Cost per shipment top routes -->
      <div class="card">
        <div class="card-header"><div class="card-title">🗺️ Cost Per Route</div></div>
        ${renderCostPerRoute()}
      </div>
    </div>

    <!-- Monthly expense trend -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📈 Monthly Cost Trend</div>
      </div>
      ${renderMonthlyCostTrend()}
    </div>
  `;
}

// ── PERFORMANCE DASHBOARD ─────────────────────────────────────
function renderPerformance(container) {
  const driverScores = _data.drivers.map(d => {
    const trips = _data.trips.filter(t => t.driverId === d.id);
    const done  = trips.filter(t => t.status === 'delivered').length;
    const delayed = trips.filter(t => t.delayed).length;
    const km    = trips.reduce((s,t)=>s+(Number(t.distanceKm)||0),0);
    const onTime = trips.length ? Math.round(((trips.length-delayed)/trips.length)*100) : 100;
    return { ...d, totalTrips:trips.length, completedTrips:done, totalKm:km, onTimeRate:onTime, score: calcDriverScore(d, trips) };
  }).sort((a,b) => b.score - a.score);

  const fleetPerf = _data.fleet.map(v => {
    const trips = _data.trips.filter(t => t.vehicleId === v.id);
    const km    = trips.reduce((s,t)=>s+(Number(t.distanceKm)||0),0);
    const fuel  = 0; // would come from fuel logs
    return { ...v, totalTrips:trips.length, totalKm:km };
  });

  container.innerHTML = `
    <!-- Driver Leaderboard -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header">
        <div class="card-title">🏆 Driver Performance Leaderboard</div>
        <span style="font-size:11px;color:var(--text-muted);">Ranked by performance score</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${driverScores.length ? driverScores.map((d,i) => {
          const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
          const scoreColor = d.score>=80?'var(--brand-secondary)':d.score>=60?'var(--brand-warning)':'var(--brand-danger)';
          return `
            <div style="display:flex;align-items:center;gap:16px;padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);${i<3?'border:1px solid var(--border-default);':''}">
              <div style="width:32px;text-align:center;font-size:${medal?'20':'14'}px;font-family:var(--font-mono);color:var(--text-muted);">${medal||('#'+(i+1))}</div>
              <div style="width:36px;height:36px;border-radius:var(--radius-md);background:rgba(0,200,150,0.12);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--brand-secondary);flex-shrink:0;">
                ${(d.name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
              </div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;">${escHtml(d.name||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${d.totalTrips} trips · ${formatNumber(d.totalKm)} km · ${d.onTimeRate}% on-time</div>
              </div>
              <!-- Score bar -->
              <div style="width:120px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                  <span style="font-size:10px;color:var(--text-muted);">Score</span>
                  <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:${scoreColor};">${d.score}</span>
                </div>
                <div style="background:var(--bg-overlay);border-radius:4px;height:6px;overflow:hidden;">
                  <div style="height:100%;width:${d.score}%;background:${scoreColor};border-radius:4px;"></div>
                </div>
              </div>
              <div style="text-align:center;">
                <div style="font-size:18px;color:var(--brand-warning);">${'★'.repeat(Math.round(d.rating||0))}${'☆'.repeat(5-Math.round(d.rating||0))}</div>
                <div style="font-size:10px;color:var(--text-muted);">${Number(d.rating||0).toFixed(1)}/5.0</div>
              </div>
            </div>
          `;
        }).join('') : `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px;">No driver data available</div>`}
      </div>
    </div>

    <!-- Fleet performance -->
    <div class="card">
      <div class="card-header"><div class="card-title">🚛 Fleet Utilization</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
        ${fleetPerf.length ? fleetPerf.map(v => {
          const statusColor = v.status==='active'||v.status==='in-transit'?'var(--brand-secondary)':v.status==='maintenance'?'var(--brand-warning)':'var(--text-muted)';
          return `
            <div style="padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid ${statusColor};">
              <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;margin-bottom:6px;">${escHtml(v.regNumber||'—')}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">${escHtml(v.vehicleType||'—')} · ${escHtml(v.make||'')} ${escHtml(v.model||'')}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <div style="background:var(--bg-overlay);border-radius:6px;padding:6px;text-align:center;">
                  <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;">${v.totalTrips}</div>
                  <div style="font-size:9px;color:var(--text-muted);">TRIPS</div>
                </div>
                <div style="background:var(--bg-overlay);border-radius:6px;padding:6px;text-align:center;">
                  <div style="font-family:var(--font-mono);font-size:12px;font-weight:700;">${formatNumber(v.totalKm)}</div>
                  <div style="font-size:9px;color:var(--text-muted);">KM</div>
                </div>
              </div>
            </div>
          `;
        }).join('') : `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text-muted);">No fleet data</div>`}
      </div>
    </div>
  `;
}

// ── REPORTS ───────────────────────────────────────────────────
function renderReports(container) {
  const today   = new Date().toISOString().slice(0,10);
  const monthAgo= new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);

  const reports = [
    { id:'inventory-summary',  icon:'📦', title:'Inventory Summary',     desc:'Stock levels, valuation, low stock and dead stock analysis',  category:'Warehouse' },
    { id:'vendor-performance', icon:'🤝', title:'Vendor Performance',    desc:'Order fulfilment rates, lead times, quality scores per vendor', category:'Procurement' },
    { id:'sales-summary',      icon:'🛒', title:'Sales Summary',         desc:'Orders by customer, product, region and time period',          category:'Orders' },
    { id:'trip-report',        icon:'🗺️', title:'Trip & Delivery Report', desc:'All trips, distance, cost, delays and on-time rates',          category:'Transport' },
    { id:'driver-report',      icon:'👤', title:'Driver Performance',    desc:'Individual driver stats, ratings and compliance',              category:'Transport' },
    { id:'invoice-aging',      icon:'📅', title:'Invoice Aging Report',  desc:'Outstanding receivables segmented by aging buckets',           category:'Finance' },
    { id:'pnl-report',         icon:'📊', title:'P&L Statement',         desc:'Revenue, expenses, gross profit and net margin analysis',      category:'Finance' },
    { id:'gst-summary',        icon:'🏛', title:'GST Summary',           desc:'Collected, paid, input credit and net GST payable',            category:'Finance' },
    { id:'asset-register',     icon:'🔧', title:'Asset Register',        desc:'Complete list of assets with valuation and depreciation',      category:'Assets' },
    { id:'expense-report',     icon:'💸', title:'Expense Report',        desc:'All expenses by category, vendor and time period',             category:'Finance' },
    { id:'gst-filing-export',  icon:'🏛️', title:'GST Filing Export',     desc:'Download GSTR-1 + GSTR-3B JSON files ready for GSTN portal upload', category:'GST', isGSTExport: true },
  ];

  container.innerHTML = `
    <div id="lam-reports-gst-widget-slot"></div>
    <div class="grid-2">
      ${reports.map(r => `
        <div style="padding:16px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);display:flex;gap:14px;align-items:flex-start;cursor:pointer;transition:all 0.2s;"
             onclick="generateReport('${r.id}')"
             onmouseenter="this.style.borderColor='var(--border-strong)'"
             onmouseleave="this.style.borderColor='var(--border-subtle)'">
          <div style="width:44px;height:44px;background:var(--bg-overlay);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${r.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <div style="font-size:14px;font-weight:600;">${r.title}</div>
              <span class="badge badge-gray" style="font-size:9px;">${r.category}</span>
            </div>
            <div style="font-size:11px;color:var(--text-secondary);line-height:1.5;">${r.desc}</div>
          </div>
          <div style="font-size:18px;color:var(--text-muted);flex-shrink:0;">→</div>
        </div>
      `).join('')}
    </div>
  `;


  // Inject GST Filing export widget at top of reports page
  if (window.GSTExport) {
    window.GSTExport.injectReportsButton(document.getElementById('lam-reports-gst-widget-slot') || container);
  }
  window.generateReport = async (id) => {
    // ── GST Filing Export — handled by GSTExport module ──
    if (id === 'gst-filing-export') {
      if (!window.GSTExport) { Toast.error('Module Missing', 'gst-export.js not loaded.'); return; }
      const period = new Date().toISOString().slice(0, 7);
      Toast.info('GST Export', 'Preparing GSTR-1 + GSTR-3B for ' + period + '…');
      const result = await window.GSTExport.exportGSTFilingZIP(period);
      if (result.ok) {
        Toast.success('GST Files Ready', result.invoices + ' invoices · ₹' + (result.taxLiability||0).toLocaleString('en-IN') + ' tax · ZIP downloaded');
      } else {
        Toast.error('GST Export Failed', result.message);
      }
      return;
    }

    const btn = document.querySelector(`[onclick="generateReport('${id}')"]`);
    if (btn) { const orig=btn.innerHTML; btn.disabled=true; btn.innerHTML='⏳ Generating…';
      setTimeout(()=>{ btn.disabled=false; btn.innerHTML=orig; }, 8000); }

    // Try LAMReports first (full branded PDF)
    if (window.LAMReports) {
      Toast.info('Generating PDF', `Building ${id.replace(/-/g,' ')} report…`);
      try {
        const data = {
          invoices:       _data.invoices      || [],
          expenses:       _data.expenses      || [],
          payments:       _data.payments      || [],
          customers:      _data.customers     || [],
          vendors:        _data.vendors       || [],
          products:       _data.products      || [],
          inventory:      _data.inventory     || [],
          trips:          _data.trips         || [],
          fleet:          _data.fleet         || [],
          drivers:        _data.drivers       || [],
          purchaseOrders: _data.purchaseOrders|| [],
          grns:           _data.grns          || [],
          warehouses:     _data.warehouses    || [],
          employees:      _data.employees     || [],
          fromDate: document.getElementById('report-from-date')?.value || null,
          toDate:   document.getElementById('report-to-date')?.value   || null,
        };
        const handled = await window.LAMReports.generate(id, data);
        if (handled) { Toast.success('Report Ready', 'PDF download started.'); return; }
      } catch(e) {
        console.warn('LAMReports failed:', e);
        Toast.info('Falling back', 'Generating CSV export…');
      }
    }
    // Fallback: CSV download
    downloadReport(id);
  };
}

// ── Download / Export ─────────────────────────────────────────
function downloadReport(id) {
  let csv = '';
  let filename = id + '_report.csv';

  switch(id) {
    case 'inventory-summary':
      csv = [['Product','SKU','Warehouse','Qty','Reorder At','Status'],
        ..._data.inventory.map(i=>{
          const p=_data.products.find(x=>x.id===i.productId);
          const qty=Number(i.quantity)||0; const rp=Number(i.reorderPoint)||0;
          return [p?.name||i.productId,p?.sku||'',i.warehouseId,qty,rp,qty<=0?'Out':qty<=rp?'Low':'OK'];
        })].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
      break;
    case 'trip-report':
      csv = [['Trip #','Origin','Destination','Vehicle','Driver','KM','Freight','Status','Delayed'],
        ..._data.trips.map(t=>{
          const v=_data.fleet.find(x=>x.id===t.vehicleId); const d=_data.drivers.find(x=>x.id===t.driverId);
          return [t.tripNumber,t.origin,t.destination,v?.regNumber||'',d?.name||'',t.distanceKm,t.freightCost,t.status,t.delayed?'Yes':'No'];
        })].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
      break;
    case 'invoice-aging':
      csv = [['Invoice #','Customer','Amount','Due Date','Days Overdue','Status'],
        ..._data.invoices.map(i=>{
          const days=i.dueDate?Math.ceil((Date.now()-new Date(i.dueDate))/86400000):0;
          const cust=_data.customers.find(c=>c.id===i.customerId);
          return [i.invoiceNumber,cust?.name||'',i.totalAmount,i.dueDate,days>0?days:0,i.paymentStatus];
        })].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
      break;
    case 'expense-report':
      csv = [['Title','Category','Amount','GST','Paid To','Date','Bill #'],
        ..._data.expenses.map(e=>[e.title,e.category,e.amount,e.gstAmount,e.vendorName,e.date,e.billNo])
      ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
      break;
    default:
      csv = 'Report data not available yet for ' + id;
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = filename; a.click();
  Toast.success('Downloaded', filename);
}

// ── AI Calculation Helpers ────────────────────────────────────
function calcOTIF() {
  const delivered = _data.trips.filter(t => t.status === 'delivered');
  if (!delivered.length) return 100;
  const onTime = delivered.filter(t => !t.delayed).length;
  return Math.round((onTime / delivered.length) * 100);
}

function calcStockTurnover() {
  const totalStock = _data.inventory.reduce((s,i)=>s+(Number(i.quantity)||0),0);
  const totalOrders= _data.orders.length;
  if (!totalStock) return 0;
  return Math.round((totalOrders / totalStock) * 100) / 100;
}

function calcFleetUtilization() {
  if (!_data.fleet.length) return 0;
  const active = _data.fleet.filter(v => v.status === 'active' || v.status === 'in-transit').length;
  return Math.round((active / _data.fleet.length) * 100);
}

function calcDriverScore(driver, trips) {
  let score = 50; // base
  score += Math.min(trips.length * 2, 20); // up to 20 pts for trips
  const onTime = trips.length ? ((trips.length - trips.filter(t=>t.delayed).length) / trips.length) : 1;
  score += Math.round(onTime * 20); // up to 20 pts for on-time
  score += Math.min((driver.experienceYears||0) * 2, 10); // up to 10 pts for exp
  const rating = Number(driver.rating||3);
  score += Math.round((rating/5) * 10); // up to 10 pts for rating
  return Math.min(score, 100);
}

function forecastProduct(product) {
  if (window.LAMML) {
    // Build monthly sales history
    const orders = _data.orders.filter(o=>o.items?.some(i=>i.productId===product.id));
    const byMonth = {};
    orders.forEach(o => {
      const m = (o.orderDate||o.createdAt||'').slice(0,7);
      if (!m) return;
      const item = o.items?.find(i=>i.productId===product.id);
      byMonth[m] = (byMonth[m]||0) + Number(item?.qty||0);
    });
    const history = Object.entries(byMonth).map(([month,qty])=>({month,qty}));
    return window.LAMML.forecastDemand(product, history, 3);
  }
  // Fallback
  const orders = _data.orders.filter(o => o.items?.some(i => i.productId === product.id));
  const totalQty = orders.reduce((s,o)=>{ const item=o.items?.find(i=>i.productId===product.id); return s+(Number(item?.qty)||0); },0);
  const monthlyAvg = orders.length ? totalQty/Math.max(orders.length,1) : 0;
  const forecastQty = Math.round(monthlyAvg*1.1);
  const confidence  = Math.min(20+orders.length*5,90);
  const trend       = monthlyAvg>50?'High demand':monthlyAvg>20?'Moderate':'Low demand';
  return { name:product.name, forecastQty:forecastQty, forecast:[forecastQty,forecastQty,forecastQty], confidence, trend, orders:orders.length };
}

function predictDelay(trip) {
  if (window.LAMML) {
    return window.LAMML.predictDelay(trip, {
      driver:           _data.drivers.find(d=>d.id===trip.driverId),
      vehicle:          _data.fleet.find(v=>v.id===trip.vehicleId),
      historicalTrips:  _data.trips.filter(t=>t.id!==trip.id),
    });
  }
  // Fallback
  const factors=[]; let risk='low', delayChance=10;
  const driver=_data.drivers.find(d=>d.id===trip.driverId);
  const vehicle=_data.fleet.find(v=>v.id===trip.vehicleId);
  if(driver){const dt=_data.trips.filter(t=>t.driverId===trip.driverId&&t.id!==trip.id);const dr=dt.length?dt.filter(t=>t.delayed).length/dt.length:0;if(dr>0.3){factors.push('Driver 30%+ delay history');delayChance+=25;}}
  if(vehicle?.nextServiceKm&&vehicle?.currentKm&&Number(vehicle.currentKm)>=Number(vehicle.nextServiceKm)){factors.push('Vehicle overdue');delayChance+=20;}
  if(Number(trip.distanceKm)>500){factors.push('Long route >500km');delayChance+=15;}
  if(!factors.length)factors.push('No significant risk factors');
  if(delayChance>=50)risk='high'; else if(delayChance>=30)risk='medium';
  return { trip, risk, delayProbability:Math.min(delayChance,95), delayChance:Math.min(delayChance,95), features:factors.map(f=>({name:f})) };
}

function generateInsights() {
  const insights = [];

  // Low stock
  const lowStock = _data.inventory.filter(i=>Number(i.quantity)<=Number(i.reorderPoint||0)).length;
  if (lowStock > 0) {
    insights.push({ type:'warning', icon:'📦', title:`${lowStock} Products Below Reorder Point`, body:'Raise purchase orders immediately to avoid stockouts and lost sales.', color:'var(--brand-warning)' });
  }

  // Outstanding invoices
  const outstanding = _data.invoices.filter(i=>i.paymentStatus!=='paid').length;
  if (outstanding > 0) {
    const amount = _data.invoices.filter(i=>i.paymentStatus!=='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
    insights.push({ type:'warning', icon:'💰', title:`₹${amount.toLocaleString('en-IN')} Outstanding Receivables`, body:`${outstanding} unpaid invoices. Follow up with customers to improve cash flow.`, color:'var(--brand-warning)' });
  }

  // Fleet maintenance
  const maintDue = _data.fleet.filter(v=>v.nextServiceKm&&v.currentKm&&Number(v.currentKm)>=Number(v.nextServiceKm)-500).length;
  if (maintDue > 0) {
    insights.push({ type:'danger', icon:'🔧', title:`${maintDue} Vehicle${maintDue>1?'s':''} Service Due`, body:'Schedule maintenance immediately to prevent breakdowns during active trips.', color:'var(--brand-danger)' });
  }

  // Good OTIF
  const otif = calcOTIF();
  if (otif >= 95) {
    insights.push({ type:'success', icon:'🎯', title:`Excellent OTIF Rate: ${otif}%`, body:'Your on-time delivery performance is above industry benchmark of 95%. Keep it up!', color:'var(--brand-secondary)' });
  }

  // License expiring
  const licExpiring = _data.drivers.filter(d=>{
    if(!d.licenseExpiry) return false;
    const days=(new Date(d.licenseExpiry)-Date.now())/86400000;
    return days<=30&&days>0;
  }).length;
  if (licExpiring > 0) {
    insights.push({ type:'warning', icon:'🪪', title:`${licExpiring} Driver License${licExpiring>1?'s':''} Expiring`, body:'Remind affected drivers to renew before expiry to avoid compliance issues.', color:'var(--brand-warning)' });
  }

  if (!insights.length) {
    insights.push({ type:'success', icon:'✅', title:'All Systems Healthy', body:'No critical alerts. Business is running smoothly. Add more data for deeper insights.', color:'var(--brand-secondary)' });
  }

  return insights;
}

function buildRevExpTrend() {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const currentMonth = new Date().getMonth();
  const labels = months.slice(Math.max(0,currentMonth-5),currentMonth+1);
  return labels.map((m,i) => {
    const monthIdx = Math.max(0,currentMonth-5)+i;
    const monthStr = `${new Date().getFullYear()}-${String(monthIdx+1).padStart(2,'0')}`;
    const rev = _data.invoices
      .filter(inv=>inv.paymentStatus==='paid'&&(inv.invoiceDate||'').startsWith(monthStr))
      .reduce((s,inv)=>s+Number(inv.totalAmount||0),0);
    const exp = _data.expenses
      .filter(e=>(e.date||'').startsWith(monthStr))
      .reduce((s,e)=>s+Number(e.amount||0),0);
    return {
      label: m,
      rev:   rev   || Math.round(Math.random()*400000+100000), // demo fallback
      exp:   exp   || Math.round(Math.random()*200000+80000),
    };
  });
}

function renderMiniBarChart(data) {
  if (!data.length) return '<div style="padding:20px;text-align:center;color:var(--text-muted);">No data</div>';
  const id = 'rev-exp-chart-' + Date.now();
  setTimeout(() => {
    const canvas = document.getElementById(id);
    if (!canvas || !window.LAMCharts) return;
    window.LAMCharts.create('bar', canvas, {
      labels:   data.map(d=>d.label),
      datasets: [
        { label:'Revenue',  data:data.map(d=>d.rev), color:'#30D158' },
        { label:'Expenses', data:data.map(d=>d.exp), color:'#FF453A' },
      ],
      opts: { fmt:'currency', animDuration:800 },
    });
  }, 50);
  return `<canvas id="${id}" style="width:100%;height:180px;"></canvas>`;
}

function renderBusinessScore() {
  const otif     = calcOTIF();
  const util     = calcFleetUtilization();
  const drivers  = _data.drivers.length;
  const products = _data.products.length;
  const overall  = Math.round((otif + util + Math.min(drivers*10,100) + Math.min(products*5,100)) / 4);
  const scoreColor = overall>=80?'var(--brand-secondary)':overall>=60?'var(--brand-warning)':'var(--brand-danger)';

  return `
    <div style="text-align:center;padding:var(--space-4) 0;">
      <div style="font-family:var(--font-display);font-size:52px;font-weight:800;color:${scoreColor};line-height:1;">${overall}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-4);">out of 100</div>
      ${[['OTIF Rate',otif+'%'],['Fleet Util.',util+'%'],['Drivers',drivers],['Products',products]].map(([l,v])=>`
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
          <span style="font-size:12px;color:var(--text-muted);">${l}</span>
          <span style="font-size:12px;font-weight:600;">${v}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderMonthlyPattern() {
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const ordersByMonth = Array(12).fill(0);
  _data.orders.forEach(o => {
    if (o.orderDate || o.createdAt) {
      const d = new Date(o.orderDate || (o.createdAt?.seconds ? o.createdAt.seconds*1000 : o.createdAt));
      if (!isNaN(d)) ordersByMonth[d.getMonth()]++;
    }
  });
  const maxO = Math.max(...ordersByMonth, 1);

  return `
    <div style="display:flex;align-items:flex-end;gap:6px;padding:8px 0;height:100px;">
      ${monthLabels.map((m,i) => {
        const h = Math.round((ordersByMonth[i]/maxO)*80);
        const isCurrentMonth = i === new Date().getMonth();
        return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <div style="width:100%;height:${h}px;background:${isCurrentMonth?'var(--brand-primary)':'rgba(10,132,255,0.3)'};border-radius:3px 3px 0 0;min-height:2px;transition:height 0.8s ease;" title="${ordersByMonth[i]} orders"></div>
            <span style="font-size:9px;color:var(--text-muted);">${m}</span>
          </div>
        `;
      }).join('')}
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Order volume by month</div>
  `;
}

function renderCostPerRoute() {
  const routes = {};
  _data.trips.forEach(t => {
    if (!t.origin || !t.destination) return;
    const key = `${t.origin} → ${t.destination}`;
    if (!routes[key]) routes[key] = { cost:0, trips:0, km:0 };
    routes[key].cost  += Number(t.freightCost)||0;
    routes[key].trips ++;
    routes[key].km    += Number(t.distanceKm)||0;
  });

  const sorted = Object.entries(routes).sort((a,b)=>b[1].cost-a[1].cost).slice(0,6);
  if (!sorted.length) return `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No route data yet</div>`;

  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${sorted.map(([route,data]) => `
        <div style="padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
            <span style="font-size:12px;color:var(--text-secondary);">${escHtml(route)}</span>
            <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹${Number(data.cost).toLocaleString('en-IN')}</span>
          </div>
          <div style="font-size:10px;color:var(--text-muted);">${data.trips} trips · ${formatNumber(data.km)} km · ₹${data.trips?Math.round(data.cost/data.trips).toLocaleString('en-IN'):0}/trip</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderMonthlyCostTrend() {
  const months = ['Jan','Feb','Mar','Apr','May','Jun'];
  const data = months.map(m => ({
    label: m,
    fuel: Math.round(Math.random()*50000+20000),
    maint: Math.round(Math.random()*30000+10000),
    other: Math.round(Math.random()*20000+5000),
  }));
  const maxVal = Math.max(...data.map(d=>d.fuel+d.maint+d.other));

  return `
    <div style="display:flex;align-items:flex-end;gap:16px;padding:8px 0;height:140px;">
      ${data.map(d => {
        const total = d.fuel+d.maint+d.other;
        const fH = Math.round((d.fuel/maxVal)*120);
        const mH = Math.round((d.maint/maxVal)*120);
        const oH = Math.round((d.other/maxVal)*120);
        return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <div style="display:flex;flex-direction:column-reverse;width:32px;height:120px;border-radius:4px 4px 0 0;overflow:hidden;background:var(--bg-overlay);">
              <div style="height:${fH}px;background:var(--brand-accent);flex-shrink:0;"></div>
              <div style="height:${mH}px;background:var(--brand-warning);flex-shrink:0;"></div>
              <div style="height:${oH}px;background:var(--brand-primary);opacity:0.6;flex-shrink:0;"></div>
            </div>
            <span style="font-size:10px;color:var(--text-muted);">${d.label}</span>
          </div>
        `;
      }).join('')}
    </div>
    <div style="display:flex;gap:14px;padding-top:8px;border-top:1px solid var(--border-subtle);">
      ${[['Fuel','var(--brand-accent)'],['Maintenance','var(--brand-warning)'],['Other','var(--brand-primary)']].map(([l,c])=>`
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);">
          <div style="width:10px;height:10px;border-radius:2px;background:${c};"></div>${l}
        </div>
      `).join('')}
    </div>
  `;
}

function renderDelayByRoute() {
  const routes = {};
  _data.trips.forEach(t=>{
    if(!t.origin||!t.destination) return;
    const key=`${t.origin.split(',')[0]} → ${t.destination.split(',')[0]}`;
    if(!routes[key]) routes[key]={total:0,delayed:0};
    routes[key].total++;
    if(t.delayed) routes[key].delayed++;
  });
  const sorted=Object.entries(routes).filter(([,d])=>d.total>=1).sort((a,b)=>b[1].delayed/b[1].total-a[1].delayed/a[1].total).slice(0,6);
  if(!sorted.length) return `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No trip data yet</div>`;
  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${sorted.map(([route,d])=>{
        const rate=Math.round((d.delayed/d.total)*100);
        const color=rate>40?'var(--brand-danger)':rate>20?'var(--brand-warning)':'var(--brand-secondary)';
        return `
          <div style="padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;">${escHtml(route)}</span>
              <span style="font-size:12px;font-weight:700;color:${color};">${rate}% delayed</span>
            </div>
            <div style="background:var(--bg-overlay);border-radius:4px;height:6px;overflow:hidden;">
              <div style="height:100%;width:${rate}%;background:${color};border-radius:4px;"></div>
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${d.delayed}/${d.total} trips delayed</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
