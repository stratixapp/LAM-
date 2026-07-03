// ============================================================
// LAM — Sales Order Management (OMS)
// Phase 2/3 — Growth Plan
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, avatarCell, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

let _orders=[], _filt=[], _page=1;
let _customers=[], _products=[], _warehouses=[];
const PER=15;
let _unsub=null;

export async function renderOrders(container) {
  [_customers, _products, _warehouses] = await Promise.all([
    dbGetAll(COLLECTIONS.CUSTOMERS,  AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.PRODUCTS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.WAREHOUSES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: 'Sales Orders',
    subtitle: 'Create and manage your sales order lifecycle.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportOrders()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openOrderModal()">+ New Order</button>
    `,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="order-summary"></div>
      ${searchBar({
        id: 'orders',
        placeholder: 'Search order number, customer…',
        filters: [
          { key: 'status', label: 'All Status', options: [
            { value: 'draft',      label: 'Draft' },
            { value: 'confirmed',  label: 'Confirmed' },
            { value: 'processing', label: 'Processing' },
            { value: 'dispatched', label: 'Dispatched' },
            { value: 'delivered',  label: 'Delivered' },
            { value: 'cancelled',  label: 'Cancelled' },
          ]},
        ],
        onSearch: 'orderSearch',
        onFilter: 'orderFilter',
      })}
      <div id="orders-table-wrap"></div>
      <div id="orders-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', orderModal());
  setupModalClose(); setupMenuClose();
  registerOrderGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen('sales_orders', c, data => {
    _orders = data; _filt = [...data];
    renderOrderSummary(); renderOrderTable();
  });
}

function renderOrderSummary() {
  const el = document.getElementById('order-summary'); if(!el) return;
  const total     = _orders.length;
  const confirmed = _orders.filter(o=>o.status==='confirmed'||o.status==='processing').length;
  const dispatched= _orders.filter(o=>o.status==='dispatched').length;
  const revenue   = _orders.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(Number(o.totalAmount)||0),0);
  [
    { label:'Total Orders', value:total,    icon:'🛒', color:'kpi-blue' },
    { label:'Confirmed',    value:confirmed,icon:'✅', color:'kpi-green' },
    { label:'Dispatched',   value:dispatched,icon:'🚛',color:'kpi-orange'},
    { label:'Revenue',      value:formatCurrency(revenue,true), icon:'💰', color:'kpi-yellow' },
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function renderOrderTable() {
  const wrap=document.getElementById('orders-table-wrap'); const pg=document.getElementById('orders-pagination'); if(!wrap)return;
  const start=(_page-1)*PER; const pageData=_filt.slice(start,start+PER);
  document.getElementById('orders-count').textContent=`${_filt.length} order${_filt.length!==1?'s':''}`;
  wrap.innerHTML = buildTable({
    id:'orders-table', onRowClick:'viewOrder',
    columns:[
      {key:'orderNumber',label:'Order #',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-primary);">${escHtml(r.orderNumber||'—')}</span>`},
      {key:'customerId',label:'Customer',render:r=>`<span style="font-size:13px;">${escHtml(custName(r.customerId))}</span>`},
      {key:'items',label:'Items',render:r=>`<span class="badge badge-blue">${r.items?.length||0} items</span>`},
      {key:'totalAmount',label:'Amount',render:r=>`<span style="font-family:var(--font-mono);font-weight:600;">₹${Number(r.totalAmount||0).toLocaleString('en-IN')}</span>`},
      {key:'paymentStatus',label:'Payment',render:r=>badge(r.paymentStatus||'unpaid')},
      {key:'status',label:'Status',render:r=>badge(r.status||'draft')},
      {key:'deliveryDate',label:'Delivery',render:r=>r.deliveryDate?`<span style="font-size:11px;color:var(--text-muted);">${r.deliveryDate}</span>`:'—'},
      {key:'createdAt',label:'Date',render:r=>`<span style="font-size:11px;color:var(--text-muted);">${formatDate(r.createdAt)}</span>`},
      {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'👁',label:'View / Print SO',     action:`viewOrder('${r.id}')`},
        {icon:'✅',label:'Approve / Confirm',    action:`approveSO('${r.id}')`},
        {icon:'🧾',label:'Convert to Invoice',   action:`convertSOToInvoice('${r.id}')`},
        {icon:'📤',label:'Dispatch',             action:`dispatchOrder('${r.id}')`},
        {icon:'📦',label:'Mark Delivered',       action:`markDelivered('${r.id}')`},
        {icon:'🗑',label:'Cancel',               action:`cancelOrder('${r.id}')`,danger:true},
      ])},
    ],
    rows:pageData, emptyMsg:'No orders yet',
  });
  pg.innerHTML=buildPagination({id:'orders',total:_filt.length,page:_page,perPage:PER,onChange:'setOrderPage'});
}

