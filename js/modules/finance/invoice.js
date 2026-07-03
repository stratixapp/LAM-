// ============================================================
// LAM — Finance & Billing Module (Phase 5)
// Auto-invoice from orders, GST, payments, aging, P&L
// Interconnects: Orders → Invoice → Payment → GST → P&L
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { TMS_COLLECTIONS } from '../transport/fleet.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, formatDateTime, escHtml, setLoading,
  searchFilter, debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

// ── Finance Collections ───────────────────────────────────────
export const FIN_COLLECTIONS = {
  INVOICES:  'fin_invoices',
  PAYMENTS:  'fin_payments',
  EXPENSES:  'fin_expenses',
  BUDGETS:   'fin_budgets',
};

let _invoices = [], _payments = [], _expenses = [];
let _filtInv  = [], _filtPay  = [], _filtExp  = [];
let _pageInv  = 1, _pagePay = 1, _pageExp = 1;
let _customers = [], _orders = [], _trips = [];
const PER = 15;
let _unsubInv = null, _unsubPay = null, _unsubExp = null;

// ── Active sub-tab ────────────────────────────────────────────
let _activeTab = 'invoices';

export async function renderFinance(container) {
  [_customers, _orders, _trips] = await Promise.all([
    dbGetAll(COLLECTIONS.CUSTOMERS, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll('sales_orders',        AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(TMS_COLLECTIONS.TRIPS, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '💰 Finance & Billing',
    subtitle: 'Invoices, payments, GST, expenses and profit & loss — all interconnected.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportFinanceData()">⬇ Export</button>
      <button class="btn btn-primary" id="fin-primary-btn" onclick="openFinanceAction()">+ Create Invoice</button>
    `,
    content: `
      <!-- Finance KPIs -->
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="fin-kpis"></div>

      <!-- Sub-navigation tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);width:fit-content;">
        ${[
          ['invoices',  '🧾 Invoices'],
          ['payments',  '💳 Payments'],
          ['expenses',  '💸 Expenses'],
          ['aging',     '📅 Aging Report'],
          ['pnl',       '📊 P&L'],
          ['gst',       '🏛 GST Summary'],
        ].map(([id, label]) => `
          <button class="fin-tab ${id==='invoices'?'active':''}" id="fin-tab-${id}"
                  onclick="switchFinTab('${id}')" style="
                    padding:8px 16px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                    color:var(--text-muted);background:transparent;border:none;cursor:pointer;
                    transition:all 0.15s;white-space:nowrap;
                  ">${label}</button>
        `).join('')}
      </div>

      <!-- Tab content area -->
      <div id="fin-tab-content"></div>
    `,
  });

  // Modal injection
  document.body.insertAdjacentHTML('beforeend', invoiceModal());
  document.body.insertAdjacentHTML('beforeend', paymentModal());
  document.body.insertAdjacentHTML('beforeend', expenseModal());
  setupModalClose(); setupMenuClose();

  // Tab style inject
  const style = document.createElement('style');
  style.textContent = `.fin-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}`;
  document.head.appendChild(style);

  registerFinGlobals();
  subscribeFinance();
  switchFinTab('invoices');
}

// ── Subscribe to all finance collections ─────────────────────
function subscribeFinance() {
  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];

  if (_unsubInv) _unsubInv();
  if (_unsubPay) _unsubPay();
  if (_unsubExp) _unsubExp();

  _unsubInv = dbListen(FIN_COLLECTIONS.INVOICES,  c, data => { _invoices = data; _filtInv = [...data]; renderFinKPIs(); if (_activeTab === 'invoices') renderInvoiceTable(); });
  _unsubPay = dbListen(FIN_COLLECTIONS.PAYMENTS,  c, data => { _payments = data; _filtPay = [...data]; if (_activeTab === 'payments') renderPaymentTable(); });
  _unsubExp = dbListen(FIN_COLLECTIONS.EXPENSES,  c, data => { _expenses = data; _filtExp = [...data]; if (_activeTab === 'expenses') renderExpenseTable(); });
}

// ── KPIs ──────────────────────────────────────────────────────
function renderFinKPIs() {
  const el = document.getElementById('fin-kpis'); if (!el) return;
  el.innerHTML = '';

  const totalInvoiced = _invoices.reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
  const totalReceived = _payments.reduce((s,p)=>s+(Number(p.amount)||0),0);
  const outstanding   = totalInvoiced - totalReceived;
  const overdue       = _invoices.filter(i=>{
    if(i.paymentStatus==='paid') return false;
    if(!i.dueDate) return false;
    return new Date(i.dueDate) < new Date();
  }).length;
  const totalExpenses = _expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);

  [
    { label:'Total Invoiced',   value:formatCurrency(totalInvoiced,true), icon:'🧾', color:'kpi-blue'   },
    { label:'Amount Received',  value:formatCurrency(totalReceived,true),  icon:'✅', color:'kpi-green'  },
    { label:'Outstanding',      value:formatCurrency(outstanding,true),    icon:'⏳', color:'kpi-yellow' },
    { label:'Overdue Invoices', value:overdue,                             icon:'🚨', color:overdue>0?'kpi-red':'kpi-blue' },
    { label:'Total Expenses',   value:formatCurrency(totalExpenses,true),  icon:'💸', color:'kpi-orange' },
  ].forEach((k,i)=>{
    el.innerHTML+=`
      <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
        <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`;
  });
}

// ── Tab Switcher ──────────────────────────────────────────────
window.switchFinTab = (tab) => {
  _activeTab = tab;
  document.querySelectorAll('.fin-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`fin-tab-${tab}`)?.classList.add('active');

  const btn = document.getElementById('fin-primary-btn');
  const actions = {
    invoices: ['+ Create Invoice', 'openFinanceAction'],
    payments: ['+ Record Payment', 'openPaymentModal'],
    expenses: ['+ Log Expense',    'openExpenseModal'],
    aging:    null, pnl: null, gst: null,
  };
  if (btn) {
    const action = actions[tab];
    if (action) { btn.style.display=''; btn.textContent=action[0]; btn.onclick=()=>window[action[1]](); }
    else btn.style.display='none';
  }

  const content = document.getElementById('fin-tab-content');
  if (!content) return;

  switch(tab) {
    case 'invoices': renderInvoiceTab(content); break;
    case 'payments': renderPaymentTab(content); break;
    case 'expenses': renderExpenseTab(content); break;
    case 'aging':    renderAgingTab(content);   break;
    case 'pnl':      renderPnLTab(content);     break;
    case 'gst':      renderGSTTab(content);     break;
  }
};

// ── INVOICES TAB ──────────────────────────────────────────────
function renderInvoiceTab(container) {
  container.innerHTML = `
    ${searchBar({
      id:'inv',
      placeholder:'Search invoice number, customer…',
      filters:[
        {key:'paymentStatus',label:'All Status',options:[
          {value:'unpaid', label:'Unpaid'},{value:'partial',label:'Partial'},{value:'paid',label:'Paid'},{value:'overdue',label:'Overdue'}
        ]},
      ],
      onSearch:'invSearch', onFilter:'invFilter',
    })}
    <div id="inv-table-wrap"></div>
    <div id="inv-pagination"></div>
  `;
  renderInvoiceTable();
}

function renderInvoiceTable() {
  const wrap = document.getElementById('inv-table-wrap');
  const pg   = document.getElementById('inv-pagination');
  if (!wrap) return;
  const start    = (_pageInv-1)*PER;
  const pageData = _filtInv.slice(start, start+PER);
  const cnt = document.getElementById('inv-count');
  if(cnt) cnt.textContent = `${_filtInv.length} invoice${_filtInv.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id: 'inv-table',
    columns: [
      { key:'invoiceNumber', label:'Invoice #', render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.invoiceNumber||'—')}</span>` },
      { key:'customerId',    label:'Customer',  render:r=>`<span style="font-size:13px;">${escHtml(custName(r.customerId))}</span>` },
      { key:'orderId',       label:'Order Ref', render:r=>r.orderId?`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(orderNum(r.orderId))}</span>`:'—' },
      { key:'invoiceDate',   label:'Date',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.invoiceDate||'—'}</span>` },
      { key:'dueDate',       label:'Due Date',  render:r=>{
        if(!r.dueDate) return '—';
        const overdue = r.paymentStatus!=='paid' && new Date(r.dueDate)<new Date();
        return `<span style="font-size:11px;color:${overdue?'var(--brand-danger)':'var(--text-muted)'};">${r.dueDate}${overdue?' ⚠':''}`;
      }},
      { key:'subtotal',      label:'Subtotal',  render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.subtotal||0).toLocaleString('en-IN')}</span>` },
      { key:'gstAmount',     label:'GST',       render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">₹${Number(r.gstAmount||0).toLocaleString('en-IN')}</span>` },
      { key:'totalAmount',   label:'Total',     render:r=>`<span style="font-family:var(--font-mono);font-weight:700;">₹${Number(r.totalAmount||0).toLocaleString('en-IN')}</span>` },
      { key:'paymentStatus', label:'Status',    render:r=>badge(r.paymentStatus||'unpaid') },
      { key:'actions',       label:'', sortable:false, render:r=>actionsMenu(r.id,[
          {icon:'👁',  label:'View Invoice',       action:`viewInvoice('${r.id}')`},
          {icon:'💳', label:'Record Payment',     action:`openPaymentModal('${r.id}')`},
          ...(r.paymentStatus !== 'paid' ? [{icon:'🔗', label:'Request Payment (Razorpay)', action:`window.LAMCloud?.openRazorpayCheckout('${r.id}')`}] : []),
          {icon:'📄', label:'Generate PDF',       action:`generateInvoicePDF('${r.id}')`},
          {icon:'📱', label:'Send via WhatsApp',  action:`window.LAMSafety?.shareInvoiceWhatsApp('${r.id}')`},
          {icon:'✉️', label:'Send via Email',     action:`sendInvoiceEmail('${r.id}')`},
          {icon:'🗑',  label:'Delete',             action:`deleteInvoice('${r.id}')`,danger:true},
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No invoices yet',
  });
  pg.innerHTML = buildPagination({id:'inv',total:_filtInv.length,page:_pageInv,perPage:PER,onChange:'setInvPage'});
}

// ── PAYMENTS TAB ──────────────────────────────────────────────
function renderPaymentTab(container) {
  container.innerHTML = `
    ${searchBar({
      id:'pay', placeholder:'Search payment ref, customer…',
      filters:[{key:'mode',label:'All Modes',options:[
        {value:'cash',label:'Cash'},{value:'cheque',label:'Cheque'},
        {value:'neft',label:'NEFT'},{value:'upi',label:'UPI'},{value:'card',label:'Card'},
      ]}],
      onSearch:'paySearch', onFilter:'payFilter',
    })}
    <div id="pay-table-wrap"></div>
    <div id="pay-pagination"></div>
  `;
  renderPaymentTable();
}

function renderPaymentTable() {
  const wrap = document.getElementById('pay-table-wrap');
  const pg   = document.getElementById('pay-pagination');
  if (!wrap) return;
  const start    = (_pagePay-1)*PER;
  const pageData = _filtPay.slice(start, start+PER);
  const cnt = document.getElementById('pay-count');
  if(cnt) cnt.textContent = `${_filtPay.length} payment${_filtPay.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id:'pay-table',
    columns:[
      {key:'paymentRef',   label:'Ref #',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-secondary);">${escHtml(r.paymentRef||'—')}</span>`},
      {key:'customerId',   label:'Customer',   render:r=>`<span style="font-size:13px;">${escHtml(custName(r.customerId))}</span>`},
      {key:'invoiceId',    label:'Invoice',    render:r=>{
        const inv=_invoices.find(i=>i.id===r.invoiceId);
        return inv?`<span style="font-family:var(--font-mono);font-size:11px;color:var(--brand-primary);">${escHtml(inv.invoiceNumber)}</span>`:'—';
      }},
      {key:'amount',       label:'Amount',     render:r=>`<span style="font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${Number(r.amount||0).toLocaleString('en-IN')}</span>`},
      {key:'mode',         label:'Mode',       render:r=>`<span class="badge badge-blue">${escHtml(r.mode||'—').toUpperCase()}</span>`},
      {key:'date',         label:'Date',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
      {key:'reference',    label:'Bank Ref',   render:r=>`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.reference||'—')}</span>`},
      {key:'actions',      label:'',sortable:false, render:r=>actionsMenu(r.id,[
          {icon:'🗑',label:'Delete',action:`deletePayment('${r.id}')`,danger:true},
        ]),
      },
    ],
    rows:pageData, emptyMsg:'No payments recorded yet',
  });
  pg.innerHTML = buildPagination({id:'pay',total:_filtPay.length,page:_pagePay,perPage:PER,onChange:'setPayPage'});
}

