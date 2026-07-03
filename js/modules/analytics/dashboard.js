// ============================================================
// LAM — Dashboard Module
// Main KPI dashboard renderer
// ============================================================

import { dbGetAll, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { formatCurrency, formatNumber, timeAgo, getInitials } from '../../core/utils.js';
import { AuthState } from '../../core/auth.js';

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Welcome back, ${AuthState.profile?.name?.split(' ')[0] || 'User'} — here's your operations overview.</p>
      </div>
      <div class="flex gap-3 items-center">
        <span id="last-updated" style="font-size:11px;color:var(--text-muted);">Refreshing…</span>
        <button class="btn btn-secondary btn-sm" onclick="refreshDashboard()">↻ Refresh</button>
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="grid-4" id="kpi-grid" style="margin-bottom:var(--space-6);">
      ${kpiSkeleton(4)}
    </div>

    <!-- Rev vs Exp Trend (Tier 6 — shows when invoices data loads) -->
    <div id="rev-exp-card" class="card" style="margin-bottom:var(--space-5);display:none;">
      <div class="card-header">
        <div class="card-title">📊 Revenue vs Expenses — Last 6 Months</div>
        <span style="font-size:10px;color:var(--text-muted);">Powered by LAMWorker</span>
      </div>
      <div id="rev-exp-trend" style="padding:12px 16px;"></div>
    </div>

    <!-- Row 2: Charts + Activity -->
    <div style="display:grid;grid-template-columns:1fr 340px;gap:var(--space-5);margin-bottom:var(--space-5);">

      <!-- Inventory Overview -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Inventory Overview</div>
            <div class="card-subtitle">Stock levels across warehouses</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="LAM.Router.navigate('inventory')">View All →</button>
        </div>
        <div id="inventory-chart-area" style="height:200px;display:flex;align-items:center;justify-content:center;">
          <div class="spinner"></div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Activity</div>
        </div>
        <div class="activity-list" id="activity-list">
          ${activitySkeleton(5)}
        </div>
      </div>
    </div>

    <!-- Row 3: Quick Actions + Low Stock + Pending -->
    <div class="grid-3" style="margin-bottom:var(--space-5);">

      <!-- Quick Actions -->
      <div class="card">
        <div class="card-header"><div class="card-title">Quick Actions</div></div>
        <div class="quick-actions" style="grid-template-columns:repeat(2,1fr);">
          <div class="quick-action" onclick="LAM.Router.navigate('vendors')">
            <span class="qa-icon">🤝</span><span class="qa-label">Add Vendor</span>
          </div>
          <div class="quick-action" onclick="LAM.Router.navigate('customers')">
            <span class="qa-icon">👤</span><span class="qa-label">Add Customer</span>
          </div>
          <div class="quick-action" onclick="LAM.Router.navigate('products')">
            <span class="qa-icon">📦</span><span class="qa-label">Add Product</span>
          </div>
          <div class="quick-action" onclick="LAM.Router.navigate('inventory')">
            <span class="qa-icon">📋</span><span class="qa-label">Stock Check</span>
          </div>
          <div class="quick-action" onclick="LAM.Router.navigate('employees')">
            <span class="qa-icon">👥</span><span class="qa-label">Add Employee</span>
          </div>
          <div class="quick-action" onclick="LAM.Router.navigate('warehouses')">
            <span class="qa-icon">🏭</span><span class="qa-label">Warehouses</span>
          </div>
        </div>
      </div>

      <!-- Low Stock Alerts -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚠️ Low Stock Alerts</div>
          <span class="badge badge-red badge-dot" id="low-stock-count">—</span>
        </div>
        <div id="low-stock-list" style="display:flex;flex-direction:column;gap:8px;">
          ${miniSkeleton(4)}
        </div>
      </div>

      <!-- Module Status -->
      <div class="card">
        <div class="card-header"><div class="card-title">Module Status</div></div>
        <div id="module-status-list" style="display:flex;flex-direction:column;gap:8px;">
          ${moduleStatusHtml()}
        </div>
      </div>
    </div>

    <!-- Row 4: Vendors + Customers summary -->
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Top Vendors</div>
          <button class="btn btn-ghost btn-sm" onclick="LAM.Router.navigate('vendors')">View All →</button>
        </div>
        <div id="top-vendors-list">
          ${miniSkeleton(4)}
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Customers</div>
          <button class="btn btn-ghost btn-sm" onclick="LAM.Router.navigate('customers')">View All →</button>
        </div>
        <div id="recent-customers-list">
          ${miniSkeleton(4)}
        </div>
      </div>
    </div>
  `;

  window.refreshDashboard = () => renderDashboard(container);
  // Yield to the browser paint cycle before hitting IDB with 9 parallel reads.
  // Without this, the skeleton UI never renders before the data load blocks
  // the main thread → user sees a white/frozen screen.
  await new Promise(r => setTimeout(r, 50));
  await loadDashboardData(container);
  const luEl = document.getElementById('last-updated'); if (luEl) luEl.textContent = 'Updated just now';
}

// ── Data Loader ───────────────────────────────────────────────
async function loadDashboardData(container) {
  try {
    const companyId = AuthState.company?.id;
    const constraints = companyId ? [where('companyId','==',companyId)] : [];

    // Load all data in parallel — finance data too
    const [vendors, customers, products, employees, inventory, warehouses, invoices, expenses, trips] = await Promise.all([
      dbGetAll(COLLECTIONS.VENDORS,    constraints),
      dbGetAll(COLLECTIONS.CUSTOMERS,  constraints),
      dbGetAll(COLLECTIONS.PRODUCTS,   constraints),
      dbGetAll(COLLECTIONS.EMPLOYEES,  constraints),
      dbGetAll(COLLECTIONS.INVENTORY,  constraints),
      dbGetAll(COLLECTIONS.WAREHOUSES, constraints),
      dbGetAll(COLLECTIONS.INVOICES,   constraints),
      dbGetAll(COLLECTIONS.EXPENSES || 'expenses', constraints).catch(()=>[]),
      dbGetAll(COLLECTIONS.TRIPS    || 'trips',    constraints).catch(()=>[]),
    ]);

    // Render basic KPIs immediately so user sees data fast
    renderKPIs({ vendors, customers, products, employees, inventory, warehouses, invoices, expenses, financeData: null });
    renderInventoryChart(inventory, products);
    renderActivity([...vendors, ...customers, ...products].sort((a,b) =>
      (b.createdAt||'') > (a.createdAt||'') ? 1 : -1
    ).slice(0, 8));
    renderLowStock(inventory, products);
    renderTopVendors(vendors);
    renderRecentCustomers(customers);

    // Heavy aggregations deferred — keeps UI responsive, worker runs after paint
    if (window.LAMWorker) {
      setTimeout(async () => {
        try {
          const today  = new Date();
          const months6 = Array.from({length:6},(_,i)=>{
            const d = new Date(today.getFullYear(), today.getMonth()-5+i, 1);
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
          });
          const [revByMonth, expByMonth, custRev, lowStock] = await Promise.all([
            window.LAMWorker.monthlyRevenue(invoices, months6),
            window.LAMWorker.monthlyExpenses(expenses, months6),
            window.LAMWorker.customerRevenue(invoices, customers),
            window.LAMWorker.lowStockAnalysis(inventory, products),
          ]);
          const financeData = { revByMonth, expByMonth, custRev, lowStock, months6 };
          renderKPIs({ vendors, customers, products, employees, inventory, warehouses, invoices, expenses, financeData });
          renderFinanceKPIs(invoices, expenses, financeData);
          renderRevExpChart(financeData);
          renderTopCustomers(financeData.custRev);
          const el = document.getElementById('last-updated');
          if (el) el.textContent = 'Updated just now';
        } catch(e) { console.warn('Dashboard worker aggregation failed:', e); }
      }, 200);
    }
  } catch(e) {
    console.error('Dashboard load error:', e);
    renderKPIs({ vendors:[], customers:[], products:[], employees:[], inventory:[], warehouses:[] });
  }
}

// ── KPI Renderer ──────────────────────────────────────────────
function renderKPIs({ vendors, customers, products, employees, inventory, warehouses, invoices=[], expenses=[], financeData=null }) {
  const totalStock    = inventory.reduce((s,i) => s + (Number(i.quantity)||0), 0);
  const lowStockItems = inventory.filter(i => Number(i.quantity) <= Number(i.reorderPoint||0));
  const today         = new Date();
  const thisMonth     = today.toISOString().slice(0,7);

  // Real finance KPIs
  const paidInv        = invoices.filter(i=>i.paymentStatus==='paid');
  const overdueInv     = invoices.filter(i=>i.paymentStatus!=='paid'&&i.dueDate&&new Date(i.dueDate)<today);
  const thisMonthRev   = paidInv.filter(i=>(i.invoiceDate||i.createdAt||'').startsWith(thisMonth))
                         .reduce((s,i)=>s+Number(i.totalAmount||0),0);
  const thisMonthExp   = expenses.filter(e=>(e.date||e.createdAt||'').startsWith(thisMonth))
                         .reduce((s,e)=>s+Number(e.amount||0),0);
  const thisMonthProfit= thisMonthRev - thisMonthExp;
  const unpaidTotal    = invoices.filter(i=>i.paymentStatus!=='paid')
                         .reduce((s,i)=>s+Number(i.totalAmount||0),0);

  // Trend vs last month
  const lastMonth      = new Date(today.getFullYear(), today.getMonth()-1, 1).toISOString().slice(0,7);
  const lastMonthRev   = paidInv.filter(i=>(i.invoiceDate||i.createdAt||'').startsWith(lastMonth))
                         .reduce((s,i)=>s+Number(i.totalAmount||0),0);
  const revTrend       = lastMonthRev ? Math.round((thisMonthRev-lastMonthRev)/lastMonthRev*100) : 0;
  const revDir         = revTrend >= 0 ? 'up' : 'down';

  const kpis = invoices.length > 0 ? [
    {
      label: 'This Month Revenue',
      value: thisMonthRev >= 100000
        ? `₹${(thisMonthRev/100000).toFixed(1)}L`
        : `₹${Math.round(thisMonthRev/1000)}K`,
      icon: '💰', color: 'kpi-green',
      trend: `${revTrend >= 0 ? '+' : ''}${revTrend}%`, dir: revDir,
      sub: `vs ₹${Math.round(lastMonthRev/1000)}K last month`,
    },
    {
      label: 'Net Profit (MTD)',
      value: thisMonthProfit >= 0
        ? (thisMonthProfit >= 100000 ? `₹${(thisMonthProfit/100000).toFixed(1)}L` : `₹${Math.round(thisMonthProfit/1000)}K`)
        : `-₹${Math.round(Math.abs(thisMonthProfit)/1000)}K`,
      icon: '📈', color: thisMonthProfit >= 0 ? 'kpi-blue' : 'kpi-orange',
      trend: thisMonthRev ? `${Math.round(thisMonthProfit/thisMonthRev*100)}% margin` : '—',
      dir: thisMonthProfit >= 0 ? 'up' : 'down',
      sub: `Expenses: ₹${Math.round(thisMonthExp/1000)}K this month`,
    },
    {
      label: 'Unpaid Invoices',
      value: formatNumber(invoices.filter(i=>i.paymentStatus!=='paid').length),
      icon: '🧾', color: overdueInv.length > 0 ? 'kpi-orange' : 'kpi-yellow',
      trend: `${overdueInv.length} overdue`, dir: overdueInv.length > 0 ? 'down' : 'up',
      sub: `₹${unpaidTotal>=100000?(unpaidTotal/100000).toFixed(1)+'L':Math.round(unpaidTotal/1000)+'K'} receivable`,
    },
    {
      label: 'Active Customers',
      value: formatNumber(customers.length),
      icon: '👤', color: 'kpi-blue',
      trend: `${employees.length} employees`, dir: 'up',
      sub: `${vendors.filter(v=>v.status!=='inactive').length} active vendors`,
    },
  ] : [
    { label: 'Total Products',   value: formatNumber(products.length),   icon: '📦', color: 'kpi-blue',   trend: '', dir: 'up',   sub: `Across ${warehouses.length} warehouse(s)` },
    { label: 'Total Stock Units', value: formatNumber(totalStock),        icon: '📋', color: 'kpi-green',  trend: '', dir: 'up',   sub: 'Current inventory level' },
    { label: 'Active Vendors',    value: formatNumber(vendors.length),    icon: '🤝', color: 'kpi-orange', trend: '', dir: 'up',   sub: `${customers.length} customers` },
    { label: 'Employees',         value: formatNumber(employees.length),  icon: '👥', color: 'kpi-yellow', trend: '', dir: 'up',   sub: 'Total staff' },
  ];

  const el = document.getElementById('kpi-grid');
  if (!el) return;
  el.innerHTML = kpis.map((k,i) => `
    <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
      <div class="kpi-top">
        <div class="kpi-icon">${k.icon}</div>
        ${k.trend ? `<div class="kpi-trend ${k.dir}">${k.dir==='up'?'↑':'↓'} ${k.trend}</div>` : ''}
      </div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>
  `).join('');

  document.getElementById('low-stock-count').textContent = lowStockItems.length || '0';
}

// ── Finance KPI row (Tier 6) ──────────────────────────────────
function renderFinanceKPIs(invoices, expenses, financeData) {
  // Already handled in renderKPIs when finance data present
}

// ── Revenue vs Expenses chart (Tier 6 — LAMWorker + LAMCharts) ─
function renderRevExpChart(financeData) {
  const { revByMonth, expByMonth, months6 } = financeData;
  const card  = document.getElementById('rev-exp-card');
  const trendEl = document.getElementById('rev-exp-trend');
  if (!trendEl || !window.LAMCharts) return;

  const revData = months6.map(m => Math.round(revByMonth[m]||0));
  const expData = months6.map(m => Math.round(expByMonth[m]||0));

  // Only show card if we have actual data
  const hasData = revData.some(v=>v>0) || expData.some(v=>v>0);
  if (!hasData) return;
  if (card) card.style.display = 'block';

  const labels = months6.map(m => {
    const mo = parseInt(m.split('-')[1]) - 1;
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo];
  });

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:160px;display:block;';
  trendEl.innerHTML = '';
  trendEl.appendChild(canvas);

  window.LAMCharts.create('line', canvas, {
    labels,
    series: [
      { label:'Revenue',  data:revData, color:'#30D158' },
      { label:'Expenses', data:expData, color:'#FF453A' },
    ],
    opts: { fmt:'currency', area:true, animDuration:700 },
  });
}

// ── Top customers card (Tier 6) ───────────────────────────────
function renderTopCustomers(custRev) {
  const el = document.getElementById('recent-customers-list');
  if (!el || !custRev?.length) return;
  el.innerHTML = custRev.slice(0,6).map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:30px;height:30px;border-radius:50%;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${(c.name||'?')[0].toUpperCase()}</div>
        <div>
          <div style="font-size:13px;font-weight:500;">${c.name||'—'}</div>
        </div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--brand-secondary);">₹${c.revenue>=100000?(c.revenue/100000).toFixed(1)+'L':Math.round(c.revenue/1000)+'K'}</div>
    </div>
  `).join('');
}