function orderModal() {
  const custOpts = _customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const whOpts   = _warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  const prodOpts = _products.map(p=>`<option value="${p.id}" data-price="${p.sellingPrice||0}" data-gst="${p.gstRate||18}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');

  return buildModal({
    id:'order-modal', title:'New Sales Order', size:'xl',
    body:`
      <input type="hidden" id="order-id">
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Order Number</label><input type="text" id="ord-number" class="form-input" value="SO-${genId()}"></div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label><select id="ord-customer" class="form-select"><option value="">Select customer…</option>${custOpts}</select></div>
        <div class="form-group"><label class="form-label">Dispatch Warehouse</label><select id="ord-warehouse" class="form-select"><option value="">Select warehouse…</option>${whOpts}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Order Date</label><input type="date" id="ord-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Delivery Date</label><input type="date" id="ord-delivery-date" class="form-input"></div>
        <div class="form-group"><label class="form-label">Payment Terms</label><select id="ord-payment-terms" class="form-select"><option value="immediate">Immediate</option><option value="net15">Net 15</option><option value="net30">Net 30</option></select></div>
      </div>

      <!-- Line Items -->
      <div style="margin:var(--space-4) 0 var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Order Items</div>
          <button class="btn btn-secondary btn-sm" type="button" onclick="addOrderLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th style="min-width:180px;">Product</th><th style="width:70px;">Qty</th><th style="width:100px;">Unit Price (₹)</th><th style="width:70px;">GST%</th><th style="width:80px;">Discount</th><th style="width:90px;">Total</th><th style="width:40px;"></th></tr></thead>
            <tbody id="order-line-body"></tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px;flex-direction:column;align-items:flex-end;gap:4px;">
          <div style="font-size:12px;color:var(--text-muted);">Subtotal: <strong id="ord-subtotal" style="color:var(--text-primary);">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">GST: <strong id="ord-gst-total" style="color:var(--text-primary);">₹0</strong></div>
          <div style="font-size:14px;font-weight:700;color:var(--brand-secondary);">Total: <span id="ord-grand-total">₹0</span></div>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Status</label><select id="ord-status" class="form-select"><option value="draft">Draft</option><option value="confirmed" selected>Confirmed</option></select></div>
        <div class="form-group"><label class="form-label">Payment Status</label><select id="ord-pay-status" class="form-select"><option value="unpaid" selected>Unpaid</option><option value="partial">Partial</option><option value="paid">Paid</option></select></div>
      </div>
      <div class="form-group"><label class="form-label">Delivery Address</label><textarea id="ord-address" class="form-textarea" rows="2" placeholder="Delivery address…"></textarea></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="ord-notes" class="form-textarea" rows="2" placeholder="Special instructions…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('order-modal')">Cancel</button><button class="btn btn-primary" id="order-save-btn" onclick="saveOrder()">Create Order</button>`,
  });
}

let _orderLines = [];

function addOrderLine(line={}) {
  const idx=_orderLines.length;
  _orderLines.push({productId:'',qty:1,unitPrice:0,gstRate:18,discount:0,...line});
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-price="${p.sellingPrice||0}" data-gst="${p.gstRate||18}" ${line.productId===p.id?'selected':''}>${escHtml(p.name)}</option>`).join('');
  const row=document.createElement('tr'); row.id=`ord-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:160px;" onchange="updateOrdLine(${idx},'productId',this.value);autoFillOrdPrice(${idx},this)"><option value="">Select…</option>${prodOpts}</select></td>
    <td><input type="number" class="form-input" style="width:60px;" value="${line.qty||1}" min="1" onchange="updateOrdLine(${idx},'qty',this.value);calcOrdTotals()"></td>
    <td><input type="number" class="form-input" id="ord-price-${idx}" style="width:90px;" value="${line.unitPrice||0}" min="0" step="0.01" onchange="updateOrdLine(${idx},'unitPrice',this.value);calcOrdTotals()"></td>
    <td><input type="number" class="form-input" id="ord-gst-${idx}" style="width:60px;" value="${line.gstRate||18}" min="0" max="28" onchange="updateOrdLine(${idx},'gstRate',this.value);calcOrdTotals()"></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.discount||0}" min="0" max="100" placeholder="%" onchange="updateOrdLine(${idx},'discount',this.value);calcOrdTotals()"></td>
    <td><span id="ord-line-total-${idx}" style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹0</span></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeOrdLine(${idx})">✕</button></td>
  `;
  document.getElementById('order-line-body').appendChild(row);
  calcOrdTotals();
}

