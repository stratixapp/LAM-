// ============================================================
// LAM Worker Engine v1 — Web Worker offloader
// Moves heavy ML, search indexing, report prep, and
// data aggregation off the main thread. UI stays smooth.
// Zero dependency. Works with all existing LAM engines.
// ============================================================

const LAMWorker = (() => {

  // ── Worker script (inlined as blob URL) ──────────────────
  const WORKER_CODE = `
// ── Inside the Web Worker ────────────────────────────────────
self.onmessage = async (e) => {
  const { id, task, payload } = e.data;
  try {
    const result = await dispatch(task, payload);
    self.postMessage({ id, status: 'ok', result });
  } catch(err) {
    self.postMessage({ id, status: 'error', error: err.message });
  }
};

async function dispatch(task, payload) {
  switch(task) {

    case 'sort': {
      const { items, key, dir } = payload;
      return [...items].sort((a,b)=>{
        const va = a[key]??'', vb = b[key]??'';
        const cmp = va<vb?-1:va>vb?1:0;
        return dir==='desc'?-cmp:cmp;
      });
    }

    case 'filter': {
      const { items, query, fields } = payload;
      if (!query?.trim()) return items;
      const q = query.toLowerCase();
      return items.filter(item=>fields.some(f=>String(item[f]??'').toLowerCase().includes(q)));
    }

    case 'aggregate': {
      const { items, groupBy, sumField } = payload;
      const groups = {};
      items.forEach(item=>{
        const k = item[groupBy]??'Other';
        if(!groups[k]) groups[k] = { key:k, count:0, sum:0 };
        groups[k].count++;
        if(sumField) groups[k].sum += Number(item[sumField]||0);
      });
      return Object.values(groups).sort((a,b)=>b.sum-a.sum);
    }

    case 'monthly_revenue': {
      const { invoices, months } = payload;
      const result = {};
      months.forEach(m=>{ result[m]=0; });
      invoices.filter(i=>i.paymentStatus==='paid').forEach(inv=>{
        const m = (inv.invoiceDate||inv.createdAt||'').slice(0,7);
        if(m in result) result[m] += Number(inv.totalAmount||0);
      });
      return result;
    }

    case 'monthly_expenses': {
      const { expenses, months } = payload;
      const result = {};
      months.forEach(m=>{ result[m]=0; });
      expenses.forEach(e=>{
        const m = (e.date||e.createdAt||'').slice(0,7);
        if(m in result) result[m] += Number(e.amount||0);
      });
      return result;
    }

    case 'inventory_value': {
      const { inventory, products } = payload;
      let total = 0;
      const byCategory = {};
      inventory.forEach(inv=>{
        const p = products.find(x=>x.id===inv.productId)||{};
        const val = Number(inv.quantity||0)*Number(p.costPrice||p.price||0);
        total += val;
        const cat = p.category||'Other';
        byCategory[cat] = (byCategory[cat]||0)+val;
      });
      return { total, byCategory };
    }

    case 'customer_revenue': {
      const { invoices, customers } = payload;
      const byCustomer = {};
      invoices.filter(i=>i.paymentStatus==='paid').forEach(inv=>{
        const k = inv.customerId||'unknown';
        byCustomer[k] = (byCustomer[k]||0)+Number(inv.totalAmount||0);
      });
      return Object.entries(byCustomer)
        .map(([id,rev])=>({
          id,
          name: customers.find(c=>c.id===id)?.name||id,
          revenue: Math.round(rev)
        }))
        .sort((a,b)=>b.revenue-a.revenue)
        .slice(0,10);
    }

    case 'expense_breakdown': {
      const { expenses } = payload;
      const by = {};
      expenses.forEach(e=>{
        const cat = e.category||'Other';
        by[cat] = (by[cat]||0)+Number(e.amount||0);
      });
      return Object.entries(by)
        .map(([cat,amt])=>({cat,amt:Math.round(amt)}))
        .sort((a,b)=>b.amt-a.amt);
    }

    case 'trip_stats': {
      const { trips, fleet } = payload;
      const byVehicle = {};
      trips.forEach(t=>{
        const v = fleet.find(f=>f.id===t.vehicleId);
        const k = v?.vehicleNumber||t.vehicleId||'unknown';
        if(!byVehicle[k]) byVehicle[k]={ vehicle:k, trips:0, km:0, revenue:0, delayed:0 };
        byVehicle[k].trips++;
        byVehicle[k].km      += Number(t.distanceKm||0);
        byVehicle[k].revenue += Number(t.freightCost||0);
        if(t.delayed) byVehicle[k].delayed++;
      });
      return Object.values(byVehicle).sort((a,b)=>b.revenue-a.revenue);
    }

    case 'low_stock_analysis': {
      const { inventory, products } = payload;
      const critical=[], warning=[], ok=[];
      products.forEach(p=>{
        const inv = inventory.filter(i=>i.productId===p.id);
        const qty = inv.reduce((s,i)=>s+Number(i.quantity||0),0);
        const reorder = Number(p.reorderPoint||p.reorderQty||0);
        const item = { id:p.id, name:p.name, sku:p.sku, qty, reorder,
          category:p.category, unit:p.unit,
          value:qty*Number(p.costPrice||p.price||0) };
        if(qty<=0) critical.push(item);
        else if(qty<=reorder) warning.push(item);
        else ok.push(item);
      });
      return { critical, warning, ok,
        totalValue: [...critical,...warning,...ok].reduce((s,i)=>s+i.value,0) };
    }

    case 'overdue_analysis': {
      const { invoices, customers } = payload;
      const today = new Date();
      const buckets = { d30:0, d60:0, d90:0, d180:0, dOver:0 };
      const amounts = { d30:0, d60:0, d90:0, d180:0, dOver:0 };
      invoices.filter(i=>i.paymentStatus!=='paid'&&i.dueDate).forEach(inv=>{
        const days = Math.floor((today-new Date(inv.dueDate))/86400000);
        const amt  = Number(inv.totalAmount||0);
        if(days<=30)      { buckets.d30++;  amounts.d30+=amt;  }
        else if(days<=60) { buckets.d60++;  amounts.d60+=amt;  }
        else if(days<=90) { buckets.d90++;  amounts.d90+=amt;  }
        else if(days<=180){ buckets.d180++; amounts.d180+=amt; }
        else              { buckets.dOver++;amounts.dOver+=amt; }
      });
      return { buckets, amounts,
        total: Object.values(amounts).reduce((a,b)=>a+b,0),
        count: Object.values(buckets).reduce((a,b)=>a+b,0) };
    }

    case 'payroll_summary': {
      const { payroll, employees } = payload;
      const byMonth = {};
      payroll.forEach(r=>{
        const m = r.month||r.createdAt?.slice(0,7)||'';
        if(!byMonth[m]) byMonth[m] = { month:m, employees:0, gross:0, net:0, pf:0, tds:0 };
        byMonth[m].employees++;
        byMonth[m].gross += Number(r.grossSalary||0);
        byMonth[m].net   += Number(r.netPay||0);
        byMonth[m].pf    += Number(r.pfEmployee||0);
        byMonth[m].tds   += Number(r.tds||0);
      });
      return Object.values(byMonth).sort((a,b)=>a.month>b.month?1:-1);
    }

    case 'search_filter': {
      // Full fuzzy search in worker
      const { items, query, fields, threshold } = payload;
      if(!query?.trim()) return items;
      const q = query.toLowerCase();
      const th= threshold||0.3;
      const scored = items.map(item=>{
        let best = 0;
        for(const f of fields){
          const text = String(item[f]??'').toLowerCase();
          if(text.startsWith(q))       { best=Math.max(best,1.0); break; }
          if(text.includes(q))         { best=Math.max(best,0.85); continue; }
          const tokens = text.split(/\s+/);
          for(const tok of tokens){
            if(tok.startsWith(q)||q.startsWith(tok)) best=Math.max(best,0.7);
          }
        }
        return best>=th ? { item, score:best } : null;
      }).filter(Boolean);
      scored.sort((a,b)=>b.score-a.score);
      return scored.map(s=>s.item);
    }

    default:
      throw new Error('Unknown task: '+task);
  }
}
`;

  // ── Worker pool ───────────────────────────────────────────
  const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 2, 4);
  let   _workers  = [];
  let   _pending  = new Map(); // id → { resolve, reject }
  let   _idCounter= 0;
  let   _initialized = false;

  function _init() {
    if (_initialized) return;
    _initialized = true;
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => {
        const { id, status, result, error } = e.data;
        const p = _pending.get(id);
        if (p) {
          _pending.delete(id);
          if (status === 'ok') p.resolve(result);
          else p.reject(new Error(error));
        }
        w._busy = false;
        _drainQueue();
      };
      w.onerror = (e) => {
        console.warn('LAMWorker error:', e.message);
        w._busy = false;
        _drainQueue();
      };
      w._busy = false;
      _workers.push(w);
    }
    URL.revokeObjectURL(url);
  }

  let _queue = [];

  function _drainQueue() {
    while (_queue.length > 0) {
      const idle = _workers.find(w => !w._busy);
      if (!idle) break;
      const { id, task, payload, resolve, reject } = _queue.shift();
      _pending.set(id, { resolve, reject });
      idle._busy = true;
      idle.postMessage({ id, task, payload });
    }
  }

  /**
   * Run a task in a Web Worker
   * @param {string} task - task name
   * @param {Object} payload - data to process
   * @returns {Promise} result
   */
  function run(task, payload) {
    _init();
    const id = ++_idCounter;
    return new Promise((resolve, reject) => {
      const idle = _workers.find(w => !w._busy);
      if (idle) {
        _pending.set(id, { resolve, reject });
        idle._busy = true;
        idle.postMessage({ id, task, payload });
      } else {
        _queue.push({ id, task, payload, resolve, reject });
      }
    });
  }

  // ── Convenience wrappers ──────────────────────────────────

  const sort        = (items, key, dir='asc')        => run('sort',        { items, key, dir });
  const filter      = (items, query, fields)          => run('filter',      { items, query, fields });
  const aggregate   = (items, groupBy, sumField)      => run('aggregate',   { items, groupBy, sumField });
  const searchItems = (items, query, fields, threshold)=> run('search_filter',{ items, query, fields, threshold });

  // Business intelligence tasks
  const monthlyRevenue  = (invoices, months)          => run('monthly_revenue',    { invoices, months });
  const monthlyExpenses = (expenses, months)          => run('monthly_expenses',   { expenses, months });
  const inventoryValue  = (inventory, products)       => run('inventory_value',    { inventory, products });
  const customerRevenue = (invoices, customers)       => run('customer_revenue',   { invoices, customers });
  const expenseBreakdown= (expenses)                  => run('expense_breakdown',  { expenses });
  const tripStats       = (trips, fleet)              => run('trip_stats',         { trips, fleet });
  const lowStockAnalysis= (inventory, products)       => run('low_stock_analysis', { inventory, products });
  const overdueAnalysis = (invoices, customers)       => run('overdue_analysis',   { invoices, customers });
  const payrollSummary  = (payroll, employees)        => run('payroll_summary',    { payroll, employees });

  // ── Terminate all workers ─────────────────────────────────
  function terminate() {
    _workers.forEach(w => w.terminate());
    _workers      = [];
    _initialized  = false;
    _pending.clear();
    _queue        = [];
  }

  function isSupported() { return typeof Worker !== 'undefined'; }

  return {
    run,
    sort, filter, aggregate, searchItems,
    monthlyRevenue, monthlyExpenses, inventoryValue,
    customerRevenue, expenseBreakdown, tripStats,
    lowStockAnalysis, overdueAnalysis, payrollSummary,
    terminate, isSupported,
    get poolSize() { return POOL_SIZE; },
    get queueLength() { return _queue.length; },
  };

})();

window.LAMWorker = LAMWorker;