// ── Inventory Chart (Pure CSS bar chart) ─────────────────────
function renderInventoryChart(inventory, products) {
  const area = document.getElementById('inventory-chart-area');
  if (!area) return;

  if (!inventory.length) {
    area.innerHTML = emptyState('📦', 'No inventory data yet', 'Add products and stock to see the chart.');
    return;
  }

  // Group by product, take top 8
  const byProduct = {};
  inventory.forEach(i => {
    const p = products.find(p => p.id === i.productId);
    const name = p?.name || i.productName || 'Unknown';
    byProduct[name] = (byProduct[name] || 0) + (Number(i.quantity) || 0);
  });

  const entries = Object.entries(byProduct).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxVal  = Math.max(...entries.map(e=>e[1]), 1);

  area.innerHTML = `
    <div style="width:100%;padding:8px 0;display:flex;flex-direction:column;gap:10px;">
      <!-- LAMCharts canvas version -->
    <canvas id="inv-bar-chart" style="width:100%;height:180px;display:block;"></canvas>
  `;

  // Init LAMCharts bar chart
  setTimeout(() => {
    const canvas = document.getElementById('inv-bar-chart');
    if (!canvas || !window.LAMCharts) {
      // Fallback CSS bars
      area.innerHTML = `<div style="width:100%;padding:8px 0;display:flex;flex-direction:column;gap:10px;">
        ${entries.map(([name,qty])=>`<div style="display:grid;grid-template-columns:130px 1fr 60px;align-items:center;gap:10px;">
          <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;">${name}</div>
          <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
            <div style="height:100%;width:${Math.round(qty/Math.max(...entries.map(e=>e[1]),1)*100)}%;background:linear-gradient(90deg,var(--brand-primary),var(--brand-secondary));border-radius:4px;"></div>
          </div>
          <div style="font-size:11px;font-family:var(--font-mono);text-align:right;">${qty}</div>
        </div>`).join('')}
      </div>`;
      return;
    }
    window.LAMCharts.create('bar', canvas, {
      labels:   entries.map(([name]) => name.length > 12 ? name.slice(0,11)+'…' : name),
      datasets: [{ label:'Stock', data:entries.map(([,qty])=>qty), color:'#0A84FF' }],
      opts:     { animDuration:700 },
    });
  }, 60);
}

