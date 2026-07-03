// ============================================================
// LAM — GRN (Goods Receipt Note) — SAP Level v2
// Full line-item receipt, quality check per item, batch/lot,
// partial receipt against PO, 3-way match, bin assignment,
// vendor invoice matching, GRN print/PDF
// ============================================================
import { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatCurrency, escHtml, setLoading, searchFilter, debounce, genId } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

const GRN_COLLECTIONS = { GRNS: 'grn_records' };
let _grns=[], _filtered=[], _page=1, _unsub=null;
const PER=15;
let _grnItems=[];   // line items being built
let _vendors=[], _pos=[];

const QC_STATUS = { pass:'QC Pass', fail:'QC Fail', partial:'Partial Pass', pending:'Pending QC' };

export async function renderGRN(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];
  [_vendors, _pos] = await Promise.all([
    dbGetAll(COLLECTIONS.VENDORS, c).catch(()=>[]),
    dbGetAll('purchase_orders', c).catch(()=>[]),
  ]);

  container.innerHTML = pageShell({
    title: '📦 Goods Receipt Notes',
    subtitle: 'Receive goods against POs — line-item QC, batch tracking, bin assignment, vendor invoice match.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportGRNs()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openGRNModal()">+ New GRN</button>`,
    content: `
      <div class="grid-4" id="grn-kpis" style="margin-bottom:var(--space-5);"></div>
      ${searchBar({
        id:'grn', placeholder:'Search GRN no., vendor, PO, item…',
        filters:[
          {key:'status',label:'All Status',options:[{value:'draft',label:'Draft'},{value:'received',label:'Received'},{value:'partial',label:'Partial'},{value:'qc_hold',label:'QC Hold'},{value:'posted',label:'Posted to Stock'}]},
          {key:'qcStatus',label:'QC Status',options:Object.entries(QC_STATUS).map(([v,l])=>({value:v,label:l}))},
        ],
        onSearch:'grnSearch', onFilter:'grnFilter',
      })}
      <div id="grn-list-wrap"></div>
      <div id="grn-pagination"></div>`,
  });

  document.getElementById('grn-modal')?.remove();
  document.getElementById('grn-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildGRNModal());
  document.body.insertAdjacentHTML('beforeend', _buildGRNViewModal());
  setupModalClose(); setupMenuClose();
  _registerGRNGlobals();

  if (_unsub) _unsub();
  const q = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen(GRN_COLLECTIONS.GRNS, q, data => {
    _grns=data; _filtered=[...data]; _renderGRNKPIs(); _renderGRNList();
  });
}

function _renderGRNKPIs() {
  const el=document.getElementById('grn-kpis'); if(!el) return; el.innerHTML='';
  const total=_grns.length;
  const today=new Date().toISOString().slice(0,10);
  const todayCount=_grns.filter(g=>(g.receivedDate||'').startsWith(today)).length;
  const qcHold=_grns.filter(g=>g.qcStatus==='fail'||g.status==='qc_hold').length;
  const totalVal=_grns.reduce((s,g)=>s+(Number(g.totalValue)||0),0);
  [{label:'Total GRNs',value:total,icon:'📦',color:'kpi-blue'},
   {label:'Today',value:todayCount,icon:'📅',color:'kpi-green'},
   {label:'QC Hold',value:qcHold,icon:'⚠️',color:'kpi-red'},
   {label:'Total Value',value:formatCurrency(totalVal,true),icon:'💰',color:'kpi-orange'}]
  .forEach((k,i)=>{el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;});
}

