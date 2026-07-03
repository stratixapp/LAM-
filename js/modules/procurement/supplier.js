// ============================================================
// LAM — Vendor / Supplier Management — DEEP v3
// SAP/Zoho level: 6-tab modal, scorecard, transaction history,
// bank details, compliance docs, contact persons, price lists,
// purchase history, payment ledger, performance rating
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatCurrency, escHtml, setLoading, searchFilter, debounce, genId, getInitials } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, avatarCell, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

// ── State ─────────────────────────────────────────────────────
let _vendors = [], _filtered = [], _page = 1, _unsub = null;
const PER = 15;
let _activeTab = 'profile';
let _pendingContacts = [];
let _pendingDocs     = [];
let _viewId = null;

// ── Lookup data loaded on render ──────────────────────────────
let _purchaseOrders = [], _invoices = [];

const VENDOR_TYPES = {
  manufacturer:  'Manufacturer',
  distributor:   'Distributor',
  trader:        'Trader',
  service:       'Service Provider',
  transporter:   'Transporter',
  contractor:    'Contractor',
  consultant:    'Consultant',
  govt:          'Govt / PSU',
};

const PAYMENT_TERMS = {
  immediate: 'Immediate',
  net7:      'Net 7 Days',
  net15:     'Net 15 Days',
  net30:     'Net 30 Days',
  net45:     'Net 45 Days',
  net60:     'Net 60 Days',
  net90:     'Net 90 Days',
  advance:   '100% Advance',
  lc:        'Letter of Credit',
};

const CURRENCIES = ['INR','USD','EUR','AED','GBP','SGD'];

// ─────────────────────────────────────────────────────────────
export async function renderVendors(container) {
  // Pre-load related data for scorecards
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];
  [_purchaseOrders, _invoices] = await Promise.all([
    dbGetAll('purchase_orders', c).catch(() => []),
    dbGetAll(COLLECTIONS.INVOICES || 'invoices', c).catch(() => []),
  ]);

  container.innerHTML = pageShell({
    title: '🏭 Vendors & Suppliers',
    subtitle: 'Full supplier lifecycle — onboarding, compliance, performance, payables.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="toggleVendorView()" id="vendor-view-btn">⊞ Grid</button>
      <button class="btn btn-secondary btn-sm" onclick="exportVendors()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openVendorModal()">+ Add Vendor</button>
    `,
    content: `
      <!-- KPIs -->
      <div class="grid-4" id="vendor-kpis" style="margin-bottom:var(--space-5);"></div>

      <!-- Category chips -->
      <div id="vendor-cat-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--space-4);"></div>

      ${searchBar({
        id: 'vendors',
        placeholder: 'Search name, GSTIN, contact, city, category…',
        filters: [
          { key:'type',   label:'All Types',  options: Object.entries(VENDOR_TYPES).map(([v,l])=>({value:v,label:l})) },
          { key:'status', label:'All Status', options: [{value:'active',label:'Active'},{value:'inactive',label:'Inactive'},{value:'blacklisted',label:'Blacklisted'},{value:'on_hold',label:'On Hold'}] },
          { key:'state',  label:'All States', options: indianStates().map(s=>({value:s,label:s})) },
          { key:'rating', label:'All Ratings',options: [{value:'5',label:'⭐⭐⭐⭐⭐'},{value:'4',label:'⭐⭐⭐⭐'},{value:'3',label:'⭐⭐⭐'},{value:'1_2',label:'Low (1-2)'}] },
        ],
        onSearch: 'vendorSearch', onFilter: 'vendorFilter',
      })}
      <div id="vendor-list-wrap"></div>
      <div id="vendor-pagination"></div>
    `,
  });

  // Inject modals
  document.getElementById('vendor-modal')?.remove();
  document.getElementById('vendor-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildVendorModal());
  document.body.insertAdjacentHTML('beforeend', _buildViewModal());

  setupModalClose(); setupMenuClose();
  _registerGlobals();

  if (_unsub) _unsub();
  const constraints = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen(COLLECTIONS.VENDORS, constraints, data => {
    _vendors = data; _filtered = [...data];
    _renderKPIs(); _renderCatChips(); _renderList();
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKPIs() {
  const el = document.getElementById('vendor-kpis'); if (!el) return; el.innerHTML = '';
  const total     = _vendors.length;
  const active    = _vendors.filter(v => (v.status||'active') === 'active').length;
  const totalPayable = _vendors.reduce((s,v) => s + (Number(v.outstandingBalance)||0), 0);
  const avgRating = _vendors.filter(v=>v.rating).reduce((s,v,_,a) => s + Number(v.rating)/a.length, 0);
  [
    { label:'Total Vendors',     value: total,                          icon:'🏭', color:'kpi-blue'   },
    { label:'Active',            value: active,                         icon:'✅', color:'kpi-green'  },
    { label:'Total Payable',     value: formatCurrency(totalPayable,true), icon:'💳', color:'kpi-orange' },
    { label:'Avg Rating',        value: avgRating ? avgRating.toFixed(1)+'★' : '—', icon:'⭐', color:'kpi-yellow' },
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
      <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
    </div>`;
  });
}

// ── Category chips ─────────────────────────────────────────────
let _activeChip = '';
function _renderCatChips() {
  const el = document.getElementById('vendor-cat-chips'); if (!el) return;
  const types = [...new Set(_vendors.map(v=>v.type).filter(Boolean))];
  el.innerHTML = `<button class="btn btn-sm ${!_activeChip?'btn-primary':'btn-secondary'}" onclick="filterVendorCat('')" style="border-radius:999px;font-size:11px;">All (${_vendors.length})</button>
    ${types.map(t => {
      const cnt = _vendors.filter(v=>v.type===t).length;
      return `<button class="btn btn-sm ${_activeChip===t?'btn-primary':'btn-secondary'}" onclick="filterVendorCat('${t}')" style="border-radius:999px;font-size:11px;">${VENDOR_TYPES[t]||t} (${cnt})</button>`;
    }).join('')}`;
}

// ── List renderer ──────────────────────────────────────────────
let _viewMode = 'table';
function _renderList() {
  const wrap = document.getElementById('vendor-list-wrap');
  const pg   = document.getElementById('vendor-pagination');
  const cnt  = document.getElementById('vendors-count');
  if (!wrap) return;
  if (cnt) cnt.textContent = `${_filtered.length} vendor${_filtered.length!==1?'s':''}`;
  const start = (_page-1)*PER;
  const rows  = _filtered.slice(start, start+PER);
  if (_viewMode === 'grid') { _renderGrid(wrap, rows); }
  else { _renderTable(wrap, rows); }
  if (pg) pg.innerHTML = buildPagination({ id:'vendors', total:_filtered.length, page:_page, perPage:PER, onChange:'setVendorPage' });
}

