// ============================================================
// LAM — Goods Receipt Note (GRN) Module
// Phase 2 — Growth Plan
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatDateTime, escHtml, setLoading, searchFilter, debounce, genId, formatNumber } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, avatarCell, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

let _grns = [], _filt = [], _page = 1;
let _vendors = [], _products = [], _warehouses = [];
const PER = 15;
let _unsub = null;

export async function renderGRN(container) {
  [_vendors, _products, _warehouses] = await Promise.all([
    dbGetAll(COLLECTIONS.VENDORS,    AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.PRODUCTS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.WAREHOUSES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: 'Goods Receipt Notes (GRN)',
    subtitle: 'Record incoming stock from suppliers and update inventory.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportGRNs()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openGRNModal()">+ Create GRN</button>
    `,
    content: `
      <!-- Summary cards -->
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="grn-summary"></div>
      ${searchBar({
        id: 'grn',
        placeholder: 'Search GRN number, vendor, product…',
        filters: [
          { key: 'status', label: 'All Status', options: [
            { value: 'pending',  label: 'Pending' },
            { value: 'received', label: 'Received' },
            { value: 'partial',  label: 'Partial' },
            { value: 'rejected', label: 'Rejected' },
          ]},
          { key: 'warehouseId', label: 'All Warehouses', options: _warehouses.map(w => ({ value: w.id, label: w.name })) },
        ],
        onSearch: 'grnSearch',
        onFilter: 'grnFilter',
      })}
      <div id="grn-table-wrap"></div>
      <div id="grn-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', grnModal());
  document.body.insertAdjacentHTML('beforeend', grnViewModal());
  setupModalClose();
  setupMenuClose();
  registerGRNGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen('grns', c, data => {
    _grns = data;
    _filt = [...data];
    renderGRNSummary();
    renderGRNTable();
  });
}

function renderGRNSummary() {
  const el = document.getElementById('grn-summary');
  if (!el) return;
  const total    = _grns.length;
  const pending  = _grns.filter(g => g.status === 'pending').length;
  const received = _grns.filter(g => g.status === 'received').length;
  const items    = _grns.reduce((s, g) => s + (g.items?.length || 0), 0);
  const kpis = [
    { label: 'Total GRNs',      value: total,    icon: '📋', color: 'kpi-blue' },
    { label: 'Pending Receipt', value: pending,  icon: '⏳', color: 'kpi-yellow' },
    { label: 'Received',        value: received, icon: '✅', color: 'kpi-green' },
    { label: 'Total Items',     value: items,    icon: '📦', color: 'kpi-orange' },
  ];
  el.innerHTML = kpis.map(k => `
    <div class="kpi-card ${k.color}">
      <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
      <div class="kpi-value">${formatNumber(k.value)}</div>
      <div class="kpi-label">${k.label}</div>
    </div>
  `).join('');
}

function renderGRNTable() {
  const wrap = document.getElementById('grn-table-wrap');
  const pg   = document.getElementById('grn-pagination');
  if (!wrap) return;
  const start    = (_page-1)*PER;
  const pageData = _filt.slice(start, start+PER);
  document.getElementById('grn-count').textContent = `${_filt.length} GRN${_filt.length !== 1 ? 's' : ''}`;

  wrap.innerHTML = buildTable({
    id: 'grn-table',
    onRowClick: 'viewGRN',
    columns: [
      { key: 'grnNumber', label: 'GRN #',    render: r => `<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-primary);">${escHtml(r.grnNumber||'—')}</span>` },
      { key: 'vendorId',  label: 'Vendor',    render: r => `<span style="font-size:13px;">${escHtml(vendorName(r.vendorId))}</span>` },
      { key: 'warehouseId',label:'Warehouse', render: r => `<span style="color:var(--text-secondary);font-size:12px;">${escHtml(whName(r.warehouseId))}</span>` },
      { key: 'items',     label: 'Items',     render: r => `<span class="badge badge-blue">${r.items?.length || 0} items</span>` },
      { key: 'totalQty',  label: 'Total Qty', render: r => `<span style="font-family:var(--font-mono);">${formatNumber(r.totalQty||0)}</span>` },
      { key: 'invoiceNo', label: 'Invoice #', render: r => `<span style="font-size:11px;color:var(--text-muted);">${escHtml(r.invoiceNo||'—')}</span>` },
      { key: 'status',    label: 'Status',    render: r => badge(r.status||'pending') },
      { key: 'createdAt', label: 'Date',      render: r => `<span style="font-size:11px;color:var(--text-muted);">${formatDate(r.createdAt)}</span>` },
      { key: 'actions',   label: '', sortable: false, render: r => actionsMenu(r.id, [
          { icon: '👁',  label: 'View',     action: `viewGRN('${r.id}')` },
          { icon: '✅',  label: 'Mark Received', action: `markReceived('${r.id}')` },
          { icon: '🗑',  label: 'Delete',   action: `deleteGRN('${r.id}')`, danger: true },
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No GRNs yet',
  });
  pg.innerHTML = buildPagination({ id:'grn', total:_filt.length, page:_page, perPage:PER, onChange:'setGRNPage' });
}

function grnModal() {
  const vendorOptions  = _vendors.map(v  => `<option value="${v.id}">${escHtml(v.name||v.companyName||'—')}</option>`).join('');
  const whOptions      = _warehouses.map(w => `<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  const productOptions = _products.map(p  => `<option value="${p.id}" data-unit="${p.unit||'pcs'}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');

  return buildModal({
    id: 'grn-modal',
    title: 'Create Goods Receipt Note',
    size: 'xl',
    body: `
      <input type="hidden" id="grn-id">
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">GRN Number</label>
          <input type="text" id="grn-number" class="form-input" value="GRN-${genId()}" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Vendor <span class="required">*</span></label>
          <select id="grn-vendor" class="form-select">
            <option value="">Select vendor…</option>
            ${vendorOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Receiving Warehouse <span class="required">*</span></label>
          <select id="grn-warehouse" class="form-select">
            <option value="">Select warehouse…</option>
            ${whOptions}
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Supplier Invoice No.</label>
          <input type="text" id="grn-invoice" class="form-input" placeholder="INV-2024-001">
        </div>
        <div class="form-group">
          <label class="form-label">Invoice Date</label>
          <input type="date" id="grn-inv-date" class="form-input">
        </div>
        <div class="form-group">
          <label class="form-label">Vehicle / Lorry No.</label>
          <input type="text" id="grn-vehicle" class="form-input" placeholder="MH12AB1234" style="text-transform:uppercase;">
        </div>
      </div>

      <!-- Line Items -->
      <div style="margin-top:var(--space-4);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div class="form-label" style="text-transform:none;font-size:13px;font-weight:600;">Line Items</div>
          <button class="btn btn-secondary btn-sm" type="button" onclick="addGRNLine()">+ Add Item</button>
        </div>
        <div id="grn-lines">
          <div class="table-container">
            <table class="table" id="grn-line-table">
              <thead>
                <tr>
                  <th style="min-width:200px;">Product</th>
                  <th style="width:80px;">Ordered</th>
                  <th style="width:80px;">Received</th>
                  <th style="width:70px;">Unit</th>
                  <th style="width:100px;">Cost/Unit (₹)</th>
                  <th style="width:80px;">Batch</th>
                  <th style="width:110px;">Expiry</th>
                  <th style="width:40px;"></th>
                </tr>
              </thead>
              <tbody id="grn-line-body"></tbody>
            </table>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px;gap:20px;font-size:13px;">
          <span style="color:var(--text-muted);">Total Items: <strong id="grn-item-count" style="color:var(--text-primary);">0</strong></span>
          <span style="color:var(--text-muted);">Total Qty: <strong id="grn-total-qty" style="color:var(--text-primary);">0</strong></span>
          <span style="color:var(--text-muted);">Total Value: <strong id="grn-total-val" style="color:var(--brand-secondary);">₹0</strong></span>
        </div>
      </div>

      <div class="form-grid-2" style="margin-top:var(--space-4);">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="grn-status" class="form-select">
            <option value="pending">Pending</option>
            <option value="received" selected>Received</option>
            <option value="partial">Partial</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Received By</label>
          <input type="text" id="grn-received-by" class="form-input" placeholder="Staff name" value="${AuthState.profile?.name||''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes / Remarks</label>
        <textarea id="grn-notes" class="form-textarea" rows="2" placeholder="Any discrepancies, damage notes…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Damage Photos <span style="font-size:10px;font-weight:400;color:var(--text-muted);">Optional — capture damaged goods</span></label>
        <div id="grn-damage-photos"></div>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('grn-modal')">Cancel</button>
      <button class="btn btn-primary" id="grn-save-btn" onclick="saveGRN()">Create GRN & Update Stock</button>
    `,
  });
}

function grnViewModal() {
  return `<div class="modal-backdrop hidden" id="grn-view-modal"><div class="modal modal-lg"><div class="modal-header"><h3 class="modal-title" id="grn-view-title">GRN Details</h3><button class="modal-close" onclick="closeModal('grn-view-modal')">✕</button></div><div class="modal-body" id="grn-view-body"></div><div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal('grn-view-modal')">Close</button></div></div></div>`;
}

let _grnLines = [];

function addGRNLine(line = {}) {
  const idx = _grnLines.length;
  _grnLines.push({ productId:'', orderedQty:0, receivedQty:0, unit:'pcs', costPerUnit:0, batch:'', expiryDate:'', ...line });

  const productOptions = _products.map(p => `<option value="${p.id}" data-unit="${p.unit||'pcs'}" ${line.productId===p.id?'selected':''}>${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');

  const row = document.createElement('tr');
  row.id = `grn-line-${idx}`;
  row.innerHTML = `
    <td><select class="form-select" style="min-width:180px;" onchange="updateGRNLine(${idx},'productId',this.value);updateGRNUnit(${idx},this)"><option value="">Select…</option>${productOptions}</select></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.orderedQty||0}" min="0" onchange="updateGRNLine(${idx},'orderedQty',this.value)"></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.receivedQty||0}" min="0" onchange="updateGRNLine(${idx},'receivedQty',this.value);calcGRNTotals()"></td>
    <td><span id="grn-unit-${idx}" class="badge badge-gray">${line.unit||'pcs'}</span></td>
    <td><input type="number" class="form-input" style="width:90px;" value="${line.costPerUnit||0}" min="0" step="0.01" onchange="updateGRNLine(${idx},'costPerUnit',this.value);calcGRNTotals()"></td>
    <td><input type="text" class="form-input" style="width:80px;" value="${line.batch||''}" placeholder="B-001" onchange="updateGRNLine(${idx},'batch',this.value)"></td>
    <td><input type="date" class="form-input" value="${line.expiryDate||''}" onchange="updateGRNLine(${idx},'expiryDate',this.value)"></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeGRNLine(${idx})">✕</button></td>
  `;
  document.getElementById('grn-line-body').appendChild(row);
  calcGRNTotals();
}

function registerGRNGlobals() {
  // Init damage photo gallery when GRN modal opens
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[onclick*="openGRNModal"], [onclick*="addGRN"]')) {
      setTimeout(() => {
        const photosEl = document.getElementById('grn-damage-photos');
        if (photosEl && window.LAMCamera && !photosEl._lamInit) {
          photosEl._lamInit  = true;
          photosEl._photos   = [];
          window.LAMCamera.renderPhotoGallery(photosEl, photosEl._photos, {
            editable:  true,
            label:     'Damage / Discrepancy Photos',
            onAdd:     (p) => photosEl._photos.push(p),
            onDelete:  (i) => photosEl._photos.splice(i, 1),
          });
        }
      }, 300);
    }
  }, { passive: true });
  _grnLines = [];
  addGRNLine(); // Start with one empty line

  window.addGRNLine    = addGRNLine;
  window.updateGRNLine = (idx, key, val) => { if (_grnLines[idx]) _grnLines[idx][key] = val; };
  window.updateGRNUnit = (idx, select) => {
    const opt = select.options[select.selectedIndex];
    const unit = opt?.dataset?.unit || 'pcs';
    if (_grnLines[idx]) _grnLines[idx].unit = unit;
    const unitEl = document.getElementById(`grn-unit-${idx}`);
    if (unitEl) unitEl.textContent = unit;
    // Auto-fill cost from product
    const p = _products.find(x => x.id === opt?.value);
    if (p) {
      const row = document.getElementById(`grn-line-${idx}`);
      const costInput = row?.querySelectorAll('input[type="number"]')[2];
      if (costInput && !Number(costInput.value)) { costInput.value = p.costPrice||0; _grnLines[idx].costPerUnit = p.costPrice||0; calcGRNTotals(); }
    }
  };
  window.removeGRNLine = (idx) => {
    document.getElementById(`grn-line-${idx}`)?.remove();
    _grnLines[idx] = null;
    calcGRNTotals();
  };
  window.calcGRNTotals = calcGRNTotals;

  window.grnSearch = debounce((q) => {
    _filt = searchFilter(_grns, q, ['grnNumber','invoiceNo']).filter(g =>
      !q || vendorName(g.vendorId).toLowerCase().includes(q.toLowerCase()) || searchFilter([g], q, ['grnNumber','invoiceNo']).length
    );
    _page = 1; renderGRNTable();
  }, 250);
  window.grnFilter = (key, val) => { _filt = val ? _grns.filter(g => g[key]===val) : [..._grns]; _page=1; renderGRNTable(); };
  window.setGRNPage = (p) => { _page=p; renderGRNTable(); };

  window.saveGRN = async () => {
    if (!validateForm([{id:'grn-vendor',label:'Vendor',required:true},{id:'grn-warehouse',label:'Warehouse',required:true}])) return;
    const validLines = _grnLines.filter(l => l && l.productId);
    if (!validLines.length) { Toast.error('No items', 'Add at least one line item.'); return; }

    const btn = document.getElementById('grn-save-btn');
    setLoading(btn, true);
    try {
      const totalQty = validLines.reduce((s,l)=>s+(Number(l.receivedQty)||0), 0);
      const totalVal = validLines.reduce((s,l)=>s+(Number(l.receivedQty)||0)*(Number(l.costPerUnit)||0), 0);

      const data = {
        grnNumber:   document.getElementById('grn-number').value.trim(),
        vendorId:    document.getElementById('grn-vendor').value,
        warehouseId: document.getElementById('grn-warehouse').value,
        invoiceNo:   document.getElementById('grn-invoice').value.trim(),
        invoiceDate: document.getElementById('grn-inv-date').value,
        vehicleNo:   document.getElementById('grn-vehicle').value.trim().toUpperCase(),
        status:      document.getElementById('grn-status').value,
        receivedBy:  document.getElementById('grn-received-by').value.trim(),
        notes:       document.getElementById('grn-notes').value.trim(),
        items:       validLines,
        totalQty,
        totalValue:  totalVal,
        companyId:   AuthState.company?.id || null,
      };

      await dbCreate('grns', data);

      // Update inventory for each received item
      if (data.status === 'received' || data.status === 'partial') {
        for (const line of validLines) {
          if (!line.productId || !Number(line.receivedQty)) continue;
          // Find existing inventory record
          const existing = await dbGetAll(COLLECTIONS.INVENTORY, [
            where('productId','==',line.productId),
            where('warehouseId','==',data.warehouseId),
            ...(AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
          ]);
          if (existing.length) {
            await dbUpdate(COLLECTIONS.INVENTORY, existing[0].id, {
              quantity: (Number(existing[0].quantity)||0) + Number(line.receivedQty),
            });
          } else {
            await dbCreate(COLLECTIONS.INVENTORY, {
              productId:   line.productId,
              warehouseId: data.warehouseId,
              quantity:    Number(line.receivedQty),
              batch:       line.batch,
              expiryDate:  line.expiryDate,
              companyId:   AuthState.company?.id || null,
            });
          }
        }
      }

      Toast.success('GRN Created', `${data.grnNumber} — stock updated for ${validLines.length} item(s).`);
      window.LAMSync?.Notify.grnReceived(data.grnNumber, data.vendorName || data.vendorId || 'Vendor');
      closeModal('grn-modal');
      _grnLines = [];
      document.getElementById('grn-line-body').innerHTML = '';
      addGRNLine();
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  window.viewGRN = (id) => {
    const g = _grns.find(x=>x.id===id); if(!g) return;
    document.getElementById('grn-view-title').textContent = g.grnNumber || 'GRN Details';
    document.getElementById('grn-view-body').innerHTML = `
      <div class="grid-2" style="gap:10px;margin-bottom:16px;">
        ${[['GRN Number',g.grnNumber],['Vendor',vendorName(g.vendorId)],['Warehouse',whName(g.warehouseId)],['Invoice No.',g.invoiceNo],['Invoice Date',g.invoiceDate],['Vehicle No.',g.vehicleNo],['Status',g.status],['Received By',g.receivedBy],['Total Qty',g.totalQty],['Total Value','₹'+(g.totalValue||0).toLocaleString('en-IN')]].map(([l,v])=>`<div style="padding:10px;background:var(--bg-elevated);border-radius:8px;"><div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">${l}</div><div style="font-size:13px;margin-top:3px;">${escHtml(String(v||'—'))}</div></div>`).join('')}
      </div>
      ${g.items?.length ? `
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Unit</th><th>Cost/Unit</th><th>Batch</th><th>Expiry</th></tr></thead>
            <tbody>${g.items.map(i=>`<tr><td>${escHtml(productName(i.productId))}</td><td>${i.orderedQty||0}</td><td>${i.receivedQty||0}</td><td>${i.unit||'pcs'}</td><td>₹${Number(i.costPerUnit||0).toLocaleString('en-IN')}</td><td>${i.batch||'—'}</td><td>${i.expiryDate||'—'}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      ` : ''}
      ${g.notes ? `<div style="margin-top:12px;padding:10px;background:var(--bg-elevated);border-radius:8px;"><div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Notes</div><div style="font-size:13px;color:var(--text-secondary);">${escHtml(g.notes)}</div></div>` : ''}
    `;
    openModal('grn-view-modal');
  };

  window.markReceived = async (id) => {
    if (!confirm('Mark this GRN as fully received?')) return;
    try {
      await dbUpdate('grns', id, { status: 'received' });
      Toast.success('Updated', 'GRN marked as received.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.deleteGRN = async (id) => {
    const g = _grns.find(x=>x.id===id);
    if (!confirm(`Delete GRN "${g?.grnNumber}"? This cannot be undone.`)) return;
    try {
      await dbDelete('grns', id);
      Toast.success('Deleted', 'GRN removed.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.exportGRNs = () => {
    const csv = [['GRN #','Vendor','Warehouse','Invoice #','Status','Total Qty','Total Value','Date'],
      ..._filt.map(g=>[g.grnNumber,vendorName(g.vendorId),whName(g.warehouseId),g.invoiceNo,g.status,g.totalQty,g.totalValue,formatDate(g.createdAt)])
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='grns_export.csv'; a.click();
    Toast.success('Exported', `${_filt.length} GRNs exported.`);
  };

  window.openGRNModal = () => {
    _grnLines = [];
    document.getElementById('grn-line-body').innerHTML = '';
    document.getElementById('grn-number').value = 'GRN-' + genId();
    addGRNLine();
    openModal('grn-modal');
  };
}

function calcGRNTotals() {
  const active = _grnLines.filter(Boolean);
  const qty = active.reduce((s,l)=>s+(Number(l.receivedQty)||0), 0);
  const val = active.reduce((s,l)=>s+(Number(l.receivedQty)||0)*(Number(l.costPerUnit)||0), 0);
  const itemCount = document.getElementById('grn-item-count');
  const totalQty  = document.getElementById('grn-total-qty');
  const totalVal  = document.getElementById('grn-total-val');
  if (itemCount) itemCount.textContent = active.filter(l=>l.productId).length;
  if (totalQty)  totalQty.textContent  = formatNumber(qty);
  if (totalVal)  totalVal.textContent  = '₹' + val.toLocaleString('en-IN');
}

function vendorName(id)  { return _vendors.find(v=>v.id===id)?.name || _vendors.find(v=>v.id===id)?.companyName || id || '—'; }
function whName(id)      { return _warehouses.find(w=>w.id===id)?.name || id || '—'; }
function productName(id) { return _products.find(p=>p.id===id)?.name || id || '—'; }

// LAMCamera integration active — see grn-damage-photos gallery
