// ============================================================
// LAM Reports Engine v1 — Full branded PDF + Excel reports
// Replaces all CSV downloads with proper business documents.
// P&L, GST Summary, Invoice Aging, Inventory Valuation,
// Driver Performance, Vendor Scorecard — all one-click.
// ============================================================

const LAMReports = (() => {

  const fmt = {
    currency: n => `₹${Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2})}`,
    num:      n => Number(n||0).toLocaleString('en-IN'),
    pct:      n => `${Math.round(Number(n||0)*10)/10}%`,
    date:     s => s ? new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—',
    dateShort:s => s ? new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) : '—',
  };

  // ── Helper: get LAMPDF doc ────────────────────────────────
  function _pdf() {
    if (!window.LAMPDF) throw new Error('LAMPDF not loaded');
    return new window.LAMPDF.LAMPdfDoc();
  }

  function _company() {
    try {
      const s = localStorage.getItem('lam_session');
      const companyId = s ? JSON.parse(s).companyId : null;
      if (!companyId) return {};
      const store = JSON.parse(localStorage.getItem('lam_db_companies') || '{}');
      return Object.values(store)[0] || {};
    } catch { return {}; }
  }

  // ── 1. P&L Statement ─────────────────────────────────────
  async function profitAndLoss(data, opts = {}) {
    const { invoices=[], expenses=[], payments=[], fromDate, toDate } = data;
    const co = _company();

    const filterDate = items => {
      if (!fromDate && !toDate) return items;
      return items.filter(i => {
        const d = i.date || i.invoiceDate || i.createdAt || '';
        return (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
      });
    };

    const filteredInv  = filterDate(invoices.filter(i=>i.paymentStatus==='paid'));
    const filteredPay  = filterDate(payments);
    const filteredExp  = filterDate(expenses);

    // Revenue breakdown
    const totalRevenue  = filteredInv.reduce((s,i)=>s+Number(i.totalAmount||0),0);
    const totalGST      = filteredInv.reduce((s,i)=>s+Number(i.gstAmount||0),0);
    const netRevenue    = totalRevenue - totalGST;

    // Expense breakdown by category
    const expByCategory = {};
    filteredExp.forEach(e => {
      const cat = e.category || 'Other';
      expByCategory[cat] = (expByCategory[cat]||0) + Number(e.amount||0);
    });
    const totalExpenses = Object.values(expByCategory).reduce((a,b)=>a+b,0);
    const grossProfit   = netRevenue - totalExpenses;
    const grossMargin   = netRevenue ? (grossProfit/netRevenue*100) : 0;

    const doc = _pdf();
    const B   = window.LAMPDF.BRAND;

    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      companyGST:  co.gstin,
      docTitle:    'PROFIT & LOSS',
      docNumber:   '',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#064E3B',
    });

    // Period label
    const period = fromDate && toDate
      ? `${fmt.date(fromDate)} to ${fmt.date(toDate)}`
      : 'All periods';
    doc.text(`Period: ${period}`, doc.margin.left, doc.y, { size:10, color: B.textLight });
    doc.space(16);

    // KPI row
    doc.kpiRow([
      { label:'Total Revenue',   value: fmt.currency(totalRevenue) },
      { label:'Net Revenue',     value: fmt.currency(netRevenue) },
      { label:'Total Expenses',  value: fmt.currency(totalExpenses) },
      { label:'Gross Profit',    value: fmt.currency(grossProfit) },
    ]);

    doc.space(8);
    doc.divider('INCOME');

    doc.table({
      headers:    ['#', 'Description', 'Amount', '% of Revenue'],
      colWidths:  [24, 380, 120, 90],
      alignments: ['left','left','right','right'],
      rows: [
        [1, 'Gross Revenue (Invoices)', fmt.currency(totalRevenue), '100%'],
        [2, 'Less: GST Collected',      fmt.currency(totalGST),    fmt.pct(netRevenue?totalGST/totalRevenue*100:0)],
        ['', 'Net Revenue',             fmt.currency(netRevenue),  fmt.pct(netRevenue?100:0)],
      ],
    });

    doc.divider('EXPENSES');

    const expRows = Object.entries(expByCategory)
      .sort((a,b)=>b[1]-a[1])
      .map(([cat, amt], i) => [
        i+1,
        cat.charAt(0).toUpperCase() + cat.slice(1),
        fmt.currency(amt),
        netRevenue ? fmt.pct(amt/netRevenue*100) : '—',
      ]);
    expRows.push(['','Total Expenses', fmt.currency(totalExpenses), netRevenue ? fmt.pct(totalExpenses/netRevenue*100) : '—']);

    doc.table({
      headers:    ['#', 'Category', 'Amount', '% of Revenue'],
      colWidths:  [24, 380, 120, 90],
      alignments: ['left','left','right','right'],
      rows:       expRows,
    });

    doc.divider('SUMMARY');
    doc.totals([
      ['Gross Revenue',  fmt.currency(totalRevenue)],
      ['Less: Expenses', fmt.currency(totalExpenses)],
      ['Gross Margin',   fmt.pct(grossMargin)],
    ], fmt.currency(grossProfit));

    doc.notes('This is a computer-generated P&L statement. Figures are based on recorded invoices and expenses in the LAM system. Consult your CA for audited financials.');
    doc.download(`PnL_${period.replace(/\s+/g,'_')}.pdf`);

    // Also generate Excel
    if (window.LAMEXCEL) {
      const wb = new window.LAMEXCEL.Workbook();
      const sh = wb.addSheet('P&L');
      sh.title('Profit & Loss Statement', 4)
        .subtitle(`${co.name||'Company'} • ${period}`)
        .headers(['Category','Sub-category','Amount (₹)','% of Revenue'])
        .widths([20,30,18,14]);
      sh.row(['INCOME','Gross Revenue', totalRevenue, 100]);
      sh.row(['','Less GST', -totalGST, -(netRevenue?totalGST/totalRevenue*100:0)]);
      sh.row(['','Net Revenue', netRevenue, 100]);
      sh.space();
      sh.row(['EXPENSES','','','']);
      Object.entries(expByCategory).sort((a,b)=>b[1]-a[1]).forEach(([cat,amt])=>{
        sh.row(['',cat, amt, netRevenue?Math.round(amt/netRevenue*1000)/10:0]);
      });
      sh.space();
      sh.total('NET PROFIT', [grossProfit, netRevenue?Math.round(grossMargin*10)/10:0]);
      wb.download(`PnL_${new Date().toISOString().slice(0,7)}.xlsx`);
    }
  }

  // ── 2. GST Summary ───────────────────────────────────────
  async function gstSummary(data, opts = {}) {
    const { invoices=[], expenses=[], fromDate, toDate } = data;
    const co = _company();

    const filterDate = items => items.filter(i => {
      const d = i.date || i.invoiceDate || i.createdAt || '';
      return (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    });

    const filtInv = filterDate(invoices);
    const filtExp = filterDate(expenses);

    // Output tax (collected on sales)
    const byRate = {};
    filtInv.forEach(inv => {
      (inv.items||[]).forEach(item => {
        const rate = Number(item.gstRate||0);
        if (!byRate[rate]) byRate[rate] = { taxable:0, cgst:0, sgst:0, igst:0 };
        const taxable = Number(item.qty||1)*Number(item.unitPrice||0)*(1-(Number(item.discount||0)/100));
        const tax = taxable * rate/100;
        byRate[rate].taxable += taxable;
        byRate[rate].cgst += tax/2;
        byRate[rate].sgst += tax/2;
      });
    });

    const totalOutput = Object.values(byRate).reduce((s,r)=>s+r.cgst+r.sgst+r.igst,0);

    // Input tax (paid on purchases)
    const inputTax = filtExp.filter(e=>Number(e.gstAmount||0)>0)
      .reduce((s,e)=>s+Number(e.gstAmount||0),0);

    const netGST = totalOutput - inputTax;

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      companyGST:  co.gstin,
      docTitle:    'GST SUMMARY',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#1E3A5F',
    });

    const period = fromDate && toDate ? `${fmt.date(fromDate)} to ${fmt.date(toDate)}` : 'All periods';
    doc.text(`Period: ${period}`, doc.margin.left, doc.y, { size:10 }); doc.space(16);

    doc.kpiRow([
      { label:'Output Tax (Collected)', value: fmt.currency(totalOutput) },
      { label:'Input Tax Credit',       value: fmt.currency(inputTax) },
      { label:'Net GST Payable',        value: fmt.currency(netGST) },
      { label:'Transactions',           value: String(filtInv.length) },
    ]);

    doc.space(8);
    doc.divider('OUTPUT TAX — GSTR-1');

    const rateRows = Object.entries(byRate).sort((a,b)=>Number(a[0])-Number(b[0])).map(([rate,r])=>[
      `${rate}%`, fmt.currency(r.taxable), fmt.currency(r.cgst), fmt.currency(r.sgst), fmt.currency(r.cgst+r.sgst),
    ]);
    rateRows.push(['TOTAL',
      fmt.currency(Object.values(byRate).reduce((s,r)=>s+r.taxable,0)),
      fmt.currency(Object.values(byRate).reduce((s,r)=>s+r.cgst,0)),
      fmt.currency(Object.values(byRate).reduce((s,r)=>s+r.sgst,0)),
      fmt.currency(totalOutput),
    ]);

    doc.table({
      headers:    ['GST Rate','Taxable Value','CGST','SGST','Total Tax'],
      colWidths:  [60, 160, 130, 130, 134],
      alignments: ['left','right','right','right','right'],
      rows:       rateRows,
    });

    doc.divider('INPUT TAX CREDIT — GSTR-2B');
    doc.table({
      headers:    ['Vendor','Category','Taxable','GST Paid'],
      colWidths:  [200, 130, 130, 154],
      alignments: ['left','left','right','right'],
      rows: filtExp.filter(e=>Number(e.gstAmount||0)>0).slice(0,20).map(e=>[
        e.vendorName||'—', e.category||'—',
        fmt.currency(Number(e.amount||0)-Number(e.gstAmount||0)),
        fmt.currency(e.gstAmount),
      ]),
    });

    doc.totals([
      ['Total Output Tax',   fmt.currency(totalOutput)],
      ['Total Input Credit', fmt.currency(inputTax)],
    ], fmt.currency(netGST));

    doc.notes(`GSTIN: ${co.gstin||'—'}. This summary is for reference only. File GSTR-1, GSTR-2B and GSTR-3B on the GST portal.`);
    doc.download(`GST_Summary_${period.replace(/\s+/g,'_')}.pdf`);
  }

  // ── 3. Invoice Aging Report ──────────────────────────────
  async function invoiceAging(data) {
    const { invoices=[], customers=[] } = data;
    const co = _company();
    const today = new Date();

    const outstanding = invoices.filter(i => i.paymentStatus !== 'paid' && i.totalAmount);

    const buckets = {
      'Current (0-30d)':  { invoices:[], total:0 },
      '31-60 days':       { invoices:[], total:0 },
      '61-90 days':       { invoices:[], total:0 },
      '91-180 days':      { invoices:[], total:0 },
      'Over 180 days':    { invoices:[], total:0 },
    };

    outstanding.forEach(inv => {
      const due  = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.invoiceDate||inv.createdAt);
      const days = Math.floor((today - due) / 86400000);
      const cust = customers.find(c=>c.id===inv.customerId);
      const row  = { ...inv, daysOverdue: days, customerName: cust?.name || inv.customerName || inv.customerId };

      if (days <= 30)       buckets['Current (0-30d)'].invoices.push(row);
      else if (days <= 60)  buckets['31-60 days'].invoices.push(row);
      else if (days <= 90)  buckets['61-90 days'].invoices.push(row);
      else if (days <= 180) buckets['91-180 days'].invoices.push(row);
      else                  buckets['Over 180 days'].invoices.push(row);
    });
    Object.values(buckets).forEach(b => { b.total = b.invoices.reduce((s,i)=>s+Number(i.totalAmount||0),0); });

    const totalOut = outstanding.reduce((s,i)=>s+Number(i.totalAmount||0),0);

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      docTitle:    'INVOICE AGING',
      docDate:     today.toLocaleDateString('en-IN'),
      color:       '#7C2D12',
    });
    doc.space(8);

    doc.kpiRow([
      { label:'Total Outstanding', value: fmt.currency(totalOut) },
      { label:'Invoices',          value: String(outstanding.length) },
      { label:'Oldest (days)',      value: String(Math.max(0,...outstanding.map(i=>Math.floor((today-new Date(i.dueDate||i.invoiceDate||i.createdAt))/86400000)))) },
      { label:'Customers',          value: String(new Set(outstanding.map(i=>i.customerId)).size) },
    ]);
    doc.space(8);

    for (const [bucket, { invoices: rows, total }] of Object.entries(buckets)) {
      if (!rows.length) continue;
      const color = bucket.includes('Over') ? '#FF453A' : bucket.includes('91') ? '#FF9F0A' : bucket.includes('61') ? '#FFD60A' : '#0A84FF';
      doc.divider(`${bucket} — ${fmt.currency(total)}`);
      doc.table({
        headers:    ['Invoice #','Customer','Invoice Date','Due Date','Days','Amount','Status'],
        colWidths:  [80, 160, 70, 70, 40, 100, 94],
        alignments: ['left','left','left','left','right','right','left'],
        rows: rows.slice(0,15).map(i=>[
          i.invoiceNumber||i.id?.slice(0,8)||'—',
          i.customerName||'—',
          fmt.dateShort(i.invoiceDate||i.createdAt),
          fmt.dateShort(i.dueDate),
          String(Math.max(0,i.daysOverdue)),
          fmt.currency(i.totalAmount),
          i.paymentStatus?.toUpperCase()||'UNPAID',
        ]),
      });
    }

    doc.totals([
      ['Total Outstanding Receivables', fmt.currency(totalOut)],
    ]);

    doc.notes('Send payment reminders for all overdue invoices. Follow up with customers in the 91-180 day bucket immediately.');
    doc.download(`Invoice_Aging_${today.toISOString().slice(0,10)}.pdf`);
  }

  // ── 4. Inventory Valuation ───────────────────────────────
  async function inventoryValuation(data) {
    const { inventory=[], products=[], warehouses=[] } = data;
    const co = _company();

    const valued = products.map(p => {
      const stock = inventory.filter(i=>i.productId===p.id);
      const qty   = stock.reduce((s,i)=>s+Number(i.quantity||i.qty||0),0);
      const cost  = Number(p.costPrice||p.price||0);
      const value = qty * cost;
      const wh    = stock.map(i=>warehouses.find(w=>w.id===i.warehouseId)?.name||i.warehouseId||'—').filter(Boolean).join(', ');
      return { ...p, qty, cost, value, warehouse: wh };
    }).filter(p=>p.qty>0);

    valued.sort((a,b)=>b.value-a.value);

    const totalQty   = valued.reduce((s,p)=>s+p.qty,0);
    const totalValue = valued.reduce((s,p)=>s+p.value,0);
    const lowStock   = valued.filter(p=>p.qty<=(p.reorderQty||p.reorderPoint||0));
    const deadStock  = valued.filter(p=>p.qty>0&&!p.lastSaleDate);

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      docTitle:    'INVENTORY VALUATION',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#1E3A5F',
    });
    doc.space(8);

    doc.kpiRow([
      { label:'Total SKUs',       value: String(valued.length) },
      { label:'Total Qty',        value: fmt.num(totalQty) },
      { label:'Inventory Value',  value: fmt.currency(totalValue) },
      { label:'Low Stock Items',  value: String(lowStock.length) },
    ]);
    doc.space(8);

    doc.divider('INVENTORY BY VALUE (Top items)');
    doc.table({
      headers:    ['SKU','Product Name','Category','Qty','Unit Cost','Stock Value','Status'],
      colWidths:  [60, 180, 80, 45, 90, 100, 59],
      alignments: ['left','left','left','right','right','right','left'],
      rows: valued.slice(0,40).map(p=>[
        p.sku||p.id?.slice(0,8)||'—',
        p.name||'—',
        p.category||'—',
        fmt.num(p.qty),
        fmt.currency(p.cost),
        fmt.currency(p.value),
        p.qty<=0?'OUT OF STOCK':p.qty<=(p.reorderQty||0)?'LOW STOCK':'OK',
      ]),
    });

    if (lowStock.length) {
      doc.divider('LOW STOCK ALERTS');
      doc.table({
        headers:    ['Product','Current Qty','Reorder At','Suggested Order'],
        colWidths:  [260, 110, 110, 134],
        alignments: ['left','right','right','right'],
        rows: lowStock.slice(0,20).map(p=>[
          p.name||'—', fmt.num(p.qty), fmt.num(p.reorderQty||0),
          fmt.num(Math.max(0,(p.reorderQty||10)*2-p.qty)),
        ]),
      });
    }

    doc.totals([
      ['Total Products in Stock', String(valued.length)],
      ['Total Inventory Qty',     fmt.num(totalQty)],
    ], fmt.currency(totalValue));

    doc.download(`Inventory_Valuation_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  // ── 5. Driver Performance Report ────────────────────────
  async function driverPerformance(data) {
    const { drivers=[], trips=[], expenses=[] } = data;
    const co = _company();

    const scored = drivers.map(d => {
      const dTrips    = trips.filter(t=>t.driverId===d.id);
      const delivered = dTrips.filter(t=>t.status==='delivered');
      const delayed   = dTrips.filter(t=>t.delayed);
      const totalKm   = dTrips.reduce((s,t)=>s+Number(t.distanceKm||0),0);
      const totalRev  = dTrips.reduce((s,t)=>s+Number(t.freightCost||0),0);
      const onTimeRate= dTrips.length ? Math.round((dTrips.length-delayed.length)/dTrips.length*100) : 100;
      const fuelExp   = expenses.filter(e=>e.driverId===d.id&&e.category==='fuel').reduce((s,e)=>s+Number(e.amount||0),0);
      const score     = Math.round(
        (onTimeRate*0.4) +
        (Math.min(delivered.length/Math.max(dTrips.length,1)*100,100)*0.3) +
        (Math.min(totalKm/1000*10,30)*0.3)
      );
      return { ...d, dTrips:dTrips.length, delivered:delivered.length, delayed:delayed.length, totalKm:Math.round(totalKm), totalRev, onTimeRate, fuelExp, score };
    });
    scored.sort((a,b)=>b.score-a.score);

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      docTitle:    'DRIVER PERFORMANCE',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#0F172A',
    });
    doc.space(8);

    doc.kpiRow([
      { label:'Total Drivers',     value: String(drivers.length) },
      { label:'Avg On-Time Rate',  value: fmt.pct(scored.reduce((s,d)=>s+d.onTimeRate,0)/Math.max(scored.length,1)) },
      { label:'Total KM',          value: fmt.num(scored.reduce((s,d)=>s+d.totalKm,0)) },
      { label:'Total Revenue',     value: fmt.currency(scored.reduce((s,d)=>s+d.totalRev,0)) },
    ]);
    doc.space(8);

    doc.table({
      headers:    ['Rank','Driver','Trips','Delivered','Delayed','On-Time%','KM','Revenue','Score'],
      colWidths:  [30, 140, 40, 55, 45, 55, 60, 95, 44],
      alignments: ['left','left','right','right','right','right','right','right','right'],
      rows: scored.map((d,i)=>[
        `#${i+1}`,
        d.name||'—',
        String(d.dTrips),
        String(d.delivered),
        String(d.delayed),
        `${d.onTimeRate}%`,
        fmt.num(d.totalKm),
        fmt.currency(d.totalRev),
        String(d.score),
      ]),
    });

    doc.notes('Score = On-Time Rate (40%) + Completion Rate (30%) + Mileage (30%). Scores above 80 are excellent.');
    doc.signatureBlock(['Prepared by','Fleet Manager','HR']);
    doc.download(`Driver_Performance_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  // ── 6. Vendor Scorecard ──────────────────────────────────
  async function vendorScorecard(data) {
    const { vendors=[], purchaseOrders=[], grns=[], expenses=[] } = data;
    const co = _company();

    const scored = vendors.map(v => {
      const vPOs  = purchaseOrders.filter(p=>p.vendorId===v.id);
      const vGRNs = grns.filter(g=>g.vendorId===v.id);
      const vExp  = expenses.filter(e=>e.vendorId===v.id);
      const totalPurchased = vPOs.reduce((s,p)=>s+Number(p.totalAmount||0),0);
      const onTime = vPOs.length ? Math.round(vPOs.filter(p=>p.deliveredOnTime).length/vPOs.length*100) : 0;
      const qualityScore = vGRNs.length ? Math.round(vGRNs.filter(g=>!g.hasDefects).length/vGRNs.length*100) : 100;
      const score = Math.round(onTime*0.4 + qualityScore*0.4 + Math.min(vPOs.length*5,20)*0.2);
      return { ...v, orders:vPOs.length, grns:vGRNs.length, totalPurchased, onTime, qualityScore, score };
    });
    scored.sort((a,b)=>b.score-a.score);

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      docTitle:    'VENDOR SCORECARD',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#312E81',
    });
    doc.space(8);

    doc.table({
      headers:    ['Rank','Vendor','POs','GRNs','On-Time%','Quality%','Total Purchased','Score'],
      colWidths:  [30, 160, 35, 35, 55, 55, 130, 44],
      alignments: ['left','left','right','right','right','right','right','right'],
      rows: scored.slice(0,30).map((v,i)=>[
        `#${i+1}`, v.name||'—', String(v.orders), String(v.grns),
        `${v.onTime}%`, `${v.qualityScore}%`,
        fmt.currency(v.totalPurchased), String(v.score),
      ]),
    });

    doc.notes('Score = On-Time Delivery (40%) + Quality (40%) + Volume (20%). Review vendors below 60.');
    doc.download(`Vendor_Scorecard_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  // ── 7. Trip Cost Report ──────────────────────────────────
  async function tripCostReport(data) {
    const { trips=[], fleet=[], drivers=[], expenses=[] } = data;
    const co = _company();

    const detailed = trips.map(t => {
      const v = fleet.find(f=>f.id===t.vehicleId);
      const d = drivers.find(d=>d.id===t.driverId);
      const fuel = expenses.filter(e=>e.tripId===t.id&&e.category==='fuel').reduce((s,e)=>s+Number(e.amount||0),0);
      const toll = expenses.filter(e=>e.tripId===t.id&&e.category==='toll').reduce((s,e)=>s+Number(e.amount||0),0);
      const other= expenses.filter(e=>e.tripId===t.id&&!['fuel','toll'].includes(e.category)).reduce((s,e)=>s+Number(e.amount||0),0);
      const totalCost = fuel+toll+other;
      const revenue   = Number(t.freightCost||0);
      const profit    = revenue-totalCost;
      const margin    = revenue ? Math.round(profit/revenue*100) : 0;
      return { ...t, vehicle:v?.vehicleNumber||'—', driver:d?.name||'—', fuel, toll, other, totalCost, revenue, profit, margin };
    });

    detailed.sort((a,b)=>b.revenue-a.revenue);

    const doc = _pdf();
    doc.docHeader({
      companyName: co.name, companyAddr: co.address,
      docTitle:'TRIP COST REPORT', docDate:new Date().toLocaleDateString('en-IN'), color:'#1E3A5F',
    });
    doc.space(8);

    const totalRev  = detailed.reduce((s,t)=>s+t.revenue,0);
    const totalCost = detailed.reduce((s,t)=>s+t.totalCost,0);
    const totalProfit = totalRev-totalCost;

    doc.kpiRow([
      { label:'Total Trips',    value: String(trips.length) },
      { label:'Total Revenue',  value: fmt.currency(totalRev) },
      { label:'Total Costs',    value: fmt.currency(totalCost) },
      { label:'Net Profit',     value: fmt.currency(totalProfit) },
    ]);
    doc.space(8);

    doc.table({
      headers:    ['Trip #','Route','Vehicle','Driver','Km','Revenue','Fuel','Toll','Profit','Margin'],
      colWidths:  [54, 150, 60, 80, 34, 70, 60, 45, 70, 41],
      alignments: ['left','left','left','left','right','right','right','right','right','right'],
      rows: detailed.slice(0,30).map(t=>[
        t.tripNumber||t.id?.slice(0,8),
        `${t.origin||'—'}→${t.destination||'—'}`.slice(0,20),
        t.vehicle, t.driver,
        String(t.distanceKm||0),
        fmt.currency(t.revenue), fmt.currency(t.fuel), fmt.currency(t.toll),
        fmt.currency(t.profit), `${t.margin}%`,
      ]),
    });

    doc.totals([
      ['Total Revenue', fmt.currency(totalRev)],
      ['Total Costs',   fmt.currency(totalCost)],
    ], fmt.currency(totalProfit));

    doc.download(`Trip_Cost_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  // ── Public API ────────────────────────────────────────────
  return {
    profitAndLoss,
    gstSummary,
    invoiceAging,
    inventoryValuation,
    driverPerformance,
    vendorScorecard,
    tripCostReport,

    // Helper for quick one-liner calls from generateReport()
    generate: async (id, data) => {
      const map = {
        'pnl-report':         () => profitAndLoss(data),
        'gst-summary':        () => gstSummary(data),
        'invoice-aging':      () => invoiceAging(data),
        'inventory-summary':  () => inventoryValuation(data),
        'driver-report':      () => driverPerformance(data),
        'vendor-performance': () => vendorScorecard(data),
        'trip-report':        () => tripCostReport(data),
      };
      const fn = map[id];
      if (fn) { await fn(); return true; }
      return false;
    },
  };

})();

window.LAMReports = LAMReports;
