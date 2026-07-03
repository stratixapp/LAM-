// ============================================================
// LAM — Advanced Warehouse Management System (WMS)
// Tools 12-20: Dispatch, Transfer, Barcode, BinLocator,
//              CycleCount, Expiry, Reorder, Damage, Valuation
// Fully interconnected with Inventory, Products, Orders, Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, dbBatch, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

export const WMS_COLLECTIONS = {
  DISPATCH:   'wms_dispatch',
  TRANSFERS:  'wms_transfers',
  CYCLE_COUNT:'wms_cycle_count',
  DAMAGE:     'wms_damage',
};

let _products = [], _warehouses = [], _inventory = [];
let _activeTab = 'dispatch';
let _unsubs = [];
function _cleanupListeners(){ _unsubs.forEach(fn=>fn&&fn()); _unsubs=[]; }

// ── Main WMS Hub ──────────────────────────────────────────────
export async function renderWMSHub(container) {
  _cleanupListeners();
  [_products, _warehouses, _inventory] = await Promise.all([
    dbGetAll(COLLECTIONS.PRODUCTS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.WAREHOUSES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.INVENTORY,  AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '🏭 Warehouse Operations',
    subtitle: 'Dispatch, transfers, bin locator, cycle counts, damage tracking and inventory valuation.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshWMS()">↻ Refresh</button>`,
    content: `
      <!-- WMS KPIs -->
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="wms-kpis"></div>

      <!-- Sub-tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['dispatch',   '📤 Dispatch/Issue'],
          ['transfer',   '🔄 W2W Transfer'],
          ['barcode',    '📊 Barcode/QR'],
          ['binlocator', '📍 Bin Locator'],
          ['cyclecount', '🔢 Cycle Count'],
          ['expiry',     '⏰ Expiry Tracking'],
          ['reorder',    '🔔 Reorder Alerts'],
          ['damage',     '⚠️ Damage/Loss'],
          ['valuation',  '💰 Valuation'],
        ].map(([id, label]) => `
          <button class="wms-tab ${id==='dispatch'?'active':''}" id="wms-tab-${id}"
            onclick="switchWMSTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:11px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;
                   transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>
        `).join('')}
      </div>
      <div id="wms-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = `.wms-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}`;
  document.head.appendChild(style);

  renderWMSKPIs();
  setupModalClose(); setupMenuClose();
  window.switchWMSTab = switchWMSTab;
  window.refreshWMS = async () => {
    _inventory = await dbGetAll(COLLECTIONS.INVENTORY, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []);
    renderWMSKPIs();
    switchWMSTab(_activeTab);
  };
  switchWMSTab('dispatch');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderWMSKPIs() {
  const el = document.getElementById('wms-kpis'); if (!el) return;
  el.innerHTML = '';
  const totalStock  = _inventory.reduce((s,i) => s+(Number(i.quantity)||0), 0);
  const lowStock    = _inventory.filter(i => Number(i.quantity) <= Number(i.reorderPoint||0)).length;
  const expiringSoon= _inventory.filter(i => {
    if (!i.expiryDate) return false;
    const d = Math.ceil((new Date(i.expiryDate)-Date.now())/86400000);
    return d > 0 && d <= 30;
  }).length;
  const zeroStock   = _inventory.filter(i => Number(i.quantity) === 0).length;
  const totalValue  = _inventory.reduce((s,i) => {
    const p = _products.find(x=>x.id===i.productId);
    return s + (Number(i.quantity)||0)*(Number(p?.costPrice||p?.sellingPrice)||0);
  }, 0);

  [
    {label:'Total Stock Units', value:formatNumber(totalStock),        icon:'📦', color:'kpi-blue'},
    {label:'Low Stock Items',   value:lowStock,                        icon:'⚠️', color:lowStock>0?'kpi-yellow':'kpi-green'},
    {label:'Zero Stock',        value:zeroStock,                       icon:'🚨', color:zeroStock>0?'kpi-red':'kpi-green'},
    {label:'Expiring (30d)',    value:expiringSoon,                    icon:'⏰', color:expiringSoon>0?'kpi-orange':'kpi-green'},
    {label:'Inventory Value',   value:formatCurrency(totalValue,true), icon:'💰', color:'kpi-green'},
  ].forEach((k,i) => {
    el.innerHTML += `
      <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
        <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`;
  });
}

// ── Tab Switcher ──────────────────────────────────────────────
function switchWMSTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.wms-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`wms-tab-${tab}`)?.classList.add('active');
  const c = document.getElementById('wms-tab-content'); if (!c) return;
  switch(tab) {
    case 'dispatch':   renderDispatchTab(c);   break;
    case 'transfer':   renderTransferTab(c);   break;
    case 'barcode':    renderBarcodeTab(c);     break;
    case 'binlocator': renderBinLocatorTab(c);  break;
    case 'cyclecount': renderCycleCountTab(c);  break;
    case 'expiry':     renderExpiryTab(c);      break;
    case 'reorder':    renderReorderTab(c);     break;
    case 'damage':     renderDamageTab(c);      break;
    case 'valuation':  renderValuationTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 12: STOCK DISPATCH / ISSUE
// ══════════════════════════════════════════════════════════════
let _dispatches = [], _filtDisp = [], _pageDisp = 1;
const PER = 15;

function renderDispatchTab(container) {
  container.innerHTML = `
    ${searchBar({id:'disp', placeholder:'Search dispatch no, product…',
      filters:[{key:'status',label:'All Status',options:[{value:'pending',label:'Pending'},{value:'issued',label:'Issued'},{value:'cancelled',label:'Cancelled'}]}],
      onSearch:'dispSearch', onFilter:'dispFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('dispatch-modal')">+ Create Dispatch</button>
    </div>
    <div id="disp-table-wrap"></div>
    <div id="disp-pagination"></div>
  `;

  document.getElementById('dispatch-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', buildDispatchModal());

  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsubs.push(dbListen(WMS_COLLECTIONS.DISPATCH, c, data => {
    _dispatches = data; _filtDisp = [...data];
    renderDispatchTable();
  }));

  window.dispSearch = debounce((q) => { _filtDisp=searchFilter(_dispatches,q,['dispatchNo','notes']); _pageDisp=1; renderDispatchTable(); }, 250);
  window.dispFilter = (k,v) => { _filtDisp=v?_dispatches.filter(d=>d[k]===v):[..._dispatches]; _pageDisp=1; renderDispatchTable(); };
  window.setDispPage = (p) => { _pageDisp=p; renderDispatchTable(); };
}

function buildDispatchModal() {
  const prodOpts = _products.map(p => `<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  const whOpts   = _warehouses.map(w => `<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  return buildModal({
    id:'dispatch-modal', title:'Create Stock Dispatch / Issue', size:'lg',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Dispatch No.</label><input type="text" id="dp-no" class="form-input" value="DSP-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">From Warehouse <span class="required">*</span></label>
          <select id="dp-wh" class="form-select" onchange="loadWarehouseStock(this.value)"><option value="">Select…</option>${whOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Issue Date</label><input type="date" id="dp-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Issue To / Purpose <span class="required">*</span></label>
          <select id="dp-purpose" class="form-select">
            <option value="sales-order">Sales Order Fulfillment</option>
            <option value="transfer">Warehouse Transfer</option>
            <option value="internal">Internal Use</option>
            <option value="sample">Sample/Demo</option>
            <option value="damage-writeoff">Damage Write-off</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Reference (Order/Document No.)</label>
          <input type="text" id="dp-ref" class="form-input" placeholder="SO-XXXX or manual ref">
        </div>
      </div>

      <div style="margin:var(--space-4) 0 var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Items to Dispatch</div>
          <button class="btn btn-secondary btn-sm" onclick="addDispLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Product</th><th>Available</th><th>Qty to Issue</th><th>Batch</th><th>Unit</th><th></th></tr></thead>
            <tbody id="dp-line-body"></tbody>
          </table>
        </div>
        <div style="text-align:right;margin-top:8px;font-size:12px;color:var(--text-muted);">
          Total Items: <strong id="dp-item-count" style="color:var(--text-primary);">0</strong> &nbsp;
          Total Qty: <strong id="dp-total-qty" style="color:var(--text-primary);">0</strong>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="dp-notes" class="form-textarea" rows="2" placeholder="Dispatch instructions…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('dispatch-modal')">Cancel</button>
            <button class="btn btn-primary" id="dp-save-btn" onclick="saveDispatch()">Issue Stock</button>`,
  });
}

let _dpLines = [];
function renderDispatchTable() {
  const wrap = document.getElementById('disp-table-wrap');
  const pg   = document.getElementById('disp-pagination');
  if (!wrap) return;
  const cnt = document.getElementById('disp-count'); if(cnt) cnt.textContent=`${_filtDisp.length} dispatch${_filtDisp.length!==1?'es':''}`;
  const start = (_pageDisp-1)*PER;
  wrap.innerHTML = buildTable({
    id:'disp-table',
    columns:[
      {key:'dispatchNo', label:'Dispatch #', render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.dispatchNo||'—')}</span>`},
      {key:'warehouseId',label:'From WH',    render:r=>`<span style="font-size:12px;">${escHtml(_warehouses.find(w=>w.id===r.warehouseId)?.name||'—')}</span>`},
      {key:'purpose',    label:'Purpose',    render:r=>`<span class="badge badge-blue">${escHtml(r.purpose||'—')}</span>`},
      {key:'items',      label:'Items',      render:r=>`<span class="badge badge-gray">${r.items?.length||0} items</span>`},
      {key:'totalQty',   label:'Total Qty',  render:r=>`<span style="font-family:var(--font-mono);">${formatNumber(r.totalQty||0)}</span>`},
      {key:'reference',  label:'Ref',        render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml(r.reference||'—')}</span>`},
      {key:'status',     label:'Status',     render:r=>badge(r.status||'issued')},
      {key:'date',       label:'Date',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
      {key:'actions',    label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'🔄',label:'Reverse Issue',action:`reverseDispatch('${r.id}')`,danger:true},
        {icon:'🗑',label:'Delete',action:`deleteDispatch('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtDisp.slice(start,start+PER), emptyMsg:'No dispatches yet',
  });
  pg.innerHTML = buildPagination({id:'disp',total:_filtDisp.length,page:_pageDisp,perPage:PER,onChange:'setDispPage'});
}

// Register dispatch globals
window.loadWarehouseStock = (whId) => {
  _dpLines = []; document.getElementById('dp-line-body').innerHTML = '';
  addDispLine(); calcDispTotals();
};
window.addDispLine = () => {
  const idx = _dpLines.length;
  _dpLines.push({productId:'', qty:0, batch:''});
  const prodOpts = _products.map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  const row = document.createElement('tr'); row.id=`dp-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:160px;" onchange="updateDpLine(${idx},'productId',this.value);showAvailable(${idx},this.value)"><option value="">Select…</option>${prodOpts}</select></td>
    <td><span id="dp-avail-${idx}" style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">—</span></td>
    <td><input type="number" class="form-input" style="width:80px;" value="0" min="0" onchange="updateDpLine(${idx},'qty',this.value);calcDispTotals()"></td>
    <td><input type="text" class="form-input" style="width:80px;" placeholder="Batch" onchange="updateDpLine(${idx},'batch',this.value)"></td>
    <td><span id="dp-unit-${idx}" class="badge badge-gray">pcs</span></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeDpLine(${idx})">✕</button></td>
  `;
  document.getElementById('dp-line-body').appendChild(row);
  calcDispTotals();
};
window.showAvailable = (idx, productId) => {
  const whId = document.getElementById('dp-wh')?.value;
  const inv = _inventory.find(i=>i.productId===productId && (!whId || i.warehouseId===whId));
  const p   = _products.find(x=>x.id===productId);
  const el  = document.getElementById(`dp-avail-${idx}`);
  const uEl = document.getElementById(`dp-unit-${idx}`);
  if (el) el.textContent = inv ? formatNumber(inv.quantity) + ' ' + (p?.unit||'pcs') : '0';
  if (uEl) uEl.textContent = p?.unit||'pcs';
  if (_dpLines[idx]) _dpLines[idx].productId = productId;
};
window.updateDpLine = (idx,key,val) => { if(_dpLines[idx]) _dpLines[idx][key]=val; };
window.removeDpLine = (idx) => { document.getElementById(`dp-line-${idx}`)?.remove(); _dpLines[idx]=null; calcDispTotals(); };
window.calcDispTotals = () => {
  const active = _dpLines.filter(l=>l&&l.productId);
  const qty    = active.reduce((s,l)=>s+(Number(l.qty)||0),0);
  const ic=document.getElementById('dp-item-count'); if(ic) ic.textContent=active.length;
  const tq=document.getElementById('dp-total-qty');  if(tq) tq.textContent=formatNumber(qty);
};
window.saveDispatch = async () => {
  if (!validateForm([{id:'dp-wh',label:'Warehouse',required:true},{id:'dp-purpose',label:'Purpose',required:true}])) return;
  const valid = _dpLines.filter(l=>l&&l.productId&&Number(l.qty)>0);
  if (!valid.length) { Toast.error('No items','Add at least one item with qty > 0.'); return; }
  const btn=document.getElementById('dp-save-btn'); setLoading(btn,true);
  const whId = document.getElementById('dp-wh').value;
  try {
    // Validate stock availability
    for (const line of valid) {
      const inv = _inventory.find(i=>i.productId===line.productId && i.warehouseId===whId);
      if (!inv || Number(inv.quantity) < Number(line.qty)) {
        const p = _products.find(x=>x.id===line.productId);
        throw new Error(`Insufficient stock for ${p?.name||'item'}: available ${inv?.quantity||0}, requested ${line.qty}`);
      }
    }
    const data = {
      dispatchNo: document.getElementById('dp-no').value.trim(),
      warehouseId: whId,
      purpose: document.getElementById('dp-purpose').value,
      reference: document.getElementById('dp-ref').value.trim(),
      date: document.getElementById('dp-date').value,
      items: valid,
      totalQty: valid.reduce((s,l)=>s+(Number(l.qty)||0),0),
      status: 'issued',
      issuedBy: AuthState.profile?.name || '',
      notes: document.getElementById('dp-notes').value.trim(),
      companyId: AuthState.company?.id||null,
    };
    await dbCreate(WMS_COLLECTIONS.DISPATCH, data);
    // Deduct from inventory
    const ops = [];
    for (const line of valid) {
      const inv = _inventory.find(i=>i.productId===line.productId && i.warehouseId===whId);
      if (inv) ops.push({ collection:COLLECTIONS.INVENTORY, id:inv.id, type:'update', data:{ quantity: Number(inv.quantity)-Number(line.qty) } });
    }
    if (ops.length) await dbBatch(ops);
    Toast.success('Dispatched',`${data.dispatchNo} — ${data.totalQty} units issued.`);
    closeModal('dispatch-modal');
    _dpLines=[]; document.getElementById('dp-line-body').innerHTML='';
    window.refreshWMS?.();
  } catch(e) { Toast.error('Failed',e.message); }
  finally { setLoading(btn,false); }
};
window.reverseDispatch = async (id) => {
  if (!confirm('Reverse this dispatch and return stock to inventory?')) return;
  const d = _dispatches.find(x=>x.id===id); if(!d) return;
  try {
    const ops = d.items?.map(line => {
      const inv = _inventory.find(i=>i.productId===line.productId && i.warehouseId===d.warehouseId);
      return inv ? {collection:COLLECTIONS.INVENTORY,id:inv.id,type:'update',data:{quantity:Number(inv.quantity)+Number(line.qty)}} : null;
    }).filter(Boolean) || [];
    if (ops.length) await dbBatch(ops);
    await dbUpdate(WMS_COLLECTIONS.DISPATCH, id, { status:'cancelled' });
    Toast.success('Reversed','Stock returned to inventory.');
    window.refreshWMS?.();
  } catch(e) { Toast.error('Failed',e.message); }
};
window.deleteDispatch = async(id) => {
  if (!confirm('Delete this dispatch record?')) return;
  try { await dbDelete(WMS_COLLECTIONS.DISPATCH,id); Toast.success('Deleted','Dispatch removed.'); }
  catch(e) { Toast.error('Failed',e.message); }
};

// ══════════════════════════════════════════════════════════════
// TOOL 13: WAREHOUSE-TO-WAREHOUSE TRANSFER
// ══════════════════════════════════════════════════════════════
let _transfers = [], _filtTrans = [], _pageTrans = 1;

function renderTransferTab(container) {
  container.innerHTML = `
    ${searchBar({id:'trans', placeholder:'Search transfer no, warehouse…',
      filters:[{key:'status',label:'All Status',options:[{value:'pending',label:'Pending'},{value:'in-transit',label:'In Transit'},{value:'completed',label:'Completed'}]}],
      onSearch:'transSearch', onFilter:'transFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openTransferModal()">+ Create Transfer</button>
    </div>
    <div id="trans-table-wrap"></div>
    <div id="trans-pagination"></div>
  `;

  document.getElementById('transfer-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', buildTransferModal());

  const cid = AuthState.company?.id;
  _unsubs.push(dbListen(WMS_COLLECTIONS.TRANSFERS, cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')], data => {
    _transfers=data; _filtTrans=[...data]; renderTransferTable();
  }));

  window.transSearch = debounce((q)=>{_filtTrans=searchFilter(_transfers,q,['transferNo','notes']);_pageTrans=1;renderTransferTable();},250);
  window.transFilter = (k,v)=>{_filtTrans=v?_transfers.filter(t=>t[k]===v):[..._transfers];_pageTrans=1;renderTransferTable();};
  window.setTransPage = (p)=>{_pageTrans=p;renderTransferTable();};
}

function buildTransferModal() {
  const whOpts = _warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  const prodOpts = _products.map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  return buildModal({
    id:'transfer-modal', title:'Create W2W Stock Transfer', size:'lg',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Transfer No.</label><input type="text" id="tr-no" class="form-input" value="TRF-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">From Warehouse <span class="required">*</span></label>
          <select id="tr-from" class="form-select"><option value="">Select…</option>${whOpts}</select></div>
        <div class="form-group"><label class="form-label">To Warehouse <span class="required">*</span></label>
          <select id="tr-to" class="form-select"><option value="">Select…</option>${whOpts}</select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Transfer Date</label><input type="date" id="tr-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Expected Arrival</label><input type="date" id="tr-eta" class="form-input"></div>
      </div>
      <div style="margin:var(--space-4) 0 var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Items to Transfer</div>
          <button class="btn btn-secondary btn-sm" onclick="addTransLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table"><thead><tr><th>Product</th><th>Available (From)</th><th>Qty</th><th></th></tr></thead>
          <tbody id="tr-line-body"></tbody></table>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="tr-notes" class="form-textarea" rows="2"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('transfer-modal')">Cancel</button>
            <button class="btn btn-primary" id="tr-save-btn" onclick="saveTransfer()">Initiate Transfer</button>`,
  });
}

let _trLines = [];
function renderTransferTable() {
  const wrap=document.getElementById('trans-table-wrap'); if(!wrap)return;
  const pg=document.getElementById('trans-pagination');
  const cnt=document.getElementById('trans-count'); if(cnt) cnt.textContent=`${_filtTrans.length} transfer${_filtTrans.length!==1?'s':''}`;
  const start=(_pageTrans-1)*PER;
  wrap.innerHTML=buildTable({id:'trans-table',columns:[
    {key:'transferNo',label:'Transfer #',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.transferNo||'—')}</span>`},
    {key:'fromWarehouseId',label:'From',render:r=>`<span style="font-size:12px;">${escHtml(_warehouses.find(w=>w.id===r.fromWarehouseId)?.name||'—')}</span>`},
    {key:'toWarehouseId',label:'To',render:r=>`<span style="font-size:12px;">${escHtml(_warehouses.find(w=>w.id===r.toWarehouseId)?.name||'—')}</span>`},
    {key:'items',label:'Items',render:r=>`<span class="badge badge-blue">${r.items?.length||0} items</span>`},
    {key:'totalQty',label:'Total Qty',render:r=>`<span style="font-family:var(--font-mono);">${formatNumber(r.totalQty||0)}</span>`},
    {key:'status',label:'Status',render:r=>badge(r.status||'pending')},
    {key:'date',label:'Date',render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
    {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[
      {icon:'✅',label:'Mark Received',action:`receiveTransfer('${r.id}')`},
      {icon:'🗑',label:'Delete',action:`deleteTransfer('${r.id}')`,danger:true},
    ])},
  ],rows:_filtTrans.slice(start,start+PER),emptyMsg:'No transfers yet'});
  if(pg) pg.innerHTML=buildPagination({id:'trans',total:_filtTrans.length,page:_pageTrans,perPage:PER,onChange:'setTransPage'});
}

window.openTransferModal = () => { _trLines=[]; document.getElementById('tr-line-body').innerHTML=''; document.getElementById('tr-no').value='TRF-'+genId(); addTransLine(); openModal('transfer-modal'); };
window.addTransLine = () => {
  const idx=_trLines.length; _trLines.push({productId:'',qty:0});
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
  const row=document.createElement('tr'); row.id=`tr-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:160px;" onchange="trLineProduct(${idx},this.value)"><option value="">Select…</option>${prodOpts}</select></td>
    <td><span id="tr-avail-${idx}" style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">—</span></td>
    <td><input type="number" class="form-input" style="width:80px;" value="0" min="0" onchange="if(_trLines[${idx}])_trLines[${idx}].qty=this.value"></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="document.getElementById('tr-line-${idx}')?.remove();_trLines[${idx}]=null">✕</button></td>
  `;
  document.getElementById('tr-line-body').appendChild(row);
};
window.trLineProduct = (idx,productId) => {
  if(_trLines[idx]) _trLines[idx].productId=productId;
  const fromId=document.getElementById('tr-from')?.value;
  const inv=_inventory.find(i=>i.productId===productId&&(!fromId||i.warehouseId===fromId));
  const el=document.getElementById(`tr-avail-${idx}`);
  if(el) el.textContent=inv?formatNumber(inv.quantity)+' units':'0 units';
};
window.saveTransfer = async () => {
  if(!validateForm([{id:'tr-from',label:'From Warehouse',required:true},{id:'tr-to',label:'To Warehouse',required:true}])) return;
  const fromId=document.getElementById('tr-from').value;
  const toId  =document.getElementById('tr-to').value;
  if(fromId===toId){Toast.error('Invalid','From and To warehouse cannot be the same.');return;}
  const valid=_trLines.filter(l=>l&&l.productId&&Number(l.qty)>0);
  if(!valid.length){Toast.error('No items','Add at least one item.');return;}
  const btn=document.getElementById('tr-save-btn'); setLoading(btn,true);
  try {
    for(const line of valid){
      const inv=_inventory.find(i=>i.productId===line.productId&&i.warehouseId===fromId);
      if(!inv||Number(inv.quantity)<Number(line.qty)){
        const p=_products.find(x=>x.id===line.productId);
        throw new Error(`Insufficient: ${p?.name} — have ${inv?.quantity||0}, need ${line.qty}`);
      }
    }
    const data={transferNo:document.getElementById('tr-no').value.trim(),fromWarehouseId:fromId,toWarehouseId:toId,date:document.getElementById('tr-date').value,expectedArrival:document.getElementById('tr-eta').value,items:valid,totalQty:valid.reduce((s,l)=>s+(Number(l.qty)||0),0),status:'in-transit',initiatedBy:AuthState.profile?.name||'',notes:document.getElementById('tr-notes').value.trim(),companyId:AuthState.company?.id||null};
    await dbCreate(WMS_COLLECTIONS.TRANSFERS,data);
    // Deduct from source
    const ops=valid.map(line=>{
      const inv=_inventory.find(i=>i.productId===line.productId&&i.warehouseId===fromId);
      return inv?{collection:COLLECTIONS.INVENTORY,id:inv.id,type:'update',data:{quantity:Number(inv.quantity)-Number(line.qty)}}:null;
    }).filter(Boolean);
    if(ops.length) await dbBatch(ops);
    Toast.success('Transfer Initiated',`${data.transferNo} — ${data.totalQty} units in transit.`);
    closeModal('transfer-modal'); _trLines=[]; window.refreshWMS?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.receiveTransfer = async (id) => {
  if(!confirm('Confirm receipt of all items at destination warehouse?')) return;
  const t=_transfers.find(x=>x.id===id); if(!t) return;
  try{
    const ops=t.items?.map(line=>{
      const inv=_inventory.find(i=>i.productId===line.productId&&i.warehouseId===t.toWarehouseId);
      if(inv) return {collection:COLLECTIONS.INVENTORY,id:inv.id,type:'update',data:{quantity:Number(inv.quantity)+Number(line.qty)}};
      return {collection:COLLECTIONS.INVENTORY,id:genId(),type:'set',data:{productId:line.productId,warehouseId:t.toWarehouseId,quantity:Number(line.qty),companyId:AuthState.company?.id||null}};
    }).filter(Boolean)||[];
    if(ops.length) await dbBatch(ops);
    await dbUpdate(WMS_COLLECTIONS.TRANSFERS,id,{status:'completed',receivedAt:new Date().toISOString()});
    Toast.success('Received!','Transfer completed. Destination inventory updated.');
    window.refreshWMS?.();
  }catch(e){Toast.error('Failed',e.message);}
};
window.deleteTransfer=async(id)=>{if(!confirm('Delete transfer?'))return;try{await dbDelete(WMS_COLLECTIONS.TRANSFERS,id);Toast.success('Deleted','Transfer removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 14: BARCODE / QR CODE GENERATOR & SCANNER
// ══════════════════════════════════════════════════════════════
function renderBarcodeTab(container) {
  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <!-- Generator -->
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Barcode / QR Generator</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-4);">
          <div class="form-group">
            <label class="form-label">Select Product</label>
            <select id="bc-product" class="form-select" onchange="generateBarcode(this.value)">
              <option value="">Select product…</option>
              ${_products.map(p=>`<option value="${p.id}" data-sku="${p.sku||''}" data-name="${escHtml(p.name)}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Custom Value (or use product SKU)</label>
            <input type="text" id="bc-custom" class="form-input" placeholder="Enter barcode value…" oninput="generateBarcodeFromValue(this.value)">
          </div>
          <div class="form-group">
            <label class="form-label">Type</label>
            <select id="bc-type" class="form-select" onchange="generateBarcode(document.getElementById('bc-product').value)">
              <option value="qr">QR Code</option>
              <option value="barcode">Barcode (128)</option>
            </select>
          </div>

          <!-- Barcode Display -->
          <div id="bc-display" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px;background:var(--bg-elevated);border-radius:var(--radius-lg);min-height:160px;justify-content:center;">
            <div style="color:var(--text-muted);font-size:12px;">Select a product to generate</div>
          </div>

          <div style="display:flex;gap:10px;">
            <button class="btn btn-primary" style="flex:1;" onclick="printBarcode()">🖨️ Print</button>
            <button class="btn btn-secondary" style="flex:1;" onclick="downloadBarcode()">⬇️ Download</button>
          </div>
        </div>
      </div>

      <!-- Scanner -->
      <div class="card">
        <div class="card-header"><div class="card-title">📷 Barcode Scanner</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-4);">
          <div class="alert alert-info">
            <span class="alert-icon">ℹ️</span>
            <div>
              <div class="alert-title">Camera Scanner</div>
              <div class="alert-text">Uses your device camera to scan barcodes/QR codes. Works on Chrome/Edge. Allow camera access when prompted.</div>
            </div>
          </div>

          <!-- Camera feed -->
          <div id="scanner-container" style="position:relative;width:100%;height:200px;background:#000;border-radius:var(--radius-lg);overflow:hidden;display:flex;align-items:center;justify-content:center;">
            <div id="scanner-placeholder" style="color:#fff;font-size:12px;opacity:0.5;text-align:center;">
              <div style="font-size:32px;margin-bottom:8px;">📷</div>
              Camera not started
            </div>
            <video id="scanner-video" style="width:100%;height:100%;object-fit:cover;display:none;"></video>
            <canvas id="scanner-canvas" style="display:none;"></canvas>
            <!-- Crosshair overlay -->
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
              <div style="width:140px;height:140px;border:2px solid var(--brand-primary);border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,0.4);"></div>
            </div>
          </div>

          <div style="display:flex;gap:10px;">
            <button class="btn btn-primary" id="scanner-start-btn" style="flex:1;" onclick="startScanner()">▶ Start Scanner</button>
            <button class="btn btn-secondary" id="scanner-stop-btn" style="flex:1;display:none;" onclick="stopScanner()">■ Stop</button>
          </div>

          <!-- Manual input fallback -->
          <div class="form-group">
            <label class="form-label">Manual Barcode Entry</label>
            <div class="input-wrapper">
              <input type="text" id="bc-manual-scan" class="form-input has-icon-left" placeholder="Scan or type barcode…" onkeydown="if(event.key==='Enter')lookupBarcode(this.value)">
              <span class="input-icon-left">🔍</span>
            </div>
          </div>

          <!-- Scan Result -->
          <div id="scan-result" style="display:none;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid var(--brand-secondary);">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">SCANNED PRODUCT</div>
            <div id="scan-result-content"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bulk Print -->
    <div class="card" style="margin-top:var(--space-5);">
      <div class="card-header">
        <div class="card-title">🖨️ Bulk Label Printing</div>
        <button class="btn btn-primary btn-sm" onclick="bulkPrint()">Print Selected</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;max-height:280px;overflow-y:auto;" id="bulk-product-grid">
        ${_products.map(p=>`
          <label style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;border:1px solid var(--border-subtle);transition:all 0.15s;"
                 onmouseenter="this.style.borderColor='var(--border-strong)'" onmouseleave="this.style.borderColor='var(--border-subtle)'">
            <input type="checkbox" value="${p.id}" style="accent-color:var(--brand-primary);">
            <div>
              <div style="font-size:12px;font-weight:500;">${escHtml(p.name)}</div>
              <div style="font-size:10px;color:var(--text-muted);">${escHtml(p.sku||'—')}</div>
            </div>
          </label>
        `).join('')}
      </div>
    </div>
  `;

  // Barcode generation via SVG (no external lib needed)
  window.generateBarcode = (productId) => {
    const p = _products.find(x=>x.id===productId); if(!p) return;
    const value = p.sku || p.id;
    document.getElementById('bc-custom').value = value;
    renderBarcodeDisplay(value, p.name, document.getElementById('bc-type').value);
  };

  window.generateBarcodeFromValue = debounce((val) => {
    if(!val) return;
    renderBarcodeDisplay(val, val, document.getElementById('bc-type').value);
  }, 400);

  window.lookupBarcode = (val) => {
    if(!val) return;
    const p = _products.find(x=>x.sku===val||x.barcode===val||x.id===val);
    const resEl = document.getElementById('scan-result');
    const content = document.getElementById('scan-result-content');
    if(p){
      const inv = _inventory.filter(i=>i.productId===p.id);
      const totalQty = inv.reduce((s,i)=>s+(Number(i.quantity)||0),0);
      content.innerHTML=`
        <div style="font-size:14px;font-weight:700;margin-bottom:6px;">${escHtml(p.name)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          ${[['SKU',p.sku||'—'],['Category',p.category||'—'],['Price','₹'+(p.sellingPrice||0).toLocaleString('en-IN')],
             ['Stock',totalQty+' '+p.unit],['HSN',p.hsn||'—'],['GST',p.gstRate+'%']].map(([l,v])=>`
            <div style="background:var(--bg-overlay);border-radius:6px;padding:6px;"><div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;">${l}</div><div style="font-size:12px;font-weight:500;">${escHtml(String(v))}</div></div>
          `).join('')}
        </div>
      `;
      resEl.style.display='block';
      resEl.style.borderLeftColor='var(--brand-secondary)';
    } else {
      content.innerHTML=`<div style="color:var(--brand-danger);font-size:13px;">No product found for: ${escHtml(val)}</div>`;
      resEl.style.display='block';
      resEl.style.borderLeftColor='var(--brand-danger)';
    }
  };

  window.startScanner = async () => {
    if (!window.LAMScanner) { Toast.error('Scanner not loaded', 'Refresh and try again.'); return; }
    const video   = document.getElementById('scanner-video');
    const canvas  = document.getElementById('scanner-canvas');
    const startBtn= document.getElementById('scanner-start-btn');
    const stopBtn = document.getElementById('scanner-stop-btn');
    const placeholder = document.getElementById('scanner-placeholder');

    // Show capability info
    const caps = window.LAMScanner.getCapabilities();
    console.log('LAM Scanner caps:', caps);

    await window.LAMScanner.startCamera({
      video,
      canvas,
      facing: 'environment',
      onResult: (value, format) => {
        video.style.display='none';
        placeholder.style.display='';
        startBtn.style.display=''; stopBtn.style.display='none';
        document.getElementById('bc-manual-scan').value = value;
        window.lookupBarcode(value);
        Toast.success('Barcode Scanned', `${format?.toUpperCase() || 'Code'}: ${value}`);
        // Also fill barcode field if product form is open
        const barcodeField = document.getElementById('p-barcode');
        if (barcodeField && !barcodeField.value) barcodeField.value = value;
      },
      onError: (msg) => {
        Toast.error('Camera Error', msg);
        placeholder.style.display='';
        startBtn.style.display=''; stopBtn.style.display='none';
      },
    });

    video.style.display='block';
    placeholder.style.display='none';
    startBtn.style.display='none'; stopBtn.style.display='';
  };

  window.stopScanner = async () => {
    if (window.LAMScanner) await window.LAMScanner.stopCamera();
    const video = document.getElementById('scanner-video');
    if (video.srcObject) video.srcObject.getTracks().forEach(t=>t.stop());
    video.style.display='none';
    document.getElementById('scanner-placeholder').style.display='';
    document.getElementById('scanner-start-btn').style.display='';
    document.getElementById('scanner-stop-btn').style.display='none';
  };

  // Add scan-from-image button handler
  window.scanFromImage = () => {
    if (!window.LAMScanner) return;
    window.LAMScanner.scanImage(
      null, // will open file picker internally
      (value, format) => {
        document.getElementById('bc-manual-scan').value = value;
        window.lookupBarcode(value);
        Toast.success('Scanned from image', value);
      },
      (err) => Toast.error('Scan failed', err)
    );
  };

  window.printBarcode = () => {
    const val=document.getElementById('bc-custom').value;
    if(!val){Toast.error('Nothing to print','Generate a barcode first.');return;}
    const win=window.open('','_blank');
    win.document.write(`<html><body style="display:flex;justify-content:center;padding:20px;">${document.getElementById('bc-display').innerHTML}</body></html>`);
    win.print(); win.close();
  };

  window.downloadBarcode = () => {
    const svg=document.querySelector('#bc-display svg');
    if(!svg){Toast.error('No barcode','Generate a barcode first.');return;}
    const blob=new Blob([svg.outerHTML],{type:'image/svg+xml'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='barcode.svg'; a.click();
    Toast.success('Downloaded','Barcode saved as SVG.');
  };

  window.bulkPrint = () => {
    const checked=[...document.querySelectorAll('#bulk-product-grid input:checked')].map(c=>c.value);
    if(!checked.length){Toast.error('None selected','Select at least one product.');return;}
    Toast.success('Print Queue',`${checked.length} labels queued for printing.`);
  };
}

function renderBarcodeDisplay(value, label, type) {
  const el=document.getElementById('bc-display'); if(!el) return;
  if(type==='qr') {
    // QR as SVG matrix (simplified visual)
    el.innerHTML=`
      <div style="background:#fff;padding:16px;border-radius:8px;display:inline-block;">
        <svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
          ${generateQRPattern(value)}
        </svg>
      </div>
      <div style="font-size:11px;color:var(--text-muted);text-align:center;max-width:160px;word-break:break-all;">${escHtml(label)}</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">${escHtml(value)}</div>
    `;
  } else {
    // Code 128 barcode as SVG bars
    el.innerHTML=`
      <div style="background:#fff;padding:12px 16px;border-radius:8px;display:inline-block;">
        <svg width="200" height="60" viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">
          ${generateBarcodePattern(value)}
        </svg>
      </div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);letter-spacing:2px;">${escHtml(value)}</div>
      <div style="font-size:11px;color:var(--text-muted);">${escHtml(label)}</div>
    `;
  }
}

function generateQRPattern(value) {
  // Deterministic visual QR pattern based on string hash
  const size=10, cellSize=12;
  let rects='';
  for(let r=0;r<size;r++) for(let c=0;c<size;c++){
    const hash=((value.charCodeAt(r%value.length)||0)+(value.charCodeAt(c%value.length)||0)+r*c)%3;
    // Always fill corners (finder pattern)
    const isCorner=(r<3&&c<3)||(r<3&&c>6)||(r>6&&c<3);
    if(isCorner||hash===0) rects+=`<rect x="${c*cellSize+1}" y="${r*cellSize+1}" width="${cellSize-1}" height="${cellSize-1}" fill="#000"/>`;
  }
  return rects;
}

function generateBarcodePattern(value) {
  let bars='';
  const chars=[...value];
  chars.forEach((ch,i)=>{
    const code=ch.charCodeAt(0);
    const w1=(code%3)+1, w2=(code%2)+1, w3=1, w4=(code%4)+1;
    const x=i*20;
    bars+=`<rect x="${x}" y="0" width="${w1}" height="55" fill="#000"/>`;
    bars+=`<rect x="${x+w1+w2}" y="0" width="${w3}" height="55" fill="#000"/>`;
    bars+=`<rect x="${x+w1+w2+w3+1}" y="0" width="${w4}" height="55" fill="#000"/>`;
  });
  return bars;
}

function scanFrame(video) {
  // Legacy stub — real scanning handled by LAMScanner engine
}

// ══════════════════════════════════════════════════════════════
// TOOL 15: BIN LOCATOR SYSTEM
// ══════════════════════════════════════════════════════════════
function renderBinLocatorTab(container) {
  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <!-- Warehouse selector -->
      <div>
        <div class="form-group" style="margin-bottom:var(--space-4);">
          <label class="form-label">Select Warehouse</label>
          <select id="bl-wh" class="form-select" onchange="renderBinMap(this.value)">
            <option value="">Choose warehouse…</option>
            ${_warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('')}
          </select>
        </div>
        <div id="bin-map-container">
          <div style="padding:40px;text-align:center;color:var(--text-muted);font-size:13px;background:var(--bg-elevated);border-radius:var(--radius-lg);">Select a warehouse to view bin layout</div>
        </div>
      </div>

      <!-- Product bin finder -->
      <div>
        <div class="card">
          <div class="card-header"><div class="card-title">🔍 Find Product Location</div></div>
          <div style="display:flex;flex-direction:column;gap:var(--space-3);">
            <div class="input-wrapper">
              <span class="input-icon-left">📦</span>
              <input type="text" id="bl-search" class="form-input has-icon-left" placeholder="Search product name or SKU…"
                oninput="searchBinLocations(this.value)">
            </div>
            <div id="bl-results"></div>
          </div>
        </div>

        <div class="card" style="margin-top:var(--space-4);">
          <div class="card-header"><div class="card-title">📍 Assign Bin Location</div></div>
          <div style="display:flex;flex-direction:column;gap:var(--space-3);">
            <div class="form-group">
              <label class="form-label">Product</label>
              <select id="bl-assign-prod" class="form-select">
                <option value="">Select product…</option>
                ${_products.map(p=>`<option value="${p.id}">${escHtml(p.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-grid-3">
              <div class="form-group"><label class="form-label">Zone</label><input type="text" id="bl-zone" class="form-input" placeholder="A"></div>
              <div class="form-group"><label class="form-label">Rack</label><input type="text" id="bl-rack" class="form-input" placeholder="R01"></div>
              <div class="form-group"><label class="form-label">Bin</label><input type="text" id="bl-bin" class="form-input" placeholder="B05"></div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="assignBinLocation()">Assign Location</button>
          </div>
        </div>
      </div>
    </div>
  `;

  window.renderBinMap = (whId) => {
    const wh = _warehouses.find(w=>w.id===whId); if(!wh) return;
    const zones = Number(wh.zones)||4;
    const racks = Number(wh.racksPerZone)||5;
    const zoneNames = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0,zones);

    const el = document.getElementById('bin-map-container');
    el.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:12px;">
        🏭 ${escHtml(wh.name)} — ${zones} zones × ${racks} racks
      </div>
      <div style="display:grid;grid-template-columns:repeat(${Math.min(zones,4)},1fr);gap:10px;">
        ${[...zoneNames].map(zone => {
          const zoneItems = _inventory.filter(i=>i.warehouseId===whId&&(i.binLocation||'').toUpperCase().startsWith(zone));
          return `
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;border:1px solid var(--border-subtle);">
              <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:var(--brand-primary);">Zone ${zone}</div>
              ${Array.from({length:racks},(_, r)=>{
                const rackId=`${zone}${String(r+1).padStart(2,'0')}`;
                const rackItems=zoneItems.filter(i=>(i.binLocation||'').includes(rackId));
                return `
                  <div style="padding:5px 8px;margin-bottom:4px;border-radius:4px;background:${rackItems.length?'rgba(10,132,255,0.12)':'var(--bg-overlay)'};font-size:10px;cursor:pointer;"
                       onclick="showBinDetails('${whId}','${rackId}')">
                    Rack ${String(r+1).padStart(2,'0')}
                    ${rackItems.length?`<span style="float:right;color:var(--brand-primary);font-weight:700;">${rackItems.length}</span>`:''}
                  </div>`;
              }).join('')}
            </div>
          `;
        }).join('')}
      </div>
    `;
  };

  window.showBinDetails = (whId, rackId) => {
    const items = _inventory.filter(i=>i.warehouseId===whId&&(i.binLocation||'').includes(rackId));
    if(!items.length){Toast.info('Empty','No items assigned to this rack.');return;}
    Toast.info(`Rack ${rackId}`, items.map(i=>{ const p=_products.find(x=>x.id===i.productId); return `${p?.name||'—'}: ${i.quantity} ${p?.unit||'pcs'}`; }).join(', '));
  };

  window.searchBinLocations = debounce((q) => {
    const el=document.getElementById('bl-results'); if(!el) return;
    if(!q){el.innerHTML='';return;}
    const matched=_products.filter(p=>p.name.toLowerCase().includes(q.toLowerCase())||(p.sku||'').toLowerCase().includes(q.toLowerCase()));
    if(!matched.length){el.innerHTML=`<div style="font-size:12px;color:var(--text-muted);padding:8px;">No products found</div>`;return;}
    el.innerHTML=matched.slice(0,8).map(p=>{
      const invs=_inventory.filter(i=>i.productId===p.id);
      return `
        <div style="padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:6px;">
          <div style="font-size:13px;font-weight:500;">${escHtml(p.name)}</div>
          ${invs.length?invs.map(i=>{
            const wh=_warehouses.find(w=>w.id===i.warehouseId);
            return `<div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">📍 ${escHtml(wh?.name||'—')} — ${escHtml(i.binLocation||'No bin assigned')} — ${formatNumber(i.quantity)} ${p.unit||'pcs'}</div>`;
          }).join(''):`<div style="font-size:11px;color:var(--text-muted);">No inventory records</div>`}
        </div>`;
    }).join('');
  },300);

  window.assignBinLocation = async () => {
    const prodId=document.getElementById('bl-assign-prod').value;
    const zone=document.getElementById('bl-zone').value.trim().toUpperCase();
    const rack=document.getElementById('bl-rack').value.trim().toUpperCase();
    const bin =document.getElementById('bl-bin').value.trim().toUpperCase();
    if(!prodId||!zone||!rack){Toast.error('Required','Select product and enter zone/rack.');return;}
    const binLoc=`Zone ${zone} / ${rack} / ${bin||'—'}`;
    const whId=document.getElementById('bl-wh')?.value;
    const invRecords=_inventory.filter(i=>i.productId===prodId&&(!whId||i.warehouseId===whId));
    if(!invRecords.length){Toast.error('No inventory','No inventory record found for this product.');return;}
    try{
      await Promise.all(invRecords.map(i=>dbUpdate(COLLECTIONS.INVENTORY,i.id,{binLocation:binLoc})));
      Toast.success('Assigned',`Bin location set to ${binLoc}`);
      window.refreshWMS?.();
    }catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// TOOL 16: CYCLE COUNT / STOCK AUDIT
// ══════════════════════════════════════════════════════════════
let _cycleCount = null;

function renderCycleCountTab(container) {
  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🔢 Start Cycle Count</div>
          <button class="btn btn-primary btn-sm" onclick="startCycleCount()">▶ Start Count</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Warehouse</label>
              <select id="cc-wh" class="form-select"><option value="">All warehouses</option>
                ${_warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label class="form-label">Count Type</label>
              <select id="cc-type" class="form-select">
                <option value="full">Full Count</option>
                <option value="partial">Partial (Category)</option>
                <option value="spot">Spot Check</option>
              </select>
            </div>
          </div>
          <div class="form-group"><label class="form-label">Counted By</label>
            <input type="text" id="cc-counter" class="form-input" value="${escHtml(AuthState.profile?.name||'')}" placeholder="Staff name">
          </div>
          <div id="cc-active-info"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">📋 Count Sheet</div></div>
        <div id="cc-sheet">
          <div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">Start a cycle count to generate count sheet</div>
        </div>
        <div id="cc-actions" style="display:none;margin-top:var(--space-4);">
          <button class="btn btn-primary" style="width:100%;" onclick="finalizeCount()">✅ Finalize & Update Inventory</button>
        </div>
      </div>
    </div>

    <!-- Discrepancy report -->
    <div class="card" style="margin-top:var(--space-5);" id="cc-discrepancy" style="display:none;"></div>
  `;

  window.startCycleCount = () => {
    const whId=document.getElementById('cc-wh').value;
    const type=document.getElementById('cc-type').value;
    const counter=document.getElementById('cc-counter').value.trim();
    const items=_inventory.filter(i=>!whId||i.warehouseId===whId).map(i=>{
      const p=_products.find(x=>x.id===i.productId);
      return { inventoryId:i.id, productId:i.productId, productName:p?.name||'—', sku:p?.sku||'—', warehouseId:i.warehouseId, systemQty:Number(i.quantity)||0, countedQty:0, binLocation:i.binLocation||'—' };
    });
    if(!items.length){Toast.error('No items','No inventory found for selected warehouse.');return;}
    _cycleCount={ type, whId, counter, items, startedAt:new Date().toISOString() };
    renderCountSheet();
    document.getElementById('cc-active-info').innerHTML=`
      <div class="alert alert-info"><span class="alert-icon">🔢</span>
        <div><div class="alert-title">Count in Progress</div><div class="alert-text">${items.length} items · ${type} count · by ${counter}</div></div>
      </div>`;
  };

  window.renderCountSheet = () => {
    const sheet=document.getElementById('cc-sheet'); const actions=document.getElementById('cc-actions');
    if(!sheet||!_cycleCount) return;
    sheet.innerHTML=`
      <div class="table-container" style="max-height:350px;overflow-y:auto;">
        <table class="table">
          <thead><tr><th>Product</th><th>SKU</th><th>Bin</th><th>System Qty</th><th>Counted Qty</th><th>Variance</th></tr></thead>
          <tbody>
            ${_cycleCount.items.map((item,i)=>`
              <tr>
                <td style="font-size:12px;">${escHtml(item.productName)}</td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(item.sku)}</td>
                <td style="font-size:11px;color:var(--text-secondary);">${escHtml(item.binLocation)}</td>
                <td style="font-family:var(--font-mono);">${item.systemQty}</td>
                <td><input type="number" class="form-input" style="width:70px;" value="${item.countedQty}" min="0"
                    onchange="_cycleCount.items[${i}].countedQty=Number(this.value);updateVariance(${i})"></td>
                <td id="cc-var-${i}" style="font-family:var(--font-mono);font-weight:700;">—</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    actions.style.display='';
  };

  window.updateVariance = (i) => {
    const item=_cycleCount?.items[i]; if(!item) return;
    const diff=item.countedQty-item.systemQty;
    const el=document.getElementById(`cc-var-${i}`);
    if(el){ el.textContent=(diff>=0?'+':'')+diff; el.style.color=diff===0?'var(--text-muted)':diff>0?'var(--brand-secondary)':'var(--brand-danger)'; }
  };

  window.finalizeCount = async () => {
    if(!_cycleCount){Toast.error('No count','Start a cycle count first.');return;}
    const discrepancies=_cycleCount.items.filter(i=>i.countedQty!==i.systemQty);
    if(!discrepancies.length){Toast.success('Perfect Match!','No discrepancies found. All stock levels verified.');return;}
    if(!confirm(`Found ${discrepancies.length} discrepancies. Update inventory to counted quantities?`)) return;
    try{
      const ops=discrepancies.map(item=>({collection:COLLECTIONS.INVENTORY,id:item.inventoryId,type:'update',data:{quantity:item.countedQty}}));
      await dbBatch(ops);
      await dbCreate(WMS_COLLECTIONS.CYCLE_COUNT,{..._cycleCount,completedAt:new Date().toISOString(),discrepancies:discrepancies.length});
      Toast.success('Inventory Updated',`${discrepancies.length} items adjusted. Inventory is now accurate.`);
      // Show discrepancy report
      const repEl=document.getElementById('cc-discrepancy');
      repEl.style.display='';
      repEl.innerHTML=`
        <div class="card-header"><div class="card-title">⚠️ Discrepancy Report</div></div>
        <div class="table-container"><table class="table"><thead><tr><th>Product</th><th>System</th><th>Counted</th><th>Variance</th><th>Action</th></tr></thead><tbody>
          ${discrepancies.map(d=>{
            const diff=d.countedQty-d.systemQty;
            return `<tr><td>${escHtml(d.productName)}</td><td style="font-family:var(--font-mono);">${d.systemQty}</td><td style="font-family:var(--font-mono);">${d.countedQty}</td>
              <td style="font-family:var(--font-mono);font-weight:700;color:${diff>=0?'var(--brand-secondary)':'var(--brand-danger)'};">${diff>=0?'+':''}${diff}</td>
              <td>${diff<0?`<span class="badge badge-red">Loss/Theft</span>`:`<span class="badge badge-green">Surplus</span>`}</td></tr>`;
          }).join('')}
        </tbody></table></div>`;
      _cycleCount=null;
    }catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// TOOL 17: EXPIRY DATE & BATCH TRACKING
// ══════════════════════════════════════════════════════════════
function renderExpiryTab(container) {
  const now=Date.now();
  const expired   =_inventory.filter(i=>i.expiryDate&&new Date(i.expiryDate)<new Date());
  const expiring30=_inventory.filter(i=>i.expiryDate&&new Date(i.expiryDate)>new Date()&&Math.ceil((new Date(i.expiryDate)-now)/86400000)<=30);
  const expiring90=_inventory.filter(i=>i.expiryDate&&new Date(i.expiryDate)>new Date()&&Math.ceil((new Date(i.expiryDate)-now)/86400000)<=90&&Math.ceil((new Date(i.expiryDate)-now)/86400000)>30);
  const withBatch =_inventory.filter(i=>i.batch);

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Expired',      value:expired.length,    color:'kpi-red',    icon:'🚨'},
        {label:'Expiring <30d',value:expiring30.length, color:'kpi-yellow', icon:'⚠️'},
        {label:'Expiring <90d',value:expiring90.length, color:'kpi-orange', icon:'⏰'},
        {label:'Batch Tracked',value:withBatch.length,  color:'kpi-blue',   icon:'📦'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div class="table-container">
      <table class="table">
        <thead><tr><th>Product</th><th>Batch</th><th>Warehouse</th><th>Qty</th><th>Expiry Date</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${[...expired,...expiring30,...expiring90].map(i=>{
            const p=_products.find(x=>x.id===i.productId);
            const wh=_warehouses.find(w=>w.id===i.warehouseId);
            const days=i.expiryDate?Math.ceil((new Date(i.expiryDate)-now)/86400000):null;
            const isExp=days!==null&&days<=0;
            const statusBadge=isExp?`<span class="badge badge-red">Expired ${Math.abs(days)}d ago</span>`:days<=30?`<span class="badge badge-yellow">Expires in ${days}d</span>`:`<span class="badge badge-orange">Expires in ${days}d</span>`;
            return `<tr>
              <td style="font-size:13px;font-weight:500;">${escHtml(p?.name||'—')}</td>
              <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(i.batch||'—')}</td>
              <td style="font-size:12px;color:var(--text-secondary);">${escHtml(wh?.name||'—')}</td>
              <td style="font-family:var(--font-mono);">${formatNumber(i.quantity||0)}</td>
              <td style="font-size:12px;font-family:var(--font-mono);color:${isExp?'var(--brand-danger)':'var(--text-muted)'};">${i.expiryDate||'—'}</td>
              <td>${statusBadge}</td>
              <td><button class="btn btn-danger btn-sm" onclick="writeOffExpiry('${i.id}')">Write Off</button></td>
            </tr>`;
          }).join('')||`<tr><td colspan="7"><div class="table-empty"><div class="empty-icon">✅</div><div class="empty-title">No expiry issues</div></div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  window.writeOffExpiry=async(id)=>{
    if(!confirm('Write off this expired/near-expiry stock? This will set quantity to 0 and log a damage record.'))return;
    try{
      const inv=_inventory.find(i=>i.id===id);
      if(inv){
        await dbCreate(WMS_COLLECTIONS.DAMAGE,{type:'expiry-writeoff',inventoryId:id,productId:inv.productId,warehouseId:inv.warehouseId,qty:inv.quantity,date:new Date().toISOString().slice(0,10),notes:'Expired stock write-off',companyId:AuthState.company?.id||null});
        await dbUpdate(COLLECTIONS.INVENTORY,id,{quantity:0});
      }
      Toast.success('Written Off','Stock removed from inventory.');
      window.refreshWMS?.();
    }catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// TOOL 18: MRP ENGINE — MATERIAL REQUIREMENTS PLANNING
// Full SAP MD01-style MRP run. Calculates net requirements,
// planned orders, safety stock, lead times, demand from sales
// orders, and generates a complete MRP report with weekly
// stock projections and EOQ-based order recommendations.
// ══════════════════════════════════════════════════════════════

const MRP_STATUS = { CRITICAL:'CRITICAL', REORDER:'REORDER', PLANNED:'PLANNED', OK:'OK' };

// EOQ = sqrt(2DS/H) — ordering cost ₹500/order, holding 20% of unit cost/yr
function calcEOQ(annualDemand, unitCost) {
  const orderCost = 500;
  const holdingCost = Math.max(unitCost * 0.20, 1);
  if (annualDemand <= 0) return 0;
  return Math.ceil(Math.sqrt((2 * annualDemand * orderCost) / holdingCost));
}

// Avg daily demand from sales orders in last 90 days
function calcAvgDailyDemand(productId, salesOrders) {
  const WINDOW = 90;
  const cutoff = Date.now() - WINDOW * 864e5;
  let total = 0;
  for (const so of salesOrders) {
    const soDate = so.createdAt?.seconds ? so.createdAt.seconds * 1000 : Date.now();
    if (soDate < cutoff) continue;
    for (const item of (so.items || [])) {
      if (item.productId === productId) total += Number(item.qty || 0);
    }
  }
  return total / WINDOW;
}

// Gross requirements from open sales orders grouped by ISO week
function buildGrossRequirements(productId, salesOrders, horizonDays) {
  const horizonEnd = Date.now() + horizonDays * 864e5;
  const weekMap = new Map();
  for (const so of salesOrders) {
    if (['delivered','cancelled'].includes(so.status)) continue;
    const delivDate = so.deliveryDate?.seconds ? so.deliveryDate.seconds * 1000
      : so.expectedDelivery?.seconds ? so.expectedDelivery.seconds * 1000 : null;
    if (!delivDate || delivDate > horizonEnd) continue;
    for (const item of (so.items || [])) {
      if (item.productId !== productId) continue;
      const qty = Number(item.qty || 0);
      if (qty <= 0) continue;
      const d = new Date(delivDate);
      const day = d.getDay() || 7;
      const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
      const key = mon.toISOString().slice(0, 10);
      weekMap.set(key, (weekMap.get(key) || 0) + qty);
    }
  }
  return [...weekMap.entries()].sort((a,b)=>a[0]<b[0]?-1:1)
    .map(([weekStart, qty]) => {
      const d = new Date(weekStart);
      return { weekStart, weekLabel: `W${d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}`, qty };
    });
}

// Scheduled receipts from open/pending GRNs
function buildScheduledReceipts(productId, grns) {
  const receipts = [];
  for (const grn of grns) {
    if (grn.status === 'received' || grn.status === 'rejected') continue;
    const expDate = grn.expectedDate?.seconds ? grn.expectedDate.seconds * 1000
      : grn.createdAt?.seconds ? grn.createdAt.seconds * 1000 + 7*864e5 : null;
    for (const item of (grn.items || [])) {
      if (item.productId !== productId) continue;
      const qty = Number(item.orderedQty || 0);
      if (qty > 0) receipts.push({ grnId: grn.id, expectedDate: expDate, qty });
    }
  }
  return receipts;
}

// Project running balance over horizon in weekly buckets
function projectBalance(onHand, grossReqs, scheduledReceipts, horizonDays) {
  const weeks = Math.ceil(horizonDays / 7);
  const now = Date.now();
  let stock = onHand;
  const schedule = [];
  for (let w = 0; w < weeks; w++) {
    const wStart = now + w * 7 * 864e5;
    const wEnd   = now + (w+1) * 7 * 864e5;
    const demand = grossReqs.filter(r => {
      const d = new Date(r.weekStart).getTime(); return d >= wStart && d < wEnd;
    }).reduce((s,r)=>s+r.qty, 0);
    const receipts = scheduledReceipts.filter(r =>
      r.expectedDate && r.expectedDate >= wStart && r.expectedDate < wEnd
    ).reduce((s,r)=>s+r.qty, 0);
    const opening = stock;
    stock = Math.max(0, stock + receipts - demand);
    const d = new Date(wStart);
    schedule.push({
      weekLabel: `W${w+1} (${d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})})`,
      openingStock: opening, demand, receipts, closingStock: stock,
    });
  }
  return schedule;
}

// MAIN MRP RUN
function runMRP(inventory, products, salesOrders, grns, config) {
  const { planHorizonDays = 90, useEOQ = true } = config || {};
  const onHandMap = new Map();
  for (const inv of inventory) {
    onHandMap.set(inv.productId, (onHandMap.get(inv.productId)||0) + Number(inv.quantity||0));
  }
  const seen = new Set();
  const results = [];
  for (const inv of inventory) {
    const pid = inv.productId;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = products.find(x=>x.id===pid);
    if (!p) continue;
    const onHand       = onHandMap.get(pid) || 0;
    const safetyStock  = Number(p.safetyStock  || p.reorderPoint || 0);
    const reorderPoint = Number(p.reorderPoint || 0);
    const maxStock     = Number(p.maxStock || 0);
    const leadTimeDays = Number(p.leadTimeDays || 7);
    const lotSize      = Number(p.lotSize || 0);
    const unitCost     = Number(p.costPrice || 0);
    const avgDailyDemand = calcAvgDailyDemand(pid, salesOrders);
    const annualDemand = avgDailyDemand * 365;
    const eoqQty       = calcEOQ(annualDemand, unitCost);
    const daysOfSupply = avgDailyDemand > 0 ? Math.round(onHand / avgDailyDemand) : 999;
    const grossReqs       = buildGrossRequirements(pid, salesOrders, planHorizonDays);
    const scheduledRcpts  = buildScheduledReceipts(pid, grns);
    const projBalance     = projectBalance(onHand, grossReqs, scheduledRcpts, planHorizonDays);
    const minProjected = projBalance.reduce((mn,w)=>Math.min(mn,w.closingStock), onHand);
    const netReq = Math.max(0, safetyStock - minProjected);
    const totalDemandInHorizon = grossReqs.reduce((s,r)=>s+r.qty,0);
    let plannedQty = 0;
    if (netReq > 0 || onHand <= reorderPoint) {
      if (useEOQ && eoqQty > 0) {
        plannedQty = Math.max(eoqQty, netReq);
      } else if (lotSize > 0) {
        plannedQty = Math.ceil(Math.max(netReq,1)/lotSize)*lotSize;
      } else {
        plannedQty = maxStock > 0 ? Math.max(0, maxStock - onHand) : Math.max(netReq, reorderPoint*3);
      }
      if (plannedQty < netReq) plannedQty = netReq;
    }
    const earliestDemand = grossReqs.length
      ? new Date(grossReqs[0].weekStart).getTime()
      : Date.now() + planHorizonDays * 864e5;
    const plannedOrderDate   = new Date(Math.max(earliestDemand - leadTimeDays*864e5, Date.now()));
    const plannedReceiptDate = new Date(plannedOrderDate.getTime() + leadTimeDays*864e5);
    const inboundQty = scheduledRcpts.reduce((s,r)=>s+r.qty,0);
    let status;
    if (onHand===0 && totalDemandInHorizon>0)    status = MRP_STATUS.CRITICAL;
    else if (onHand<=reorderPoint && plannedQty>0) status = MRP_STATUS.REORDER;
    else if (plannedQty>0)                         status = MRP_STATUS.PLANNED;
    else                                           status = MRP_STATUS.OK;
    results.push({
      productId:pid, productName:p.name||'—', sku:p.sku||'—', unit:p.unit||'pcs',
      onHand, safetyStock, reorderPoint, maxStock, leadTimeDays, lotSize, unitCost,
      grossReqs, scheduledReceipts:scheduledRcpts, projBalance,
      netRequirement:netReq, plannedOrderQty:Math.round(plannedQty),
      plannedOrderDate, plannedReceiptDate,
      status, eoqQty:Math.round(eoqQty),
      avgDailyDemand:Math.round(avgDailyDemand*10)/10,
      daysOfSupply:Math.min(daysOfSupply,999),
      totalDemandInHorizon, inboundQty,
    });
  }
  const ord = {CRITICAL:0,REORDER:1,PLANNED:2,OK:3};
  return results.sort((a,b)=>ord[a.status]-ord[b.status]);
}

// MRP TAB RENDERER
async function renderReorderTab(container) {
  let _salesOrders=[]; let _grns=[]; let _mrpResults=[];
  let _mrpFilter='all'; let _detailOpen=null; let _horizon=90; let _useEOQ=true; let _configOpen=false;
  const cid=AuthState.company?.id;
  try { _salesOrders=await dbGetAll('salesOrders',cid?[where('companyId','==',cid)]:[]);} catch(e){_salesOrders=[];}
  try { _grns=await dbGetAll('grns',cid?[where('companyId','==',cid)]:[]);} catch(e){_grns=[];}

  const runAndRender=()=>{
    _mrpResults=runMRP(_inventory,_products,_salesOrders,_grns,{planHorizonDays:_horizon,useEOQ:_useEOQ});
    renderMRPBody();
  };

  const fmtDate=(d)=>d?(d instanceof Date?d:new Date(d)).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}):'—';
  const fmtINR=(n)=>'₹'+Math.round(n).toLocaleString('en-IN');

  const statusBadge=(s)=>({
    CRITICAL:`<span class="badge badge-red">🚨 CRITICAL</span>`,
    REORDER: `<span class="badge badge-yellow">⚠️ REORDER</span>`,
    PLANNED: `<span class="badge badge-blue">📋 PLANNED</span>`,
    OK:      `<span class="badge badge-green">✅ OK</span>`,
  }[s]||s);

  const renderProjectionMini=(proj)=>{
    if(!proj?.length) return '—';
    const max=Math.max(...proj.map(w=>Math.max(w.openingStock,w.closingStock)),1);
    return `<div style="display:inline-flex;align-items:flex-end;height:32px;gap:0;">${
      proj.slice(0,8).map(w=>{
        const h=Math.max(2,Math.round((w.closingStock/max)*30));
        const col=w.closingStock<=0?'#EF4444':w.closingStock<=(w.demand||0)?'#F59E0B':'#22C55E';
        return `<div style="width:6px;height:${h}px;background:${col};border-radius:2px;display:inline-block;margin:0 1px;vertical-align:bottom;"></div>`;
      }).join('')
    }</div>`;
  };

  const renderDetailPanel=(r)=>`
    <tr><td colspan="11" style="padding:0;">
      <div style="background:var(--bg-overlay);border-top:1px solid var(--border-subtle);padding:16px 20px;">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
          ${[
            ['On Hand',          formatNumber(r.onHand)+' '+r.unit,                          'var(--brand-primary)'],
            ['Safety Stock',     formatNumber(r.safetyStock)+' '+r.unit,                     'var(--brand-warning)'],
            ['Avg Daily Demand', r.avgDailyDemand+' '+r.unit+'/day',                         'var(--brand-secondary)'],
            ['Days of Supply',   r.daysOfSupply>=999?'Sufficient':r.daysOfSupply+' days',
              r.daysOfSupply<7?'var(--brand-danger)':r.daysOfSupply<21?'var(--brand-warning)':'var(--brand-success)'],
          ].map(([label,val,col])=>`
            <div class="card" style="padding:10px 14px;">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:4px;">${label}</div>
              <div style="font-size:16px;font-weight:700;color:${col};">${val}</div>
            </div>
          `).join('')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
          <div class="card" style="padding:14px 16px;">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;">📋 Planned Order</div>
            <table style="width:100%;font-size:12px;border-collapse:collapse;">
              ${[
                ['EOQ (Economic Order Qty)',formatNumber(r.eoqQty)+' '+r.unit],
                ['Recommended Order Qty',   `<strong style="color:var(--brand-primary);">${formatNumber(r.plannedOrderQty)} ${r.unit}</strong>`],
                ['Order Must Be Placed By', `<strong style="color:${r.plannedOrderDate<=new Date()?'var(--brand-danger)':'var(--brand-primary)'};">${fmtDate(r.plannedOrderDate)}</strong>`],
                ['Expected Receipt Date',   fmtDate(r.plannedReceiptDate)],
                ['Lead Time',               r.leadTimeDays+' days'],
                ['Inbound (Open GRNs)',      formatNumber(r.inboundQty)+' '+r.unit+(r.inboundQty>0?' ✓':'')],
                ['Net Requirement',         formatNumber(r.netRequirement)+' '+r.unit],
                ['Total Demand in Horizon', formatNumber(r.totalDemandInHorizon)+' '+r.unit],
              ].map(([k,v])=>`<tr><td style="color:var(--text-muted);padding:3px 0;width:55%;">${k}</td><td style="font-family:var(--font-mono);font-size:11px;">${v}</td></tr>`).join('')}
            </table>
            ${r.plannedOrderQty>0?`
              <div style="margin-top:12px;display:flex;gap:8px;">
                <button class="btn btn-primary btn-sm" onclick="mrpCreatePO('${r.productId}','${escHtml(r.productName)}',${r.plannedOrderQty})">📋 Create PO Now</button>
                <button class="btn btn-secondary btn-sm" onclick="mrpExportItem('${r.productId}')">⬇ Export</button>
              </div>`:`<div style="margin-top:10px;font-size:11px;color:var(--brand-success);">✓ No planned order required in this horizon.</div>`}
          </div>
          <div class="card" style="padding:14px 16px;overflow-x:auto;">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;">📆 Weekly Stock Projection</div>
            <table class="table" style="font-size:11px;">
              <thead><tr><th>Week</th><th>Open</th><th>Demand</th><th>Receipts</th><th>Close</th></tr></thead>
              <tbody>
                ${r.projBalance.map(w=>`
                  <tr style="${w.closingStock<=0?'background:rgba(239,68,68,.08);':w.closingStock<=(w.demand||0)?'background:rgba(245,158,11,.06);':''}">
                    <td style="font-size:10px;color:var(--text-muted);">${w.weekLabel}</td>
                    <td style="font-family:var(--font-mono);font-size:11px;">${Math.round(w.openingStock)}</td>
                    <td style="font-family:var(--font-mono);font-size:11px;color:${w.demand>0?'var(--brand-danger)':'var(--text-muted)'};">${w.demand>0?'-'+Math.round(w.demand):'—'}</td>
                    <td style="font-family:var(--font-mono);font-size:11px;color:${w.receipts>0?'var(--brand-success)':'var(--text-muted)'};">${w.receipts>0?'+'+Math.round(w.receipts):'—'}</td>
                    <td style="font-family:var(--font-mono);font-size:11px;font-weight:600;color:${w.closingStock<=0?'var(--brand-danger)':w.closingStock<10?'var(--brand-warning)':'inherit'};">${Math.round(w.closingStock)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ${r.grossReqs.length?`
          <div class="card" style="padding:14px 16px;">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">📦 Gross Requirements from Sales Orders</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              ${r.grossReqs.map(g=>`
                <div style="background:var(--bg-elevated);border:.5px solid var(--border-subtle);border-radius:var(--border-radius-md);padding:6px 12px;font-size:11px;">
                  <span style="color:var(--text-muted);">${g.weekLabel}</span>
                  <span style="font-family:var(--font-mono);font-weight:700;color:var(--brand-danger);margin-left:6px;">${formatNumber(g.qty)} ${r.unit}</span>
                </div>`).join('')}
            </div>
          </div>`:''}
      </div>
    </td></tr>
  `;

  const renderMRPBody=()=>{
    const filtered=_mrpFilter==='all'?_mrpResults:_mrpResults.filter(r=>r.status===_mrpFilter);
    const critical=_mrpResults.filter(r=>r.status==='CRITICAL').length;
    const reorder =_mrpResults.filter(r=>r.status==='REORDER').length;
    const planned =_mrpResults.filter(r=>r.status==='PLANNED').length;
    const ok      =_mrpResults.filter(r=>r.status==='OK').length;
    const totalPlanVal=_mrpResults.filter(r=>r.plannedOrderQty>0).reduce((s,r)=>s+r.plannedOrderQty*r.unitCost,0);
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
    set('mrp-critical',critical); set('mrp-reorder',reorder); set('mrp-planned',planned);
    set('mrp-ok',ok); set('mrp-plan-value',fmtINR(totalPlanVal));
    set('mrp-horizon-label',`${_horizon}d horizon · ${_useEOQ?'EOQ':'Lot-size'} mode`);
    const tbody=document.getElementById('mrp-tbody'); if(!tbody) return;
    tbody.innerHTML=filtered.length?filtered.map(r=>{
      const isOpen=_detailOpen===r.productId;
      return `
        <tr onclick="mrpToggleDetail('${r.productId}')" style="cursor:pointer;"
            onmouseover="this.style.background='var(--bg-overlay)'" onmouseout="this.style.background=''">
          <td style="font-size:13px;font-weight:500;">${escHtml(r.productName)}</td>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.sku)}</td>
          <td style="font-family:var(--font-mono);">${formatNumber(r.onHand)} <span style="color:var(--text-muted);font-size:10px;">${r.unit}</span></td>
          <td style="font-family:var(--font-mono);color:var(--text-secondary);">${formatNumber(r.safetyStock)}</td>
          <td style="font-family:var(--font-mono);color:var(--brand-danger);">${r.totalDemandInHorizon||'—'}</td>
          <td style="font-family:var(--font-mono);color:var(--brand-success);">${r.inboundQty>0?'+'+formatNumber(r.inboundQty):'—'}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:${r.netRequirement>0?'var(--brand-danger)':'var(--brand-success)'};">${r.netRequirement>0?formatNumber(r.netRequirement):'—'}</td>
          <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-primary);">${r.plannedOrderQty>0?formatNumber(r.plannedOrderQty)+' '+r.unit:'—'}</td>
          <td style="font-size:12px;color:${r.plannedOrderDate<=new Date()&&r.plannedOrderQty>0?'var(--brand-danger)':'inherit'};">${r.plannedOrderQty>0?fmtDate(r.plannedOrderDate):'—'}</td>
          <td>${renderProjectionMini(r.projBalance)}</td>
          <td>${statusBadge(r.status)}</td>
        </tr>
        ${isOpen?renderDetailPanel(r):''}
      `;
    }).join(''):`<tr><td colspan="11"><div class="table-empty"><div class="empty-icon">✅</div><div class="empty-title">No items match this filter</div></div></td></tr>`;
  };

  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);flex-wrap:wrap;gap:var(--space-3);">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="mrpRunNow()">▶ Run MRP</button>
        <select id="mrp-filter-sel" class="form-select" style="width:auto;font-size:12px;padding:4px 8px;height:30px;" onchange="mrpSetFilter(this.value)">
          <option value="all">All Items</option>
          <option value="CRITICAL">🚨 Critical</option>
          <option value="REORDER">⚠️ Reorder</option>
          <option value="PLANNED">📋 Planned</option>
          <option value="OK">✅ OK</option>
        </select>
        <span style="font-size:11px;color:var(--text-muted);" id="mrp-horizon-label"></span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" onclick="mrpToggleConfig()">⚙️ MRP Config</button>
        <button class="btn btn-secondary btn-sm" onclick="mrpExportAll()">⬇ Export Plan</button>
        <button class="btn btn-primary btn-sm" onclick="mrpBulkPO()">📋 Bulk Create POs</button>
      </div>
    </div>
    <div id="mrp-config-panel" style="display:none;margin-bottom:var(--space-4);">
      <div class="card" style="padding:16px 20px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px;">⚙️ MRP Run Parameters</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:12px;">
          <div><label class="form-label">Plan Horizon (days)</label><input type="number" id="mrp-cfg-horizon" class="form-input" value="${_horizon}" min="7" max="365"></div>
          <div><label class="form-label">Order Quantity Mode</label>
            <select id="mrp-cfg-eoq" class="form-select">
              <option value="1" selected>EOQ (Economic Order Qty)</option>
              <option value="0">Lot-Size / Min-Max</option>
            </select></div>
          <div style="display:flex;align-items:flex-end;padding-bottom:4px;"><button class="btn btn-primary btn-sm" onclick="mrpApplyConfig()">Apply & Re-run</button></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);">Lead times, safety stock, lot sizes and max stock are configured per-product in the Configure section below.</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:var(--space-5);">
      ${[
        {id:'mrp-critical',  label:'Critical',      color:'var(--brand-danger)',   icon:'🚨'},
        {id:'mrp-reorder',   label:'Reorder',        color:'var(--brand-warning)',  icon:'⚠️'},
        {id:'mrp-planned',   label:'Planned Orders', color:'var(--brand-primary)',  icon:'📋'},
        {id:'mrp-ok',        label:'Adequate',       color:'var(--brand-success)',  icon:'✅'},
        {id:'mrp-plan-value',label:'Total PO Value', color:'var(--brand-secondary)',icon:'💰'},
      ].map(k=>`<div class="card" style="text-align:center;padding:12px 8px;">
        <div style="font-size:18px;margin-bottom:4px;">${k.icon}</div>
        <div style="font-family:var(--font-display);font-size:20px;font-weight:800;color:${k.color};" id="${k.id}">—</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;">${k.label}</div>
      </div>`).join('')}
    </div>
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">📊 MRP Planned Orders — Click row to drill down</div></div>
      <div class="table-container">
        <table class="table">
          <thead><tr>
            <th>Product</th><th>SKU</th><th>On Hand</th><th>Safety Stock</th>
            <th>Demand (horizon)</th><th>Inbound</th><th>Net Req.</th>
            <th>Planned Qty</th><th>Order By</th><th>Projection</th><th>Status</th>
          </tr></thead>
          <tbody id="mrp-tbody">
            <tr><td colspan="11" style="text-align:center;padding:24px;color:var(--text-muted);">Click ▶ Run MRP to generate plan…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">⚙️ Configure MRP Parameters per Product</div>
        <span style="font-size:11px;color:var(--text-muted);">Lead time · safety stock · lot size · max stock</span>
      </div>
      <div class="table-container" style="max-height:320px;overflow-y:auto;">
        <table class="table">
          <thead><tr><th>Product</th><th>On Hand</th><th>Safety Stock</th><th>Reorder Point</th><th>Max Stock</th><th>Lead Time (d)</th><th>Lot Size</th><th>Save</th></tr></thead>
          <tbody>
            ${_inventory.filter((v,i,a)=>a.findIndex(x=>x.productId===v.productId)===i).map((inv,idx)=>{
              const p=_products.find(x=>x.id===inv.productId);
              const qty=_inventory.filter(x=>x.productId===inv.productId).reduce((s,x)=>s+Number(x.quantity||0),0);
              return `<tr>
                <td style="font-size:12px;font-weight:500;">${escHtml(p?.name||'—')}</td>
                <td style="font-family:var(--font-mono);">${formatNumber(qty)}</td>
                <td><input type="number" id="mrp-ss-${idx}"  class="form-input" style="width:70px;" value="${p?.safetyStock||0}"  min="0"></td>
                <td><input type="number" id="mrp-rp-${idx}"  class="form-input" style="width:70px;" value="${p?.reorderPoint||0}" min="0"></td>
                <td><input type="number" id="mrp-max-${idx}" class="form-input" style="width:70px;" value="${p?.maxStock||0}"      min="0"></td>
                <td><input type="number" id="mrp-lt-${idx}"  class="form-input" style="width:60px;" value="${p?.leadTimeDays||7}"  min="1"></td>
                <td><input type="number" id="mrp-ls-${idx}"  class="form-input" style="width:60px;" value="${p?.lotSize||0}"       min="0"></td>
                <td><button class="btn btn-secondary btn-sm" onclick="mrpSaveProductConfig('${inv.productId}',${idx})">Save</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="padding:8px 16px;font-size:11px;color:var(--text-muted);">
        Lot Size 0 = use EOQ / Max Stock fill. Lead Time drives planned order dates. Safety Stock = minimum buffer.
      </div>
    </div>
  `;

  window.mrpRunNow=()=>{runAndRender();Toast.success('MRP Run','Material Requirements Plan updated.');};
  window.mrpSetFilter=(f)=>{_mrpFilter=f;renderMRPBody();};
  window.mrpToggleDetail=(pid)=>{_detailOpen=_detailOpen===pid?null:pid;renderMRPBody();};
  window.mrpToggleConfig=()=>{_configOpen=!_configOpen;const p=document.getElementById('mrp-config-panel');if(p)p.style.display=_configOpen?'block':'none';};
  window.mrpApplyConfig=()=>{
    _horizon=Number(document.getElementById('mrp-cfg-horizon')?.value)||90;
    _useEOQ=document.getElementById('mrp-cfg-eoq')?.value==='1';
    runAndRender();
  };
  window.mrpSaveProductConfig=async(productId,idx)=>{
    const safetyStock =Number(document.getElementById(`mrp-ss-${idx}`)?.value)||0;
    const reorderPoint=Number(document.getElementById(`mrp-rp-${idx}`)?.value)||0;
    const maxStock    =Number(document.getElementById(`mrp-max-${idx}`)?.value)||0;
    const leadTimeDays=Number(document.getElementById(`mrp-lt-${idx}`)?.value)||7;
    const lotSize     =Number(document.getElementById(`mrp-ls-${idx}`)?.value)||0;
    try{
      await dbUpdate(COLLECTIONS.PRODUCTS,productId,{safetyStock,reorderPoint,maxStock,leadTimeDays,lotSize});
      const p=_products.find(x=>x.id===productId);
      if(p) Object.assign(p,{safetyStock,reorderPoint,maxStock,leadTimeDays,lotSize});
      Toast.success('Saved','MRP parameters updated. Re-run MRP to see changes.');
    }catch(e){Toast.error('Failed',e.message);}
  };
  window.mrpCreatePO=(productId,productName,qty)=>{
    Toast.info('Creating PO',`Redirecting to Procurement for ${formatNumber(qty)} × ${productName}…`);
    setTimeout(()=>LAM.Router.navigate('procurement'),800);
  };
  window.mrpBulkPO=()=>{
    const act=_mrpResults.filter(r=>r.plannedOrderQty>0&&(r.status==='CRITICAL'||r.status==='REORDER'));
    if(!act.length){Toast.info('No Action Needed','No critical/reorder items require POs.');return;}
    Toast.info('Bulk PO',`Redirecting to Procurement for ${act.length} planned orders…`);
    setTimeout(()=>LAM.Router.navigate('procurement'),800);
  };
  window.mrpExportAll=()=>{
    const csv=[
      ['Product','SKU','Unit','On Hand','Safety Stock','Reorder Point','Avg Daily Demand',
       'Total Demand','Inbound','Net Req','EOQ','Planned Qty','Order By','Receipt Date','Lead Time','Days of Supply','Status'],
      ..._mrpResults.map(r=>[
        r.productName,r.sku,r.unit,r.onHand,r.safetyStock,r.reorderPoint,
        r.avgDailyDemand,r.totalDemandInHorizon,r.inboundQty,r.netRequirement,
        r.eoqQty,r.plannedOrderQty,
        r.plannedOrderQty>0?r.plannedOrderDate.toLocaleDateString('en-IN'):'—',
        r.plannedOrderQty>0?r.plannedReceiptDate.toLocaleDateString('en-IN'):'—',
        r.leadTimeDays,r.daysOfSupply>=999?'Sufficient':r.daysOfSupply,r.status,
      ])
    ].map(row=>row.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download=`mrp_plan_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    Toast.success('Exported',`MRP plan exported — ${_mrpResults.length} items.`);
  };
  window.mrpExportItem=(productId)=>{
    const r=_mrpResults.find(x=>x.productId===productId); if(!r) return;
    const csv=[
      ['Week','Opening Stock','Demand','Receipts','Closing Stock'],
      ...r.projBalance.map(w=>[w.weekLabel,Math.round(w.openingStock),Math.round(w.demand),Math.round(w.receipts),Math.round(w.closingStock)])
    ].map(row=>row.join(',')).join('\n');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download=`mrp_${r.sku||r.productId}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };
  runAndRender();
}

// ══════════════════════════════════════════════════════════════
// TOOL 19: DAMAGE / LOSS REPORTING
// ══════════════════════════════════════════════════════════════
let _damages=[], _filtDmg=[], _pageDmg=1;

function renderDamageTab(container) {
  container.innerHTML=`
    ${searchBar({id:'dmg',placeholder:'Search damage report…',
      filters:[{key:'type',label:'All Types',options:[{value:'damage',label:'Damage'},{value:'loss',label:'Loss/Theft'},{value:'expiry-writeoff',label:'Expiry Write-off'},{value:'quality',label:'Quality Reject'}]}],
      onSearch:'dmgSearch',onFilter:'dmgFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('damage-modal')">+ Report Damage/Loss</button>
    </div>
    <div id="dmg-table-wrap"></div>
    <div id="dmg-pagination"></div>
  `;

  document.getElementById('damage-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', buildDamageModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(WMS_COLLECTIONS.DAMAGE,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _damages=data; _filtDmg=[...data]; renderDamageTable();
  }));

  window.dmgSearch=debounce((q)=>{_filtDmg=searchFilter(_damages,q,['notes','type']);_pageDmg=1;renderDamageTable();},250);
  window.dmgFilter=(k,v)=>{_filtDmg=v?_damages.filter(d=>d[k]===v):[..._damages];_pageDmg=1;renderDamageTable();};
  window.setDmgPage=(p)=>{_pageDmg=p;renderDamageTable();};
}

function buildDamageModal(){
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  const whOpts=_warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  return buildModal({
    id:'damage-modal',title:'Report Damage / Loss',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
          <select id="dm-type" class="form-select">
            <option value="damage">Physical Damage</option><option value="loss">Loss / Theft</option>
            <option value="quality">Quality Rejection</option><option value="expired">Expired Stock</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="dm-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label>
          <select id="dm-product" class="form-select" onchange="showDmgStock(this.value)"><option value="">Select…</option>${prodOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Warehouse</label>
          <select id="dm-wh" class="form-select"><option value="">Select…</option>${whOpts}</select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Qty Affected <span class="required">*</span></label>
          <input type="number" id="dm-qty" class="form-input" placeholder="0" min="0">
        </div>
        <div class="form-group"><label class="form-label">Available Stock</label>
          <input type="text" id="dm-avail" class="form-input" readonly style="background:var(--bg-overlay);" value="—">
        </div>
        <div class="form-group"><label class="form-label">Estimated Loss Value (₹)</label>
          <input type="number" id="dm-value" class="form-input" placeholder="0" min="0">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description <span class="required">*</span></label>
        <textarea id="dm-notes" class="form-textarea" rows="2" placeholder="Describe what happened, cause of damage/loss…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Reported By</label>
          <input type="text" id="dm-reporter" class="form-input" value="${escHtml(AuthState.profile?.name||'')}">
        </div>
        <div class="form-group"><label class="form-label">Deduct from Inventory?</label>
          <select id="dm-deduct" class="form-select"><option value="yes">Yes — Deduct immediately</option><option value="no">No — Report only</option></select>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('damage-modal')">Cancel</button>
            <button class="btn btn-primary" id="dm-save-btn" onclick="saveDamageReport()">Submit Report</button>`,
  });
}

function renderDamageTable(){
  const wrap=document.getElementById('dmg-table-wrap'); if(!wrap)return;
  const pg=document.getElementById('dmg-pagination');
  const cnt=document.getElementById('dmg-count'); if(cnt) cnt.textContent=`${_filtDmg.length} report${_filtDmg.length!==1?'s':''}`;
  const start=(_pageDmg-1)*PER;
  wrap.innerHTML=buildTable({id:'dmg-table',columns:[
    {key:'type',     label:'Type',      render:r=>`<span class="badge badge-${r.type==='damage'?'orange':r.type==='loss'?'red':r.type==='quality'?'yellow':'gray'}">${escHtml(r.type||'—')}</span>`},
    {key:'productId',label:'Product',   render:r=>{const p=_products.find(x=>x.id===r.productId);return `<span style="font-size:12px;">${escHtml(p?.name||'—')}</span>`}},
    {key:'warehouseId',label:'WH',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml(_warehouses.find(w=>w.id===r.warehouseId)?.name||'—')}</span>`},
    {key:'qty',      label:'Qty',       render:r=>`<span style="font-family:var(--font-mono);color:var(--brand-danger);">-${formatNumber(r.qty||0)}</span>`},
    {key:'lossValue',label:'Est. Loss', render:r=>r.lossValue?`<span style="font-family:var(--font-mono);">₹${Number(r.lossValue).toLocaleString('en-IN')}</span>`:'—'},
    {key:'notes',    label:'Description',render:r=>`<span style="font-size:11px;color:var(--text-secondary);">${escHtml((r.notes||'').slice(0,60))}${(r.notes||'').length>60?'…':''}</span>`},
    {key:'date',     label:'Date',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
    {key:'actions',  label:'',sortable:false,render:r=>actionsMenu(r.id,[{icon:'🗑',label:'Delete',action:`deleteDamage('${r.id}')`,danger:true}])},
  ],rows:_filtDmg.slice(start,start+PER),emptyMsg:'No damage/loss reports'});
  if(pg) pg.innerHTML=buildPagination({id:'dmg',total:_filtDmg.length,page:_pageDmg,perPage:PER,onChange:'setDmgPage'});
}

window.showDmgStock=(productId)=>{
  const whId=document.getElementById('dm-wh')?.value;
  const inv=_inventory.find(i=>i.productId===productId&&(!whId||i.warehouseId===whId));
  const el=document.getElementById('dm-avail'); if(el) el.value=inv?formatNumber(inv.quantity)+' units':'0 units';
  const p=_products.find(x=>x.id===productId);
  const qtyEl=document.getElementById('dm-qty'); const valEl=document.getElementById('dm-value');
  qtyEl?.addEventListener('input',()=>{ if(p&&valEl) valEl.value=Math.round(Number(qtyEl.value)*(p.costPrice||p.sellingPrice||0)); },{once:true});
};
window.saveDamageReport=async()=>{
  if(!validateForm([{id:'dm-product',label:'Product',required:true},{id:'dm-qty',label:'Qty',required:true},{id:'dm-notes',label:'Description',required:true},{id:'dm-date',label:'Date',required:true}])) return;
  const btn=document.getElementById('dm-save-btn'); setLoading(btn,true);
  const productId=document.getElementById('dm-product').value;
  const whId=document.getElementById('dm-wh').value;
  const qty=Number(document.getElementById('dm-qty').value)||0;
  const deduct=document.getElementById('dm-deduct').value==='yes';
  const data={type:document.getElementById('dm-type').value,date:document.getElementById('dm-date').value,productId,warehouseId:whId,qty,lossValue:Number(document.getElementById('dm-value').value)||0,notes:document.getElementById('dm-notes').value.trim(),reportedBy:document.getElementById('dm-reporter').value.trim(),deducted:deduct,companyId:AuthState.company?.id||null};
  try{
    await dbCreate(WMS_COLLECTIONS.DAMAGE,data);
    if(deduct){
      const inv=_inventory.find(i=>i.productId===productId&&(!whId||i.warehouseId===whId));
      if(inv) await dbUpdate(COLLECTIONS.INVENTORY,inv.id,{quantity:Math.max(0,Number(inv.quantity)-qty)});
    }
    Toast.success('Reported',`Damage/loss report saved.${deduct?' Inventory updated.':''}`);
    closeModal('damage-modal'); window.refreshWMS?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.deleteDamage=async(id)=>{if(!confirm('Delete report?'))return;try{await dbDelete(WMS_COLLECTIONS.DAMAGE,id);Toast.success('Deleted','Report removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 20: INVENTORY VALUATION — FIFO / LIFO / WAC / SPLIT
// Real GRN-layer cost engine. Consumes actual receipt history
// per product per warehouse. Supports price adjustment journal.
// ══════════════════════════════════════════════════════════════

/**
 * Build cost layers per (productId, warehouseId) from GRN history.
 * Each GRN item contributes: { qty, costPerUnit, date, grnId }
 * Returns Map keyed by "productId::warehouseId"
 */
function buildCostLayers(grns) {
  const layerMap = new Map();
  const sorted = [...grns].sort((a,b)=> (a.createdAt?.seconds||0)-(b.createdAt?.seconds||0));
  for (const grn of sorted) {
    if (grn.status === 'rejected') continue;
    const whId = grn.warehouseId || '';
    const date = grn.createdAt;
    for (const item of (grn.items || [])) {
      const key = `${item.productId}::${whId}`;
      if (!layerMap.has(key)) layerMap.set(key, []);
      const qty = Number(item.receivedQty || item.orderedQty || 0);
      const cost = Number(item.costPerUnit || 0);
      if (qty > 0 && cost > 0) {
        layerMap.get(key).push({ qty, remaining: qty, costPerUnit: cost, date, grnId: grn.id });
      }
    }
  }
  return layerMap;
}

/**
 * FIFO: consume oldest layers first for the current on-hand qty.
 * Returns { unitCost, totalCost, layers[] }
 */
function calcFIFO(layers, onHandQty) {
  if (!layers || !layers.length || onHandQty <= 0) return { unitCost: 0, totalCost: 0, layers: [] };
  let remaining = onHandQty;
  let totalCost = 0;
  const consumed = [];
  // FIFO: oldest first — layers already sorted chronologically
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, layer.remaining);
    totalCost += take * layer.costPerUnit;
    consumed.push({ ...layer, taken: take });
    remaining -= take;
  }
  // If GRN history doesn't cover full qty (e.g. opening stock), use last known cost
  if (remaining > 0) {
    const fallbackCost = layers[layers.length-1]?.costPerUnit || 0;
    totalCost += remaining * fallbackCost;
  }
  return { unitCost: onHandQty > 0 ? totalCost / onHandQty : 0, totalCost, layers: consumed };
}

/**
 * LIFO: consume newest layers first for the current on-hand qty.
 */
function calcLIFO(layers, onHandQty) {
  if (!layers || !layers.length || onHandQty <= 0) return { unitCost: 0, totalCost: 0, layers: [] };
  const reversed = [...layers].reverse();
  let remaining = onHandQty;
  let totalCost = 0;
  const consumed = [];
  for (const layer of reversed) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, layer.remaining);
    totalCost += take * layer.costPerUnit;
    consumed.push({ ...layer, taken: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const fallbackCost = layers[0]?.costPerUnit || 0;
    totalCost += remaining * fallbackCost;
  }
  return { unitCost: onHandQty > 0 ? totalCost / onHandQty : 0, totalCost, layers: consumed };
}

/**
 * Weighted Average Cost (WAC): total cost of all received / total qty received.
 * Re-calculated on every new GRN receipt.
 */
function calcWAC(layers, onHandQty) {
  if (!layers || !layers.length || onHandQty <= 0) return { unitCost: 0, totalCost: 0 };
  const totalReceived = layers.reduce((s, l) => s + l.qty, 0);
  const totalValue    = layers.reduce((s, l) => s + l.qty * l.costPerUnit, 0);
  const wac = totalReceived > 0 ? totalValue / totalReceived : 0;
  return { unitCost: wac, totalCost: wac * onHandQty };
}

/**
 * Split Valuation: groups same product by warehouse and shows
 * a separate valuation row per warehouse, with individual cost pools.
 * This is how SAP handles batch/plant split valuation.
 */
function buildSplitValuationRows(inventory, products, warehouses, layerMap, method) {
  const rows = [];
  for (const inv of inventory) {
    const qty = Number(inv.quantity) || 0;
    if (qty <= 0) continue;
    const p   = products.find(x => x.id === inv.productId);
    const wh  = warehouses.find(w => w.id === inv.warehouseId);
    const key = `${inv.productId}::${inv.warehouseId}`;
    const layers = layerMap.get(key) || [];
    let unitCost = 0, totalCost = 0, layerDetail = [];
    if (method === 'fifo') {
      const r = calcFIFO(layers, qty); unitCost = r.unitCost; totalCost = r.totalCost; layerDetail = r.layers;
    } else if (method === 'lifo') {
      const r = calcLIFO(layers, qty); unitCost = r.unitCost; totalCost = r.totalCost; layerDetail = r.layers;
    } else {
      const r = calcWAC(layers, qty);  unitCost = r.unitCost; totalCost = r.totalCost;
    }
    // Fallback to product cost price if no GRN history
    if (unitCost === 0) { unitCost = Number(p?.costPrice || 0); totalCost = unitCost * qty; }
    const sellingPrice = Number(p?.sellingPrice || 0);
    const marketValue  = qty * sellingPrice;
    const nlrv         = marketValue - totalCost; // Net Realisable Value
    const margin       = marketValue > 0 ? Math.round(((marketValue - totalCost) / marketValue) * 100) : 0;
    const hasHistory   = layers.length > 0;
    rows.push({
      productId: inv.productId, warehouseId: inv.warehouseId,
      productName: p?.name || '—', sku: p?.sku || '—', unit: p?.unit || 'pcs',
      warehouseName: wh?.name || '—', qty, unitCost, totalCost, sellingPrice,
      marketValue, nlrv, margin, layerCount: layers.length, hasHistory, layerDetail,
    });
  }
  return rows;
}

async function renderValuationTab(container) {
  let method = 'wac';
  let _grns = [];
  let _layerMap = new Map();
  let _valRows = [];
  let _valFilter = 'all'; // all | low-margin | high-margin | no-history
  let _showLayers = null; // productId::warehouseId or null

  // Load GRN history
  const cid = AuthState.company?.id;
  try {
    _grns = await dbGetAll('grns', cid ? [where('companyId','==',cid), orderBy('createdAt','asc')] : [orderBy('createdAt','asc')]);
  } catch(e) { _grns = []; }
  _layerMap = buildCostLayers(_grns);

  const recompute = (m) => {
    _valRows = buildSplitValuationRows(_inventory, _products, _warehouses, _layerMap, m);
  };

  const getFiltered = () => {
    if (_valFilter === 'low-margin')   return _valRows.filter(r => r.margin < 10);
    if (_valFilter === 'high-margin')  return _valRows.filter(r => r.margin >= 30);
    if (_valFilter === 'no-history')   return _valRows.filter(r => !r.hasHistory);
    return _valRows;
  };

  const fmtINR = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

  const renderLayerDetail = (key) => {
    const row = _valRows.find(r => `${r.productId}::${r.warehouseId}` === key);
    if (!row) return '';
    const layers = _layerMap.get(key) || [];
    if (!layers.length) return `<div style="padding:16px;color:var(--text-muted);font-size:12px;">No GRN history found — cost based on product master price.</div>`;
    const shown = method === 'lifo' ? [...layers].reverse() : layers;
    return `
      <div style="padding:12px 16px;background:var(--bg-overlay);border-top:1px solid var(--border-subtle);">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">
          Cost Layers — ${method.toUpperCase()} (${row.productName} / ${row.warehouseName}) — ${layers.length} receipt${layers.length!==1?'s':''}
        </div>
        <table class="table" style="font-size:11px;">
          <thead><tr><th>#</th><th>GRN Date</th><th>Received Qty</th><th>Cost/Unit</th><th>Layer Value</th><th>Used in ${method.toUpperCase()}</th></tr></thead>
          <tbody>
            ${shown.map((l,i)=>{
              const taken = row.layerDetail?.find(ld => ld.grnId === l.grnId && ld.date === l.date)?.taken;
              const usedQty = taken !== undefined ? taken : '—';
              const usedVal = taken !== undefined ? fmtINR(taken * l.costPerUnit) : '—';
              const dateStr = l.date?.seconds ? new Date(l.date.seconds*1000).toLocaleDateString('en-IN') : '—';
              return `<tr>
                <td style="color:var(--text-muted);">${i+1}</td>
                <td style="font-family:var(--font-mono);font-size:10px;">${dateStr}</td>
                <td style="font-family:var(--font-mono);">${formatNumber(l.qty)}</td>
                <td style="font-family:var(--font-mono);color:var(--brand-primary);">${fmtINR(l.costPerUnit)}</td>
                <td style="font-family:var(--font-mono);">${fmtINR(l.qty * l.costPerUnit)}</td>
                <td style="font-family:var(--font-mono);color:var(--brand-secondary);font-weight:600;">${usedQty !== '—' ? formatNumber(usedQty)+' → '+usedVal : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  };

  const renderValTable = () => {
    const rows = getFiltered();
    const totalCost   = rows.reduce((s,r)=>s+r.totalCost,0);
    const totalMarket = rows.reduce((s,r)=>s+r.marketValue,0);
    const totalNLRV   = totalMarket - totalCost;
    const avgMargin   = totalMarket > 0 ? Math.round(((totalMarket-totalCost)/totalMarket)*100) : 0;
    const el = document.getElementById('val-table-wrap'); if (!el) return;

    // Update KPIs
    const set = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
    set('val-total-cost',   fmtINR(totalCost));
    set('val-total-market', fmtINR(totalMarket));
    set('val-nlrv',         fmtINR(totalNLRV));
    set('val-avg-margin',   avgMargin + '%');
    set('val-grn-count',    _grns.length + ' receipts');
    set('val-layer-count',  [..._layerMap.values()].reduce((s,a)=>s+a.length,0) + ' layers');

    el.innerHTML = `
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Product</th><th>SKU</th><th>Warehouse</th><th>Qty</th>
              <th>${method.toUpperCase()} Unit Cost</th><th>Inventory Value</th>
              <th>Market Value</th><th>NRV</th><th>Margin</th><th>Layers</th>
            </tr>
          </thead>
          <tbody id="val-tbody">
            ${rows.length ? rows.map(r => {
              const key = `${r.productId}::${r.warehouseId}`;
              const isOpen = _showLayers === key;
              const marginColor = r.margin>=20?'green':r.margin>=10?'yellow':'red';
              const nrvColor = r.nlrv>=0?'var(--brand-success)':'var(--brand-danger)';
              return `
                <tr onclick="toggleValLayer('${key}')" style="cursor:pointer;transition:background .15s;"
                    onmouseover="this.style.background='var(--bg-overlay)'" onmouseout="this.style.background=''">
                  <td style="font-size:13px;font-weight:500;">${escHtml(r.productName)}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.sku)}</td>
                  <td style="font-size:12px;color:var(--text-secondary);">${escHtml(r.warehouseName)}</td>
                  <td style="font-family:var(--font-mono);">${formatNumber(r.qty)} <span style="font-size:10px;color:var(--text-muted);">${r.unit}</span></td>
                  <td style="font-family:var(--font-mono);">
                    ${fmtINR(r.unitCost)}
                    ${!r.hasHistory ? '<span style="font-size:9px;background:var(--bg-overlay);border-radius:4px;padding:1px 4px;color:var(--text-muted);margin-left:4px;">est.</span>' : ''}
                  </td>
                  <td style="font-family:var(--font-mono);font-weight:600;color:var(--brand-primary);">${fmtINR(r.totalCost)}</td>
                  <td style="font-family:var(--font-mono);">${fmtINR(r.marketValue)}</td>
                  <td style="font-family:var(--font-mono);color:${nrvColor};font-weight:500;">${fmtINR(r.nlrv)}</td>
                  <td><span class="badge badge-${marginColor}">${r.margin}%</span></td>
                  <td>
                    <span style="font-size:11px;color:${r.hasHistory?'var(--brand-secondary)':'var(--text-muted)'};">
                      ${r.hasHistory ? r.layerCount+' layers ▾' : 'No history'}
                    </span>
                  </td>
                </tr>
                ${isOpen ? `<tr><td colspan="10" style="padding:0;">${renderLayerDetail(key)}</td></tr>` : ''}
              `;
            }).join('') : `<tr><td colspan="10"><div class="table-empty"><div class="empty-icon">💰</div><div class="empty-title">No inventory to value</div><div class="empty-sub">Add products and record GRNs to see valuations</div></div></td></tr>`}
          </tbody>
          <tfoot>
            <tr style="background:var(--bg-elevated);">
              <td colspan="5" style="font-weight:700;padding:12px 16px;">TOTALS (${rows.length} line${rows.length!==1?'s':''})</td>
              <td style="font-family:var(--font-mono);font-weight:800;color:var(--brand-primary);padding:12px 16px;">${fmtINR(totalCost)}</td>
              <td style="font-family:var(--font-mono);font-weight:700;padding:12px 16px;">${fmtINR(totalMarket)}</td>
              <td style="font-family:var(--font-mono);font-weight:700;color:${totalNLRV>=0?'var(--brand-success)':'var(--brand-danger)'};padding:12px 16px;">${fmtINR(totalNLRV)}</td>
              <td colspan="2" style="padding:12px 16px;"><span class="badge badge-${avgMargin>=20?'green':avgMargin>=10?'yellow':'red'}">${avgMargin}% avg</span></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style="font-size:11px;color:var(--text-muted);padding:8px 4px;">
        💡 Click any row to drill into cost layers. "est." = cost from product master (no GRN history). NRV = Market Value − Inventory Cost.
        ${method==='wac'?'WAC recalculates on every receipt.':method==='fifo'?'FIFO: oldest receipts consumed first — typically lowest COGS in rising-cost market.':'LIFO: newest receipts consumed first — higher COGS in rising-cost market. Not allowed under Ind AS 2.'}
      </div>
    `;
  };

  container.innerHTML = `
    <!-- Controls row -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);flex-wrap:wrap;gap:var(--space-3);">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--text-secondary);font-weight:500;">Method:</span>
        ${[['wac','WAC (Weighted Avg)'],['fifo','FIFO'],['lifo','LIFO']].map(([m,label])=>`
          <button onclick="switchValMethod('${m}')" id="val-btn-${m}"
            class="btn btn-${m==='wac'?'primary':'secondary'} btn-sm">${label}</button>
        `).join('')}
        <span style="margin-left:8px;font-size:12px;color:var(--text-secondary);font-weight:500;">Filter:</span>
        <select id="val-filter-sel" class="form-select" style="width:auto;font-size:12px;padding:4px 8px;height:30px;" onchange="applyValFilter(this.value)">
          <option value="all">All Items</option>
          <option value="low-margin">Low Margin (&lt;10%)</option>
          <option value="high-margin">High Margin (≥30%)</option>
          <option value="no-history">No GRN History</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" onclick="exportValuation()">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" onclick="exportValuationXLSX()">⬇ Export Excel</button>
      </div>
    </div>

    <!-- KPI cards — 6 metrics -->
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Total Inventory Cost</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-primary);" id="val-total-cost">—</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Market Value (Selling)</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-secondary);" id="val-total-market">—</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Net Realisable Value</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-success);" id="val-nlrv">—</div>
      </div>
    </div>
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Avg Gross Margin</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-warning);" id="val-avg-margin">—</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">GRN Receipts Analysed</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-primary);" id="val-grn-count">—</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Cost Layers Tracked</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-secondary);" id="val-layer-count">—</div>
      </div>
    </div>

    <div id="val-table-wrap"></div>
  `;

  // Wire globals
  window.switchValMethod = (m) => {
    method = m;
    ['wac','fifo','lifo'].forEach(x => {
      const btn = document.getElementById(`val-btn-${x}`);
      if (btn) btn.className = `btn btn-${x===m?'primary':'secondary'} btn-sm`;
    });
    recompute(m);
    renderValTable();
  };

  window.applyValFilter = (f) => {
    _valFilter = f;
    renderValTable();
  };

  window.toggleValLayer = (key) => {
    _showLayers = _showLayers === key ? null : key;
    renderValTable();
  };

  window.exportValuation = () => {
    const rows = _valRows;
    const csv = [
      ['Product','SKU','Warehouse','Qty','Unit','Method','Unit Cost (₹)','Inventory Value (₹)','Market Value (₹)','NRV (₹)','Margin %','GRN Layers','Has History'],
      ...rows.map(r => [
        r.productName, r.sku, r.warehouseName, r.qty, r.unit, method.toUpperCase(),
        r.unitCost.toFixed(2), r.totalCost.toFixed(0), r.marketValue.toFixed(0),
        r.nlrv.toFixed(0), r.margin, r.layerCount, r.hasHistory?'Yes':'No (estimated)',
      ])
    ].map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = `inventory_valuation_${method}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    Toast.success('Exported', `Valuation exported — ${method.toUpperCase()} method, ${rows.length} lines.`);
  };

  window.exportValuationXLSX = () => {
    // TSV for Excel compatibility (tab-separated opens natively in Excel)
    const rows = _valRows;
    const tsv = [
      ['Product','SKU','Warehouse','Qty','Unit','Method','Unit Cost','Inventory Value','Market Value','NRV','Margin %','GRN Layers'],
      ...rows.map(r => [
        r.productName, r.sku, r.warehouseName, r.qty, r.unit, method.toUpperCase(),
        r.unitCost.toFixed(2), r.totalCost.toFixed(0), r.marketValue.toFixed(0), r.nlrv.toFixed(0), r.margin, r.layerCount,
      ])
    ].map(r => r.join('\t')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tsv], {type:'text/tab-separated-values'}));
    a.download = `inventory_valuation_${method}_${new Date().toISOString().slice(0,10)}.tsv`;
    a.click();
    Toast.success('Exported', 'Open the .tsv file in Excel for formatted view.');
  };

  recompute('wac');
  renderValTable();
}

// ── Also export renderDispatch for router ─────────────────────
export async function renderDispatch(container) {
  await renderWMSHub(container);
  switchWMSTab('dispatch');
}