// ── EXPENSES TAB ──────────────────────────────────────────────
function renderExpenseTab(container) {
  container.innerHTML = `
    ${searchBar({
      id:'exp', placeholder:'Search expense, category…',
      filters:[{key:'category',label:'All Categories',options:[
        {value:'fuel',label:'Fuel'},{value:'maintenance',label:'Maintenance'},
        {value:'salary',label:'Salary'},{value:'rent',label:'Rent'},
        {value:'utilities',label:'Utilities'},{value:'office',label:'Office'},
        {value:'travel',label:'Travel'},{value:'other',label:'Other'},
      ]}],
      onSearch:'expSearch', onFilter:'expFilter',
    })}
    <div id="exp-table-wrap"></div>
    <div id="exp-pagination"></div>
  `;
  renderExpenseTable();
}

function renderExpenseTable() {
  const wrap = document.getElementById('exp-table-wrap');
  const pg   = document.getElementById('exp-pagination');
  if (!wrap) return;
  const start    = (_pageExp-1)*PER;
  const pageData = _filtExp.slice(start, start+PER);
  const cnt = document.getElementById('exp-count');
  if(cnt) cnt.textContent = `${_filtExp.length} expense${_filtExp.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id:'exp-table',
    columns:[
      {key:'title',    label:'Expense',  render:r=>`<span style="font-size:13px;font-weight:500;">${escHtml(r.title||'—')}</span>`},
      {key:'category', label:'Category', render:r=>`<span class="badge badge-gray">${escHtml(r.category||'other')}</span>`},
      {key:'amount',   label:'Amount',   render:r=>`<span style="font-family:var(--font-mono);font-weight:600;color:var(--brand-danger);">₹${Number(r.amount||0).toLocaleString('en-IN')}</span>`},
      {key:'gst',      label:'GST',      render:r=>r.gstAmount?`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">₹${Number(r.gstAmount||0).toLocaleString('en-IN')}</span>`:'—'},
      {key:'vendor',   label:'Paid To',  render:r=>`<span style="font-size:12px;color:var(--text-secondary);">${escHtml(r.vendorName||'—')}</span>`},
      {key:'date',     label:'Date',     render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
      {key:'billNo',   label:'Bill #',   render:r=>`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.billNo||'—')}</span>`},
      {key:'actions',  label:'',sortable:false, render:r=>actionsMenu(r.id,[
          {icon:'✏️',label:'Edit',  action:`editExpense('${r.id}')`},
          {icon:'🗑', label:'Delete',action:`deleteExpense('${r.id}')`,danger:true},
        ]),
      },
    ],
    rows:pageData, emptyMsg:'No expenses logged yet',
  });
  pg.innerHTML = buildPagination({id:'exp',total:_filtExp.length,page:_pageExp,perPage:PER,onChange:'setExpPage'});
}