function _renderTable(wrap, rows) {
  wrap.innerHTML = buildTable({
    id: 'vendors-table',
    columns: [
      { key:'name',     label:'Vendor',     render: r => _vendorCell(r) },
      { key:'type',     label:'Type',       render: r => badge(r.type, VENDOR_TYPES[r.type]||r.type||'—') },
      { key:'phone',    label:'Phone',      render: r => `<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.phone||'—')}</span>` },
      { key:'city',     label:'Location',   render: r => `<span style="font-size:12px;color:var(--text-secondary);">${escHtml([r.city,r.state].filter(Boolean).join(', ')||'—')}</span>` },
      { key:'gstin',    label:'GSTIN',      render: r => `<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.gstin||'—')}</span>` },
      { key:'rating',   label:'Rating',     render: r => r.rating ? `<span style="color:#f59e0b;font-size:13px;">${'★'.repeat(Math.round(r.rating))}${'☆'.repeat(5-Math.round(r.rating))}</span>` : '—' },
      { key:'outstandingBalance', label:'Payable', render: r => r.outstandingBalance ? `<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-danger);">₹${Number(r.outstandingBalance).toLocaleString('en-IN')}</span>` : '—' },
      { key:'status',   label:'Status',     render: r => badge(r.status||'active') },
      { key:'actions',  label:'', sortable:false, render: r => actionsMenu(r.id, [
          { icon:'👁', label:'View Profile',      action:`viewVendor('${r.id}')` },
          { icon:'✏️', label:'Edit',               action:`editVendor('${r.id}')` },
          { icon:'📋', label:'Purchase History',   action:`viewVendorPOs('${r.id}')` },
          { icon:'💳', label:'Payment Ledger',     action:`viewVendorLedger('${r.id}')` },
          { icon:'⭐', label:'Rate Vendor',        action:`rateVendor('${r.id}')` },
          { icon:'🗑', label:'Delete',             action:`deleteVendor('${r.id}')`, danger:true },
        ])
      },
    ],
    rows,
    emptyMsg: 'No vendors yet — add your first supplier',
  });
}