function registerOrderGlobals() {
  _orderLines = [];
  addOrderLine();

  window.addOrderLine   = addOrderLine;
  window.updateOrdLine  = (idx,key,val) => { if(_orderLines[idx]) _orderLines[idx][key]=val; };
  window.autoFillOrdPrice=(idx,select)=>{
    const opt=select.options[select.selectedIndex];
    const price=Number(opt?.dataset?.price||0); const gst=Number(opt?.dataset?.gst||18);
    if(_orderLines[idx]){_orderLines[idx].unitPrice=price;_orderLines[idx].gstRate=gst;}
    const pe=document.getElementById(`ord-price-${idx}`); if(pe)pe.value=price;
    const ge=document.getElementById(`ord-gst-${idx}`);   if(ge)ge.value=gst;
    calcOrdTotals();
  };
  window.removeOrdLine=(idx)=>{document.getElementById(`ord-line-${idx}`)?.remove();_orderLines[idx]=null;calcOrdTotals();};
  window.calcOrdTotals=calcOrdTotals;

  window.orderSearch=debounce((q)=>{_filt=_orders.filter(o=>(o.orderNumber||'').toLowerCase().includes(q.toLowerCase())||(custName(o.customerId)||'').toLowerCase().includes(q.toLowerCase()));_page=1;renderOrderTable();},250);
  window.orderFilter=(k,v)=>{_filt=v?_orders.filter(o=>o[k]===v):[..._orders];_page=1;renderOrderTable();};
  window.setOrderPage=(p)=>{_page=p;renderOrderTable();};

  window.saveOrder=async()=>{
    if(!validateForm([{id:'ord-customer',label:'Customer',required:true}])) return;
    const validLines=_orderLines.filter(l=>l&&l.productId);
    if(!validLines.length){Toast.error('No items','Add at least one item.');return;}
    const btn=document.getElementById('order-save-btn'); setLoading(btn,true);
    const subtotal=validLines.reduce((s,l)=>{const base=(l.qty||0)*(l.unitPrice||0);return s+base*(1-(l.discount||0)/100);},0);
    const gstAmt =validLines.reduce((s,l)=>{const base=(l.qty||0)*(l.unitPrice||0)*(1-(l.discount||0)/100);return s+base*((l.gstRate||0)/100);},0);
    const data={orderNumber:document.getElementById('ord-number').value.trim(),customerId:document.getElementById('ord-customer').value,warehouseId:document.getElementById('ord-warehouse').value,orderDate:document.getElementById('ord-date').value,deliveryDate:document.getElementById('ord-delivery-date').value,paymentTerms:document.getElementById('ord-payment-terms').value,status:document.getElementById('ord-status').value,paymentStatus:document.getElementById('ord-pay-status').value,deliveryAddress:document.getElementById('ord-address').value.trim(),notes:document.getElementById('ord-notes').value.trim(),items:validLines,subtotal,gstAmount:gstAmt,totalAmount:subtotal+gstAmt,companyId:AuthState.company?.id||null};
    try{await dbCreate('sales_orders',data);Toast.success('Order Created',`${data.orderNumber} confirmed.`);closeModal('order-modal');_orderLines=[];document.getElementById('order-line-body').innerHTML='';addOrderLine();}
    catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.viewOrder=(id)=>{
    const o=_orders.find(x=>x.id===id); if(!o) return;
    const co=AuthState.company||{};
    const cust=_customers?.find?.(c=>c.id===o.customerId)||{};
    const win=window.open('','_blank','width=900,height=700');
    if(!win){Toast.error('Blocked','Allow popups to view order.');return;}
    const itemRows=(o.items||[]).map((it,i)=>{
      const sub=(it.qty||0)*(it.rate||0);
      const gstA=sub*(it.gstRate||0)/100;
      return `<tr>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${i+1}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;">${escHtml(it.productName||it.description||'—')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${it.qty||0} ${escHtml(it.unit||'')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;">₹${Number(it.rate||0).toLocaleString('en-IN')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${it.discount||0}%</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${it.gstRate||0}%</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;font-weight:600;">₹${(sub+gstA).toLocaleString('en-IN')}</td>
      </tr>`;
    }).join('');
    const stBg={confirmed:'#dbeafe',dispatched:'#fef9c3',delivered:'#dcfce7',cancelled:'#fee2e2',draft:'#f1f5f9'};
    const stFg={confirmed:'#1d4ed8',dispatched:'#854d0e',delivered:'#166534',cancelled:'#991b1b',draft:'#475569'};
    win.document.write(`<!DOCTYPE html><html><head>
      <title>Order ${escHtml(o.orderNumber||'')}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b;background:#f8fafc;padding:24px;}
      .doc{max-width:850px;margin:0 auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-radius:8px;overflow:hidden;}
      .hdr{background:linear-gradient(135deg,#1e3a5f,#0a84ff);color:#fff;padding:24px 32px;}
      .hdr h1{font-size:20px;font-weight:800;}.hdr .sub{font-size:11px;opacity:0.75;margin-top:3px;}
      .body{padding:24px 32px;}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;}
      .box{background:#f8fafc;border-radius:8px;padding:14px;}
      .box .lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:8px;}
      .row{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid #f1f5f9;}.row:last-child{border:none;}.row .k{color:#64748b;}.row .v{font-weight:600;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px;}
      th{background:#1e3a5f;color:#fff;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;}
      .tot{display:flex;justify-content:flex-end;}.tot-box{width:240px;}
      .tot-row{display:flex;justify-content:space-between;padding:5px 10px;font-size:12px;border-bottom:1px solid #f1f5f9;}
      .tot-fin{background:#0a84ff;color:#fff;border-radius:5px;font-weight:800;font-size:14px;padding:8px 10px;border:none;}
      .actions{display:flex;gap:10px;padding:14px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;}
      .btn{border:none;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;}
      .btn-blue{background:#0a84ff;color:#fff;}.btn-gray{background:#e2e8f0;color:#475569;}
      .sig{display:flex;justify-content:space-between;margin-top:24px;}
      .sig-box{text-align:center;width:160px;}.sig-line{border-top:1px solid #cbd5e1;padding-top:6px;font-size:10px;color:#64748b;}
      @media print{.actions{display:none;}body{background:#fff;padding:0;}.doc{box-shadow:none;}}</style></head><body>
      <div class="doc">
        <div class="hdr"><div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div><h1>${escHtml(co.name||'Company')}</h1><div class="sub">${escHtml(co.address||'')}${co.gstin?' · GSTIN: '+co.gstin:''}</div></div>
          <div style="text-align:right;"><div style="font-size:20px;font-weight:800;">SALES ORDER</div>
            <div style="font-size:13px;opacity:0.85;margin-top:4px;">${escHtml(o.orderNumber||'—')}</div>
            <span style="display:inline-block;margin-top:8px;padding:3px 12px;border-radius:99px;font-size:10px;font-weight:700;background:${stBg[o.status]||'#f1f5f9'};color:${stFg[o.status]||'#475569'};">${(o.status||'draft').toUpperCase()}</span>
          </div>
        </div></div>
        <div class="body">
          <div class="meta">
            <div class="box"><div class="lbl">Customer Details</div>
              <div style="font-size:14px;font-weight:700;color:#0a84ff;margin-bottom:6px;">${escHtml(cust.name||custName(o.customerId)||'—')}</div>
              ${cust.phone?`<div style="font-size:11px;color:#64748b;">📞 ${escHtml(cust.phone)}</div>`:''}
              ${cust.gstin?`<div style="font-size:11px;color:#64748b;">GSTIN: ${escHtml(cust.gstin)}</div>`:''}
              ${o.deliveryAddress?`<div style="font-size:11px;color:#64748b;margin-top:4px;">📍 ${escHtml(o.deliveryAddress)}</div>`:''}
            </div>
            <div class="box"><div class="lbl">Order Details</div>
              <div class="row"><span class="k">Order No.</span><span class="v" style="font-family:monospace;">${escHtml(o.orderNumber||'—')}</span></div>
              <div class="row"><span class="k">Order Date</span><span class="v">${o.orderDate||'—'}</span></div>
              <div class="row"><span class="k">Delivery By</span><span class="v">${o.deliveryDate||'—'}</span></div>
              <div class="row"><span class="k">Payment Terms</span><span class="v">${escHtml(o.paymentTerms||'—')}</span></div>
            </div>
          </div>
          <table><thead><tr><th style="width:4%;">#</th><th style="width:30%;">Item / Description</th><th style="width:10%;text-align:center;">Qty</th><th style="width:13%;text-align:right;">Rate(₹)</th><th style="width:8%;text-align:center;">Disc%</th><th style="width:8%;text-align:center;">GST%</th><th style="width:13%;text-align:right;">Total(₹)</th></tr></thead>
          <tbody>${itemRows||'<tr><td colspan="7" style="padding:20px;text-align:center;color:#94a3b8;">No items</td></tr>'}</tbody></table>
          <div class="tot"><div class="tot-box">
            <div class="tot-row"><span>Subtotal</span><span style="font-family:monospace;">₹${Number(o.subtotal||0).toLocaleString('en-IN')}</span></div>
            <div class="tot-row"><span>GST</span><span style="font-family:monospace;">₹${Number(o.gstAmount||0).toLocaleString('en-IN')}</span></div>
            <div class="tot-row tot-fin"><span>TOTAL</span><span style="font-family:monospace;">₹${Number(o.totalAmount||0).toLocaleString('en-IN')}</span></div>
          </div></div>
          ${o.notes?`<div style="background:#fff8e1;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:0 6px 6px 0;font-size:11px;margin-bottom:16px;">Notes: ${escHtml(o.notes)}</div>`:''}
          <div class="sig">
            <div class="sig-box"><div class="sig-line">Prepared By</div></div>
            <div class="sig-box"><div class="sig-line">Authorised Signatory</div></div>
            <div class="sig-box"><div class="sig-line">Customer Acknowledgement</div></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-blue" onclick="window.print()">🖨️ Print / PDF</button>
          <button class="btn btn-gray" onclick="window.close()">✕ Close</button>
        </div>
      </div></body></html>`);
    win.document.close();
  };

  window.convertSOToInvoice=async(id)=>{
    const o=_orders.find(x=>x.id===id); if(!o) return;
    if(o.status==='cancelled'){Toast.error('Cannot Convert','Cannot convert a cancelled order.');return;}
    if(!confirm(`Convert SO ${o.orderNumber} to a Sales Invoice? This will create a new invoice.`)) return;
    try{
      const inv={
        invoiceNumber:`INV-${o.orderNumber}`,
        customerId:o.customerId,customerName:custName(o.customerId),
        orderRef:o.orderNumber,soId:o.id,
        invoiceDate:new Date().toISOString().slice(0,10),
        dueDate:o.deliveryDate||'',
        paymentTerms:o.paymentTerms||'Net 30',
        items:o.items||[],
        subtotal:o.subtotal||0,gstAmount:o.gstAmount||0,
        totalAmount:o.totalAmount||0,
        status:'unpaid',paymentStatus:'unpaid',
        notes:o.notes||'',
        companyId:AuthState.company?.id||null,
      };
      await dbCreate(COLLECTIONS.INVOICES||'invoices',inv);
      await dbUpdate('sales_orders',id,{status:'invoiced',invoicedAt:new Date().toISOString()});
      Toast.success('Invoice Created',`Invoice created from SO ${o.orderNumber}. Go to Finance → Invoices to view.`);
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.approveSO=async(id)=>{
    try{await dbUpdate('sales_orders',id,{status:'confirmed',approvedBy:AuthState.profile?.name||'',approvedAt:new Date().toISOString()});Toast.success('Approved','Sales Order confirmed.');}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.dispatchOrder=async(id)=>{
    if(!confirm('Mark this order as dispatched?')) return;
    try{await dbUpdate('sales_orders',id,{status:'dispatched'});Toast.success('Dispatched','Order marked as dispatched.');}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.markDelivered=async(id)=>{
    if(!confirm('Mark this order as delivered?')) return;
    try{await dbUpdate('sales_orders',id,{status:'delivered',paymentStatus:'paid'});Toast.success('Delivered','Order marked as delivered.');}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.cancelOrder=async(id)=>{
    const o=_orders.find(x=>x.id===id);
    if(!confirm(`Cancel order "${o?.orderNumber}"?`)) return;
    try{await dbUpdate('sales_orders',id,{status:'cancelled'});Toast.warning('Cancelled','Order cancelled.');}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.exportOrders=()=>{
    const csv=[['Order #','Customer','Items','Amount','Payment','Status','Date'],..._filt.map(o=>[o.orderNumber,custName(o.customerId),o.items?.length,o.totalAmount,o.paymentStatus,o.status,o.createdAt ? formatDate(o.createdAt) : "—"])].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='orders_export.csv'; a.click();
    Toast.success('Exported',`${_filt.length} orders exported.`);
  };
  window.openOrderModal=()=>{_orderLines=[];document.getElementById('order-line-body').innerHTML='';document.getElementById('ord-number').value='SO-'+genId();addOrderLine();openModal('order-modal');};
}

function calcOrdTotals() {
  const active=_orderLines.filter(Boolean);
  let sub=0, gst=0;
  active.forEach((l,idx)=>{
    if(!l.productId) return;
    const base=(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(1-(Number(l.discount)||0)/100);
    const gstAmt=base*((Number(l.gstRate)||0)/100);
    sub+=base; gst+=gstAmt;
    const te=document.getElementById(`ord-line-total-${idx}`);
    if(te) te.textContent='₹'+(base+gstAmt).toLocaleString('en-IN',{maximumFractionDigits:0});
  });
  const s=document.getElementById('ord-subtotal');  if(s) s.textContent='₹'+sub.toLocaleString('en-IN',{maximumFractionDigits:0});
  const g=document.getElementById('ord-gst-total'); if(g) g.textContent='₹'+gst.toLocaleString('en-IN',{maximumFractionDigits:0});
  const t=document.getElementById('ord-grand-total');if(t) t.textContent='₹'+(sub+gst).toLocaleString('en-IN',{maximumFractionDigits:0});
}

function custName(id) { return _customers.find(c=>c.id===id)?.name || id || '—'; }
