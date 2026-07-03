// ============================================================
// LAM — Trip / Shipment Planning Module
// The core of TMS — connects Orders → Fleet → Drivers → POD → Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { TMS_COLLECTIONS } from './fleet.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, formatDateTime, escHtml, setLoading,
  searchFilter, debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose
} from '../_shared.js';

let _trips = [], _filt = [], _page = 1;
let _fleet = [], _drivers = [], _orders = [], _customers = [];
const PER = 15;
let _unsub = null;

export async function renderTrips(container) {
  [_fleet, _drivers, _orders, _customers] = await Promise.all([
    dbGetAll(TMS_COLLECTIONS.FLEET,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(TMS_COLLECTIONS.DRIVERS, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll('sales_orders',          AuthState.company?.id ? [where('companyId','==',AuthState.company.id), where('status','==','confirmed')] : [where('status','==','confirmed')]),
    dbGetAll(COLLECTIONS.CUSTOMERS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '🗺️ Trip & Shipment Planning',
    subtitle: 'Plan routes, assign vehicles and drivers, track deliveries end-to-end.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportTrips()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openTripModal()">+ Plan Trip</button>
    `,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="trip-kpis"></div>

      <!-- Live Trip Tracker -->
      <div class="card" style="margin-bottom:var(--space-5);">
        <div class="card-header">
          <div class="card-title">🔴 Live Trips</div>
          <span class="badge badge-green badge-dot" id="live-trip-count">0 active</span>
        </div>
        <div id="live-trips-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;"></div>
      </div>

      ${searchBar({
        id: 'trips',
        placeholder: 'Search trip no, origin, destination…',
        filters: [
          { key: 'status', label: 'All Status', options: [
            { value: 'planned',    label: 'Planned' },
            { value: 'loading',    label: 'Loading' },
            { value: 'in-transit', label: 'In Transit' },
            { value: 'delivered',  label: 'Delivered' },
            { value: 'cancelled',  label: 'Cancelled' },
          ]},
        ],
        onSearch: 'tripSearch',
        onFilter: 'tripFilter',
      })}
      <div id="trips-table-wrap"></div>
      <div id="trips-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', tripModal());
  document.body.insertAdjacentHTML('beforeend', podModal());
  setupModalClose(); setupMenuClose();
  registerTripGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid
    ? [where('companyId','==',cid), orderBy('createdAt','desc')]
    : [orderBy('createdAt','desc')];

  _unsub = dbListen(TMS_COLLECTIONS.TRIPS, c, data => {
    _trips = data; _filt = [...data];
    renderTripKPIs();
    renderLiveTrips();
    renderTripsTable();
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function renderTripKPIs() {
  const el = document.getElementById('trip-kpis'); if (!el) return;
  el.innerHTML = '';
  const total    = _trips.length;
  const active   = _trips.filter(t => t.status === 'in-transit' || t.status === 'loading').length;
  const delivered= _trips.filter(t => t.status === 'delivered').length;
  const delayed  = _trips.filter(t => t.delayed === true && t.status !== 'delivered').length;
  const totalKm  = _trips.reduce((s,t) => s+(Number(t.distanceKm)||0), 0);
  [
    { label:'Total Trips',    value:total,              icon:'🗺️', color:'kpi-blue'   },
    { label:'In Transit',     value:active,             icon:'🚛', color:'kpi-green'  },
    { label:'Delivered',      value:delivered,          icon:'✅', color:'kpi-orange' },
    { label:'Delayed',        value:delayed,            icon:'⚠️', color:delayed>0?'kpi-red':'kpi-blue' },
    { label:'Total KM',       value:formatNumber(totalKm)+' km', icon:'📍', color:'kpi-yellow' },
  ].forEach((k,i) => {
    el.innerHTML += `
      <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
        <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`;
  });
}

// ── Live Trips Grid ───────────────────────────────────────────
function renderLiveTrips() {
  const el    = document.getElementById('live-trips-grid');
  const badge = document.getElementById('live-trip-count');
  if (!el) return;

  const active = _trips.filter(t => t.status === 'in-transit' || t.status === 'loading');
  if (badge) badge.textContent = active.length + ' active';

  if (!active.length) {
    el.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-muted);font-size:12px;">No trips currently in transit</div>`;
    return;
  }

  el.innerHTML = active.map(t => {
    const vehicle = _fleet.find(v => v.id === t.vehicleId);
    const driver  = _drivers.find(d => d.id === t.driverId);
    const progress = t.status === 'loading' ? 10 : t.status === 'in-transit' ? 50 : t.status === 'delivered' ? 100 : 0;
    return `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:16px;border-left:3px solid var(--brand-primary);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(t.tripNumber||'—')}</span>
          <span class="badge badge-${t.status==='in-transit'?'blue':'yellow'} badge-dot">${t.status}</span>
        </div>
        <div style="font-size:13px;font-weight:500;margin-bottom:4px;">
          ${escHtml(t.origin||'—')} → ${escHtml(t.destination||'—')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
          🚛 ${escHtml(vehicle?.regNumber||'—')} &nbsp;·&nbsp; 👤 ${escHtml(driver?.name||'—')}
        </div>
        <!-- Progress bar -->
        <div style="background:var(--bg-overlay);border-radius:4px;height:6px;overflow:hidden;margin-bottom:8px;">
          <div style="height:100%;width:${progress}%;background:linear-gradient(90deg,var(--brand-primary),var(--brand-secondary));border-radius:4px;transition:width 1s ease;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">
          <span>${t.distanceKm||0} km</span>
          <span>ETA: ${t.eta||'—'}</span>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button class="btn btn-ghost btn-sm" style="flex:1;font-size:11px;" onclick="updateTripStatus('${t.id}','delivered')">✅ Mark Delivered</button>
          <button class="btn btn-ghost btn-sm" style="font-size:11px;" onclick="openPODModal('${t.id}')">📋 POD</button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Table ─────────────────────────────────────────────────────
function renderTripsTable() {
  const wrap = document.getElementById('trips-table-wrap');
  const pg   = document.getElementById('trips-pagination');
  if (!wrap) return;
  const start    = (_page-1)*PER;
  const pageData = _filt.slice(start, start+PER);
  const countEl  = document.getElementById('trips-count');
  if (countEl) countEl.textContent = `${_filt.length} trip${_filt.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id: 'trips-table',
    columns: [
      { key:'tripNumber',  label:'Trip #',     render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.tripNumber||'—')}</span>` },
      { key:'origin',      label:'Route',      render:r=>`<div style="font-size:12px;">${escHtml(r.origin||'—')}</div><div style="font-size:11px;color:var(--text-muted);">→ ${escHtml(r.destination||'—')}</div>` },
      { key:'vehicleId',   label:'Vehicle',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(_fleet.find(v=>v.id===r.vehicleId)?.regNumber||'—')}</span>` },
      { key:'driverId',    label:'Driver',     render:r=>`<span style="font-size:12px;">${escHtml(_drivers.find(d=>d.id===r.driverId)?.name||'Unassigned')}</span>` },
      { key:'distanceKm',  label:'Distance',   render:r=>`<span style="font-family:var(--font-mono);">${r.distanceKm||0} km</span>` },
      { key:'freightCost', label:'Freight',    render:r=>`<span style="font-family:var(--font-mono);">₹${Number(r.freightCost||0).toLocaleString('en-IN')}</span>` },
      { key:'delayed',     label:'',           render:r=>r.delayed?`<span class="badge badge-red">⚠ Delayed</span>`:'' },
      { key:'status',      label:'Status',     render:r=>badge(r.status||'planned') },
      { key:'startDate',   label:'Start',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.startDate||'—'}</span>` },
      { key:'actions',     label:'', sortable:false, render:r=>actionsMenu(r.id, [
          { icon:'🚛', label:'Start Trip',      action:`updateTripStatus('${r.id}','in-transit')` },
          { icon:'✅', label:'Mark Delivered',  action:`updateTripStatus('${r.id}','delivered')` },
          { icon:'📋', label:'Upload POD',      action:`openPODModal('${r.id}')` },
          { icon:'🗺️', label:'Live Track',       action:`openTripTracker('${r.id}')` },
          { icon:'📍', label:'Plan Route',        action:`window.openRoutePlanner?.('${r.id}')` },
          { icon:'⚠️', label:'Mark Delayed',    action:`markTripDelayed('${r.id}')` },
          { icon:'✏️', label:'Edit',            action:`editTrip('${r.id}')` },
          { icon:'🗑',  label:'Delete',          action:`deleteTrip('${r.id}')`, danger:true },
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No trips planned yet',
  });
  pg.innerHTML = buildPagination({ id:'trips', total:_filt.length, page:_page, perPage:PER, onChange:'setTripPage' });
}

// ── Trip Modal ────────────────────────────────────────────────
function tripModal() {
  const vehicleOpts = _fleet.filter(v => v.status !== 'maintenance' && v.status !== 'inactive').map(v =>
    `<option value="${v.id}">${escHtml(v.regNumber)} (${escHtml(v.vehicleType)}, ${v.payloadCapacity||0}kg)</option>`
  ).join('');

  const driverOpts = _drivers.filter(d => d.status !== 'inactive').map(d =>
    `<option value="${d.id}">${escHtml(d.name)} — ${escHtml(d.licenseType||'')}</option>`
  ).join('');

  const orderOpts = _orders.map(o => {
    const cust = _customers.find(c => c.id === o.customerId);
    return `<option value="${o.id}">${escHtml(o.orderNumber)} — ${escHtml(cust?.name||'—')}</option>`;
  }).join('');

  return buildModal({
    id: 'trip-modal',
    title: '<span id="trip-modal-title">Plan New Trip</span>',
    size: 'lg',
    body: `
      <input type="hidden" id="trip-id">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Trip Number</label>
          <input type="text" id="t-number" class="form-input" value="TRIP-${genId()}" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Linked Sales Order</label>
          <select id="t-order" class="form-select" onchange="autoFillTripFromOrder(this.value)">
            <option value="">Select order (optional)…</option>
            ${orderOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Origin <span class="required">*</span></label>
          <input type="text" id="t-origin" class="form-input" placeholder="Pickup location">
        </div>
        <div class="form-group">
          <label class="form-label">Destination <span class="required">*</span></label>
          <input type="text" id="t-dest" class="form-input" placeholder="Delivery location">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Start Date <span class="required">*</span></label>
          <input type="date" id="t-start" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Expected Delivery</label>
          <input type="date" id="t-eta-date" class="form-input">
        </div>
        <div class="form-group">
          <label class="form-label">Distance (km)</label>
          <input type="number" id="t-distance" class="form-input" placeholder="250" min="0" oninput="calcFreightCost()">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Vehicle <span class="required">*</span></label>
          <select id="t-vehicle" class="form-select">
            <option value="">Select vehicle…</option>
            ${vehicleOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Driver <span class="required">*</span></label>
          <select id="t-driver" class="form-select">
            <option value="">Select driver…</option>
            ${driverOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Cargo Description</label>
          <input type="text" id="t-cargo" class="form-input" placeholder="What is being transported">
        </div>
        <div class="form-group">
          <label class="form-label">Weight (kg)</label>
          <input type="number" id="t-weight" class="form-input" placeholder="0" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Freight Cost (₹)</label>
          <input type="number" id="t-freight" class="form-input" placeholder="0" min="0">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">E-Way Bill No.</label>
          <input type="text" id="t-eway" class="form-input" placeholder="EWB-XXXXXXXXXXXXX">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="t-status" class="form-select">
            <option value="planned">Planned</option>
            <option value="loading">Loading</option>
            <option value="in-transit">In Transit</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea id="t-notes" class="form-textarea" rows="2" placeholder="Special instructions, route notes…"></textarea>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('trip-modal')">Cancel</button>
      <button class="btn btn-primary" id="trip-save-btn" onclick="saveTrip()">Save Trip</button>
    `,
  });
}

// ── POD Modal ─────────────────────────────────────────────────
function podModal() {
  return buildModal({
    id:    'pod-modal',
    title: '📋 Digital Proof of Delivery',
    body: `
      <input type="hidden" id="pod-trip-id">
      <input type="hidden" id="pod-gps-lat">
      <input type="hidden" id="pod-gps-lng">

      <!-- GPS status bar -->
      <div id="pod-gps-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-elevated);border-radius:8px;margin-bottom:12px;font-size:11px;">
        <span id="pod-gps-icon">📡</span>
        <span id="pod-gps-label" style="color:var(--text-muted);">Getting GPS location…</span>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Delivery Date <span class="required">*</span></label>
          <input type="date" id="pod-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Delivery Status</label>
          <select id="pod-status" class="form-select">
            <option value="complete">✅ Complete Delivery</option>
            <option value="partial">⚠️ Partial Delivery</option>
            <option value="damaged">🔴 Goods Damaged</option>
            <option value="refused">❌ Refused / Rejected</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Received By <span class="required">*</span></label>
          <input type="text" id="pod-receiver" class="form-input" placeholder="Full name of receiver">
        </div>
        <div class="form-group">
          <label class="form-label">Contact Number</label>
          <input type="tel" id="pod-contact" class="form-input" placeholder="9876543210" maxlength="10">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Remarks / Discrepancies</label>
        <textarea id="pod-remarks" class="form-textarea" rows="2" placeholder="Any damage, shortage or special notes…"></textarea>
      </div>

      <!-- Signature pad -->
      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          Receiver Signature
          <span style="font-size:10px;color:var(--text-muted);font-weight:400;">Touch/mouse to sign</span>
        </label>
        <div id="pod-sig-pad"></div>
      </div>

      <!-- Photo evidence -->
      <div class="form-group">
        <label class="form-label">Photo Evidence</label>
        <div id="pod-photos-gallery"></div>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('pod-modal')">Cancel</button>
      <button class="btn btn-primary" id="pod-save-btn" onclick="savePOD()">✅ Confirm & Save POD</button>
    `,
  });
}

// Pod photos array — module-level
let _podPhotos   = [];
let _podSigPad   = null;

// ── Register Globals ──────────────────────────────────────────
function registerTripGlobals() {
  window.tripSearch = debounce((q) => {
    _filt = searchFilter(_trips, q, ['tripNumber','origin','destination','eWayBill','cargoDescription']);
    _page = 1; renderTripsTable();
  }, 250);

  window.tripFilter = (key, val) => {
    _filt = val ? _trips.filter(t => t[key] === val) : [..._trips];
    _page = 1; renderTripsTable();
  };

  window.setTripPage = (p) => { _page = p; renderTripsTable(); };

  window.openTripModal = () => {
    document.getElementById('trip-modal-title').textContent = 'Plan New Trip';
    document.getElementById('trip-id').value      = '';
    document.getElementById('t-number').value     = 'TRIP-' + genId();
    document.getElementById('t-origin').value     = '';
    document.getElementById('t-dest').value       = '';
    document.getElementById('t-cargo').value      = '';
    document.getElementById('t-weight').value     = '';
    document.getElementById('t-freight').value    = '';
    document.getElementById('t-eway').value       = '';
    document.getElementById('t-notes').value      = '';
    document.getElementById('t-distance').value   = '';
    openModal('trip-modal');
  };

  window.autoFillTripFromOrder = (orderId) => {
    if (!orderId) return;
    const order  = _orders.find(o => o.id === orderId);
    const cust   = _customers.find(c => c.id === order?.customerId);
    if (order) {
      if (cust?.address) document.getElementById('t-dest').value = cust.address;
      if (order.deliveryDate) document.getElementById('t-eta-date').value = order.deliveryDate;
    }
  };

  window.calcFreightCost = () => {
    const km   = Number(document.getElementById('t-distance')?.value) || 0;
    const rate = 12; // ₹12/km default rate
    const fEl  = document.getElementById('t-freight');
    if (fEl && !Number(fEl.value)) fEl.value = Math.round(km * rate);
  };

  window.saveTrip = async () => {
    if (!validateForm([
      { id:'t-origin',  label:'Origin',      required:true },
      { id:'t-dest',    label:'Destination', required:true },
      { id:'t-vehicle', label:'Vehicle',     required:true },
      { id:'t-driver',  label:'Driver',      required:true },
      { id:'t-start',   label:'Start Date',  required:true },
    ])) return;

    const btn = document.getElementById('trip-save-btn');
    setLoading(btn, true);
    const id = document.getElementById('trip-id').value;

    const data = {
      tripNumber:       document.getElementById('t-number').value.trim(),
      linkedOrderId:    document.getElementById('t-order').value  || null,
      origin:           document.getElementById('t-origin').value.trim(),
      destination:      document.getElementById('t-dest').value.trim(),
      startDate:        document.getElementById('t-start').value,
      eta:              document.getElementById('t-eta-date').value || null,
      distanceKm:       Number(document.getElementById('t-distance').value) || 0,
      vehicleId:        document.getElementById('t-vehicle').value,
      driverId:         document.getElementById('t-driver').value,
      cargoDescription: document.getElementById('t-cargo').value.trim(),
      weightKg:         Number(document.getElementById('t-weight').value) || 0,
      freightCost:      Number(document.getElementById('t-freight').value) || 0,
      eWayBill:         document.getElementById('t-eway').value.trim(),
      status:           document.getElementById('t-status').value,
      notes:            document.getElementById('t-notes').value.trim(),
      delayed:          false,
      companyId:        AuthState.company?.id || null,
    };

    try {
      if (id) {
        await dbUpdate(TMS_COLLECTIONS.TRIPS, id, data);
        Toast.success('Updated', `${data.tripNumber} updated.`);
      } else {
        await dbCreate(TMS_COLLECTIONS.TRIPS, data);
        // Update vehicle + driver status
        await dbUpdate(TMS_COLLECTIONS.FLEET,   data.vehicleId, { status: 'in-transit' });
        await dbUpdate(TMS_COLLECTIONS.DRIVERS, data.driverId,  { status: 'on-trip', currentTripId: 'new' });
        // Update linked order to 'processing'
        if (data.linkedOrderId) await dbUpdate('sales_orders', data.linkedOrderId, { status: 'processing' });
        Toast.success('Trip Created', `${data.tripNumber} planned.`);
      window.LAMSync?.Notify.tripAssigned(data.id, data.driverName || data.driverId || 'Driver', data.destination || '—');
      }
      closeModal('trip-modal');
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  window.editTrip = (id) => {
    const t = _trips.find(x => x.id === id); if (!t) return;
    document.getElementById('trip-modal-title').textContent = 'Edit Trip';
    document.getElementById('trip-id').value       = t.id;
    document.getElementById('t-number').value      = t.tripNumber||'';
    document.getElementById('t-order').value       = t.linkedOrderId||'';
    document.getElementById('t-origin').value      = t.origin||'';
    document.getElementById('t-dest').value        = t.destination||'';
    document.getElementById('t-start').value       = t.startDate||'';
    document.getElementById('t-eta-date').value    = t.eta||'';
    document.getElementById('t-distance').value    = t.distanceKm||'';
    document.getElementById('t-vehicle').value     = t.vehicleId||'';
    document.getElementById('t-driver').value      = t.driverId||'';
    document.getElementById('t-cargo').value       = t.cargoDescription||'';
    document.getElementById('t-weight').value      = t.weightKg||'';
    document.getElementById('t-freight').value     = t.freightCost||'';
    document.getElementById('t-eway').value        = t.eWayBill||'';
    document.getElementById('t-status').value      = t.status||'planned';
    document.getElementById('t-notes').value       = t.notes||'';
    openModal('trip-modal');
  };

  window.updateTripStatus = async (id, newStatus) => {
    const t = _trips.find(x => x.id === id); if (!t) return;
    try {
      await dbUpdate(TMS_COLLECTIONS.TRIPS, id, { status: newStatus });

      if (newStatus === 'in-transit') {
        await dbUpdate(TMS_COLLECTIONS.FLEET,   t.vehicleId, { status: 'in-transit' });
        await dbUpdate(TMS_COLLECTIONS.DRIVERS, t.driverId,  { status: 'on-trip' });
        if (t.linkedOrderId) await dbUpdate('sales_orders', t.linkedOrderId, { status: 'dispatched' });
      }

      if (newStatus === 'delivered') {
        await dbUpdate(TMS_COLLECTIONS.FLEET,   t.vehicleId, { status: 'active' });
        await dbUpdate(TMS_COLLECTIONS.DRIVERS, t.driverId,  { status: 'active', currentTripId: null });
        // Increment driver trip count
        const driver = _drivers.find(d => d.id === t.driverId);
        if (driver) await dbUpdate(TMS_COLLECTIONS.DRIVERS, t.driverId, { totalTrips: (driver.totalTrips||0)+1 });
        if (t.linkedOrderId) await dbUpdate('sales_orders', t.linkedOrderId, { status: 'delivered' });
        Toast.success('Delivered! 🎉', `${t.tripNumber} marked as delivered. Vehicle & driver freed.`);
      window.LAMSync?.Notify.deliveryComplete(t.tripNumber, 'Driver');
      }
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.markTripDelayed = async (id) => {
    const reason = prompt('Enter reason for delay:');
    if (!reason) return;
    try {
      await dbUpdate(TMS_COLLECTIONS.TRIPS, id, { delayed: true, delayReason: reason });
      Toast.warning('Marked Delayed', 'Trip flagged as delayed.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.openPODModal = async (tripId) => {
    // If driver already captured a POD via lam-driver.js, show it read-only
    if (window.LAMDriver?.openPODViewer) {
      const existingPOD = await window.LAMDriver.openPODViewer(tripId);
      if (existingPOD) {
        _showDriverPODReadonly(existingPOD, tripId);
        return;
      }
    }

    _podPhotos = [];
    _podSigPad = null;
    document.getElementById('pod-trip-id').value = tripId;
    openModal('pod-modal');

    // Delay slightly so modal is in DOM
    setTimeout(() => {
      // Initialize signature pad
      const sigContainer = document.getElementById('pod-sig-pad');
      if (sigContainer && window.LAMCamera) {
        _podSigPad = window.LAMCamera.createSignaturePad(sigContainer, {
          height: 140,
          penColor: '#0F172A',
        });
      }

      // Initialize photo gallery
      const photosContainer = document.getElementById('pod-photos-gallery');
      if (photosContainer && window.LAMCamera) {
        window.LAMCamera.renderPhotoGallery(photosContainer, _podPhotos, {
          editable: true,
          label: 'Delivery Photos',
          onAdd: (photo) => _podPhotos.push(photo),
        });
      }

      // Get GPS location
      const gpsBar   = document.getElementById('pod-gps-bar');
      const gpsLabel = document.getElementById('pod-gps-label');
      const gpsIcon  = document.getElementById('pod-gps-icon');
      const gpsLat   = document.getElementById('pod-gps-lat');
      const gpsLng   = document.getElementById('pod-gps-lng');

      if (window.LAMGPS && gpsLabel) {
        window.LAMGPS.getCurrentLocation({ highAccuracy: true, timeout: 12000 })
          .then(pos => {
            gpsLat.value = pos.lat;
            gpsLng.value = pos.lng;
            gpsIcon.textContent  = '📍';
            gpsLabel.textContent = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${Math.round(pos.accuracy)}m)`;
            gpsLabel.style.color = 'var(--brand-secondary)';
          })
          .catch(() => {
            gpsIcon.textContent  = '⚠️';
            gpsLabel.textContent = 'Location unavailable — POD will be saved without GPS stamp.';
            gpsLabel.style.color = 'var(--brand-warning)';
          });
      } else if (gpsLabel) {
        gpsLabel.textContent = 'GPS engine not loaded.';
      }
    }, 120);
  };

  window.savePOD = async () => {
    if (!validateForm([
      { id:'pod-date',     label:'Delivery Date', required:true },
      { id:'pod-receiver', label:'Received By',   required:true },
    ])) return;

    const btn    = document.getElementById('pod-save-btn');
    setLoading(btn, true);
    const tripId = document.getElementById('pod-trip-id').value;
    const trip   = _trips.find(x => x.id === tripId);

    // Capture signature
    const signature = _podSigPad?.getSignatureJpeg?.() || null;

    // Capture GPS
    const gpsLat = parseFloat(document.getElementById('pod-gps-lat')?.value || '0') || null;
    const gpsLng = parseFloat(document.getElementById('pod-gps-lng')?.value || '0') || null;

    const podData = {
      tripId,
      vehicleId:    trip?.vehicleId || null,
      driverId:     trip?.driverId  || null,
      orderId:      trip?.linkedOrderId || null,
      deliveryDate: document.getElementById('pod-date').value,
      signature:    signature,
      gps:          gpsLat && gpsLng ? { lat: gpsLat, lng: gpsLng } : null,
      photos:       _podPhotos.map(p => ({ thumb: p.thumb, sizeKB: p.sizeKB, timestamp: p.timestamp, gps: p.gps, base64: p.base64 })),
      signedAt:     new Date().toISOString(),
      receivedBy:   document.getElementById('pod-receiver').value.trim(),
      receiverContact: document.getElementById('pod-contact').value.trim(),
      deliveryStatus:  document.getElementById('pod-status').value,
      remarks:      document.getElementById('pod-remarks').value.trim(),
      companyId:    AuthState.company?.id || null,
    };

    try {
      await dbCreate(TMS_COLLECTIONS.POD, podData);
      // Mark trip delivered
      await window.updateTripStatus(tripId, 'delivered');
      Toast.success('POD Saved', 'Delivery confirmed. All records updated.');
      window.LAMSync?.Notify.deliveryComplete(podData.tripId || 'Trip', podData.receiver || 'Receiver');
      closeModal('pod-modal');
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  window.deleteTrip = async (id) => {
    const t = _trips.find(x => x.id === id);
    if (!confirm(`Delete trip "${t?.tripNumber}"?`)) return;
    try {
      await dbDelete(TMS_COLLECTIONS.TRIPS, id);
      Toast.success('Deleted', 'Trip removed.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.exportTrips = () => {
    const csv = [
      ['Trip #','Origin','Destination','Vehicle','Driver','Distance(km)','Freight(₹)','Status','Start Date'],
      ..._filt.map(t => [
        t.tripNumber, t.origin, t.destination,
        _fleet.find(v=>v.id===t.vehicleId)?.regNumber||'—',
        _drivers.find(d=>d.id===t.driverId)?.name||'—',
        t.distanceKm, t.freightCost, t.status, t.startDate,
      ])
    ].map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    a.download = 'trips_export.csv'; a.click();
    Toast.success('Exported', `${_filt.length} trips exported.`);
  };
}

// ── Driver-captured POD viewer (read-only, for Owner/Accountant) ──────────────
function _showDriverPODReadonly(pod, tripId) {
  const trip = (_trips || []).find(t => t.id === tripId) || {};

  const modal = document.createElement('div');
  modal.id = 'lam-driver-pod-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;padding:16px;
    font-family:var(--font-body,'Geist',system-ui,sans-serif);
  `;

  const escH = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dt   = iso => iso
    ? new Date(iso).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true})
    : '—';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:500px;
                max-height:90dvh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <div style="padding:16px 20px;border-bottom:1px solid #EAECF0;
                  display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1;">
        <div>
          <div style="font-weight:700;font-size:15px;color:#0D1117;">📋 Proof of Delivery</div>
          <div style="font-size:12px;color:#8898AA;">${escH(trip.tripNumber||pod.tripNumber||'—')}</div>
        </div>
        <button onclick="document.getElementById('lam-driver-pod-modal').remove()"
          style="background:none;border:none;cursor:pointer;font-size:22px;color:#8898AA;line-height:1;">×</button>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:14px;">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="padding:12px;background:#F8FAFC;border-radius:10px;">
            <div style="font-size:10px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Receiver</div>
            <div style="font-weight:700;font-size:14px;color:#0D1117;">${escH(pod.receiverName||'—')}</div>
          </div>
          <div style="padding:12px;background:#F8FAFC;border-radius:10px;">
            <div style="font-size:10px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Delivery Time</div>
            <div style="font-weight:600;font-size:13px;color:#0D1117;">${dt(pod.timestamp)}</div>
          </div>
          <div style="padding:12px;background:#F8FAFC;border-radius:10px;">
            <div style="font-size:10px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Driver</div>
            <div style="font-weight:600;font-size:13px;color:#0D1117;">${escH(pod.driverName||'—')}</div>
          </div>
          ${pod.gpsLat ? `
          <div style="padding:12px;background:#F8FAFC;border-radius:10px;">
            <div style="font-size:10px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">GPS</div>
            <div style="font-size:12px;color:#4A5568;">📍 ${pod.gpsLat.toFixed(5)}, ${pod.gpsLng.toFixed(5)}</div>
          </div>` : ''}
        </div>

        ${pod.photoB64 ? `
        <div>
          <div style="font-size:12px;font-weight:700;color:#4A5568;margin-bottom:8px;">Photo Evidence</div>
          <img src="data:image/jpeg;base64,${pod.photoB64}"
            style="width:100%;max-height:240px;object-fit:cover;border-radius:12px;
                   border:1px solid #E2E8F0;display:block;">
        </div>` : ''}

        ${pod.signatureB64 ? `
        <div>
          <div style="font-size:12px;font-weight:700;color:#4A5568;margin-bottom:8px;">Receiver Signature</div>
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:12px;">
            <img src="data:image/png;base64,${pod.signatureB64}"
              style="width:100%;max-height:120px;object-fit:contain;display:block;">
          </div>
        </div>` : ''}

        <div style="display:flex;gap:10px;padding-top:4px;">
          <button onclick="document.getElementById('lam-driver-pod-modal').remove()"
            class="btn btn-secondary" style="flex:1;">Close</button>
          <button onclick="window.LAMPDF?.deliveryNote({...${JSON.stringify({id:pod.tripId, tripNumber:pod.tripNumber})}, receiverName:'${escH(pod.receiverName)}', deliveredAt:'${pod.timestamp}'},{},{},[]);document.getElementById('lam-driver-pod-modal').remove()"
            class="btn btn-primary" style="flex:1;">⬇ Download PDF</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
}


// ── Live Trip Tracker ─────────────────────────────────────────
// Called from dashboard when user clicks a "Track" button on a trip
window.openTripTracker = (tripId) => {
  const trip = (_trips || []).find(t => t.id === tripId);
  if (!trip) { Toast.error('Not Found', 'Trip not found.'); return; }

  // Build tracker modal
  const existing = document.getElementById('trip-tracker-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'trip-tracker-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;width:100%;max-width:700px;max-height:90vh;overflow:auto;display:flex;flex-direction:column;">
      <div style="padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-subtle);">
        <div>
          <div style="font-size:15px;font-weight:700;">🚛 Live Tracking — ${escHtml(trip.tripId || trip.id?.slice(0,8) || '—')}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(trip.origin||'—')} → ${escHtml(trip.destination||'—')}</div>
        </div>
        <button onclick="document.getElementById('trip-tracker-modal').remove();window._tripTrackerStop?.();" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--text-muted);">✕</button>
      </div>

      <!-- Map canvas -->
      <div style="padding:12px;">
        <canvas id="trip-tracker-map" width="660" height="320" style="width:100%;border-radius:12px;border:1px solid var(--border-subtle);"></canvas>
      </div>

      <!-- Live info bar -->
      <div id="tracker-info" style="padding:0 12px 12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
        <div style="background:var(--bg-elevated);border-radius:8px;padding:10px;text-align:center;">
          <div id="tk-speed" style="font-size:18px;font-weight:700;">—</div>
          <div style="font-size:10px;color:var(--text-muted);">km/h</div>
        </div>
        <div style="background:var(--bg-elevated);border-radius:8px;padding:10px;text-align:center;">
          <div id="tk-dist" style="font-size:18px;font-weight:700;">—</div>
          <div style="font-size:10px;color:var(--text-muted);">km covered</div>
        </div>
        <div style="background:var(--bg-elevated);border-radius:8px;padding:10px;text-align:center;">
          <div id="tk-acc" style="font-size:18px;font-weight:700;">—</div>
          <div style="font-size:10px;color:var(--text-muted);">m accuracy</div>
        </div>
        <div style="background:var(--bg-elevated);border-radius:8px;padding:10px;text-align:center;">
          <div id="tk-status" style="font-size:13px;font-weight:600;">Locating…</div>
          <div style="font-size:10px;color:var(--text-muted);">status</div>
        </div>
      </div>

      <div style="padding:0 12px 16px;display:flex;gap:8px;">
        <button id="tk-start-btn" class="btn btn-primary" style="flex:1;" onclick="window._startTripTracking?.('${trip.id}')">▶ Start Tracking Me</button>
        <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('trip-tracker-modal').remove();window._tripTrackerStop?.();">✕ Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Init map
  setTimeout(() => {
    if (!window.LAMGPS) return;
    const canvas = document.getElementById('trip-tracker-map');
    if (!canvas) return;

    const map = new window.LAMGPS.LAMMap(canvas, {
      zoom:   12,
      center: { lat: 9.9312, lng: 76.2673 },
    });

    // Upgrade tile loader to use IDB cache (Tier 5)
    if (window.LAMMaps) {
      // Pre-cache tiles for the trip region when online
      const tripOriginCoords = window.LAMMaps.geocodeOffline?.(trip.origin||'kochi');
      if (tripOriginCoords) {
        map.setCenter(tripOriginCoords.lat, tripOriginCoords.lng, 12);
        // Cache tiles for this region silently
        window.LAMMaps.preCacheRegion({
          north: tripOriginCoords.lat + 0.5,
          south: tripOriginCoords.lat - 0.5,
          east:  tripOriginCoords.lng + 0.5,
          west:  tripOriginCoords.lng - 0.5,
        }, [10, 11, 12], (loaded, total) => {
          if (loaded === total) console.log(`LAMMaps: ${total} tiles cached for offline use`);
        }).catch(() => {});
      }
    }

    // Plot origin/destination if geocodable
    map.addMarker({ lat: 9.9312, lng: 76.2673, title: trip.origin     || 'Origin',      color: '#30D158', type: 'pin' });
    map.addMarker({ lat: 9.8800, lng: 76.5000, title: trip.destination || 'Destination', color: '#FF453A', type: 'pin' });

    // GPS Tracker
    const tracker = new window.LAMGPS.GPSTracker({
      onUpdate: (point) => {
        // Update map
        map.clearMarkers();
        map.addMarker({ lat: 9.9312, lng: 76.2673, title: 'Origin', color: '#30D158', type: 'pin' });
        map.addMarker({ lat: 9.8800, lng: 76.5000, title: 'Destination', color: '#FF453A', type: 'pin' });
        map.addMarker({ lat: point.lat, lng: point.lng, title: 'Driver', color: '#0A84FF', type: 'truck', bearing: point.bearing || 0 });

        // Plot route
        const hist = tracker.getHistory();
        if (hist.length > 1) {
          map.clearRoutes();
          map.addRoute({ points: hist, color: '#0A84FF', width: 3 });
        }
        map.setCenter(point.lat, point.lng);

        // Update info bar
        const speed = document.getElementById('tk-speed');
        const dist  = document.getElementById('tk-dist');
        const acc   = document.getElementById('tk-acc');
        const status= document.getElementById('tk-status');
        if (speed) speed.textContent = point.speed ?? '—';
        if (dist)  dist.textContent  = (tracker.getTotalDistance() / 1000).toFixed(1);
        if (acc)   acc.textContent   = Math.round(point.accuracy || 0);
        if (status) { status.textContent = '🟢 Live'; status.style.color = 'var(--brand-secondary)'; }
      },
      onError: (err) => {
        Toast.error('GPS Error', err);
      },
    });

    window._tripTrackerStop = () => { tracker.stop(); map.destroy?.(); };

    window._startTripTracking = () => {
      const btn = document.getElementById('tk-start-btn');
      if (btn) btn.disabled = true;
      tracker.start();
      Toast.info('Tracking started', 'Your location is being tracked.');
    };

  }, 200);
};


// ── Route Planner (Tier 5 — LAMMaps) ─────────────────────────
window.openRoutePlanner = async (tripId) => {
  const trip = (_trips||[]).find(t=>t.id===tripId);
  if (!trip || !window.LAMMaps) {
    Toast.info('Route Planner', 'Route planning requires LAMMaps engine.');
    return;
  }

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;width:100%;max-width:660px;overflow:hidden;">
      <div style="padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-subtle);">
        <div style="font-weight:700;">🗺️ Route Planner — ${escHtml(trip.tripNumber||trip.id?.slice(0,8)||'Trip')}</div>
        <button onclick="this.closest('div').parentElement.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--text-muted);">✕</button>
      </div>
      <div style="padding:12px;">
        <canvas id="route-map-canvas" style="width:100%;height:300px;border-radius:10px;border:1px solid var(--border-subtle);display:block;"></canvas>
      </div>
      <div id="route-details" style="padding:0 16px 16px;font-size:12px;color:var(--text-muted);">Calculating route…</div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

  setTimeout(async () => {
    const canvas = document.getElementById('route-map-canvas');
    if (!canvas || !window.LAMGPS) return;

    // Geocode origin and destination
    const [originCoords, destCoords] = await Promise.all([
      window.LAMMaps.geocode(trip.origin||'Kochi, Kerala'),
      window.LAMMaps.geocode(trip.destination||'Kochi, Kerala'),
    ]);

    const origin = originCoords[0] || { lat:9.9312, lng:76.2673 };
    const dest   = destCoords[0]   || { lat:9.8800, lng:76.5000 };

    // Plan route via OSRM
    const route = await window.LAMMaps.planRoute(origin, dest);

    // Render map
    const map = new window.LAMGPS.LAMMap(canvas, { zoom:10, center:{ lat:(origin.lat+dest.lat)/2, lng:(origin.lng+dest.lng)/2 } });
    map.addMarker({ lat:origin.lat, lng:origin.lng, title:'Origin',      color:'#30D158', type:'pin' });
    map.addMarker({ lat:dest.lat,   lng:dest.lng,   title:'Destination', color:'#FF453A', type:'pin' });
    if (route.points?.length > 2) {
      map.addRoute({ points:route.points, color:'#0A84FF', width:3 });
    }
    map.fitBounds([origin, dest]);

    // Show route details
    const details = document.getElementById('route-details');
    if (details) {
      details.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:4px;">
          ${[
            { label:'Distance', value:`${route.distanceKm} km` },
            { label:'Duration', value:route.durationHr },
            { label:'Est. Toll', value:`₹${route.tollEstimate?.toLocaleString('en-IN')||'—'}` },
            { label:'Fuel Cost', value:`₹${route.fuelCost?.toLocaleString('en-IN')||'—'}` },
          ].map(k=>`<div style="background:var(--bg-elevated);border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:14px;font-weight:700;">${k.value}</div>
            <div style="font-size:10px;color:var(--text-muted);">${k.label}</div>
          </div>`).join('')}
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--text-muted);">
          Route source: ${route.source} • ${origin.label?.slice(0,40)||trip.origin} → ${dest.label?.slice(0,40)||trip.destination}
        </div>
      `;
    }
  }, 200);
};