// ── Activity Feed ─────────────────────────────────────────────
function renderActivity(items) {
  const list = document.getElementById('activity-list');
  if (!list) return;

  if (!items.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px;">No recent activity</div>`;
    return;
  }

  const colors = ['var(--brand-primary)','var(--brand-secondary)','var(--brand-accent)','var(--brand-warning)'];
  const typeLabel = (item) => {
    if (item.gstin || item.contactPerson) return ['Vendor added', 'var(--brand-primary)'];
    if (item.email && item.phone && !item.role)   return ['Customer added', 'var(--brand-secondary)'];
    if (item.sku || item.category)                return ['Product added', 'var(--brand-accent)'];
    if (item.role)                                return ['Employee added', 'var(--brand-warning)'];
    return ['Record created', colors[0]];
  };

  list.innerHTML = items.map(item => {
    const [label, color] = typeLabel(item);
    return `
      <div class="activity-item">
        <div class="activity-dot" style="background:${color};"></div>
        <div class="activity-content">
          <div class="activity-text"><strong>${item.name || item.companyName || 'Record'}</strong> — ${label}</div>
          <div class="activity-time">${timeAgo(item.createdAt)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Low Stock ─────────────────────────────────────────────────
function renderLowStock(inventory, products) {
  const list = document.getElementById('low-stock-list');
  if (!list) return;

  const low = inventory.filter(i => {
    const qty = Number(i.quantity) || 0;
    const reorder = Number(i.reorderPoint) || 10;
    return qty <= reorder;
  }).slice(0, 5);

  if (!low.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">✅ All stock levels healthy</div>`;
    return;
  }

  list.innerHTML = low.map(i => {
    const p = products.find(p=>p.id===i.productId);
    const name = p?.name || i.productName || 'Unknown Product';
    const qty  = Number(i.quantity) || 0;
    const isOut = qty === 0;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
        <div style="font-size:12px;color:var(--text-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
        <span class="badge ${isOut ? 'badge-red' : 'badge-yellow'}" style="margin-left:8px;flex-shrink:0;">${isOut ? 'Out' : qty + ' left'}</span>
      </div>
    `;
  }).join('');
}

// ── Top Vendors ───────────────────────────────────────────────
function renderTopVendors(vendors) {
  const el = document.getElementById('top-vendors-list');
  if (!el) return;

  if (!vendors.length) {
    el.innerHTML = emptyState('🤝', 'No vendors yet', 'Add your first vendor to get started.');
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${vendors.slice(0,5).map(v => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
          <div style="width:30px;height:30px;border-radius:8px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-primary);flex-shrink:0;">${getInitials(v.name||v.companyName||'V')}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v.name || v.companyName || '—'}</div>
            <div style="font-size:11px;color:var(--text-muted);">${v.city || v.email || '—'}</div>
          </div>
          <span class="badge badge-${v.status==='active'||!v.status?'green':'gray'}">${v.status||'active'}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Recent Customers ──────────────────────────────────────────
function renderRecentCustomers(customers) {
  const el = document.getElementById('recent-customers-list');
  if (!el) return;

  if (!customers.length) {
    el.innerHTML = emptyState('👤', 'No customers yet', 'Add your first customer to get started.');
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${customers.slice(0,5).map(c => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
          <div style="width:30px;height:30px;border-radius:8px;background:rgba(0,200,150,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-secondary);flex-shrink:0;">${getInitials(c.name||'C')}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name||'—'}</div>
            <div style="font-size:11px;color:var(--text-muted);">${c.phone || c.email || '—'}</div>
          </div>
          <span class="badge badge-${c.type==='premium'?'blue':c.type==='wholesale'?'green':'gray'}">${c.type||'retail'}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Module Status ─────────────────────────────────────────────
function moduleStatusHtml() {
  const modules = [
    { name: 'Auth & Users',     status: 'live',   plan: 'all' },
    { name: 'Warehouse / WMS',  status: 'live',   plan: 'all' },
    { name: 'Vendors & CRM',    status: 'live',   plan: 'all' },
    { name: 'Orders / GRN',     status: 'growth', plan: 'growth' },
    { name: 'Transport / TMS',  status: 'locked', plan: 'enterprise' },
    { name: 'Finance & GST',    status: 'locked', plan: 'enterprise' },
    { name: 'AI Forecasting',   status: 'locked', plan: 'enterprise' },
  ];
  return modules.map(m => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border-subtle);">
      <div style="font-size:12px;color:${m.status==='locked'?'var(--text-muted)':'var(--text-primary)'};">${m.name}</div>
      ${m.status === 'live'    ? `<span class="badge badge-green badge-dot">Live</span>` : ''}
      ${m.status === 'growth'  ? `<span class="badge badge-yellow">Growth</span>` : ''}
      ${m.status === 'locked'  ? `<span class="badge badge-gray">🔒 Enterprise</span>` : ''}
    </div>
  `).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function kpiSkeleton(n) {
  return Array(n).fill(0).map((_,i) => `
    <div class="kpi-card anim-fade-in-up stagger-${i+1}">
      <div class="skeleton" style="width:40px;height:40px;border-radius:10px;margin-bottom:12px;"></div>
      <div class="skeleton" style="width:80px;height:28px;border-radius:6px;margin-bottom:8px;"></div>
      <div class="skeleton" style="width:120px;height:12px;border-radius:4px;"></div>
    </div>
  `).join('');
}

function activitySkeleton(n) {
  return Array(n).fill(0).map(() => `
    <div class="activity-item">
      <div class="skeleton" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px;"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
        <div class="skeleton" style="width:70%;height:12px;border-radius:4px;"></div>
        <div class="skeleton" style="width:40%;height:10px;border-radius:4px;"></div>
      </div>
    </div>
  `).join('');
}

function miniSkeleton(n) {
  return Array(n).fill(0).map(() => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
      <div class="skeleton" style="width:60%;height:12px;border-radius:4px;"></div>
      <div class="skeleton" style="width:20%;height:12px;border-radius:4px;"></div>
    </div>
  `).join('');
}

function emptyState(icon, title, text) {
  return `
    <div style="text-align:center;padding:24px 16px;color:var(--text-muted);">
      <div style="font-size:28px;margin-bottom:8px;opacity:0.4;">${icon}</div>
      <div style="font-size:13px;font-weight:500;color:var(--text-secondary);margin-bottom:4px;">${title}</div>
      <div style="font-size:11px;">${text}</div>
    </div>
  `;
}