function _renderGrid(wrap, rows) {
  if (!rows.length) { wrap.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted);">No vendors found.</div>`; return; }
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--space-4);">
    ${rows.map(r => `
      <div class="card" style="padding:0;overflow:hidden;cursor:pointer;" onclick="viewVendor('${r.id}')">
        <div style="height:4px;background:${r.status==='blacklisted'?'var(--brand-danger)':r.status==='on_hold'?'var(--brand-warning)':'var(--brand-primary)'};"></div>
        <div style="padding:16px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--brand-primary);flex-shrink:0;">${getInitials(r.name||'?')}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.name||'—')}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(r.contactPerson||r.type||'—')}</div>
            </div>
            ${badge(r.status||'active')}
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-secondary);">
            ${r.phone?`<div>📞 ${escHtml(r.phone)}</div>`:''}
            ${r.city?`<div>📍 ${escHtml([r.city,r.state].filter(Boolean).join(', '))}</div>`:''}
            ${r.gstin?`<div style="font-family:var(--font-mono);">GST: ${escHtml(r.gstin)}</div>`:''}
          </div>
          ${r.rating?`<div style="margin-top:10px;color:#f59e0b;font-size:14px;">${'★'.repeat(Math.round(r.rating))}${'☆'.repeat(5-Math.round(r.rating))}</div>`:''}
          ${r.outstandingBalance?`<div style="margin-top:8px;font-family:var(--font-mono);font-size:12px;color:var(--brand-danger);font-weight:600;">Payable: ₹${Number(r.outstandingBalance).toLocaleString('en-IN')}</div>`:''}
        </div>
      </div>`).join('')}
  </div>`;
}

function _vendorCell(r) {
  const initials = getInitials(r.name||'?');
  return `<div style="display:flex;align-items:center;gap:10px;">
    <div style="width:36px;height:36px;border-radius:10px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-primary);flex-shrink:0;">${initials}</div>
    <div>
      <div style="font-size:13px;font-weight:500;">${escHtml(r.name||'—')}</div>
      <div style="font-size:11px;color:var(--text-muted);">${escHtml(r.contactPerson||r.email||'—')}</div>
    </div>
  </div>`;
}

// ── MODAL — 6 tabs ────────────────────────────────────────────
const TABS = [
  ['profile',     '🏢 Profile'],
  ['contacts',    '👤 Contacts'],
  ['financial',   '💰 Financial'],
  ['bank',        '🏦 Bank & IDs'],
  ['compliance',  '📋 Compliance'],
  ['performance', '⭐ Performance'],
];

function _buildVendorModal() {
  const typeOpts  = Object.entries(VENDOR_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const termOpts  = Object.entries(PAYMENT_TERMS).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const stateOpts = indianStates().map(s=>`<option value="${s}">${s}</option>`).join('');
  const curOpts   = CURRENCIES.map(c=>`<option value="${c}">${c}</option>`).join('');

  const tabBtns = TABS.map(([id,label],i) => `
    <button class="v-tab ${i===0?'active':''}" id="vtab-btn-${id}" onclick="switchVTab('${id}')"
      style="padding:8px 12px;border-radius:var(--radius-sm);font-size:11px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;white-space:nowrap;">
      ${label}
    </button>`).join('');

  return buildModal({
    id:'vendor-modal', title:'<span id="vendor-modal-title">Add Vendor</span>', size:'lg',
    body: `
      <style>
        .v-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}
        .v-pane{display:none;} .v-pane.active{display:block;}
        .v-divider{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:14px 0 8px;padding-top:12px;border-top:1px solid var(--border-subtle);}
      </style>
      <input type="hidden" id="v-id">

      <div style="display:flex;gap:2px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:3px;margin-bottom:var(--space-4);overflow-x:auto;">${tabBtns}</div>

      <!-- TAB 1: PROFILE -->
      <div class="v-pane active" id="vpane-profile">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Company / Vendor Name <span class="required">*</span></label>
            <input type="text" id="v-name" class="form-input" placeholder="ABC Logistics Pvt Ltd">
          </div>
          <div class="form-group">
            <label class="form-label">Short Name / Alias</label>
            <input type="text" id="v-alias" class="form-input" placeholder="ABC Logistics">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Vendor Type <span class="required">*</span></label>
            <select id="v-type" class="form-select">${typeOpts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Industry / Category</label>
            <input type="text" id="v-industry" class="form-input" placeholder="Fuel, Tyres, Spare Parts…">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Primary Phone <span class="required">*</span></label>
            <input type="tel" id="v-phone" class="form-input" placeholder="9876543210" maxlength="10">
          </div>
          <div class="form-group">
            <label class="form-label">Primary Email</label>
            <input type="email" id="v-email" class="form-input" placeholder="vendor@company.com">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Website</label>
            <input type="url" id="v-website" class="form-input" placeholder="https://vendor.com">
          </div>
          <div class="form-group">
            <label class="form-label">LinkedIn / Social</label>
            <input type="text" id="v-social" class="form-input" placeholder="linkedin.com/company/…">
          </div>
        </div>
        <div class="v-divider">Registered Address</div>
        <div class="form-group">
          <label class="form-label">Address Line 1</label>
          <input type="text" id="v-addr1" class="form-input" placeholder="Building, Street">
        </div>
        <div class="form-group">
          <label class="form-label">Address Line 2</label>
          <input type="text" id="v-addr2" class="form-input" placeholder="Area, Landmark">
        </div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">City</label>
            <input type="text" id="v-city" class="form-input" placeholder="Mumbai">
          </div>
          <div class="form-group">
            <label class="form-label">State</label>
            <select id="v-state" class="form-select"><option value="">Select…</option>${stateOpts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">PIN Code</label>
            <input type="text" id="v-pin" class="form-input" placeholder="400001" maxlength="6">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Status</label>
            <select id="v-status" class="form-select">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="on_hold">On Hold</option>
              <option value="blacklisted">Blacklisted</option>
              <option value="prospect">Prospect</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Vendor Since (Relationship Date)</label>
            <input type="date" id="v-since" class="form-input">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Internal Notes</label>
          <textarea id="v-notes" class="form-textarea" rows="2" placeholder="Reliable for express fuel delivery. Contact Rajesh directly for bulk orders."></textarea>
        </div>
      </div>

      <!-- TAB 2: CONTACTS -->
      <div class="v-pane" id="vpane-contacts">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Add multiple contact persons for this vendor — sales rep, accounts, technical support etc.</div>
        <div id="v-contacts-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
        <div class="card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Add Contact Person</div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Full Name <span class="required">*</span></label>
              <input type="text" id="vc-name" class="form-input" placeholder="Rajesh Kumar">
            </div>
            <div class="form-group">
              <label class="form-label">Designation</label>
              <input type="text" id="vc-desig" class="form-input" placeholder="Sales Manager">
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Phone</label>
              <input type="tel" id="vc-phone" class="form-input" placeholder="9876543210" maxlength="10">
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input type="email" id="vc-email" class="form-input" placeholder="rajesh@vendor.com">
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Department</label>
              <select id="vc-dept" class="form-select">
                <option value="sales">Sales</option><option value="accounts">Accounts</option>
                <option value="technical">Technical</option><option value="logistics">Logistics</option>
                <option value="management">Management</option><option value="support">Support</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Is Primary Contact?</label>
              <select id="vc-primary" class="form-select">
                <option value="no">No</option><option value="yes">Yes — Make Primary</option>
              </select>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="addVContact()">+ Add Contact</button>
        </div>
      </div>

      <!-- TAB 3: FINANCIAL -->
      <div class="v-pane" id="vpane-financial">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Credit Limit (₹)</label>
            <input type="number" id="v-credit" class="form-input" placeholder="500000" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Outstanding Balance (₹)</label>
            <input type="number" id="v-outstanding" class="form-input" placeholder="0" min="0">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Payment Terms</label>
            <select id="v-terms" class="form-select">${termOpts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Currency</label>
            <select id="v-currency" class="form-select">${curOpts}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Advance Required (%)</label>
            <input type="number" id="v-advance" class="form-input" placeholder="0" min="0" max="100">
          </div>
          <div class="form-group">
            <label class="form-label">Early Payment Discount (%)</label>
            <input type="number" id="v-discount" class="form-input" placeholder="0" min="0" max="100" step="0.5">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Min Order Value (₹)</label>
            <input type="number" id="v-moq-val" class="form-input" placeholder="0" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Typical Lead Time (Days)</label>
            <input type="number" id="v-leadtime" class="form-input" placeholder="7" min="0">
          </div>
        </div>
        <div class="v-divider">Tax Configuration</div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">GSTIN <span class="required">*</span></label>
            <input type="text" id="v-gstin" class="form-input" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase;" oninput="validateGSTIN(this)">
            <div id="v-gstin-status" style="font-size:10px;margin-top:3px;"></div>
          </div>
          <div class="form-group">
            <label class="form-label">GST Registration Type</label>
            <select id="v-gst-type" class="form-select">
              <option value="regular">Regular (GSTIN)</option>
              <option value="composition">Composition Scheme</option>
              <option value="unregistered">Unregistered</option>
              <option value="sez">SEZ Unit</option>
              <option value="overseas">Overseas / Import</option>
            </select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">PAN Number</label>
            <input type="text" id="v-pan" class="form-input" placeholder="AAAPL1234C" maxlength="10" style="text-transform:uppercase;">
          </div>
          <div class="form-group">
            <label class="form-label">TDS Category</label>
            <select id="v-tds" class="form-select">
              <option value="">Not Applicable</option>
              <option value="194c">194C — Contractor (1%/2%)</option>
              <option value="194j">194J — Professional (10%)</option>
              <option value="194h">194H — Commission (5%)</option>
              <option value="194i">194I — Rent (10%)</option>
              <option value="194q">194Q — Purchase of Goods (0.1%)</option>
            </select>
          </div>
        </div>
        <div class="v-divider">Price List</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Define negotiated rates / price list with this vendor.</div>
        <div id="v-pricelist-items" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;"></div>
        <div class="form-grid-3" style="align-items:flex-end;">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Item / Service</label>
            <input type="text" id="vpl-item" class="form-input" placeholder="Diesel, Spare Part…">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Negotiated Rate (₹)</label>
            <input type="number" id="vpl-rate" class="form-input" placeholder="0" min="0">
          </div>
          <button class="btn btn-secondary btn-sm" style="height:36px;" onclick="addVPriceItem()">+ Add</button>
        </div>
      </div>

      <!-- TAB 4: BANK & IDs -->
      <div class="v-pane" id="vpane-bank">
        <div class="v-divider" style="margin-top:0;border-top:none;">Bank Account Details</div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Account Holder Name</label>
            <input type="text" id="v-bank-name" class="form-input" placeholder="As per bank records">
          </div>
          <div class="form-group">
            <label class="form-label">Account Number</label>
            <input type="text" id="v-bank-acc" class="form-input" placeholder="Bank account number">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">IFSC Code</label>
            <input type="text" id="v-bank-ifsc" class="form-input" placeholder="SBIN0001234" maxlength="11" style="text-transform:uppercase;" oninput="this.value=this.value.toUpperCase()">
          </div>
          <div class="form-group">
            <label class="form-label">Bank Name & Branch</label>
            <input type="text" id="v-bank-branch" class="form-input" placeholder="SBI, Andheri East">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Account Type</label>
            <select id="v-bank-type" class="form-select">
              <option value="current">Current Account</option>
              <option value="savings">Savings Account</option>
              <option value="cc">Cash Credit</option>
              <option value="od">Overdraft</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">UPI ID (for quick payments)</label>
            <input type="text" id="v-upi" class="form-input" placeholder="vendor@upi">
          </div>
        </div>
        <div class="v-divider">Government Registrations</div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">MSME Registration No.</label>
            <input type="text" id="v-msme" class="form-input" placeholder="UDYAM-XX-00-0000000">
          </div>
          <div class="form-group">
            <label class="form-label">MSME Category</label>
            <select id="v-msme-cat" class="form-select">
              <option value="">Not MSME</option>
              <option value="micro">Micro Enterprise</option>
              <option value="small">Small Enterprise</option>
              <option value="medium">Medium Enterprise</option>
            </select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Import Export Code (IEC)</label>
            <input type="text" id="v-iec" class="form-input" placeholder="IEC for importers/exporters">
          </div>
          <div class="form-group">
            <label class="form-label">CIN (Company Reg. No.)</label>
            <input type="text" id="v-cin" class="form-input" placeholder="U12345KA2010PTC123456">
          </div>
        </div>
      </div>

      <!-- TAB 5: COMPLIANCE -->
      <div class="v-pane" id="vpane-compliance">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Track compliance documents, certifications and their expiry dates.</div>
        <div id="v-docs-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
        <div class="card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Add Document / Certificate</div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Document Type</label>
              <select id="vd-type" class="form-select">
                <option value="gst_cert">GST Certificate</option>
                <option value="pan_card">PAN Card</option>
                <option value="msme_cert">MSME Certificate</option>
                <option value="iso_cert">ISO Certification</option>
                <option value="trade_license">Trade License</option>
                <option value="pollution_cert">Pollution Certificate</option>
                <option value="insurance">Insurance Policy</option>
                <option value="bank_letter">Bank Letter / Cancelled Cheque</option>
                <option value="incorporation">Incorporation Certificate</option>
                <option value="contract">Signed Contract / Agreement</option>
                <option value="nda">NDA</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Document Name</label>
              <input type="text" id="vd-name" class="form-input" placeholder="e.g. GST Certificate 2024">
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Expiry Date</label>
              <input type="date" id="vd-expiry" class="form-input">
            </div>
            <div class="form-group">
              <label class="form-label">Document URL / Link</label>
              <input type="url" id="vd-url" class="form-input" placeholder="https://drive.google.com/…">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Notes</label>
            <input type="text" id="vd-note" class="form-input" placeholder="Verified on 01-Jan-2025 by Finance team">
          </div>
          <button class="btn btn-secondary btn-sm" onclick="addVDoc()">+ Add Document</button>
        </div>
      </div>

      <!-- TAB 6: PERFORMANCE -->
      <div class="v-pane" id="vpane-performance">
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Overall Rating (1–5 ⭐)</label>
            <select id="v-rating" class="form-select">
              <option value="">Not rated</option>
              <option value="5">⭐⭐⭐⭐⭐ — Excellent</option>
              <option value="4">⭐⭐⭐⭐ — Good</option>
              <option value="3">⭐⭐⭐ — Average</option>
              <option value="2">⭐⭐ — Poor</option>
              <option value="1">⭐ — Very Poor</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Last Reviewed Date</label>
            <input type="date" id="v-review-date" class="form-input">
          </div>
        </div>
        <div class="v-divider">Quality Scores (Rate 1–10)</div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Delivery Timeliness (1–10)</label>
            <input type="number" id="v-score-delivery" class="form-input" placeholder="8" min="1" max="10">
          </div>
          <div class="form-group">
            <label class="form-label">Product / Service Quality (1–10)</label>
            <input type="number" id="v-score-quality" class="form-input" placeholder="8" min="1" max="10">
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label">Communication (1–10)</label>
            <input type="number" id="v-score-comm" class="form-input" placeholder="8" min="1" max="10">
          </div>
          <div class="form-group">
            <label class="form-label">Price Competitiveness (1–10)</label>
            <input type="number" id="v-score-price" class="form-input" placeholder="8" min="1" max="10">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Performance Review Notes</label>
          <textarea id="v-review-notes" class="form-textarea" rows="3" placeholder="Vendor consistently delivers on time. Minor quality issues in Q3 resolved. Negotiate pricing in annual review."></textarea>
        </div>
        <div class="v-divider">Preferred Products / Services from this Vendor</div>
        <div class="form-group">
          <label class="form-label">Tags / Products / Categories</label>
          <input type="text" id="v-tags" class="form-input" placeholder="Diesel, Engine Oil, Tyres, Spare Parts… (comma separated)">
        </div>
      </div>
    `,
    footer: `
      <div style="flex:1;"><span id="vtab-indicator" style="font-size:11px;color:var(--text-muted);"></span></div>
      <button class="btn btn-secondary" onclick="closeModal('vendor-modal')">Cancel</button>
      <button class="btn btn-primary" id="vendor-save-btn" onclick="saveVendor()">💾 Save Vendor</button>
    `,
  });
}

// ── VIEW MODAL ─────────────────────────────────────────────────
function _buildViewModal() {
  return buildModal({
    id:'vendor-view-modal', title:'<span id="vview-title">Vendor Profile</span>', size:'lg',
    body:`<div id="vview-content"></div>`,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('vendor-view-modal')">Close</button>
      <button class="btn btn-primary" id="vview-edit-btn">✏️ Edit Vendor</button>
    `,
  });
}