// ── AGING REPORT ──────────────────────────────────────────────
function renderAgingTab(container) {
  const now = Date.now();
  const buckets = { current:[], '1-30':[], '31-60':[], '61-90':[], '90+':[] };

  _invoices.filter(i => i.paymentStatus !== 'paid').forEach(inv => {
    if (!inv.dueDate) { buckets.current.push(inv); return; }
    const days = Math.ceil((now - new Date(inv.dueDate)) / 86400000);
    if (days <= 0)        buckets.current.push(inv);
    else if (days <= 30)  buckets['1-30'].push(inv);
    else if (days <= 60)  buckets['31-60'].push(inv);
    else if (days <= 90)  buckets['61-90'].push(inv);
    else                  buckets['90+'].push(inv);
  });

  const total = (arr) => arr.reduce((s,i)=>s+(Number(i.totalAmount)||0),0);

  container.innerHTML = `
    <div class="grid-5" style="margin-bottom:var(--space-5);">
      ${Object.entries(buckets).map(([label, items]) => `
        <div class="card" style="border-top:3px solid ${label==='current'?'var(--brand-secondary)':label==='1-30'?'var(--brand-warning)':label==='31-60'?'var(--brand-accent)':'var(--brand-danger)'};">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${label === 'current' ? 'Current' : label + ' days'}</div>
          <div style="font-family:var(--font-display);font-size:20px;font-weight:700;margin-bottom:4px;">₹${total(items).toLocaleString('en-IN')}</div>
          <div style="font-size:11px;color:var(--text-muted);">${items.length} invoice${items.length!==1?'s':''}</div>
        </div>
      `).join('')}
    </div>

    <div class="table-container">
      <table class="table">
        <thead>
          <tr><th>Customer</th><th>Invoice #</th><th>Invoice Date</th><th>Due Date</th><th>Days Overdue</th><th>Amount</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${_invoices.filter(i=>i.paymentStatus!=='paid').map(i => {
            const days = i.dueDate ? Math.ceil((now - new Date(i.dueDate)) / 86400000) : 0;
            const color = days > 90 ? 'var(--brand-danger)' : days > 60 ? 'var(--brand-accent)' : days > 30 ? 'var(--brand-warning)' : 'var(--text-muted)';
            return `
              <tr>
                <td>${escHtml(custName(i.customerId))}</td>
                <td style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(i.invoiceNumber||'—')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${i.invoiceDate||'—'}</td>
                <td style="font-size:11px;color:var(--text-muted);">${i.dueDate||'—'}</td>
                <td><span style="font-family:var(--font-mono);font-weight:700;color:${color};">${days > 0 ? days + ' days' : 'Current'}</span></td>
                <td style="font-family:var(--font-mono);font-weight:600;">₹${Number(i.totalAmount||0).toLocaleString('en-IN')}</td>
                <td><button class="btn btn-primary btn-sm" onclick="openPaymentModal('${i.id}')">Collect</button></td>
              </tr>
            `;
          }).join('') || '<tr><td colspan="7"><div class="table-empty"><div class="empty-icon">✅</div><div class="empty-title">No outstanding invoices</div></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// ── P&L SUMMARY ───────────────────────────────────────────────
function renderPnLTab(container) {
  const revenue   = _invoices.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
  const gstColl   = _invoices.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.gstAmount)||0),0);
  const expenses  = _expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
  const gstPaid   = _expenses.reduce((s,e)=>s+(Number(e.gstAmount)||0),0);
  const freight   = _trips.reduce((s,t)=>s+(Number(t.freightCost)||0),0);
  const grossProfit = revenue - expenses;
  const netProfit   = grossProfit - freight * 0.1; // simplified
  const margin      = revenue ? Math.round((grossProfit/revenue)*100) : 0;

  const rows = [
    { label:'Revenue (Invoiced)',  value:revenue,      type:'income',  indent:0 },
    { label:'GST Collected',       value:gstColl,      type:'note',    indent:1 },
    { label:'Total Expenses',      value:-expenses,    type:'expense', indent:0 },
    { label:'GST Paid (Input)',    value:-gstPaid,     type:'note',    indent:1 },
    { label:'Freight Revenue',     value:freight,      type:'income',  indent:0 },
    { label:'',                    value:null,         type:'divider', indent:0 },
    { label:'Gross Profit',        value:grossProfit,  type:'total',   indent:0 },
    { label:'Profit Margin',       value:margin+'%',   type:'note',    indent:0 },
    { label:'GST Payable (Net)',   value:gstColl-gstPaid,type:'note', indent:0 },
  ];

  const colors = { income:'var(--brand-secondary)', expense:'var(--brand-danger)', total:'var(--brand-primary)', note:'var(--text-muted)' };

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 320px;gap:var(--space-5);">
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Profit & Loss Summary</div></div>
        <div style="display:flex;flex-direction:column;gap:2px;">
          ${rows.map(r => {
            if (r.type === 'divider') return `<div style="height:1px;background:var(--border-subtle);margin:8px 0;"></div>`;
            const color = colors[r.type] || 'var(--text-primary)';
            const isTotal = r.type === 'total';
            const val = typeof r.value === 'number' ? '₹' + Math.abs(r.value).toLocaleString('en-IN') : r.value;
            const isNeg = typeof r.value === 'number' && r.value < 0;
            return `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:${isTotal?'12':'8'}px ${12+r.indent*16}px;
                          background:${isTotal?'var(--bg-elevated)':'transparent'};border-radius:${isTotal?'8':'0'}px;
                          ${isTotal?'border:1px solid var(--border-subtle);margin-top:4px;':''}">
                <span style="font-size:${isTotal?'14':'13'}px;font-weight:${isTotal?'700':'400'};color:${isTotal?'var(--text-primary)':'var(--text-secondary)'};">${r.label}</span>
                <span style="font-family:var(--font-mono);font-weight:${isTotal?'700':'500'};color:${isNeg?'var(--brand-danger)':isTotal?'var(--brand-primary)':color};">
                  ${isNeg?'-':''}${val||'—'}
                </span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Margin Gauge -->
      <div style="display:flex;flex-direction:column;gap:var(--space-4);">
        <div class="card">
          <div class="card-title" style="margin-bottom:var(--space-4);">Profit Margin</div>
          <div style="position:relative;width:120px;height:120px;margin:0 auto 16px;">
            <svg width="120" height="120" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="50" fill="none" stroke="var(--bg-overlay)" stroke-width="10"/>
              <circle cx="60" cy="60" r="50" fill="none" stroke="${margin>=0?'var(--brand-secondary)':'var(--brand-danger)'}" stroke-width="10"
                      stroke-dasharray="${Math.abs(margin)*3.14} 314" stroke-dashoffset="78.5" stroke-linecap="round"/>
            </svg>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;">
              <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:${margin>=0?'var(--brand-secondary)':'var(--brand-danger)'};">${margin}%</div>
              <div style="font-size:10px;color:var(--text-muted);">Margin</div>
            </div>
          </div>
          ${[
            ['Gross Profit', formatCurrency(grossProfit, true), grossProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'],
            ['Revenue',      formatCurrency(revenue,true),      'var(--brand-primary)'],
            ['Expenses',     formatCurrency(expenses,true),     'var(--brand-danger)'],
          ].map(([l,v,c])=>`
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border-subtle);">
              <span style="font-size:12px;color:var(--text-muted);">${l}</span>
              <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:${c};">${v}</span>
            </div>
          `).join('')}
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:var(--space-3);">GST Position</div>
          ${[
            ['GST Collected', formatCurrency(gstColl,true), 'var(--brand-secondary)'],
            ['GST Paid (Input)',formatCurrency(gstPaid,true),'var(--brand-danger)'],
            ['Net GST Payable',formatCurrency(gstColl-gstPaid,true),(gstColl-gstPaid)>=0?'var(--brand-warning)':'var(--brand-secondary)'],
          ].map(([l,v,c])=>`
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
              <span style="font-size:12px;color:var(--text-muted);">${l}</span>
              <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:${c};">${v}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ── GST SUMMARY ───────────────────────────────────────────────
function renderGSTTab(container) {
  const gstRates = {};
  _invoices.forEach(inv => {
    if (!inv.items) return;
    inv.items.forEach(item => {
      const rate = item.gstRate || 18;
      if (!gstRates[rate]) gstRates[rate] = { taxable:0, gst:0, count:0 };
      const taxable = (Number(item.qty)||0) * (Number(item.unitPrice)||0) * (1-(Number(item.discount)||0)/100);
      gstRates[rate].taxable += taxable;
      gstRates[rate].gst     += taxable * (rate/100);
      gstRates[rate].count   ++;
    });
  });

  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <div class="card">
        <div class="card-header"><div class="card-title">🏛 GST Summary by Rate</div></div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>GST Rate</th><th>Taxable Value</th><th>CGST</th><th>SGST</th><th>Total GST</th></tr></thead>
            <tbody>
              ${Object.entries(gstRates).length ? Object.entries(gstRates).map(([rate, data])=>`
                <tr>
                  <td><span class="badge badge-blue">${rate}%</span></td>
                  <td style="font-family:var(--font-mono);">₹${data.taxable.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                  <td style="font-family:var(--font-mono);">₹${(data.gst/2).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                  <td style="font-family:var(--font-mono);">₹${(data.gst/2).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                  <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-primary);">₹${data.gst.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                </tr>
              `).join('') : '<tr><td colspan="5"><div class="table-empty"><div class="empty-icon">🏛</div><div class="empty-title">No GST data yet</div></div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📄 GST Filing Checklist</div></div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${[
            ['GSTR-1 (Sales)',   'Monthly by 11th',  'File outward supplies'],
            ['GSTR-3B (Summary)','Monthly by 20th',  'Pay tax & file summary'],
            ['GSTR-2B (Input)',  'Auto-generated',   'Reconcile input credits'],
            ['Annual Return',    'GSTR-9 by Dec 31', 'Annual reconciliation'],
          ].map(([title,due,desc])=>`
            <div style="display:flex;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
              <div style="font-size:18px;flex-shrink:0;">📋</div>
              <div>
                <div style="font-size:13px;font-weight:600;">${title}</div>
                <div style="font-size:11px;color:var(--brand-warning);">${due}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ── Modals ────────────────────────────────────────────────────
function invoiceModal() {
  const custOpts  = _customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const orderOpts = _orders.map(o=>`<option value="${o.id}">${escHtml(o.orderNumber)} — ₹${Number(o.totalAmount||0).toLocaleString('en-IN')}</option>`).join('');

  return buildModal({
    id:'invoice-modal', title:'Create Invoice', size:'xl',
    body:`
      <input type="hidden" id="inv-id">
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Invoice Number</label><input type="text" id="inv-number" class="form-input" value="INV-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label><select id="inv-customer" class="form-select"><option value="">Select customer…</option>${custOpts}</select></div>
        <div class="form-group"><label class="form-label">Link Sales Order</label><select id="inv-order" class="form-select" onchange="autoFillFromOrder(this.value)"><option value="">None (manual)</option>${orderOpts}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Invoice Date <span class="required">*</span></label><input type="date" id="inv-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Due Date</label><input type="date" id="inv-due" class="form-input"></div>
        <div class="form-group"><label class="form-label">Payment Terms</label><select id="inv-terms" class="form-select"><option value="immediate">Immediate</option><option value="net15">Net 15</option><option value="net30">Net 30</option><option value="net45">Net 45</option></select></div>
      </div>

      <!-- Line Items -->
      <div style="margin:var(--space-4) 0 var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Invoice Items</div>
          <button class="btn btn-secondary btn-sm" onclick="addInvLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr>
              <th style="min-width:160px;">Description</th>
              <th style="width:70px;">Qty</th>
              <th style="width:100px;">Unit Price</th>
              <th style="width:70px;">GST%</th>
              <th style="width:80px;">Discount%</th>
              <th style="width:90px;">Total</th>
              <th style="width:36px;"></th>
            </tr></thead>
            <tbody id="inv-line-body"></tbody>
          </table>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-top:12px;padding-right:8px;">
          <div style="font-size:12px;color:var(--text-muted);">Subtotal: <strong id="inv-sub">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">GST: <strong id="inv-gst">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">Discount: <strong id="inv-disc" style="color:var(--brand-danger);">₹0</strong></div>
          <div style="font-size:15px;font-weight:700;color:var(--brand-secondary);">Total: <span id="inv-total">₹0</span></div>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Payment Status</label><select id="inv-pay-status" class="form-select"><option value="unpaid">Unpaid</option><option value="partial">Partial</option><option value="paid">Paid</option></select></div>
        <div class="form-group"><label class="form-label">Place of Supply</label><select id="inv-supply-state" class="form-select">
          ${['Kerala','Maharashtra','Delhi','Karnataka','Tamil Nadu','Gujarat','Rajasthan','West Bengal','Andhra Pradesh','Telangana','Uttar Pradesh','Punjab','Haryana','Madhya Pradesh','Bihar'].map(s=>`<option value="${s}">${s}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-group"><label class="form-label">Notes / Terms</label><textarea id="inv-notes" class="form-textarea" rows="2" placeholder="Payment terms, bank details…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('invoice-modal')">Cancel</button><button class="btn btn-primary" id="inv-save-btn" onclick="saveInvoice()">Create Invoice</button>`,
  });
}

function paymentModal() {
  const invOpts  = _invoices.filter(i=>i.paymentStatus!=='paid').map(i=>`<option value="${i.id}">${escHtml(i.invoiceNumber)} — ₹${Number(i.totalAmount||0).toLocaleString('en-IN')}</option>`).join('');
  const custOpts = _customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  return buildModal({
    id:'payment-modal', title:'Record Payment',
    body:`
      <input type="hidden" id="pay-inv-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Invoice <span class="required">*</span></label><select id="pay-invoice" class="form-select" onchange="autoFillPayment(this.value)"><option value="">Select invoice…</option>${invOpts}</select></div>
        <div class="form-group"><label class="form-label">Customer</label><select id="pay-customer" class="form-select"><option value="">Auto-filled…</option>${custOpts}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Amount <span class="required">*</span></label><input type="number" id="pay-amount" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Payment Mode <span class="required">*</span></label><select id="pay-mode" class="form-select"><option value="cash">Cash</option><option value="cheque">Cheque</option><option value="neft">NEFT</option><option value="upi">UPI</option><option value="card">Card</option></select></div>
        <div class="form-group"><label class="form-label">Payment Date <span class="required">*</span></label><input type="date" id="pay-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Bank Reference / UTR</label><input type="text" id="pay-ref" class="form-input" placeholder="UTR/Cheque number"></div>
        <div class="form-group"><label class="form-label">Payment Reference No.</label><input type="text" id="pay-ref-no" class="form-input" value="PAY-${genId()}" style="text-transform:uppercase;"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="pay-notes" class="form-textarea" rows="2" placeholder="Remarks…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('payment-modal')">Cancel</button><button class="btn btn-primary" id="pay-save-btn" onclick="savePayment()">Record Payment</button>`,
  });
}

function expenseModal() {
  return buildModal({
    id:'expense-modal', title:'<span id="exp-modal-title">Log Expense</span>',
    body:`
      <input type="hidden" id="exp-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Title <span class="required">*</span></label><input type="text" id="ex-title" class="form-input" placeholder="Expense description"></div>
        <div class="form-group"><label class="form-label">Category <span class="required">*</span></label>
          <select id="ex-category" class="form-select">
            <option value="fuel">Fuel</option><option value="maintenance">Maintenance</option>
            <option value="salary">Salary</option><option value="rent">Rent</option>
            <option value="utilities">Utilities</option><option value="office">Office Supplies</option>
            <option value="travel">Travel</option><option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Amount (₹) <span class="required">*</span></label><input type="number" id="ex-amount" class="form-input" placeholder="0" min="0" oninput="calcExpGST()"></div>
        <div class="form-group"><label class="form-label">GST Rate (%)</label><select id="ex-gst-rate" class="form-select" onchange="calcExpGST()"><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18" selected>18%</option><option value="28">28%</option></select></div>
        <div class="form-group"><label class="form-label">GST Amount (₹)</label><input type="number" id="ex-gst" class="form-input" readonly style="background:var(--bg-overlay);" placeholder="Auto"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Paid To / Vendor</label><input type="text" id="ex-vendor" class="form-input" placeholder="Vendor or payee name"></div>
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" id="ex-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Bill Number</label><input type="text" id="ex-bill" class="form-input" placeholder="Receipt/bill no."></div>
        <div class="form-group"><label class="form-label">Payment Mode</label><select id="ex-mode" class="form-select"><option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="neft">NEFT</option></select></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="ex-notes" class="form-textarea" rows="2" placeholder="Additional details…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('expense-modal')">Cancel</button><button class="btn btn-primary" id="exp-save-btn" onclick="saveExpense()">Save Expense</button>`,
  });
}

// ── Register Globals ──────────────────────────────────────────
let _invLines = [];

function registerFinGlobals() {
  _invLines = [];

  // Search/filter
  window.invSearch = debounce((q)=>{ _filtInv=searchFilter(_invoices,q,['invoiceNumber']); _pageInv=1; renderInvoiceTable(); },250);
  window.invFilter = (k,v)=>{ _filtInv=v?_invoices.filter(i=>i[k]===v):[..._invoices]; _pageInv=1; renderInvoiceTable(); };
  window.setInvPage = (p)=>{ _pageInv=p; renderInvoiceTable(); };

  window.paySearch = debounce((q)=>{ _filtPay=searchFilter(_payments,q,['paymentRef','reference']); _pagePay=1; renderPaymentTable(); },250);
  window.payFilter = (k,v)=>{ _filtPay=v?_payments.filter(p=>p[k]===v):[..._payments]; _pagePay=1; renderPaymentTable(); };
  window.setPayPage = (p)=>{ _pagePay=p; renderPaymentTable(); };

  window.expSearch = debounce((q)=>{ _filtExp=searchFilter(_expenses,q,['title','vendorName','billNo']); _pageExp=1; renderExpenseTable(); },250);
  window.expFilter = (k,v)=>{ _filtExp=v?_expenses.filter(e=>e[k]===v):[..._expenses]; _pageExp=1; renderExpenseTable(); };
  window.setExpPage = (p)=>{ _pageExp=p; renderExpenseTable(); };

  // Open actions
  window.openFinanceAction = () => {
    _invLines = []; document.getElementById('inv-line-body').innerHTML = '';
    document.getElementById('inv-number').value = 'INV-'+genId();
    addInvLine(); openModal('invoice-modal');
  };
  window.openPaymentModal = (invoiceId='') => {
    if (invoiceId) {
      document.getElementById('pay-inv-id').value = invoiceId;
      document.getElementById('pay-invoice').value = invoiceId;
      autoFillPayment(invoiceId);
    }
    openModal('payment-modal');
  };
  window.openExpenseModal = () => {
    document.getElementById('exp-modal-title').textContent = 'Log Expense';
    document.getElementById('exp-id').value = '';
    ['ex-title','ex-amount','ex-gst','ex-vendor','ex-bill','ex-notes'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    openModal('expense-modal');
  };

  // Auto-fill helpers
  window.autoFillFromOrder = (orderId) => {
    const order = _orders.find(o=>o.id===orderId); if(!order) return;
    document.getElementById('inv-customer').value = order.customerId||'';
    // Auto-populate line items from order
    _invLines = [];
    document.getElementById('inv-line-body').innerHTML = '';
    (order.items||[]).forEach(item => addInvLine({ description: item.productId, qty: item.qty||1, unitPrice: item.unitPrice||0, gstRate: item.gstRate||18, discount: item.discount||0 }));
    if (!_invLines.length) addInvLine();
    calcInvTotals();
  };

  window.autoFillPayment = (invoiceId) => {
    const inv = _invoices.find(i=>i.id===invoiceId); if(!inv) return;
    document.getElementById('pay-customer').value = inv.customerId||'';
    document.getElementById('pay-amount').value   = inv.totalAmount||0;
  };

  window.calcExpGST = () => {
    const amt  = Number(document.getElementById('ex-amount')?.value)||0;
    const rate = Number(document.getElementById('ex-gst-rate')?.value)||0;
    const el   = document.getElementById('ex-gst');
    if (el) el.value = (amt * rate / 100).toFixed(2);
  };

  // Invoice line items
  window.addInvLine = addInvLine;
  window.calcInvTotals = calcInvTotals;

  // Save actions
  window.saveInvoice = async () => {
    if (!validateForm([{id:'inv-customer',label:'Customer',required:true},{id:'inv-date',label:'Date',required:true}])) return;
    const valid = _invLines.filter(l=>l&&l.description);
    if (!valid.length) { Toast.error('No items','Add at least one line item.'); return; }
    const btn = document.getElementById('inv-save-btn'); setLoading(btn,true);
    const sub   = valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(1-(Number(l.discount)||0)/100)+s,0);
    const gst   = valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(1-(Number(l.discount)||0)/100)*((Number(l.gstRate)||0)/100)+s,0);
    const disc  = valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(Number(l.discount)||0)/100+s,0);
    const data  = {
      invoiceNumber:  document.getElementById('inv-number').value.trim(),
      customerId:     document.getElementById('inv-customer').value,
      orderId:        document.getElementById('inv-order').value||null,
      invoiceDate:    document.getElementById('inv-date').value,
      dueDate:        document.getElementById('inv-due').value||null,
      paymentTerms:   document.getElementById('inv-terms').value,
      paymentStatus:  document.getElementById('inv-pay-status').value,
      placeOfSupply:  document.getElementById('inv-supply-state').value,
      notes:          document.getElementById('inv-notes').value.trim(),
      items:          valid,
      subtotal:       sub, gstAmount:gst, discountAmount:disc,
      totalAmount:    sub+gst,
      companyId:      AuthState.company?.id||null,
    };
    try {
      await dbCreate(FIN_COLLECTIONS.INVOICES, data);
      // Update order payment status
      if (data.orderId) await dbUpdate('sales_orders', data.orderId, { invoiceId: 'created', invoiceNumber: data.invoiceNumber });
      Toast.success('Invoice Created', `${data.invoiceNumber} — ₹${data.totalAmount.toLocaleString('en-IN')}`);
      closeModal('invoice-modal');
      _invLines = []; document.getElementById('inv-line-body').innerHTML='';
    } catch(e) { Toast.error('Failed',e.message); }
    finally { setLoading(btn,false); }
  };

  window.savePayment = async () => {
    if (!validateForm([{id:'pay-invoice',label:'Invoice',required:true},{id:'pay-amount',label:'Amount',required:true},{id:'pay-mode',label:'Mode',required:true}])) return;
    const btn = document.getElementById('pay-save-btn'); setLoading(btn,true);
    const invoiceId = document.getElementById('pay-invoice').value;
    const amount    = Number(document.getElementById('pay-amount').value)||0;
    const data = {
      invoiceId,
      customerId:  document.getElementById('pay-customer').value,
      amount,
      mode:        document.getElementById('pay-mode').value,
      date:        document.getElementById('pay-date').value,
      reference:   document.getElementById('pay-ref').value.trim(),
      paymentRef:  document.getElementById('pay-ref-no').value.trim(),
      notes:       document.getElementById('pay-notes').value.trim(),
      companyId:   AuthState.company?.id||null,
    };
    try {
      await dbCreate(FIN_COLLECTIONS.PAYMENTS, data);
      // Update invoice payment status
      const inv = _invoices.find(i=>i.id===invoiceId);
      if (inv) {
        const totalPaid = _payments.filter(p=>p.invoiceId===invoiceId).reduce((s,p)=>s+(Number(p.amount)||0),0) + amount;
        const status = totalPaid >= Number(inv.totalAmount||0) ? 'paid' : 'partial';
        await dbUpdate(FIN_COLLECTIONS.INVOICES, invoiceId, { paymentStatus: status, paidAmount: totalPaid });
      }
      Toast.success('Payment Recorded', `₹${amount.toLocaleString('en-IN')} received.`);
      window.LAMSync?.Notify.paymentReceived(amount, inv?.customerName || 'Customer');
      closeModal('payment-modal');
    } catch(e) { Toast.error('Failed',e.message); }
    finally { setLoading(btn,false); }
  };

  window.saveExpense = async () => {
    if (!validateForm([{id:'ex-title',label:'Title',required:true},{id:'ex-amount',label:'Amount',required:true},{id:'ex-date',label:'Date',required:true}])) return;
    const btn = document.getElementById('exp-save-btn'); setLoading(btn,true);
    const id  = document.getElementById('exp-id').value;
    const data= {
      title:       document.getElementById('ex-title').value.trim(),
      category:    document.getElementById('ex-category').value,
      amount:      Number(document.getElementById('ex-amount').value)||0,
      gstRate:     Number(document.getElementById('ex-gst-rate').value)||0,
      gstAmount:   Number(document.getElementById('ex-gst').value)||0,
      vendorName:  document.getElementById('ex-vendor').value.trim(),
      date:        document.getElementById('ex-date').value,
      billNo:      document.getElementById('ex-bill').value.trim(),
      paymentMode: document.getElementById('ex-mode').value,
      notes:       document.getElementById('ex-notes').value.trim(),
      companyId:   AuthState.company?.id||null,
    };
    try {
      if(id){ await dbUpdate(FIN_COLLECTIONS.EXPENSES,id,data); Toast.success('Updated','Expense updated.'); }
      else  { await dbCreate(FIN_COLLECTIONS.EXPENSES,data);    Toast.success('Logged',`${data.title} — ₹${data.amount.toLocaleString('en-IN')}.`); }
      closeModal('expense-modal');
    } catch(e) { Toast.error('Failed',e.message); }
    finally { setLoading(btn,false); }
  };

  window.editExpense = (id) => {
    const e=_expenses.find(x=>x.id===id); if(!e)return;
    document.getElementById('exp-modal-title').textContent='Edit Expense';
    document.getElementById('exp-id').value=e.id;
    document.getElementById('ex-title').value=e.title||'';
    document.getElementById('ex-category').value=e.category||'other';
    document.getElementById('ex-amount').value=e.amount||'';
    document.getElementById('ex-gst-rate').value=e.gstRate||18;
    document.getElementById('ex-gst').value=e.gstAmount||'';
    document.getElementById('ex-vendor').value=e.vendorName||'';
    document.getElementById('ex-date').value=e.date||'';
    document.getElementById('ex-bill').value=e.billNo||'';
    document.getElementById('ex-mode').value=e.paymentMode||'cash';
    document.getElementById('ex-notes').value=e.notes||'';
    openModal('expense-modal');
  };

  window.deleteInvoice  = async(id)=>{ if(!confirm('Delete invoice?'))return; try{await dbDelete(FIN_COLLECTIONS.INVOICES,id);Toast.success('Deleted','Invoice removed.');}catch(e){Toast.error('Failed',e.message);} };
  window.deletePayment  = async(id)=>{ if(!confirm('Delete payment record?'))return; try{await dbDelete(FIN_COLLECTIONS.PAYMENTS,id);Toast.success('Deleted','Payment removed.');}catch(e){Toast.error('Failed',e.message);} };
  window.deleteExpense  = async(id)=>{ if(!confirm('Delete expense?'))return; try{await dbDelete(FIN_COLLECTIONS.EXPENSES,id);Toast.success('Deleted','Expense removed.');}catch(e){Toast.error('Failed',e.message);} };
  window.viewInvoice    = (id)=>{ window.generateInvoicePDF(id); };
  window.shareInvoiceWA = (id)=>{ window.LAMSafety?.shareInvoiceWhatsApp(id); };
  window.exportInvoices = ()=>{
    if (window.LAMEXCEL) { window.LAMEXCEL.invoices(_invoices, AuthState.company||{}); }
    else Toast.info('Export','Excel export requires lam-excel.js');
  };
  window.generateInvoicePDF = async (id) => {
    const inv  = _invoices.find(i => i.id === id);
    if (!inv) { Toast.error('Not Found','Invoice not found.'); return; }
    const cust = _customers.find(c => c.id === inv.customerId) || {};
    const co   = AuthState.company || {};
    Toast.info('Generating…', 'Building invoice PDF…', 1500);
    if (!window.LAMPDF) { Toast.error('PDF Error', 'PDF engine not loaded. Please refresh.'); return; }
    setTimeout(() => window.LAMPDF.invoice(inv, co, cust), 300);
  };
  window.sendInvoiceEmail = (id) => {
    const inv = _invoices.find(x=>x.id===id);
    if (!inv) return;
    const customer = _customers?.find?.(c=>c.id===inv.customerId)||{};
    const toEmail  = inv.customerEmail || customer.email || '';
    if (!toEmail) { Toast.warning('No Email','No email address for this customer. Update customer record first.'); return; }
    const co       = AuthState.company||{};
    const subject  = encodeURIComponent(`Invoice ${inv.invoiceNumber||''} — ₹${Number(inv.totalAmount||0).toLocaleString('en-IN')} — ${co.name||'Company'}`);
    const body     = encodeURIComponent(
      `Dear ${inv.customerName||'Customer'},\n\n` +
      `Please find the details for Invoice ${inv.invoiceNumber||''}.\n\n` +
      `Amount: ₹${Number(inv.totalAmount||0).toLocaleString('en-IN')}\n` +
      `Due Date: ${inv.dueDate||'As per terms'}\n` +
      `Payment Terms: ${inv.paymentTerms||''}\n\n` +
      `Please arrange payment at your earliest convenience.\n\n` +
      `For any queries, please contact us.\n\nRegards,\n${AuthState.profile?.name||co.name||'Finance Team'}\n${co.phone||''}`
    );
    window.open(`mailto:${toEmail}?subject=${subject}&body=${body}`, '_blank');
    Toast.success('Email Client', `Opening email to ${toEmail}`);
  };
  window.exportFinanceData=()=>{ Toast.success('Export','Finance data export initiated.'); };
}

function addInvLine(line={}) {
  const idx = _invLines.length;
  _invLines.push({ description:'', qty:1, unitPrice:0, gstRate:18, discount:0, ...line });
  const row = document.createElement('tr'); row.id=`inv-line-${idx}`;
  row.innerHTML = `
    <td><input type="text" class="form-input" value="${escHtml(line.description||'')}" placeholder="Item description…" onchange="updateInvLine(${idx},'description',this.value)"></td>
    <td><input type="number" class="form-input" style="width:60px;" value="${line.qty||1}" min="1" onchange="updateInvLine(${idx},'qty',this.value);calcInvTotals()"></td>
    <td><input type="number" class="form-input" style="width:90px;" value="${line.unitPrice||0}" min="0" step="0.01" onchange="updateInvLine(${idx},'unitPrice',this.value);calcInvTotals()"></td>
    <td><select class="form-select" style="width:60px;" onchange="updateInvLine(${idx},'gstRate',this.value);calcInvTotals()">
      ${[0,5,12,18,28].map(r=>`<option value="${r}" ${(line.gstRate||18)==r?'selected':''}>${r}%</option>`).join('')}
    </select></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.discount||0}" min="0" max="100" onchange="updateInvLine(${idx},'discount',this.value);calcInvTotals()"></td>
    <td><span id="inv-line-total-${idx}" style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹0</span></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeInvLine(${idx})">✕</button></td>
  `;
  document.getElementById('inv-line-body').appendChild(row);
  calcInvTotals();
}

window.updateInvLine = (idx,key,val)=>{ if(_invLines[idx]) _invLines[idx][key]=val; };
window.removeInvLine = (idx)=>{ document.getElementById(`inv-line-${idx}`)?.remove(); _invLines[idx]=null; calcInvTotals(); };

function calcInvTotals() {
  let sub=0, gst=0, disc=0;
  _invLines.filter(Boolean).forEach((l,idx)=>{
    const base  = (Number(l.qty)||0)*(Number(l.unitPrice)||0);
    const d     = base*(Number(l.discount)||0)/100;
    const taxable=base-d;
    const g     = taxable*(Number(l.gstRate)||0)/100;
    sub+=taxable; gst+=g; disc+=d;
    const te = document.getElementById(`inv-line-total-${idx}`);
    if(te) te.textContent='₹'+(taxable+g).toLocaleString('en-IN',{maximumFractionDigits:0});
  });
  const s=document.getElementById('inv-sub');   if(s) s.textContent='₹'+sub.toLocaleString('en-IN',{maximumFractionDigits:0});
  const g=document.getElementById('inv-gst');   if(g) g.textContent='₹'+gst.toLocaleString('en-IN',{maximumFractionDigits:0});
  const d=document.getElementById('inv-disc');  if(d) d.textContent='₹'+disc.toLocaleString('en-IN',{maximumFractionDigits:0});
  const t=document.getElementById('inv-total'); if(t) t.textContent='₹'+(sub+gst).toLocaleString('en-IN',{maximumFractionDigits:0});
}

// Helpers
function custName(id)  { return _customers.find(c=>c.id===id)?.name || id || '—'; }
function orderNum(id)  { return _orders.find(o=>o.id===id)?.orderNumber || id || '—'; }