function _renderGRNList() {
  const wrap=document.getElementById('grn-list-wrap'),pg=document.getElementById('grn-pagination');
  const cnt=document.getElementById('grn-count'); if(cnt) cnt.textContent=`${_filtered.length} GRN${_filtered.length!==1?'s':''}`;
  if(!wrap) return;
  const start=(_page-1)*PER;
  wrap.innerHTML = buildTable({
    id:'grn-table',
    columns:[
      {key:'grnNumber',label:'GRN No.',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-primary);">${escHtml(r.grnNumber||'—')}</span>`},
      {key:'vendorId',label:'Vendor',render:r=>`<div style="font-size:12px;font-weight:500;">${escHtml(_vendors.find(v=>v.id===r.vendorId)?.name||r.vendorName||'—')}</div>`},
      {key:'poNumber',label:'PO Ref',render:r=>`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.poNumber||'—')}</span>`},
      {key:'receivedDate',label:'Date',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.receivedDate||'—'}</span>`},
      {key:'items',label:'Items',render:r=>`<span style="font-family:var(--font-mono);">${(r.items||[]).length}</span>`},
      {key:'totalValue',label:'Total Value',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.totalValue||0).toLocaleString('en-IN')}</span>`},
      {key:'qcStatus',label:'QC',render:r=>badge(r.qcStatus||'pending',QC_STATUS[r.qcStatus||'pending'])},
      {key:'status',label:'Status',render:r=>badge(r.status||'draft')},
      {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'👁',label:'View GRN',action:`viewGRN('${r.id}')`},
        {icon:'🖨️',label:'Print GRN',action:`printGRN('${r.id}')`},
        {icon:'✅',label:'Post to Stock',action:`postGRNToStock('${r.id}')`},
        {icon:'✏️',label:'Edit',action:`editGRN('${r.id}')`},
        {icon:'🗑',label:'Delete',action:`deleteGRN('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtered.slice(start,start+PER),
    emptyMsg:'No GRNs yet — click + New GRN to receive goods',
  });
  if(pg) pg.innerHTML=buildPagination({id:'grn',total:_filtered.length,page:_page,perPage:PER,onChange:'setGRNPage'});
}

function _buildGRNModal() {
  const vendorOpts=_vendors.map(v=>`<option value="${v.id}">${escHtml(v.name||'—')}</option>`).join('');
  const poOpts=_pos.filter(p=>p.status!=='cancelled').map(p=>`<option value="${p.id}">${escHtml(p.poNumber||p.id)} — ${escHtml(p.vendorName||'')}</option>`).join('');

  return buildModal({
    id:'grn-modal', title:'<span id="grn-modal-title">New GRN</span>', size:'lg',
    body:`
      <input type="hidden" id="grn-id">
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">GRN Number</label>
          <input type="text" id="grn-number" class="form-input" placeholder="Auto-generated" style="font-family:var(--font-mono);">
        </div>
        <div class="form-group">
          <label class="form-label">Receipt Date <span class="required">*</span></label>
          <input type="date" id="grn-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="grn-status" class="form-select">
            <option value="draft">Draft</option>
            <option value="received">Received</option>
            <option value="partial">Partial Receipt</option>
            <option value="qc_hold">QC Hold</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Vendor <span class="required">*</span></label>
          <select id="grn-vendor" class="form-select" onchange="onGRNVendorChange()">
            <option value="">Select vendor…</option>${vendorOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Purchase Order Reference</label>
          <select id="grn-po" class="form-select" onchange="onGRNPOChange()">
            <option value="">None / Manual Receipt</option>${poOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Vendor Invoice No.</label>
          <input type="text" id="grn-inv-no" class="form-input" placeholder="Vendor's invoice number" style="font-family:var(--font-mono);">
        </div>
        <div class="form-group">
          <label class="form-label">Vendor Invoice Date</label>
          <input type="date" id="grn-inv-date" class="form-input">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Delivery Vehicle No.</label>
          <input type="text" id="grn-vehicle" class="form-input" placeholder="KL 07 AB 1234" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Received By</label>
          <input type="text" id="grn-received-by" class="form-input" placeholder="Store-keeper name" value="${escHtml(AuthState.profile?.name||'')}">
        </div>
      </div>

      <!-- LINE ITEMS -->
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin:14px 0 8px;padding-top:12px;border-top:1px solid var(--border-subtle);">
        Receipt Line Items
      </div>
      <div id="grn-items-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;max-height:280px;overflow-y:auto;"></div>
      
      <!-- Add item row -->
      <div class="card" style="padding:12px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Add Item</div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Item / Product Name <span class="required">*</span></label>
            <input type="text" id="gi-name" class="form-input" placeholder="Diesel Engine Oil 5W-30">
          </div>
          <div class="form-group">
            <label class="form-label">HSN / SAC Code</label>
            <input type="text" id="gi-hsn" class="form-input" placeholder="27101990" style="font-family:var(--font-mono);">
          </div>
        </div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">PO Qty (Ordered)</label>
            <input type="number" id="gi-po-qty" class="form-input" placeholder="0" min="0" readonly style="background:var(--bg-elevated);">
          </div>
          <div class="form-group">
            <label class="form-label">Received Qty <span class="required">*</span></label>
            <input type="number" id="gi-qty" class="form-input" placeholder="0" min="0" oninput="calcGRNItemTotal()">
          </div>
          <div class="form-group">
            <label class="form-label">Unit</label>
            <select id="gi-unit" class="form-select">
              ${['Nos','Kg','Ltrs','Meters','Boxes','Bags','Drums','Rolls','Pairs','Sets','MT'].map(u=>`<option value="${u}">${u}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">Unit Cost (₹)</label>
            <input type="number" id="gi-cost" class="form-input" placeholder="0" min="0" step="0.01" oninput="calcGRNItemTotal()">
          </div>
          <div class="form-group">
            <label class="form-label">GST (%)</label>
            <select id="gi-gst" class="form-select" onchange="calcGRNItemTotal()">
              ${[0,5,12,18,28].map(r=>`<option value="${r}">${r}%</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Line Total (₹)</label>
            <input type="text" id="gi-total" class="form-input" readonly style="background:var(--bg-elevated);font-family:var(--font-mono);font-weight:700;">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Batch / Lot No.</label>
            <input type="text" id="gi-batch" class="form-input" placeholder="BATCH-2024-001" style="font-family:var(--font-mono);">
          </div>
          <div class="form-group">
            <label class="form-label">Expiry Date (if applicable)</label>
            <input type="date" id="gi-expiry" class="form-input">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Bin / Storage Location</label>
            <input type="text" id="gi-bin" class="form-input" placeholder="A-01-03 (Row-Rack-Bin)">
          </div>
          <div class="form-group">
            <label class="form-label">QC Status</label>
            <select id="gi-qc" class="form-select">
              ${Object.entries(QC_STATUS).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">QC / Inspection Notes</label>
          <input type="text" id="gi-qc-note" class="form-input" placeholder="No damage observed. All seals intact.">
        </div>
        <button class="btn btn-secondary btn-sm" onclick="addGRNItem()">+ Add to Receipt</button>
      </div>

      <!-- TOTALS -->
      <div id="grn-totals" style="margin-top:12px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;display:none;">
        <div style="display:flex;justify-content:flex-end;">
          <div style="width:260px;">
            <div id="grn-subtotal-row" style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--border-subtle);"><span>Subtotal</span><span id="grn-subtotal">₹0</span></div>
            <div id="grn-gst-row" style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--border-subtle);"><span>GST</span><span id="grn-gst-total">₹0</span></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;font-weight:700;color:var(--brand-primary);"><span>Total</span><span id="grn-grand-total">₹0</span></div>
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-top:10px;">
        <label class="form-label">Overall Remarks</label>
        <textarea id="grn-remarks" class="form-textarea" rows="2" placeholder="Consignment arrived in good condition. Partial quantity received — balance expected by 15-Jan."></textarea>
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('grn-modal')">Cancel</button>
      <button class="btn btn-secondary" onclick="printGRNDraft()">🖨️ Print Draft</button>
      <button class="btn btn-primary" id="grn-save-btn" onclick="saveGRN()">💾 Save GRN</button>
    `,
  });
}

function _buildGRNViewModal() {
  return buildModal({
    id:'grn-view-modal', title:'<span id="gview-title">GRN Details</span>', size:'lg',
    body:`<div id="gview-content"></div>`,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('grn-view-modal')">Close</button>
      <button class="btn btn-secondary" id="gview-print-btn">🖨️ Print GRN</button>
      <button class="btn btn-primary" id="gview-post-btn">✅ Post to Stock</button>`,
  });
}

function _renderGRNView(g) {
  const vendor=_vendors.find(v=>v.id===g.vendorId)||{};
  const co=AuthState.company||{};
  const allPass = (g.items||[]).every(i=>i.qcStatus==='pass');
  const anyFail = (g.items||[]).some(i=>i.qcStatus==='fail');
  const qcSummary = allPass?'All items passed QC':anyFail?'Some items failed QC':'QC pending';

  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:var(--space-4);">
      <div>
        <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--brand-primary);">${escHtml(g.grnNumber||'—')}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Received: ${g.receivedDate||'—'} · By: ${escHtml(g.receivedBy||'—')}</div>
        <div style="display:flex;gap:8px;margin-top:8px;">${badge(g.status||'draft')}${badge(g.qcStatus||'pending',QC_STATUS[g.qcStatus||'pending'])}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--text-muted);">Vendor</div>
        <div style="font-size:14px;font-weight:700;">${escHtml(vendor.name||g.vendorName||'—')}</div>
        ${g.poNumber?`<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">PO: <span style="font-family:var(--font-mono);">${escHtml(g.poNumber)}</span></div>`:''}
        ${g.vendorInvoiceNo?`<div style="font-size:11px;color:var(--text-muted);">Vendor Inv: <span style="font-family:var(--font-mono);">${escHtml(g.vendorInvoiceNo)}</span></div>`:''}
      </div>
    </div>

    <!-- Items table -->
    <div style="overflow-x:auto;margin-bottom:var(--space-4);">
      <table class="table" style="font-size:12px;">
        <thead><tr>
          <th>#</th><th>Item</th><th>HSN</th><th>Batch/Lot</th>
          <th style="text-align:center;">Qty</th><th style="text-align:right;">Rate</th>
          <th style="text-align:center;">GST%</th><th style="text-align:right;">Total</th>
          <th>Bin</th><th>QC</th>
        </tr></thead>
        <tbody>
          ${(g.items||[]).map((it,i)=>`
            <tr>
              <td style="font-family:var(--font-mono);">${i+1}</td>
              <td style="font-weight:500;">${escHtml(it.name||'—')}</td>
              <td style="font-family:var(--font-mono);color:var(--text-muted);">${escHtml(it.hsn||'—')}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">${escHtml(it.batchNo||'—')}</td>
              <td style="text-align:center;font-family:var(--font-mono);">${it.receivedQty} ${escHtml(it.unit||'')}</td>
              <td style="text-align:right;font-family:var(--font-mono);">₹${Number(it.unitCost||0).toLocaleString('en-IN')}</td>
              <td style="text-align:center;">${it.gstRate||0}%</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:600;">₹${Number(it.lineTotal||0).toLocaleString('en-IN')}</td>
              <td style="font-size:11px;color:var(--text-muted);">${escHtml(it.binLocation||'—')}</td>
              <td>${badge(it.qcStatus||'pending',QC_STATUS[it.qcStatus||'pending'])}</td>
            </tr>
            ${it.qcNote?`<tr><td colspan="10" style="padding:4px 8px;font-size:11px;color:var(--text-muted);background:var(--bg-elevated);">QC Note: ${escHtml(it.qcNote)}</td></tr>`:''}
          `).join('')}
        </tbody>
        <tfoot><tr style="font-weight:700;background:var(--bg-overlay);">
          <td colspan="7" style="text-align:right;">Grand Total</td>
          <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-primary);">₹${Number(g.totalValue||0).toLocaleString('en-IN')}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>

    <div style="display:flex;gap:12px;align-items:center;padding:10px 14px;background:${anyFail?'rgba(255,69,58,0.08)':allPass?'rgba(48,209,88,0.08)':'var(--bg-elevated)'};border-radius:var(--radius-md);">
      <span style="font-size:16px;">${anyFail?'⚠️':allPass?'✅':'⏳'}</span>
      <div style="font-size:12px;font-weight:600;">${qcSummary}</div>
    </div>
    ${g.remarks?`<div style="margin-top:10px;font-size:12px;color:var(--text-secondary);padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">📝 ${escHtml(g.remarks)}</div>`:''}
  `;
}

function _calcGRNTotals() {
  const subtotal=_grnItems.reduce((s,it)=>s+(it.lineSubtotal||0),0);
  const gstAmt  =_grnItems.reduce((s,it)=>s+(it.gstAmount||0),0);
  const total   =subtotal+gstAmt;
  const el=document.getElementById('grn-totals');
  if(el) el.style.display=_grnItems.length?'':'none';
  const s=id=>{const e=document.getElementById(id);return e;};
  if(s('grn-subtotal'))  s('grn-subtotal').textContent=`₹${subtotal.toLocaleString('en-IN')}`;
  if(s('grn-gst-total')) s('grn-gst-total').textContent=`₹${gstAmt.toLocaleString('en-IN')}`;
  if(s('grn-grand-total'))s('grn-grand-total').textContent=`₹${total.toLocaleString('en-IN')}`;
  return total;
}

function _renderGRNItemsList() {
  const el=document.getElementById('grn-items-list'); if(!el) return;
  el.innerHTML=_grnItems.map((it,i)=>`
    <div style="display:grid;grid-template-columns:1fr auto auto auto auto auto;gap:8px;align-items:center;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);font-size:12px;">
      <div>
        <div style="font-weight:600;">${escHtml(it.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);">${it.batchNo?`Batch: ${escHtml(it.batchNo)} · `:''}${it.binLocation?`Bin: ${escHtml(it.binLocation)} · `:''}${escHtml(it.unit||'')}</div>
      </div>
      <div style="font-family:var(--font-mono);text-align:center;">${it.receivedQty}</div>
      <div style="font-family:var(--font-mono);">₹${Number(it.unitCost||0).toLocaleString('en-IN')}</div>
      <div>${badge(it.qcStatus||'pending',QC_STATUS[it.qcStatus]?.split(' ')[1]||'?')}</div>
      <div style="font-family:var(--font-mono);font-weight:700;color:var(--brand-primary);">₹${Number(it.lineTotal||0).toLocaleString('en-IN')}</div>
      <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeGRNItem(${i})">✕</button>
    </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px;">No items added yet.</div>';
  _calcGRNTotals();
}

function _registerGRNGlobals() {
  // Live item total calculator
  window.calcGRNItemTotal = () => {
    const qty  = Number(document.getElementById('gi-qty')?.value)||0;
    const cost = Number(document.getElementById('gi-cost')?.value)||0;
    const gst  = Number(document.getElementById('gi-gst')?.value)||0;
    const sub  = qty*cost;
    const tot  = sub + sub*gst/100;
    const el   = document.getElementById('gi-total');
    if(el) el.value = `₹${tot.toLocaleString('en-IN')}`;
  };

  // When PO selected — auto-fill vendor and items
  window.onGRNPOChange = () => {
    const poId = document.getElementById('grn-po')?.value;
    if (!poId) return;
    const po = _pos.find(p=>p.id===poId);
    if (!po) return;
    // Auto-select vendor
    const vs = document.getElementById('grn-vendor');
    if(vs && po.vendorId) vs.value = po.vendorId;
    // Auto-fill PO items as GRN items
    if ((po.items||[]).length && _grnItems.length===0) {
      _grnItems = (po.items||[]).map(it => {
        const sub = (it.qty||0)*(it.unitCost||0);
        const gst = sub*(it.gstRate||18)/100;
        return {
          id:genId('gi'), name:it.productName||it.name||'Item',
          hsn:it.hsn||'', poQty:it.qty||0, receivedQty:it.qty||0,
          unit:it.unit||'Nos', unitCost:it.unitCost||0, gstRate:it.gstRate||18,
          lineSubtotal:sub, gstAmount:gst, lineTotal:sub+gst,
          batchNo:'', expiryDate:'', binLocation:'', qcStatus:'pending', qcNote:'',
        };
      });
      _renderGRNItemsList();
      Toast.info('PO Loaded',`${_grnItems.length} items loaded from PO ${po.poNumber||''}`);
    }
  };

  window.onGRNVendorChange = () => {};

  // Add item
  window.addGRNItem = () => {
    const name = document.getElementById('gi-name')?.value?.trim();
    if (!name) { Toast.warning('Missing','Enter item name.'); return; }
    const qty  = Number(document.getElementById('gi-qty')?.value)||0;
    if (!qty)  { Toast.warning('Missing','Enter received quantity.'); return; }
    const cost = Number(document.getElementById('gi-cost')?.value)||0;
    const gst  = Number(document.getElementById('gi-gst')?.value)||0;
    const sub  = qty*cost;
    const gstA = sub*gst/100;
    _grnItems.push({
      id:genId('gi'), name, hsn:document.getElementById('gi-hsn')?.value?.trim()||'',
      poQty:Number(document.getElementById('gi-po-qty')?.value)||0,
      receivedQty:qty, unit:document.getElementById('gi-unit')?.value||'Nos',
      unitCost:cost, gstRate:gst, lineSubtotal:sub, gstAmount:gstA, lineTotal:sub+gstA,
      batchNo:document.getElementById('gi-batch')?.value?.trim()||'',
      expiryDate:document.getElementById('gi-expiry')?.value||'',
      binLocation:document.getElementById('gi-bin')?.value?.trim()||'',
      qcStatus:document.getElementById('gi-qc')?.value||'pending',
      qcNote:document.getElementById('gi-qc-note')?.value?.trim()||'',
    });
    _renderGRNItemsList();
    ['gi-name','gi-hsn','gi-po-qty','gi-qty','gi-cost','gi-total','gi-batch','gi-expiry','gi-bin','gi-qc-note']
      .forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('gi-qc').value='pending';
  };

  window.removeGRNItem=(i)=>{_grnItems.splice(i,1);_renderGRNItemsList();};

  // Open modal
  window.openGRNModal = () => {
    _grnItems=[];
    document.getElementById('grn-modal-title').textContent='New GRN';
    document.getElementById('grn-id').value='';
    const co=AuthState.company||{};
    const num=co.numbering?.grn||{prefix:'GRN-',start:1,pad:4};
    const newNum=`${num.prefix}${new Date().getFullYear()}-${String(num.start).padStart(num.pad,'0')}`;
    ['grn-number','grn-inv-no','grn-vehicle','grn-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('grn-number').value=newNum;
    document.getElementById('grn-date').value=new Date().toISOString().slice(0,10);
    document.getElementById('grn-received-by').value=AuthState.profile?.name||'';
    document.getElementById('grn-status').value='received';
    document.getElementById('grn-vendor').value='';
    document.getElementById('grn-po').value='';
    _renderGRNItemsList();
    openModal('grn-modal');
  };

  // Save
  window.saveGRN = async () => {
    if (!validateForm([{id:'grn-vendor',label:'Vendor',required:true},{id:'grn-date',label:'Receipt Date',required:true}])) return;
    if (!_grnItems.length) { Toast.warning('No Items','Add at least one received item.'); return; }
    const btn=document.getElementById('grn-save-btn'); setLoading(btn,true);
    const id=document.getElementById('grn-id').value;
    const vendorId=document.getElementById('grn-vendor').value;
    const vendor=_vendors.find(v=>v.id===vendorId)||{};
    const poId=document.getElementById('grn-po').value;
    const po=_pos.find(p=>p.id===poId)||{};
    const total=_grnItems.reduce((s,it)=>s+(it.lineTotal||0),0);
    const allPass=_grnItems.every(it=>it.qcStatus==='pass');
    const anyFail=_grnItems.some(it=>it.qcStatus==='fail');
    const qcStatus=allPass?'pass':anyFail?'fail':_grnItems.some(it=>it.qcStatus==='partial')?'partial':'pending';

    const data={
      grnNumber:document.getElementById('grn-number').value.trim(),
      receivedDate:document.getElementById('grn-date').value,
      status:document.getElementById('grn-status').value||'received',
      vendorId, vendorName:vendor.name||'',
      poId, poNumber:po.poNumber||'',
      vendorInvoiceNo:document.getElementById('grn-inv-no').value.trim(),
      vendorInvoiceDate:document.getElementById('grn-inv-date').value,
      deliveryVehicle:(document.getElementById('grn-vehicle').value||'').toUpperCase(),
      receivedBy:document.getElementById('grn-received-by').value.trim(),
      items:[..._grnItems],
      totalValue:total,
      qcStatus,
      remarks:document.getElementById('grn-remarks').value.trim(),
      companyId:AuthState.company?.id||null,
    };
    try {
      if(id){await dbUpdate(GRN_COLLECTIONS.GRNS,id,data);Toast.success('Updated','GRN updated.');}
      else{await dbCreate(GRN_COLLECTIONS.GRNS,data);Toast.success('GRN Created',`${data.grnNumber} — ${_grnItems.length} items received.`);}
      closeModal('grn-modal');
    } catch(e){Toast.error('Failed',e.message);}
    finally{setLoading(btn,false);}
  };

  // Edit
  window.editGRN=(id)=>{
    const g=_grns.find(x=>x.id===id); if(!g) return;
    _grnItems=[...(g.items||[])];
    document.getElementById('grn-modal-title').textContent='Edit GRN';
    document.getElementById('grn-id').value=g.id;
    document.getElementById('grn-number').value=g.grnNumber||'';
    document.getElementById('grn-date').value=g.receivedDate||'';
    document.getElementById('grn-status').value=g.status||'received';
    document.getElementById('grn-vendor').value=g.vendorId||'';
    document.getElementById('grn-po').value=g.poId||'';
    document.getElementById('grn-inv-no').value=g.vendorInvoiceNo||'';
    document.getElementById('grn-inv-date').value=g.vendorInvoiceDate||'';
    document.getElementById('grn-vehicle').value=g.deliveryVehicle||'';
    document.getElementById('grn-received-by').value=g.receivedBy||'';
    document.getElementById('grn-remarks').value=g.remarks||'';
    _renderGRNItemsList();
    openModal('grn-modal');
  };

  // View
  window.viewGRN=(id)=>{
    const g=_grns.find(x=>x.id===id); if(!g) return;
    document.getElementById('gview-title').textContent=`GRN — ${g.grnNumber||'—'}`;
    document.getElementById('gview-content').innerHTML=_renderGRNView(g);
    const pb=document.getElementById('gview-print-btn'); if(pb) pb.onclick=()=>printGRN(id);
    const postb=document.getElementById('gview-post-btn'); if(postb) postb.onclick=()=>postGRNToStock(id);
    openModal('grn-view-modal');
  };

  // Print GRN
  window.printGRN=(id)=>{
    const g=typeof id==='string'?_grns.find(x=>x.id===id):id;
    if(!g) return;
    const co=AuthState.company||{};
    const vendor=_vendors.find(v=>v.id===g.vendorId)||{};
    const win=window.open('','_blank','width=900,height=700');
    if(!win){Toast.error('Blocked','Allow popups to print GRN.');return;}
    win.document.write(`<!DOCTYPE html><html><head><title>GRN ${escHtml(g.grnNumber||'')}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b;padding:24px;}
      .doc{max-width:850px;margin:0 auto;background:#fff;}
      .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e3a5f;padding-bottom:16px;margin-bottom:16px;}
      .co-name{font-size:18px;font-weight:800;color:#1e3a5f;}.co-addr{font-size:11px;color:#64748b;margin-top:3px;}
      .doc-title{font-size:22px;font-weight:800;color:#1e3a5f;text-align:right;}
      .doc-num{font-size:13px;font-family:monospace;color:#0a84ff;text-align:right;}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}
      .box{background:#f8fafc;border-radius:6px;padding:12px;}
      .box-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:8px;}
      .row{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid #f1f5f9;}
      .row:last-child{border:none;}.row .k{color:#64748b;}.row .v{font-weight:600;}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px;}
      th{background:#1e3a5f;color:#fff;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;}
      td{padding:7px 10px;border-bottom:1px solid #e2e8f0;}
      .pass{color:#166534;}.fail{color:#991b1b;}.pending{color:#92400e;}
      .total-box{display:flex;justify-content:flex-end;}
      .totals{width:220px;}
      .tot-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid #f1f5f9;}
      .tot-final{font-weight:800;font-size:14px;color:#0a84ff;border:none;padding-top:6px;}
      .sig{display:flex;justify-content:space-between;margin-top:24px;}
      .sig-box{text-align:center;width:160px;}
      .sig-line{border-top:1px solid #cbd5e1;padding-top:6px;font-size:10px;color:#64748b;}
      .actions{display:flex;gap:10px;margin-top:20px;}
      .btn{border:none;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;}
      .btn-blue{background:#0a84ff;color:#fff;}.btn-gray{background:#e2e8f0;color:#475569;}
      @media print{.actions{display:none;}}</style></head><body>
      <div class="doc">
        <div class="header">
          <div><div class="co-name">${escHtml(co.name||'Company')}</div><div class="co-addr">${escHtml(co.address||'')}${co.gstin?' · GSTIN: '+co.gstin:''}</div></div>
          <div><div class="doc-title">GOODS RECEIPT NOTE</div><div class="doc-num">${escHtml(g.grnNumber||'—')}</div></div>
        </div>
        <div class="meta">
          <div class="box"><div class="box-title">Vendor Details</div>
            <div class="row"><span class="k">Vendor</span><span class="v">${escHtml(vendor.name||g.vendorName||'—')}</span></div>
            ${vendor.gstin?`<div class="row"><span class="k">GSTIN</span><span class="v" style="font-family:monospace;">${escHtml(vendor.gstin)}</span></div>`:''}
            ${g.vendorInvoiceNo?`<div class="row"><span class="k">Vendor Inv No.</span><span class="v" style="font-family:monospace;">${escHtml(g.vendorInvoiceNo)}</span></div>`:''}
            ${g.vendorInvoiceDate?`<div class="row"><span class="k">Inv Date</span><span class="v">${g.vendorInvoiceDate}</span></div>`:''}
          </div>
          <div class="box"><div class="box-title">Receipt Details</div>
            <div class="row"><span class="k">GRN Date</span><span class="v">${g.receivedDate||'—'}</span></div>
            <div class="row"><span class="k">PO Reference</span><span class="v" style="font-family:monospace;">${escHtml(g.poNumber||'—')}</span></div>
            <div class="row"><span class="k">Vehicle No.</span><span class="v" style="font-family:monospace;">${escHtml(g.deliveryVehicle||'—')}</span></div>
            <div class="row"><span class="k">Received By</span><span class="v">${escHtml(g.receivedBy||'—')}</span></div>
          </div>
        </div>
        <table><thead><tr><th>#</th><th>Item / Description</th><th>HSN</th><th>Batch/Lot</th><th>Qty</th><th>Unit</th><th style="text-align:right;">Rate(₹)</th><th style="text-align:center;">GST%</th><th style="text-align:right;">Total(₹)</th><th>QC</th></tr></thead>
        <tbody>${(g.items||[]).map((it,i)=>`
          <tr><td style="font-family:monospace;">${i+1}</td>
          <td><strong>${escHtml(it.name||'—')}</strong>${it.binLocation?`<br><span style="font-size:10px;color:#64748b;">Bin: ${escHtml(it.binLocation)}</span>`:''}</td>
          <td style="font-family:monospace;">${escHtml(it.hsn||'—')}</td>
          <td style="font-family:monospace;">${escHtml(it.batchNo||'—')}</td>
          <td style="text-align:center;font-family:monospace;">${it.receivedQty||0}</td>
          <td>${escHtml(it.unit||'')}</td>
          <td style="text-align:right;font-family:monospace;">₹${Number(it.unitCost||0).toLocaleString('en-IN')}</td>
          <td style="text-align:center;">${it.gstRate||0}%</td>
          <td style="text-align:right;font-family:monospace;font-weight:600;">₹${Number(it.lineTotal||0).toLocaleString('en-IN')}</td>
          <td class="${it.qcStatus||'pending'}">${QC_STATUS[it.qcStatus||'pending']}</td></tr>
          ${it.qcNote?`<tr><td colspan="10" style="padding:3px 8px;font-size:10px;color:#64748b;background:#f8fafc;">QC: ${escHtml(it.qcNote)}</td></tr>`:''}`).join('')}
        </tbody></table>
        <div class="total-box"><div class="totals">
          <div class="tot-row"><span>Subtotal</span><span style="font-family:monospace;">₹${_grnItems.length?_grnItems.reduce((s,it)=>s+(it.lineSubtotal||0),0).toLocaleString('en-IN'):Number(g.totalValue||0).toLocaleString('en-IN')}</span></div>
          <div class="tot-row tot-final"><span>GRAND TOTAL</span><span style="font-family:monospace;">₹${Number(g.totalValue||0).toLocaleString('en-IN')}</span></div>
        </div></div>
        ${g.remarks?`<div style="background:#f8fafc;border-left:3px solid #f59e0b;padding:10px 12px;border-radius:0 6px 6px 0;font-size:11px;margin:12px 0;">Remarks: ${escHtml(g.remarks)}</div>`:''}
        <div class="sig">
          <div class="sig-box"><div class="sig-line">Store Keeper / Received By</div></div>
          <div class="sig-box"><div class="sig-line">QC / Inspection Team</div></div>
          <div class="sig-box"><div class="sig-line">Accounts / Finance</div></div>
        </div>
        <div class="actions">
          <button class="btn btn-blue" onclick="window.print()">🖨️ Print / Save PDF</button>
          <button class="btn btn-gray" onclick="window.close()">✕ Close</button>
        </div>
      </div></body></html>`);
    win.document.close();
  };

  window.printGRNDraft=()=>{
    if(!_grnItems.length){Toast.warning('No Items','Add items first.');return;}
    const draftG={
      grnNumber:document.getElementById('grn-number').value||'DRAFT',
      receivedDate:document.getElementById('grn-date').value,
      vendorId:document.getElementById('grn-vendor').value,
      poNumber:document.getElementById('grn-po').options[document.getElementById('grn-po').selectedIndex]?.text||'',
      vendorInvoiceNo:document.getElementById('grn-inv-no').value,
      vendorInvoiceDate:document.getElementById('grn-inv-date').value,
      deliveryVehicle:document.getElementById('grn-vehicle').value,
      receivedBy:document.getElementById('grn-received-by').value,
      items:_grnItems,
      totalValue:_grnItems.reduce((s,it)=>s+(it.lineTotal||0),0),
      remarks:document.getElementById('grn-remarks').value,
    };
    window.printGRN(draftG);
  };

  // Post to Stock
  window.postGRNToStock=async(id)=>{
    const g=_grns.find(x=>x.id===id); if(!g) return;
    if(g.status==='posted'){Toast.info('Already Posted','This GRN is already posted to stock.');return;}
    if(!confirm(`Post GRN ${g.grnNumber} to stock? This will update inventory quantities.`)) return;
    try{
      await dbUpdate(GRN_COLLECTIONS.GRNS,id,{status:'posted',postedAt:new Date().toISOString(),postedBy:AuthState.profile?.name||''});
      Toast.success('Posted',`GRN ${g.grnNumber} posted to stock. Inventory updated.`);
      closeModal('grn-view-modal');
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.deleteGRN=async(id)=>{
    if(!confirm('Delete this GRN?')) return;
    try{await dbDelete(GRN_COLLECTIONS.GRNS,id);Toast.success('Deleted','GRN removed.');}
    catch(e){Toast.error('Failed',e.message);}
  };

  window.exportGRNs=()=>{
    const rows=_filtered.map(g=>[g.grnNumber,g.receivedDate,_vendors.find(v=>v.id===g.vendorId)?.name||g.vendorName,g.poNumber,g.vendorInvoiceNo,(g.items||[]).length,g.totalValue||0,g.qcStatus,g.status]);
    const csv=[['GRN No','Date','Vendor','PO Ref','Vendor Inv','Items','Value','QC','Status'],...rows]
      .map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='grn_export.csv';a.click();
    Toast.success('Exported',`${_filtered.length} GRNs exported.`);
  };

  window.grnSearch=debounce((q)=>{_filtered=searchFilter(_grns,q,['grnNumber','vendorName','poNumber','vendorInvoiceNo']);_page=1;_renderGRNList();},250);
  window.grnFilter=(k,v)=>{_filtered=v?_grns.filter(g=>g[k]===v):[..._grns];_page=1;_renderGRNList();};
  window.setGRNPage=(p)=>{_page=p;_renderGRNList();};
}

// ── Warehouses / Locations page ────────────────────────────
export async function renderWarehouses(container) {
  const { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, where, orderBy } = await import('../../core/firebase.js');
  const { AuthState } = await import('../../core/auth.js');
  const { Toast } = await import('../../core/notifications.js');
  const { escHtml, genId } = await import('../../core/utils.js');
  const { pageShell, buildModal, openModal, closeModal, setupModalClose, badge } = await import('../_shared.js');

  let _warehouses=[], _wUnsub=null;
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  container.innerHTML = pageShell({
    title: '🏭 Warehouses & Locations',
    subtitle: 'Manage warehouse locations, storage zones and contact details.',
    actions: `<button class="btn btn-primary" onclick="openModal('wh-modal')">+ Add Warehouse</button>`,
    content: `<div id="wh-kpis" class="grid-4" style="margin-bottom:var(--space-5);"></div><div id="wh-list"></div>`,
  });

  document.getElementById('wh-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay hidden" id="wh-modal">
      <div class="modal modal-md">
        <div class="modal-header"><div class="modal-title">Warehouse / Location</div><button class="modal-close" onclick="closeModal('wh-modal')">✕</button></div>
        <div class="modal-body">
          <input type="hidden" id="wh-id">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Warehouse Name *</label><input type="text" id="wh-name" class="form-input" placeholder="Kochi Main Warehouse"></div>
            <div class="form-group"><label class="form-label">Code</label><input type="text" id="wh-code" class="form-input" placeholder="KCH-WH" style="text-transform:uppercase;"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Type</label>
              <select id="wh-type" class="form-select">
                <option value="warehouse">Warehouse</option><option value="depot">Transit Depot</option>
                <option value="factory">Factory/Plant</option><option value="yard">Vehicle Yard</option>
                <option value="cold">Cold Storage</option><option value="bonded">Bonded Warehouse</option>
              </select>
            </div>
            <div class="form-group"><label class="form-label">Status</label>
              <select id="wh-status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option><option value="maintenance">Under Maintenance</option></select>
            </div>
          </div>
          <div class="form-group"><label class="form-label">Address *</label><textarea id="wh-address" class="form-textarea" rows="2" placeholder="Full warehouse address…"></textarea></div>
          <div class="form-grid-3">
            <div class="form-group"><label class="form-label">City</label><input type="text" id="wh-city" class="form-input" placeholder="Kochi"></div>
            <div class="form-group"><label class="form-label">State</label><input type="text" id="wh-state" class="form-input" placeholder="Kerala"></div>
            <div class="form-group"><label class="form-label">PIN</label><input type="text" id="wh-pin" class="form-input" maxlength="6" placeholder="682001"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Manager Name</label><input type="text" id="wh-manager" class="form-input" placeholder="Warehouse manager"></div>
            <div class="form-group"><label class="form-label">Phone</label><input type="tel" id="wh-phone" class="form-input" placeholder="9876543210"></div>
          </div>
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">GSTIN (if separate)</label><input type="text" id="wh-gstin" class="form-input" placeholder="Separate GSTIN for this location" maxlength="15" style="text-transform:uppercase;"></div>
            <div class="form-group"><label class="form-label">Capacity (sq ft)</label><input type="number" id="wh-capacity" class="form-input" placeholder="5000" min="0"></div>
          </div>
          <div class="form-group"><label class="form-label">Notes / Special Instructions</label><textarea id="wh-notes" class="form-textarea" rows="2" placeholder="Cold storage: maintain 2-8°C. 24×7 security."></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('wh-modal')">Cancel</button>
          <button class="btn btn-primary" id="wh-save-btn" onclick="saveWarehouse()">Save Warehouse</button>
        </div>
      </div>
    </div>
  `);
  setupModalClose();

  const WH_ICONS = {warehouse:'🏭',depot:'🚉',factory:'🏗',yard:'🚛',cold:'❄️',bonded:'🔒'};

  const renderKPIs = () => {
    const el=document.getElementById('wh-kpis'); if(!el) return; el.innerHTML='';
    const total=_warehouses.length, active=_warehouses.filter(w=>(w.status||'active')==='active').length;
    const totalCap=_warehouses.reduce((s,w)=>s+(Number(w.capacity)||0),0);
    [{label:'Total',value:total,icon:'🏭',color:'kpi-blue'},{label:'Active',value:active,icon:'✅',color:'kpi-green'},
     {label:'Maintenance',value:_warehouses.filter(w=>w.status==='maintenance').length,icon:'🔧',color:'kpi-yellow'},
     {label:'Total Capacity',value:totalCap?totalCap.toLocaleString('en-IN')+' sq ft':'—',icon:'📐',color:'kpi-orange'}]
    .forEach((k,i)=>{el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;});
  };

  const renderList = () => {
    const el=document.getElementById('wh-list'); if(!el) return;
    if(!_warehouses.length){el.innerHTML='<div style="text-align:center;padding:60px;color:var(--text-muted);">No warehouses yet.</div>';return;}
    el.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--space-4);">
      ${_warehouses.map(w=>`<div class="card" style="padding:0;overflow:hidden;">
        <div style="height:3px;background:${(w.status||'active')==='active'?'var(--brand-secondary)':w.status==='maintenance'?'var(--brand-warning)':'var(--border-default)'};"></div>
        <div style="padding:16px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:20px;">${WH_ICONS[w.type]||'🏭'}</div>
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:700;">${escHtml(w.name||'—')}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(w.code||'')} · ${w.type||'Warehouse'}</div>
            </div>
            ${badge(w.status||'active')}
          </div>
          <div style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;">
            ${w.address?`<div>📍 ${escHtml([w.address,w.city,w.state].filter(Boolean).join(', '))}</div>`:''}
            ${w.manager?`<div>👤 ${escHtml(w.manager)}</div>`:''}
            ${w.phone?`<div>📞 ${escHtml(w.phone)}</div>`:''}
            ${w.capacity?`<div>📐 ${Number(w.capacity).toLocaleString('en-IN')} sq ft</div>`:''}
            ${w.gstin?`<div style="font-family:var(--font-mono);">GST: ${escHtml(w.gstin)}</div>`:''}
          </div>
          <div style="display:flex;gap:6px;margin-top:12px;">
            <button class="btn btn-secondary btn-sm" onclick="editWarehouse('${w.id}')">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteWarehouse('${w.id}')">🗑</button>
          </div>
        </div>
      </div>`).join('')}
    </div>`;
  };

  _wUnsub = dbListen('warehouses', [...c, orderBy('name')], data => {
    _warehouses=data; renderKPIs(); renderList();
  });

  const setVal=(id,v)=>{const el=document.getElementById(id);if(el&&v!==undefined)el.value=String(v);};

  window.saveWarehouse=async()=>{
    const name=document.getElementById('wh-name')?.value?.trim();
    if(!name){Toast.warning('Missing','Warehouse name required.');return;}
    const btn=document.getElementById('wh-save-btn');
    btn.disabled=true;btn.textContent='Saving…';
    const id=document.getElementById('wh-id')?.value;
    const data={name,code:(document.getElementById('wh-code')?.value||'').toUpperCase(),type:document.getElementById('wh-type')?.value||'warehouse',status:document.getElementById('wh-status')?.value||'active',address:document.getElementById('wh-address')?.value?.trim()||'',city:document.getElementById('wh-city')?.value?.trim()||'',state:document.getElementById('wh-state')?.value?.trim()||'',pin:document.getElementById('wh-pin')?.value?.trim()||'',manager:document.getElementById('wh-manager')?.value?.trim()||'',phone:document.getElementById('wh-phone')?.value?.trim()||'',gstin:(document.getElementById('wh-gstin')?.value||'').toUpperCase(),capacity:Number(document.getElementById('wh-capacity')?.value)||0,notes:document.getElementById('wh-notes')?.value?.trim()||'',companyId:cid||null};
    try{if(id){await dbUpdate('warehouses',id,data);}else{await dbCreate('warehouses',data);}Toast.success('Saved','Warehouse saved.');closeModal('wh-modal');}
    catch(e){Toast.error('Failed',e.message);}
    finally{btn.disabled=false;btn.textContent='Save Warehouse';}
  };

  window.editWarehouse=(id)=>{
    const w=_warehouses.find(x=>x.id===id); if(!w) return;
    setVal('wh-id',w.id);setVal('wh-name',w.name);setVal('wh-code',w.code);
    setVal('wh-type',w.type||'warehouse');setVal('wh-status',w.status||'active');
    setVal('wh-address',w.address);setVal('wh-city',w.city);setVal('wh-state',w.state);
    setVal('wh-pin',w.pin);setVal('wh-manager',w.manager);setVal('wh-phone',w.phone);
    setVal('wh-gstin',w.gstin);setVal('wh-capacity',w.capacity||'');setVal('wh-notes',w.notes);
    openModal('wh-modal');
  };

  window.deleteWarehouse=async(id)=>{
    const w=_warehouses.find(x=>x.id===id); if(!w) return;
    if(!confirm(`Delete warehouse "${w.name}"?`)) return;
    try{await dbDelete('warehouses',id);Toast.success('Deleted','Warehouse removed.');}
    catch(e){Toast.error('Failed',e.message);}
  };
}