function _renderVendorView(v) {
  const pos     = _purchaseOrders.filter(p=>p.vendorId===v.id);
  const totalPO = pos.reduce((s,p)=>s+(Number(p.totalAmount)||0),0);
  const tags    = (v.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
  const docs    = v.documents||[];
  const contacts= v.contacts||[];

  const scoreBar = (score) => {
    const pct = (Number(score)||0)*10;
    return `<div style="display:flex;align-items:center;gap:8px;"><div style="flex:1;height:5px;background:var(--border-subtle);border-radius:3px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${pct>=70?'var(--brand-secondary)':pct>=40?'var(--brand-warning)':'var(--brand-danger)'};"></div></div><span style="font-size:11px;font-weight:700;">${score||'—'}</span></div>`;
  };

  return `
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:16px;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:var(--space-4);">
      <div style="width:60px;height:60px;border-radius:14px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:var(--brand-primary);">${getInitials(v.name||'?')}</div>
      <div style="flex:1;">
        <div style="font-size:18px;font-weight:700;">${escHtml(v.name||'—')}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${VENDOR_TYPES[v.type]||v.type||'Vendor'}${v.industry?' · '+escHtml(v.industry):''}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          ${badge(v.status||'active')}
          ${v.gstin?`<span class="badge badge-blue" style="font-family:var(--font-mono);">${escHtml(v.gstin)}</span>`:''}
          ${v.msmeCat?`<span class="badge badge-green">MSME: ${v.msmeCat}</span>`:''}
          ${v.rating?`<span style="color:#f59e0b;">${'★'.repeat(Math.round(v.rating))}${'☆'.repeat(5-Math.round(v.rating))}</span>`:''}
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--text-muted);">Total Orders</div>
        <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:var(--brand-primary);">${pos.length}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Total Purchased</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--brand-secondary);">₹${totalPO.toLocaleString('en-IN')}</div>
        ${v.outstandingBalance?`<div style="font-family:var(--font-mono);font-size:12px;color:var(--brand-danger);">Payable: ₹${Number(v.outstandingBalance).toLocaleString('en-IN')}</div>`:''}
      </div>
    </div>

    <div class="grid-2" style="gap:var(--space-4);">
      <div>
        <div class="v-divider" style="margin-top:0;border-top:none;">Contact Information</div>
        ${_vRow('📞 Phone',    v.phone)}
        ${_vRow('✉️ Email',    v.email)}
        ${_vRow('🌐 Website',  v.website)}
        ${_vRow('📍 Address',  [v.addr1,v.addr2,v.city,v.state,v.pin].filter(Boolean).join(', '))}
        ${_vRow('📅 Vendor Since', v.since?formatDate(v.since):null)}
        ${_vRow('⏱ Lead Time', v.leadTimeDays?v.leadTimeDays+' days':null)}

        ${contacts.length?`
          <div class="v-divider">Contact Persons</div>
          ${contacts.map(c=>`
            <div style="padding:8px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:6px;font-size:12px;">
              <div style="font-weight:600;">${escHtml(c.name||'—')} ${c.isPrimary?'<span class="badge badge-blue" style="font-size:9px;">Primary</span>':''}</div>
              <div style="color:var(--text-muted);">${escHtml(c.designation||'—')} · ${escHtml(c.department||'')}</div>
              <div>${escHtml(c.phone||'')} ${c.email?'· '+escHtml(c.email):''}</div>
            </div>`).join('')}
        `:''}
      </div>

      <div>
        <div class="v-divider" style="margin-top:0;border-top:none;">Financial Details</div>
        ${_vRow('💳 Payment Terms', PAYMENT_TERMS[v.paymentTerms]||v.paymentTerms)}
        ${_vRow('🏦 Currency',      v.currency||'INR')}
        ${_vRow('💰 Credit Limit',  v.creditLimit?'₹'+Number(v.creditLimit).toLocaleString('en-IN'):null)}
        ${_vRow('📊 TDS Category',  v.tdsCategory)}
        ${_vRow('🏭 GST Type',      v.gstType)}
        ${_vRow('🆔 PAN',           v.pan)}
        ${_vRow('🏦 Bank',          v.bankDetails?.bankName)}
        ${_vRow('💳 A/C',           v.bankDetails?.accountNumber?'••••'+v.bankDetails.accountNumber.slice(-4):null)}
        ${_vRow('🔢 IFSC',          v.bankDetails?.ifsc)}
        ${_vRow('📱 UPI',           v.bankDetails?.upiId)}
        ${_vRow('📋 MSME No.',      v.msmeNumber)}

        ${v.scores?`
          <div class="v-divider">Performance Scores</div>
          <div style="font-size:12px;display:flex;flex-direction:column;gap:6px;">
            <div>Delivery ${scoreBar(v.scores.delivery)}</div>
            <div>Quality  ${scoreBar(v.scores.quality)}</div>
            <div>Comm.    ${scoreBar(v.scores.communication)}</div>
            <div>Price    ${scoreBar(v.scores.price)}</div>
          </div>
        `:''}
      </div>
    </div>

    ${tags.length?`<div class="v-divider">Tags / Products</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${tags.map(t=>`<span class="badge badge-blue">${escHtml(t)}</span>`).join('')}</div>`:''}

    ${docs.length?`
      <div class="v-divider">Compliance Documents</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${docs.map(d=>{
          const expired = d.expiry && new Date(d.expiry) < new Date();
          const expiring = d.expiry && !expired && (new Date(d.expiry)-new Date()) < 30*86400000;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <span>📎</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:500;">${escHtml(d.name||d.type||'Document')}</div>
              ${d.expiry?`<div style="font-size:10px;color:${expired?'var(--brand-danger)':expiring?'var(--brand-warning)':'var(--text-muted)'};">${expired?'⚠️ EXPIRED':'Expires'}: ${d.expiry}</div>`:''}
            </div>
            ${d.url?`<a href="${d.url}" target="_blank" class="btn btn-secondary btn-sm" style="font-size:10px;">Open ↗</a>`:''}
          </div>`;
        }).join('')}
      </div>
    `:''}

    ${v.reviewNotes?`<div class="v-divider">Performance Notes</div><div style="font-size:12px;color:var(--text-secondary);padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">${escHtml(v.reviewNotes)}</div>`:''}
  `;
}

function _vRow(label, val) {
  if (!val) return '';
  return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-subtle);">
    <div style="font-size:11px;color:var(--text-muted);min-width:100px;flex-shrink:0;">${label}</div>
    <div style="font-size:12px;">${escHtml(String(val))}</div>
  </div>`;
}

// ── GLOBALS ────────────────────────────────────────────────────
function _registerGlobals() {
  let _pendingPriceItems = [];

  // Tab switch
  window.switchVTab = (tab) => {
    _activeTab = tab;
    document.querySelectorAll('.v-tab').forEach(b=>b.classList.remove('active'));
    document.getElementById(`vtab-btn-${tab}`)?.classList.add('active');
    document.querySelectorAll('.v-pane').forEach(p=>p.classList.remove('active'));
    document.getElementById(`vpane-${tab}`)?.classList.add('active');
    const idx = TABS.findIndex(([id])=>id===tab)+1;
    const ind = document.getElementById('vtab-indicator');
    if (ind) ind.textContent = `Tab ${idx}/${TABS.length}`;
  };

  // GSTIN validator
  window.validateGSTIN = (el) => {
    const v = el.value.toUpperCase(); el.value = v;
    const el2 = document.getElementById('v-gstin-status');
    if (!el2) return;
    const re = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!v) { el2.textContent=''; return; }
    if (re.test(v)) {
      const stateCode = v.slice(0,2);
      el2.textContent = `✅ Valid GSTIN — State code ${stateCode}`;
      el2.style.color = 'var(--brand-secondary)';
    } else {
      el2.textContent = '❌ Invalid GSTIN format';
      el2.style.color = 'var(--brand-danger)';
    }
  };

  // Contact management
  window.addVContact = () => {
    const name  = document.getElementById('vc-name')?.value?.trim();
    if (!name) { Toast.warning('Missing','Enter contact name.'); return; }
    const contact = {
      id:          genId('vc'),
      name,
      designation: document.getElementById('vc-desig')?.value?.trim()||'',
      phone:       document.getElementById('vc-phone')?.value?.trim()||'',
      email:       document.getElementById('vc-email')?.value?.trim()||'',
      department:  document.getElementById('vc-dept')?.value||'',
      isPrimary:   document.getElementById('vc-primary')?.value==='yes',
    };
    if (contact.isPrimary) _pendingContacts.forEach(c=>c.isPrimary=false);
    _pendingContacts.push(contact);
    _renderContactsList();
    ['vc-name','vc-desig','vc-phone','vc-email'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('vc-primary').value='no';
  };

  function _renderContactsList() {
    const el = document.getElementById('v-contacts-list'); if (!el) return;
    el.innerHTML = _pendingContacts.map((c,i)=>`
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <div style="width:30px;height:30px;border-radius:8px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--brand-primary);">${getInitials(c.name)}</div>
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:600;">${escHtml(c.name)} ${c.isPrimary?'<span class="badge badge-blue" style="font-size:9px;">Primary</span>':''}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(c.designation||'—')} · ${escHtml(c.phone||'')} ${c.email?'· '+escHtml(c.email):''}</div>
        </div>
        <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeVContact(${i})">✕</button>
      </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px;">No contacts added yet.</div>';
  }

  window.removeVContact = (i) => { _pendingContacts.splice(i,1); _renderContactsList(); };

  // Price list
  window.addVPriceItem = () => {
    const item = document.getElementById('vpl-item')?.value?.trim();
    const rate = document.getElementById('vpl-rate')?.value;
    if (!item) { Toast.warning('Missing','Enter item name.'); return; }
    _pendingPriceItems.push({ item, rate: Number(rate)||0 });
    _renderPriceList();
    ['vpl-item','vpl-rate'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  };

  function _renderPriceList() {
    const el = document.getElementById('v-pricelist-items'); if (!el) return;
    el.innerHTML = _pendingPriceItems.map((p,i)=>`
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <div style="flex:1;font-size:12px;">${escHtml(p.item)}</div>
        <div style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹${Number(p.rate).toLocaleString('en-IN')}</div>
        <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeVPrice(${i})">✕</button>
      </div>`).join('');
  }
  window.removeVPrice = (i) => { _pendingPriceItems.splice(i,1); _renderPriceList(); };

  // Document management
  window.addVDoc = () => {
    const name = document.getElementById('vd-name')?.value?.trim();
    if (!name) { Toast.warning('Missing','Enter document name.'); return; }
    _pendingDocs.push({
      id: genId('vd'), type: document.getElementById('vd-type')?.value||'other',
      name, expiry: document.getElementById('vd-expiry')?.value||'',
      url:  document.getElementById('vd-url')?.value?.trim()||'',
      note: document.getElementById('vd-note')?.value?.trim()||'',
      addedAt: new Date().toISOString(),
    });
    _renderDocsList();
    ['vd-name','vd-expiry','vd-url','vd-note'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  };

  function _renderDocsList() {
    const el = document.getElementById('v-docs-list'); if (!el) return;
    el.innerHTML = _pendingDocs.map((d,i)=>{
      const expired  = d.expiry && new Date(d.expiry)<new Date();
      const expiring = d.expiry && !expired && (new Date(d.expiry)-new Date())<30*86400000;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <span>📎</span>
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:500;">${escHtml(d.name)}</div>
          ${d.expiry?`<div style="font-size:10px;color:${expired?'var(--brand-danger)':expiring?'var(--brand-warning)':'var(--text-muted)'};">${expired?'⚠️ EXPIRED ':''}Expires: ${d.expiry}</div>`:''}
        </div>
        <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeVDoc(${i})">✕</button>
      </div>`;
    }).join('');
  }
  window.removeVDoc = (i) => { _pendingDocs.splice(i,1); _renderDocsList(); };

  // Open modal
  window.openVendorModal = () => {
    _pendingContacts=[]; _pendingDocs=[]; _pendingPriceItems=[];
    _renderContactsList(); _renderDocsList(); _renderPriceList();
    document.getElementById('vendor-modal-title').textContent='Add Vendor';
    [
      'v-id','v-name','v-alias','v-phone','v-email','v-website','v-social',
      'v-addr1','v-addr2','v-city','v-pin','v-gstin','v-pan','v-credit',
      'v-outstanding','v-advance','v-discount','v-moq-val','v-leadtime',
      'v-bank-name','v-bank-acc','v-bank-ifsc','v-bank-branch','v-upi',
      'v-msme','v-iec','v-cin','v-review-notes','v-tags',
      'v-score-delivery','v-score-quality','v-score-comm','v-score-price',
    ].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    ['v-type','v-status','v-terms','v-currency','v-gst-type','v-tds','v-msme-cat','v-bank-type','v-rating']
      .forEach(id=>{const el=document.getElementById(id);if(el)el.selectedIndex=0;});
    document.getElementById('v-gstin-status').textContent='';
    switchVTab('profile');
    openModal('vendor-modal');
  };

  // Save
  window.saveVendor = async () => {
    if (!validateForm([
      {id:'v-name',  label:'Vendor Name', required:true},
      {id:'v-phone', label:'Phone',        required:true, minLength:10},
    ])) { switchVTab('profile'); return; }

    const btn = document.getElementById('vendor-save-btn');
    setLoading(btn,true);
    const id = document.getElementById('v-id').value;

    const d1 = Number(document.getElementById('v-score-delivery')?.value)||0;
    const d2 = Number(document.getElementById('v-score-quality')?.value)||0;
    const d3 = Number(document.getElementById('v-score-comm')?.value)||0;
    const d4 = Number(document.getElementById('v-score-price')?.value)||0;

    const data = {
      name:           document.getElementById('v-name').value.trim(),
      alias:          document.getElementById('v-alias')?.value?.trim()||'',
      phone:          document.getElementById('v-phone').value.trim(),
      email:          document.getElementById('v-email')?.value?.trim()||'',
      website:        document.getElementById('v-website')?.value?.trim()||'',
      social:         document.getElementById('v-social')?.value?.trim()||'',
      type:           document.getElementById('v-type')?.value||'trader',
      industry:       document.getElementById('v-industry')?.value?.trim()||'',
      status:         document.getElementById('v-status')?.value||'active',
      since:          document.getElementById('v-since')?.value||'',
      addr1:          document.getElementById('v-addr1')?.value?.trim()||'',
      addr2:          document.getElementById('v-addr2')?.value?.trim()||'',
      city:           document.getElementById('v-city')?.value?.trim()||'',
      state:          document.getElementById('v-state')?.value||'',
      pin:            document.getElementById('v-pin')?.value?.trim()||'',
      notes:          document.getElementById('v-notes')?.value?.trim()||'',
      contacts:       [..._pendingContacts],
      creditLimit:    Number(document.getElementById('v-credit')?.value)||0,
      outstandingBalance: Number(document.getElementById('v-outstanding')?.value)||0,
      paymentTerms:   document.getElementById('v-terms')?.value||'net30',
      currency:       document.getElementById('v-currency')?.value||'INR',
      advanceRequired:Number(document.getElementById('v-advance')?.value)||0,
      earlyPayDiscount:Number(document.getElementById('v-discount')?.value)||0,
      minOrderValue:  Number(document.getElementById('v-moq-val')?.value)||0,
      leadTimeDays:   Number(document.getElementById('v-leadtime')?.value)||0,
      gstin:          (document.getElementById('v-gstin')?.value||'').trim().toUpperCase(),
      gstType:        document.getElementById('v-gst-type')?.value||'regular',
      pan:            (document.getElementById('v-pan')?.value||'').trim().toUpperCase(),
      tdsCategory:    document.getElementById('v-tds')?.value||'',
      priceList:      [..._pendingPriceItems],
      bankDetails: {
        accountHolderName: document.getElementById('v-bank-name')?.value?.trim()||'',
        accountNumber:     document.getElementById('v-bank-acc')?.value?.trim()||'',
        ifsc:              (document.getElementById('v-bank-ifsc')?.value||'').toUpperCase(),
        bankName:          document.getElementById('v-bank-branch')?.value?.trim()||'',
        accountType:       document.getElementById('v-bank-type')?.value||'current',
        upiId:             document.getElementById('v-upi')?.value?.trim()||'',
      },
      msmeNumber: document.getElementById('v-msme')?.value?.trim()||'',
      msmeCat:    document.getElementById('v-msme-cat')?.value||'',
      iec:        document.getElementById('v-iec')?.value?.trim()||'',
      cin:        document.getElementById('v-cin')?.value?.trim()||'',
      documents:  [..._pendingDocs],
      rating:     document.getElementById('v-rating')?.value||'',
      reviewDate: document.getElementById('v-review-date')?.value||'',
      scores: { delivery:d1, quality:d2, communication:d3, price:d4 },
      reviewNotes:document.getElementById('v-review-notes')?.value?.trim()||'',
      tags:       document.getElementById('v-tags')?.value?.trim()||'',
      companyId:  AuthState.company?.id||null,
    };

    try {
      if (id) {
        await dbUpdate(COLLECTIONS.VENDORS, id, data);
        Toast.success('Updated', `${data.name} updated.`);
      } else {
        await dbCreate(COLLECTIONS.VENDORS, data);
        Toast.success('Added', `${data.name} added as vendor.`);
      }
      closeModal('vendor-modal');
    } catch(e) { Toast.error('Failed', e.message); }
    finally    { setLoading(btn,false); }
  };

  // Edit
  window.editVendor = (id) => {
    const v = _vendors.find(x=>x.id===id); if(!v) return;
    _pendingContacts = [...(v.contacts||[])];
    _pendingDocs     = [...(v.documents||[])];
    _pendingPriceItems = [...(v.priceList||[])];
    document.getElementById('vendor-modal-title').textContent='Edit Vendor';
    document.getElementById('v-id').value=v.id;
    const set=(id,val)=>{const el=document.getElementById(id);if(el&&val!==undefined)el.value=val;};
    set('v-name',v.name); set('v-alias',v.alias); set('v-phone',v.phone); set('v-email',v.email);
    set('v-website',v.website); set('v-social',v.social); set('v-type',v.type);
    set('v-industry',v.industry); set('v-status',v.status||'active'); set('v-since',v.since);
    set('v-addr1',v.addr1); set('v-addr2',v.addr2); set('v-city',v.city); set('v-state',v.state);
    set('v-pin',v.pin); set('v-notes',v.notes);
    set('v-credit',v.creditLimit); set('v-outstanding',v.outstandingBalance);
    set('v-terms',v.paymentTerms||'net30'); set('v-currency',v.currency||'INR');
    set('v-advance',v.advanceRequired); set('v-discount',v.earlyPayDiscount);
    set('v-moq-val',v.minOrderValue); set('v-leadtime',v.leadTimeDays);
    set('v-gstin',v.gstin); set('v-gst-type',v.gstType||'regular');
    set('v-pan',v.pan); set('v-tds',v.tdsCategory||'');
    set('v-bank-name',v.bankDetails?.accountHolderName); set('v-bank-acc',v.bankDetails?.accountNumber);
    set('v-bank-ifsc',v.bankDetails?.ifsc); set('v-bank-branch',v.bankDetails?.bankName);
    set('v-bank-type',v.bankDetails?.accountType||'current'); set('v-upi',v.bankDetails?.upiId);
    set('v-msme',v.msmeNumber); set('v-msme-cat',v.msmeCat||''); set('v-iec',v.iec); set('v-cin',v.cin);
    set('v-rating',v.rating||''); set('v-review-date',v.reviewDate);
    set('v-score-delivery',v.scores?.delivery); set('v-score-quality',v.scores?.quality);
    set('v-score-comm',v.scores?.communication); set('v-score-price',v.scores?.price);
    set('v-review-notes',v.reviewNotes); set('v-tags',v.tags);
    if (v.gstin) window.validateGSTIN(document.getElementById('v-gstin'));
    _renderContactsList(); _renderDocsList(); _renderPriceList();
    switchVTab('profile');
    openModal('vendor-modal');
  };

  // View
  window.viewVendor = (id) => {
    const v = _vendors.find(x=>x.id===id); if(!v) return;
    _viewId = id;
    document.getElementById('vview-title').textContent = v.name||'Vendor Profile';
    document.getElementById('vview-content').innerHTML = _renderVendorView(v);
    const eb = document.getElementById('vview-edit-btn');
    if (eb) eb.onclick = ()=>{ closeModal('vendor-view-modal'); editVendor(id); };
    openModal('vendor-view-modal');
  };

  // Purchase history
  window.viewVendorPOs = (id) => {
    const v = _vendors.find(x=>x.id===id); if(!v) return;
    const pos = _purchaseOrders.filter(p=>p.vendorId===id);
    const total = pos.reduce((s,p)=>s+(Number(p.totalAmount)||0),0);
    const win = window.open('','_blank','width=800,height=600');
    if (!win) { Toast.error('Blocked','Allow popups to view purchase history.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Purchase History — ${escHtml(v.name)}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;font-size:13px;padding:24px;color:#1e293b;}
      h2{font-size:18px;font-weight:700;margin-bottom:4px;}table{width:100%;border-collapse:collapse;margin-top:16px;}
      th{background:#1e3a5f;color:#fff;padding:8px 12px;text-align:left;font-size:11px;}td{padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;}
      .total{background:#f8fafc;font-weight:700;}@media print{button{display:none;}}</style></head><body>
      <h2>Purchase History — ${escHtml(v.name)}</h2>
      <div style="color:#64748b;font-size:12px;margin-bottom:12px;">${pos.length} orders · Total: ₹${total.toLocaleString('en-IN')}</div>
      <button onclick="window.print()" style="background:#0a84ff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;margin-bottom:16px;">🖨️ Print</button>
      <table><thead><tr><th>PO Number</th><th>Date</th><th>Items</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${pos.map(p=>`<tr><td style="font-family:monospace;font-weight:600;color:#0a84ff;">${escHtml(p.poNumber||'—')}</td>
        <td>${formatDate(p.createdAt)}</td><td>${p.items?.length||0}</td>
        <td style="font-family:monospace;font-weight:600;">₹${Number(p.totalAmount||0).toLocaleString('en-IN')}</td>
        <td><span style="background:${p.status==='approved'?'#dcfce7':p.status==='cancelled'?'#fee2e2':'#f8fafc'};color:${p.status==='approved'?'#166534':p.status==='cancelled'?'#991b1b':'#475569'};padding:2px 8px;border-radius:99px;font-size:10px;">${p.status||'draft'}</span></td>
      </tr>`).join('')}
      <tr class="total"><td colspan="3">Total</td><td>₹${total.toLocaleString('en-IN')}</td><td></td></tr>
      </tbody></table></body></html>`);
    win.document.close();
  };

  // Payment ledger
  window.viewVendorLedger = (id) => {
    const v = _vendors.find(x=>x.id===id); if(!v) return;
    Toast.info('Ledger', `Payment ledger for ${v.name} — connect Finance module for full ledger view.`);
  };

  // Rate vendor quick action
  window.rateVendor = (id) => {
    editVendor(id);
    setTimeout(()=>switchVTab('performance'),200);
  };

  // Delete
  window.deleteVendor = async (id) => {
    const v = _vendors.find(x=>x.id===id); if(!v) return;
    if (!confirm(`Delete vendor "${v.name}"? This cannot be undone.`)) return;
    try { await dbDelete(COLLECTIONS.VENDORS, id); Toast.success('Deleted','Vendor removed.'); }
    catch(e) { Toast.error('Failed',e.message); }
  };

  // Search / filter
  window.vendorSearch = debounce((q)=>{
    _filtered = searchFilter(_vendors, q, ['name','alias','contactPerson','phone','email','city','gstin','industry','tags']);
    _page=1; _renderList();
  },250);
  window.vendorFilter = (k,v)=>{ _filtered=v?_vendors.filter(x=>x[k]===v):[..._vendors]; _page=1; _renderList(); };
  window.filterVendorCat = (t)=>{ _activeChip=t; _filtered=t?_vendors.filter(v=>v.type===t):[..._vendors]; _page=1; _renderCatChips(); _renderList(); };
  window.setVendorPage = (p)=>{ _page=p; _renderList(); };
  window.toggleVendorView = ()=>{ _viewMode=_viewMode==='table'?'grid':'table'; document.getElementById('vendor-view-btn').textContent=_viewMode==='table'?'⊞ Grid':'☰ Table'; _renderList(); };

  // Export
  window.exportVendors = ()=>{
    const headers=['Name','Type','Phone','Email','City','State','GSTIN','PAN','Payment Terms','Credit Limit','Outstanding','Rating','Status','Since'];
    const rows=_filtered.map(v=>[v.name,VENDOR_TYPES[v.type]||v.type,v.phone,v.email,v.city,v.state,v.gstin,v.pan,PAYMENT_TERMS[v.paymentTerms]||v.paymentTerms,v.creditLimit||0,v.outstandingBalance||0,v.rating||'',v.status||'active',v.since||'']);
    const csv=[headers,...rows].map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='vendors_export.csv'; a.click();
    Toast.success('Exported',`${_filtered.length} vendors exported.`);
  };
}

function indianStates() {
  return ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Delhi','Jammu & Kashmir','Ladakh','Puducherry','Chandigarh'];
}
