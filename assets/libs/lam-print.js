// ============================================================
// LAM Print Engine v1 — Thermal POS receipts + all print stubs
// Generates proper 80mm thermal printer receipts as canvas.
// Replaces ALL window.print() calls across every module.
// Shift reports, session summaries, attendance sheets,
// payroll registers — all one-click branded prints.
// ============================================================

const LAMPrint = (() => {

  const THERMAL_WIDTH = 560; // 80mm at 180dpi ≈ 560px
  const FONT_MONO     = '"Courier New", Courier, monospace';
  const FONT_SANS     = 'Arial, Helvetica, sans-serif';

  // ── Company info helper ───────────────────────────────────
  function _co() {
    try {
      const raw = localStorage.getItem('lam_db_companies');
      if (!raw) return {};
      const companies = Object.values(JSON.parse(raw));
      return companies[0] || {};
    } catch { return {}; }
  }

  function _fmt(n) { return `Rs.${Number(n||0).toLocaleString('en-IN', {minimumFractionDigits:2})}`; }
  function _fmtShort(n) { return Number(n||0).toLocaleString('en-IN', {minimumFractionDigits:2}); }

  // ── Thermal canvas renderer ───────────────────────────────
  class ThermalCanvas {
    constructor() {
      this.canvas  = document.createElement('canvas');
      this.canvas.width  = THERMAL_WIDTH;
      this.canvas.height = 2000; // will be trimmed
      this.ctx     = this.canvas.getContext('2d');
      this.y       = 16;
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(0, 0, THERMAL_WIDTH, 2000);
    }

    _txt(text, opts = {}) {
      const ctx    = this.ctx;
      const size   = opts.size   || 14;
      const weight = opts.bold   ? 'bold ' : '';
      const mono   = opts.mono   || false;
      ctx.font      = `${weight}${size}px ${mono ? FONT_MONO : FONT_SANS}`;
      ctx.fillStyle = opts.color || '#000';
      ctx.textAlign = opts.align || 'left';
      const x = opts.align === 'right'  ? THERMAL_WIDTH - 16 :
                opts.align === 'center' ? THERMAL_WIDTH / 2   : 16;
      ctx.fillText(String(text ?? ''), x, this.y);
      this.y += (opts.lineH || Math.round(size * 1.4));
    }

    _line(style = 'solid') {
      const ctx = this.ctx;
      ctx.strokeStyle = '#000';
      ctx.lineWidth   = style === 'double' ? 2 : 1;
      if (style === 'dashed') ctx.setLineDash([6, 4]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(16, this.y);
      ctx.lineTo(THERMAL_WIDTH - 16, this.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.y += 10;
    }

    _row(left, right, opts = {}) {
      const ctx    = this.ctx;
      const size   = opts.size || 13;
      const weight = opts.bold ? 'bold ' : '';
      ctx.font      = `${weight}${size}px ${FONT_MONO}`;
      ctx.fillStyle = opts.color || '#000';
      ctx.textAlign = 'left';
      ctx.fillText(String(left ?? ''), 16, this.y);
      ctx.textAlign = 'right';
      ctx.fillText(String(right ?? ''), THERMAL_WIDTH - 16, this.y);
      ctx.textAlign = 'left';
      this.y += Math.round(size * 1.4);
    }

    _space(h = 8) { this.y += h; }

    finalize() {
      const trimmed = document.createElement('canvas');
      trimmed.width  = THERMAL_WIDTH;
      trimmed.height = this.y + 24;
      trimmed.getContext('2d').drawImage(this.canvas, 0, 0);
      return trimmed;
    }

    // Download / print
    download(filename = 'receipt.png') {
      const final = this.finalize();
      final.toBlob(blob => {
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    }

    print() {
      const final = this.finalize();
      const url   = final.toDataURL('image/png');
      const win   = window.open('', '_blank', 'width=620,height=900');
      if (!win) { this.download('receipt.png'); return; }
      win.document.write(`
        <!DOCTYPE html><html><head>
        <title>Print</title>
        <style>
          * { margin:0; padding:0; }
          body { background:#fff; display:flex; justify-content:center; padding:16px; }
          img  { max-width:${THERMAL_WIDTH}px; }
          @media print {
            body { padding:0; }
            button { display:none; }
          }
        </style>
        </head><body>
        <div>
          <button onclick="window.print();setTimeout(()=>window.close(),500);"
            style="margin-bottom:12px;padding:8px 20px;background:#0A84FF;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">
            🖨️ Print Receipt
          </button><br>
          <img src="${url}" alt="Receipt">
        </div>
        </body></html>
      `);
      win.document.close();
    }
  }

  // ── 1. POS Receipt ────────────────────────────────────────
  function posReceipt(sale, opts = {}) {
    const co   = opts.company || _co();
    const tc   = new ThermalCanvas();
    const now  = new Date();

    // Header
    tc._txt(co.name || 'LAM POS', { size:18, bold:true, align:'center' });
    if (co.address) tc._txt(co.address.split(',')[0], { size:11, align:'center', color:'#444' });
    if (co.gstin)   tc._txt(`GSTIN: ${co.gstin}`, { size:11, align:'center', color:'#444' });
    if (co.phone)   tc._txt(`Ph: ${co.phone}`, { size:11, align:'center', color:'#444' });
    tc._line('double');

    // Sale info
    tc._row('Receipt #', sale.receiptNumber || sale.id?.slice(0,10) || '—');
    tc._row('Date', now.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }));
    tc._row('Time', now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }));
    if (sale.cashierName) tc._row('Cashier', sale.cashierName);
    if (sale.customer)    tc._row('Customer', sale.customer);
    tc._line();

    // Items
    tc._txt('ITEMS', { size:11, bold:true, color:'#555' });
    tc._space(4);
    (sale.items || []).forEach(item => {
      const name  = (item.name || item.productName || item.productId || '').slice(0, 22);
      const total = _fmtShort(Number(item.qty||1) * Number(item.unitPrice||item.price||0));
      tc._txt(`${item.qty||1} x ${item.unitPrice||item.price||0}`, { size:12, color:'#444' });
      tc._row(name, total, { size:13 });
    });

    tc._line();

    // Totals
    const subtotal = Number(sale.subtotal || sale.totalAmount || 0);
    const gstAmt   = Number(sale.gstAmount || sale.taxAmount || 0);
    const discount = Number(sale.discount || sale.discountAmount || 0);
    const total    = Number(sale.totalAmount || sale.grandTotal || subtotal + gstAmt - discount);
    const paid     = Number(sale.amountPaid || sale.cashReceived || total);
    const change   = paid - total;

    if (discount > 0) tc._row('Discount', `-${_fmtShort(discount)}`, { color:'#006600' });
    if (gstAmt > 0) {
      tc._row('CGST', _fmtShort(gstAmt/2));
      tc._row('SGST', _fmtShort(gstAmt/2));
    }
    tc._line('dashed');
    tc._row('TOTAL', _fmt(total), { bold:true, size:16 });
    tc._space(4);
    tc._row(`${sale.paymentMethod || 'CASH'} Paid`, _fmt(paid));
    if (change >= 0) tc._row('Change', _fmt(change));

    tc._line('double');
    tc._space(4);

    // GST details
    if (co.gstin && gstAmt > 0) {
      tc._txt(`Tax Invoice (${co.gstin})`, { size:10, align:'center', color:'#666' });
      tc._space(4);
    }

    // Footer
    tc._txt('*** Thank You ***', { size:13, bold:true, align:'center' });
    tc._txt('Visit Again!', { size:11, align:'center', color:'#555' });
    tc._space(8);
    tc._txt('Powered by LAM', { size:10, align:'center', color:'#aaa' });
    tc._space(16);

    tc.print();
    return tc;
  }

  // ── 2. POS Session / Shift Report ────────────────────────
  function sessionReport(session, sales, opts = {}) {
    const co  = opts.company || _co();
    const tc  = new ThermalCanvas();

    tc._txt(co.name || 'LAM POS', { size:16, bold:true, align:'center' });
    tc._txt('SHIFT REPORT', { size:14, bold:true, align:'center' });
    tc._line('double');

    const openedAt  = session.openedAt  ? new Date(session.openedAt).toLocaleString('en-IN')  : '—';
    const closedAt  = session.closedAt  ? new Date(session.closedAt).toLocaleString('en-IN')  : 'Open';
    tc._row('Session #', session.id?.slice(0,8) || '—');
    tc._row('Cashier',   session.cashierName || '—');
    tc._row('Opened',    openedAt);
    tc._row('Closed',    closedAt);
    tc._line();

    const totalSales    = sales.reduce((s,x)=>s+Number(x.totalAmount||0),0);
    const cashSales     = sales.filter(s=>s.paymentMethod==='cash').reduce((s,x)=>s+Number(x.totalAmount||0),0);
    const upiSales      = sales.filter(s=>['upi','qr'].includes(s.paymentMethod)).reduce((s,x)=>s+Number(x.totalAmount||0),0);
    const cardSales     = sales.filter(s=>s.paymentMethod==='card').reduce((s,x)=>s+Number(x.totalAmount||0),0);
    const totalVoids    = sales.filter(s=>s.voided).length;
    const totalGST      = sales.reduce((s,x)=>s+Number(x.gstAmount||0),0);
    const totalDiscount = sales.reduce((s,x)=>s+Number(x.discountAmount||0),0);

    tc._txt('SALES SUMMARY', { size:11, bold:true, color:'#555' });
    tc._space(4);
    tc._row('Total Transactions', String(sales.length));
    tc._row('Total Revenue',      _fmt(totalSales));
    tc._row('GST Collected',      _fmt(totalGST));
    tc._row('Discounts Given',    _fmt(totalDiscount));
    tc._row('Voided Bills',       String(totalVoids));
    tc._line();

    tc._txt('PAYMENT BREAKDOWN', { size:11, bold:true, color:'#555' });
    tc._space(4);
    tc._row('Cash',    _fmt(cashSales));
    tc._row('UPI/QR',  _fmt(upiSales));
    tc._row('Card',    _fmt(cardSales));
    tc._line();

    tc._row('Opening Float', _fmt(session.openingCash || 0));
    tc._row('Cash Sales',    _fmt(cashSales));
    tc._row('Expected Cash', _fmt((session.openingCash||0)+cashSales));
    tc._row('Actual Cash',   _fmt(session.closingCash || (session.openingCash||0)+cashSales));
    const diff = Number(session.closingCash||(session.openingCash||0)+cashSales) - ((session.openingCash||0)+cashSales);
    if (diff !== 0) tc._row('Difference', _fmt(diff), { color: diff > 0 ? '#006600' : '#cc0000' });

    tc._line('double');
    tc._txt(_fmt(totalSales), { size:20, bold:true, align:'center' });
    tc._txt('TOTAL SALES', { size:11, align:'center', color:'#555' });
    tc._space(8);
    tc._txt(new Date().toLocaleString('en-IN'), { size:10, align:'center', color:'#aaa' });
    tc._space(16);

    tc.print();
    return tc;
  }

  // ── 3. Attendance Sheet ───────────────────────────────────
  function attendanceSheet(attendance, employees, opts = {}) {
    const co    = opts.company || _co();
    const month = opts.month || new Date().toISOString().slice(0,7);
    const [year, mon] = month.split('-');
    const monthLabel = new Date(+year, +mon-1, 1).toLocaleDateString('en-IN', { month:'long', year:'numeric' });

    // Use LAMPDF for multi-page attendance sheet
    if (!window.LAMPDF) return;
    const doc = new window.LAMPDF.LAMPdfDoc();

    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      docTitle:    'ATTENDANCE SHEET',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#0F172A',
    });

    doc.text(`Month: ${monthLabel}`, doc.margin.left, doc.y, { size:10, color:'#64748B' });
    doc.space(16);

    const daysInMonth = new Date(+year, +mon, 0).getDate();
    const headers     = ['Employee', ...Array.from({length:daysInMonth},(_,i)=>String(i+1)), 'P', 'A', 'L', '%'];
    const colWidths   = [120, ...Array.from({length:daysInMonth},()=>12), 20,20,20,30];

    const rows = employees.map(emp => {
      const empAtt = attendance.filter(a=>a.employeeId===emp.id&&(a.date||'').startsWith(month));
      const byDay  = {};
      empAtt.forEach(a => { byDay[a.date?.slice(8,10)] = a.status; });
      const days = Array.from({length:daysInMonth},(_,i)=>{
        const d = String(i+1).padStart(2,'0');
        const s = byDay[d];
        return s==='present'?'P':s==='absent'?'A':s==='half'?'H':s==='leave'?'L':'—';
      });
      const P = days.filter(d=>d==='P').length;
      const A = days.filter(d=>d==='A').length;
      const L = days.filter(d=>d==='L').length;
      const pct = daysInMonth ? Math.round(P/daysInMonth*100) : 0;
      return [emp.name?.slice(0,14)||'—', ...days, P, A, L, `${pct}%`];
    });

    doc.table({ headers, colWidths, rows });
    doc.download(`Attendance_${monthLabel.replace(' ','_')}.pdf`);
  }

  // ── 4. Payroll Register ───────────────────────────────────
  function payrollRegister(payroll, employees, opts = {}) {
    const co    = opts.company || _co();
    const month = opts.month || payroll[0]?.month || new Date().toISOString().slice(0,7);
    const [year, mon] = month.split('-');
    const monthLabel = new Date(+year,+mon-1,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});

    if (!window.LAMPDF) return;
    const doc = new window.LAMPDF.LAMPdfDoc();

    doc.docHeader({
      companyName: co.name || 'Company',
      companyAddr: co.address,
      companyGST:  co.gstin,
      docTitle:    'PAYROLL REGISTER',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#064E3B',
    });

    doc.text(`Period: ${monthLabel}`, doc.margin.left, doc.y, { size:10, color:'#64748B' });
    doc.space(8);

    const totalGross   = payroll.reduce((s,r)=>s+Number(r.grossSalary||0),0);
    const totalNet     = payroll.reduce((s,r)=>s+Number(r.netPay||0),0);
    const totalPF      = payroll.reduce((s,r)=>s+Number(r.pfEmployee||0),0);
    const totalTDS     = payroll.reduce((s,r)=>s+Number(r.tds||0),0);

    doc.kpiRow([
      { label:'Employees',    value:String(payroll.length) },
      { label:'Gross Payout', value:`₹${totalGross.toLocaleString('en-IN')}` },
      { label:'Net Payout',   value:`₹${totalNet.toLocaleString('en-IN')}` },
      { label:'Total TDS',    value:`₹${totalTDS.toLocaleString('en-IN')}` },
    ]);
    doc.space(8);

    const rows = payroll.map((r,i)=>{
      const emp = employees.find(e=>e.id===r.employeeId);
      return [
        i+1,
        emp?.name||r.employeeId||'—',
        emp?.department||'—',
        emp?.employeeId||emp?.id?.slice(0,6)||'—',
        `₹${Number(r.basicSalary||r.basic||0).toLocaleString('en-IN')}`,
        `₹${Number(r.hra||0).toLocaleString('en-IN')}`,
        `₹${Number(r.grossSalary||0).toLocaleString('en-IN')}`,
        `₹${Number(r.pfEmployee||0).toLocaleString('en-IN')}`,
        `₹${Number(r.tds||0).toLocaleString('en-IN')}`,
        `₹${Number(r.netPay||0).toLocaleString('en-IN')}`,
        emp?.bankAccount?.slice(-4)||'—',
      ];
    });

    doc.table({
      headers:    ['#','Employee','Dept','EmpID','Basic','HRA','Gross','PF','TDS','Net Pay','A/C'],
      colWidths:  [20,120,60,50,70,60,70,60,60,70,50],
      alignments: ['left','left','left','left','right','right','right','right','right','right','left'],
      rows,
    });

    doc.totals([
      ['Total Gross', `₹${totalGross.toLocaleString('en-IN')}`],
      ['Total PF',    `₹${totalPF.toLocaleString('en-IN')}`],
      ['Total TDS',   `₹${totalTDS.toLocaleString('en-IN')}`],
    ], `₹${totalNet.toLocaleString('en-IN')}`);

    doc.notes('This register is confidential. Distribute only to authorized personnel. Signed copies required for audit.');
    doc.signatureBlock(['Prepared by HR', 'Verified by Finance', 'Approved by MD']);
    doc.download(`Payroll_${monthLabel.replace(' ','_')}.pdf`);
  }

  // ── 5. Consolidated Report (multi-company) ────────────────
  function consolidatedReport(companies, data, opts = {}) {
    if (!window.LAMPDF) return;
    const doc = new window.LAMPDF.LAMPdfDoc();

    doc.docHeader({
      companyName: opts.groupName || 'Group Consolidated',
      docTitle:    'CONSOLIDATED P&L',
      docDate:     new Date().toLocaleDateString('en-IN'),
      color:       '#312E81',
    });
    doc.space(8);

    const rows = companies.map(co => {
      const d    = data[co.id] || {};
      const rev  = Number(d.revenue  || 0);
      const exp  = Number(d.expenses || 0);
      const prof = rev - exp;
      return [
        co.name || '—',
        `₹${rev.toLocaleString('en-IN')}`,
        `₹${exp.toLocaleString('en-IN')}`,
        `₹${prof.toLocaleString('en-IN')}`,
        rev ? `${Math.round(prof/rev*100)}%` : '—',
      ];
    });

    const totalRev  = companies.reduce((s,co)=>s+Number(data[co.id]?.revenue||0),0);
    const totalExp  = companies.reduce((s,co)=>s+Number(data[co.id]?.expenses||0),0);
    const totalProf = totalRev - totalExp;

    doc.table({
      headers:    ['Entity', 'Revenue', 'Expenses', 'Net Profit', 'Margin'],
      colWidths:  [200, 130, 130, 130, 70],
      alignments: ['left','right','right','right','right'],
      rows: [...rows, [
        'TOTAL GROUP',
        `₹${totalRev.toLocaleString('en-IN')}`,
        `₹${totalExp.toLocaleString('en-IN')}`,
        `₹${totalProf.toLocaleString('en-IN')}`,
        totalRev?`${Math.round(totalProf/totalRev*100)}%`:'—',
      ]],
    });

    doc.download(`Consolidated_PnL_${new Date().toISOString().slice(0,7)}.pdf`);
  }

  // ── Public API ────────────────────────────────────────────
  return {
    posReceipt,
    sessionReport,
    attendanceSheet,
    payrollRegister,
    consolidatedReport,
    ThermalCanvas,
  };

})();

window.LAMPrint = LAMPrint;
