// ============================================================
// LAM — Transport Management System (TMS)
// Phase 4 — Enterprise Plan
// Module 1: Fleet / Vehicle Management
// Interconnects: Drivers, Trips, Maintenance, Orders, Fuel
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, avatarCell,
  validateForm, openModal, closeModal,
  setupModalClose, setupMenuClose
} from '../_shared.js';

// ── Collection names ──────────────────────────────────────────
export const TMS_COLLECTIONS = {
  FLEET:       'tms_fleet',
  DRIVERS:     'tms_drivers',
  TRIPS:       'tms_trips',
  FUEL:        'tms_fuel',
  MAINTENANCE: 'tms_maintenance',
  POD:         'tms_pod',
};

let _fleet = [], _filt = [], _page = 1;
let _drivers = [];
const PER = 15;
let _unsub = null;

export async function renderFleet(container) {
  _drivers = await dbGetAll(TMS_COLLECTIONS.DRIVERS,
    AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []
  );

  container.innerHTML = pageShell({
    title: '🚛 Fleet Management',
    subtitle: 'Manage vehicles, track status, assign drivers and monitor performance.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportFleet()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openFleetModal()">+ Add Vehicle</button>
    `,
    content: `
      <!-- Fleet KPIs -->
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="fleet-kpis"></div>

      <!-- Fleet Status Grid -->
      <div style="display:grid;grid-template-columns:1fr 300px;gap:var(--space-5);margin-bottom:var(--space-5);">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Vehicle Status Board</div>
            <div class="flex gap-2">
              <span class="badge badge-green badge-dot" id="fleet-active-count">0 Active</span>
              <span class="badge badge-yellow badge-dot" id="fleet-maintenance-count">0 Maintenance</span>
              <span class="badge badge-gray badge-dot" id="fleet-idle-count">0 Idle</span>
            </div>
          </div>
          <div id="fleet-status-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">⚠️ Alerts</div></div>
          <div id="fleet-alerts" style="display:flex;flex-direction:column;gap:8px;"></div>
        </div>
      </div>

      <!-- Search + Table -->
      ${searchBar({
        id: 'fleet',
        placeholder: 'Search reg number, type, driver…',
        filters: [
          { key: 'status', label: 'All Status', options: [
            { value: 'active',      label: 'Active' },
            { value: 'in-transit',  label: 'In Transit' },
            { value: 'maintenance', label: 'Maintenance' },
            { value: 'idle',        label: 'Idle' },
            { value: 'inactive',    label: 'Inactive' },
          ]},
          { key: 'vehicleType', label: 'All Types', options: [
            { value: 'truck',      label: 'Truck' },
            { value: 'mini-truck', label: 'Mini Truck' },
            { value: 'van',        label: 'Van' },
            { value: 'bike',       label: 'Bike / 2W' },
            { value: 'tempo',      label: 'Tempo' },
            { value: 'container',  label: 'Container' },
          ]},
        ],
        onSearch: 'fleetSearch',
        onFilter: 'fleetFilter',
      })}
      <div id="fleet-table-wrap"></div>
      <div id="fleet-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', fleetModal());
  document.body.insertAdjacentHTML('beforeend', fleetViewModal());
  setupModalClose(); setupMenuClose();
  registerFleetGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid
    ? [where('companyId','==',cid), orderBy('createdAt','desc')]
    : [orderBy('createdAt','desc')];

  _unsub = dbListen(TMS_COLLECTIONS.FLEET, c, data => {
    _fleet = data; _filt = [...data];
    renderFleetKPIs();
    renderFleetStatusGrid();
    renderFleetAlerts();
    renderFleetTable();
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function renderFleetKPIs() {
  const el = document.getElementById('fleet-kpis'); if (!el) return;
  const total       = _fleet.length;
  const active      = _fleet.filter(v => v.status === 'active' || v.status === 'in-transit').length;
  const maintenance = _fleet.filter(v => v.status === 'maintenance').length;
  const totalCap    = _fleet.reduce((s, v) => s + (Number(v.payloadCapacity) || 0), 0);
  const expiringSoon = _fleet.filter(v => {
    if (!v.insuranceExpiry) return false;
    const days = (new Date(v.insuranceExpiry) - Date.now()) / 86400000;
    return days <= 30 && days > 0;
  }).length;

  [
    { label: 'Total Vehicles',     value: total,        icon: '🚛', color: 'kpi-blue' },
    { label: 'Active / In Transit',value: active,       icon: '✅', color: 'kpi-green' },
    { label: 'In Maintenance',     value: maintenance,  icon: '🔧', color: 'kpi-yellow' },
    { label: 'Total Payload (kg)', value: formatNumber(totalCap), icon: '⚖️', color: 'kpi-orange' },
    { label: 'Insurance Expiring', value: expiringSoon, icon: '⚠️', color: expiringSoon > 0 ? 'kpi-red' : 'kpi-blue' },
  ].forEach((k, i) => {
    el.innerHTML += `
      <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
        <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`;
  });

  // Update status badge counts
  const ac = document.getElementById('fleet-active-count');
  const mc = document.getElementById('fleet-maintenance-count');
  const ic = document.getElementById('fleet-idle-count');
  if (ac) ac.textContent = active + ' Active';
  if (mc) mc.textContent = maintenance + ' Maintenance';
  if (ic) ic.textContent = _fleet.filter(v => v.status === 'idle').length + ' Idle';
}

// ── Status Grid ───────────────────────────────────────────────
function renderFleetStatusGrid() {
  const el = document.getElementById('fleet-status-grid'); if (!el) return;
  if (!_fleet.length) {
    el.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);font-size:13px;">No vehicles added yet</div>`;
    return;
  }
  const statusIcon  = { active:'🟢', 'in-transit':'🔵', maintenance:'🟡', idle:'⚫', inactive:'🔴' };
  const statusColor = { active:'var(--brand-secondary)', 'in-transit':'var(--brand-primary)', maintenance:'var(--brand-warning)', idle:'var(--text-muted)', inactive:'var(--brand-danger)' };

  el.innerHTML = _fleet.map(v => {
    const driver = _drivers.find(d => d.id === v.assignedDriverId);
    const color  = statusColor[v.status] || 'var(--text-muted)';

    // Find the active trip for this vehicle to surface GPS last ping
    const activeTripEl = v.status === 'in-transit'
      ? `<div id="gps-ping-${v.id}" style="font-size:10px;color:var(--brand-primary);margin-top:4px;">
           📡 Loading GPS…
         </div>`
      : '';

    return `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:14px;cursor:pointer;transition:all 0.2s;border-left:3px solid ${color};"
           onclick="viewVehicle('${v.id}')" onmouseenter="this.style.borderColor='${color}'" onmouseleave="this.style.borderColor='var(--border-subtle)'">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--text-primary);">${escHtml(v.regNumber || '—')}</span>
          <span style="font-size:14px;">${statusIcon[v.status] || '⚫'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">${escHtml(v.vehicleType || '—')} · ${escHtml(v.make || '')} ${escHtml(v.model || '')}</div>
        <div style="font-size:11px;color:var(--text-muted);">👤 ${escHtml(driver?.name || 'Unassigned')}</div>
        ${v.payloadCapacity ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">⚖️ ${v.payloadCapacity} kg capacity</div>` : ''}
        ${activeTripEl}
      </div>
    `;
  }).join('');

  // Async: load GPS pings for in-transit vehicles
  _loadGPSPingsForFleet();
}

async function _loadGPSPingsForFleet() {
  if (!window.LAMDB) return;
  try {
    const pings = await window.LAMDB.dbGetAll('lam_gps_pings').catch(() => []);
    const trips = await window.LAMDB.dbGetAll('tms_trips').catch(() => []);

    _fleet.filter(v => v.status === 'in-transit').forEach(v => {
      const el = document.getElementById(`gps-ping-${v.id}`);
      if (!el) return;

      // Find active trip for this vehicle
      const trip = trips.find(t => t.vehicleId === v.id && t.status === 'in-transit');
      if (!trip) { el.textContent = ''; return; }

      // Find latest ping for this trip
      const tripPings = pings
        .filter(p => p.tripId === trip.id)
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      const latest = tripPings[0];

      if (!latest) {
        el.innerHTML = '📡 No GPS ping yet';
        return;
      }

      const ageMin = Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 60000);
      const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin/60)}h ago`;

      el.innerHTML = `
        📍 <a href="https://maps.google.com/?q=${latest.lat},${latest.lng}"
              target="_blank" rel="noopener"
              style="color:var(--brand-primary);text-decoration:none;font-weight:600;"
              onclick="event.stopPropagation()">
              View on map
           </a> · ${ageStr}
      `;
    });
  } catch {}
}

// ── Alerts ────────────────────────────────────────────────────
function renderFleetAlerts() {
  const el = document.getElementById('fleet-alerts'); if (!el) return;
  const alerts = [];
  const now = Date.now();

  _fleet.forEach(v => {
    // Insurance expiry
    if (v.insuranceExpiry) {
      const days = Math.ceil((new Date(v.insuranceExpiry) - now) / 86400000);
      if (days <= 0)  alerts.push({ type: 'error',   icon: '🚨', text: `${v.regNumber} — Insurance EXPIRED` });
      else if (days <= 30) alerts.push({ type: 'warning', icon: '⚠️', text: `${v.regNumber} — Insurance expires in ${days}d` });
    }
    // Fitness/RC expiry
    if (v.fitnessExpiry) {
      const days = Math.ceil((new Date(v.fitnessExpiry) - now) / 86400000);
      if (days <= 0)  alerts.push({ type: 'error',   icon: '🚨', text: `${v.regNumber} — Fitness cert EXPIRED` });
      else if (days <= 30) alerts.push({ type: 'warning', icon: '⚠️', text: `${v.regNumber} — Fitness expires in ${days}d` });
    }
    // Service due
    if (v.nextServiceKm && v.currentKm && Number(v.currentKm) >= Number(v.nextServiceKm) - 500) {
      alerts.push({ type: 'warning', icon: '🔧', text: `${v.regNumber} — Service due at ${v.nextServiceKm} km` });
    }
  });

  if (!alerts.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">✅ All vehicles clear</div>`;
    return;
  }

  el.innerHTML = alerts.slice(0, 8).map(a => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${a.type==='error'?'var(--brand-danger)':'var(--brand-warning)'};">
      <span style="flex-shrink:0;">${a.icon}</span>
      <span style="font-size:11px;color:var(--text-secondary);line-height:1.5;">${escHtml(a.text)}</span>
    </div>
  `).join('');
}

// ── Table ─────────────────────────────────────────────────────
function renderFleetTable() {
  const wrap = document.getElementById('fleet-table-wrap');
  const pg   = document.getElementById('fleet-pagination');
  if (!wrap) return;
  const start    = (_page-1)*PER;
  const pageData = _filt.slice(start, start+PER);
  const countEl  = document.getElementById('fleet-count');
  if (countEl) countEl.textContent = `${_filt.length} vehicle${_filt.length !== 1 ? 's' : ''}`;

  wrap.innerHTML = buildTable({
    id: 'fleet-table',
    onRowClick: 'viewVehicle',
    columns: [
      { key: 'regNumber',   label: 'Reg. Number', render: r => `<span style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--brand-primary);">${escHtml(r.regNumber||'—')}</span>` },
      { key: 'vehicleType', label: 'Type',         render: r => badge(r.vehicleType, r.vehicleType) },
      { key: 'make',        label: 'Make / Model', render: r => `<span style="color:var(--text-secondary)">${escHtml((r.make||'')+(r.model?' '+r.model:''))}</span>` },
      { key: 'assignedDriverId', label: 'Driver', render: r => {
        const d = _drivers.find(x => x.id === r.assignedDriverId);
        return d ? avatarCell(d.name, d.phone, 'var(--brand-secondary)', 'rgba(0,200,150,0.12)') : `<span style="color:var(--text-muted);font-size:12px;">Unassigned</span>`;
      }},
      { key: 'currentKm',   label: 'Odometer',    render: r => `<span style="font-family:var(--font-mono);font-size:12px;">${formatNumber(r.currentKm||0)} km</span>` },
      { key: 'payloadCapacity', label: 'Payload', render: r => r.payloadCapacity ? `<span style="font-size:12px;">${formatNumber(r.payloadCapacity)} kg</span>` : '—' },
      { key: 'fuelType',    label: 'Fuel',         render: r => `<span class="badge badge-gray">${escHtml(r.fuelType||'—')}</span>` },
      { key: 'insuranceExpiry', label: 'Insurance', render: r => {
        if (!r.insuranceExpiry) return '—';
        const days = Math.ceil((new Date(r.insuranceExpiry) - Date.now()) / 86400000);
        const color = days <= 0 ? 'var(--brand-danger)' : days <= 30 ? 'var(--brand-warning)' : 'var(--text-muted)';
        return `<span style="font-size:11px;color:${color};font-family:var(--font-mono);">${r.insuranceExpiry}${days <= 30 ? ` (${days}d)` : ''}</span>`;
      }},
      { key: 'status',      label: 'Status',       render: r => badge(r.status||'idle') },
      { key: 'actions',     label: '', sortable: false, render: r => actionsMenu(r.id, [
          { icon: '👁',  label: 'View Details',     action: `viewVehicle('${r.id}')` },
          { icon: '✏️', label: 'Edit',              action: `editVehicle('${r.id}')` },
          { icon: '👤', label: 'Assign Driver',     action: `assignDriver('${r.id}')` },
          { icon: '🔧', label: 'Log Maintenance',   action: `logMaintenance('${r.id}')` },
          { icon: '⛽', label: 'Log Fuel',          action: `logFuel('${r.id}')` },
          { icon: '🗑',  label: 'Delete',            action: `deleteVehicle('${r.id}')`, danger: true },
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No vehicles registered yet',
  });
  pg.innerHTML = buildPagination({ id:'fleet', total:_filt.length, page:_page, perPage:PER, onChange:'setFleetPage' });
}

// ── Modals ────────────────────────────────────────────────────
function fleetModal() {
  const driverOpts = _drivers.map(d =>
    `<option value="${d.id}">${escHtml(d.name)} — ${escHtml(d.licenseNo||'—')}</option>`
  ).join('');

  return buildModal({
    id: 'fleet-modal',
    title: '<span id="fleet-modal-title">Add Vehicle</span>',
    size: 'lg',
    body: `
      <input type="hidden" id="fleet-id">

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Registration Number <span class="required">*</span></label>
          <input type="text" id="f-reg" class="form-input" placeholder="MH12AB1234" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Vehicle Type <span class="required">*</span></label>
          <select id="f-type" class="form-select">
            <option value="truck">Truck</option>
            <option value="mini-truck">Mini Truck</option>
            <option value="van">Van</option>
            <option value="tempo">Tempo</option>
            <option value="container">Container</option>
            <option value="bike">Bike / 2W</option>
          </select>
        </div>
      </div>

      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Make (Brand)</label>
          <input type="text" id="f-make" class="form-input" placeholder="Tata, Ashok Leyland…">
        </div>
        <div class="form-group">
          <label class="form-label">Model</label>
          <input type="text" id="f-model" class="form-input" placeholder="407, 1613…">
        </div>
        <div class="form-group">
          <label class="form-label">Year</label>
          <input type="number" id="f-year" class="form-input" placeholder="2020" min="1990" max="2030">
        </div>
      </div>

      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Fuel Type</label>
          <select id="f-fuel" class="form-select">
            <option value="diesel">Diesel</option>
            <option value="petrol">Petrol</option>
            <option value="cng">CNG</option>
            <option value="electric">Electric</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Payload Capacity (kg)</label>
          <input type="number" id="f-payload" class="form-input" placeholder="5000" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Current Odometer (km)</label>
          <input type="number" id="f-km" class="form-input" placeholder="0" min="0">
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Assigned Driver</label>
          <select id="f-driver" class="form-select">
            <option value="">Unassigned</option>
            ${driverOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="f-status" class="form-select">
            <option value="active">Active</option>
            <option value="idle">Idle</option>
            <option value="maintenance">In Maintenance</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      <div style="margin-top:var(--space-4);padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-md);">
        <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:var(--space-3);">📋 Documents & Compliance</div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">Insurance Expiry</label>
            <input type="date" id="f-insurance" class="form-input">
          </div>
          <div class="form-group">
            <label class="form-label">Fitness Cert Expiry</label>
            <input type="date" id="f-fitness" class="form-input">
          </div>
          <div class="form-group">
            <label class="form-label">Permit Expiry</label>
            <input type="date" id="f-permit" class="form-input">
          </div>
        </div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">PUC Expiry</label>
            <input type="date" id="f-puc" class="form-input">
          </div>
          <div class="form-group">
            <label class="form-label">Next Service (km)</label>
            <input type="number" id="f-service-km" class="form-input" placeholder="45000" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">GPS Device ID</label>
            <input type="text" id="f-gps" class="form-input" placeholder="GPS-001">
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-top:var(--space-3);">
        <label class="form-label">Notes</label>
        <textarea id="f-notes" class="form-textarea" rows="2" placeholder="Additional notes…"></textarea>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('fleet-modal')">Cancel</button>
      <button class="btn btn-primary" id="fleet-save-btn" onclick="saveVehicle()">Save Vehicle</button>
    `,
  });
}

function fleetViewModal() {
  return `
    <div class="modal-backdrop hidden" id="fleet-view-modal">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h3 class="modal-title" id="fleet-view-title">Vehicle Details</h3>
          <button class="modal-close" onclick="closeModal('fleet-view-modal')">✕</button>
        </div>
        <div class="modal-body" id="fleet-view-body"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('fleet-view-modal')">Close</button>
          <button class="btn btn-secondary" id="fleet-view-edit-btn">Edit</button>
          <button class="btn btn-primary" onclick="closeModal('fleet-view-modal');LAM.Router.navigate('trips')">View Trips →</button>
        </div>
      </div>
    </div>
  `;
}

// ── Assign Driver Modal ───────────────────────────────────────
function assignDriverModal(vehicleId) {
  const driverOpts = _drivers.map(d =>
    `<option value="${d.id}">${escHtml(d.name)} (${escHtml(d.licenseNo||'—')})</option>`
  ).join('');
  return buildModal({
    id: 'assign-driver-modal',
    title: 'Assign Driver',
    body: `
      <input type="hidden" id="ad-vehicle-id" value="${vehicleId}">
      <div class="form-group">
        <label class="form-label">Select Driver <span class="required">*</span></label>
        <select id="ad-driver" class="form-select">
          <option value="">Unassign (no driver)</option>
          ${driverOpts}
        </select>
      </div>
      ${!_drivers.length ? `<div class="alert alert-warning"><span class="alert-icon">⚠️</span><div><div class="alert-title">No drivers found</div><div class="alert-text">Add drivers first in the Drivers module.</div></div></div>` : ''}
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('assign-driver-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="confirmAssignDriver()">Assign</button>
    `,
  });
}

// ── Fuel Log Modal ────────────────────────────────────────────
function fuelModal(vehicleId) {
  const v = _fleet.find(x => x.id === vehicleId);
  return buildModal({
    id: 'fuel-modal',
    title: `⛽ Log Fuel — ${v?.regNumber || ''}`,
    body: `
      <input type="hidden" id="fuel-vehicle-id" value="${vehicleId}">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="fuel-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Odometer Reading (km) <span class="required">*</span></label>
          <input type="number" id="fuel-km" class="form-input" placeholder="${v?.currentKm||0}" min="0">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Litres Filled <span class="required">*</span></label>
          <input type="number" id="fuel-litres" class="form-input" placeholder="50" min="0" step="0.1" oninput="calcFuelCost()">
        </div>
        <div class="form-group">
          <label class="form-label">Rate per Litre (₹)</label>
          <input type="number" id="fuel-rate" class="form-input" placeholder="95.50" min="0" step="0.01" oninput="calcFuelCost()">
        </div>
        <div class="form-group">
          <label class="form-label">Total Cost (₹)</label>
          <input type="number" id="fuel-cost" class="form-input" placeholder="Auto-calculated" readonly style="background:var(--bg-overlay);">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Fuel Station</label>
          <input type="text" id="fuel-station" class="form-input" placeholder="HP, BPCL, Indian Oil…">
        </div>
        <div class="form-group">
          <label class="form-label">Bill Number</label>
          <input type="text" id="fuel-bill" class="form-input" placeholder="Bill/receipt no.">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea id="fuel-notes" class="form-textarea" rows="2" placeholder="Remarks…"></textarea>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('fuel-modal')">Cancel</button>
      <button class="btn btn-primary" id="fuel-save-btn" onclick="saveFuelLog()">Save Fuel Log</button>
    `,
  });
}

// ── Maintenance Modal ─────────────────────────────────────────
function maintenanceModal(vehicleId) {
  const v = _fleet.find(x => x.id === vehicleId);
  return buildModal({
    id: 'maintenance-modal',
    title: `🔧 Log Maintenance — ${v?.regNumber || ''}`,
    body: `
      <input type="hidden" id="maint-vehicle-id" value="${vehicleId}">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Service Type <span class="required">*</span></label>
          <select id="maint-type" class="form-select">
            <option value="oil-change">Oil Change</option>
            <option value="tire-change">Tyre Change/Rotation</option>
            <option value="brake-service">Brake Service</option>
            <option value="engine-service">Engine Service</option>
            <option value="ac-service">AC Service</option>
            <option value="body-repair">Body Repair</option>
            <option value="electrical">Electrical Repair</option>
            <option value="full-service">Full Service</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Service Date <span class="required">*</span></label>
          <input type="date" id="maint-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Odometer (km)</label>
          <input type="number" id="maint-km" class="form-input" placeholder="${v?.currentKm||0}">
        </div>
        <div class="form-group">
          <label class="form-label">Cost (₹) <span class="required">*</span></label>
          <input type="number" id="maint-cost" class="form-input" placeholder="0" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Next Service (km)</label>
          <input type="number" id="maint-next-km" class="form-input" placeholder="${(Number(v?.currentKm)||0)+5000}">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Service Centre</label>
          <input type="text" id="maint-centre" class="form-input" placeholder="Workshop name">
        </div>
        <div class="form-group">
          <label class="form-label">Status After Service</label>
          <select id="maint-after-status" class="form-select">
            <option value="active">Back to Active</option>
            <option value="maintenance">Still in Maintenance</option>
            <option value="idle">Idle</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Description / Parts Replaced</label>
        <textarea id="maint-desc" class="form-textarea" rows="2" placeholder="Details of work done, parts replaced…"></textarea>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('maintenance-modal')">Cancel</button>
      <button class="btn btn-primary" id="maint-save-btn" onclick="saveMaintenance()">Save & Update Vehicle</button>
    `,
  });
}

// ── Register Globals ──────────────────────────────────────────
function registerFleetGlobals() {
  window.fleetSearch = debounce((q) => {
    _filt = searchFilter(_fleet, q, ['regNumber','make','model','vehicleType','gpsDeviceId']);
    _page = 1; renderFleetTable();
  }, 250);

  window.fleetFilter = (key, val) => {
    _filt = val ? _fleet.filter(v => v[key] === val) : [..._fleet];
    _page = 1; renderFleetTable();
  };

  window.setFleetPage = (p) => { _page = p; renderFleetTable(); };

  window.openFleetModal = () => {
    document.getElementById('fleet-modal-title').textContent = 'Add Vehicle';
    clearFleetForm();
    openModal('fleet-modal');
  };

  window.saveVehicle = async () => {
    if (!validateForm([
      { id: 'f-reg',  label: 'Registration Number', required: true },
      { id: 'f-type', label: 'Vehicle Type',         required: true },
    ])) return;

    const btn = document.getElementById('fleet-save-btn');
    setLoading(btn, true);
    const id = document.getElementById('fleet-id').value;

    const data = {
      regNumber:        document.getElementById('f-reg').value.trim().toUpperCase(),
      vehicleType:      document.getElementById('f-type').value,
      make:             document.getElementById('f-make').value.trim(),
      model:            document.getElementById('f-model').value.trim(),
      year:             Number(document.getElementById('f-year').value) || null,
      fuelType:         document.getElementById('f-fuel').value,
      payloadCapacity:  Number(document.getElementById('f-payload').value) || 0,
      currentKm:        Number(document.getElementById('f-km').value) || 0,
      assignedDriverId: document.getElementById('f-driver').value || null,
      status:           document.getElementById('f-status').value,
      insuranceExpiry:  document.getElementById('f-insurance').value || null,
      fitnessExpiry:    document.getElementById('f-fitness').value || null,
      permitExpiry:     document.getElementById('f-permit').value || null,
      pucExpiry:        document.getElementById('f-puc').value || null,
      nextServiceKm:    Number(document.getElementById('f-service-km').value) || null,
      gpsDeviceId:      document.getElementById('f-gps').value.trim(),
      notes:            document.getElementById('f-notes').value.trim(),
      companyId:        AuthState.company?.id || null,
    };

    try {
      if (id) {
        await dbUpdate(TMS_COLLECTIONS.FLEET, id, data);
        Toast.success('Updated', `${data.regNumber} updated.`);
      } else {
        await dbCreate(TMS_COLLECTIONS.FLEET, data);
        Toast.success('Added', `${data.regNumber} registered.`);
      }
      closeModal('fleet-modal');
      clearFleetForm();
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  window.editVehicle = (id) => {
    const v = _fleet.find(x => x.id === id); if (!v) return;
    document.getElementById('fleet-modal-title').textContent = 'Edit Vehicle';
    document.getElementById('fleet-id').value       = v.id;
    document.getElementById('f-reg').value          = v.regNumber || '';
    document.getElementById('f-type').value         = v.vehicleType || 'truck';
    document.getElementById('f-make').value         = v.make || '';
    document.getElementById('f-model').value        = v.model || '';
    document.getElementById('f-year').value         = v.year || '';
    document.getElementById('f-fuel').value         = v.fuelType || 'diesel';
    document.getElementById('f-payload').value      = v.payloadCapacity || '';
    document.getElementById('f-km').value           = v.currentKm || '';
    document.getElementById('f-driver').value       = v.assignedDriverId || '';
    document.getElementById('f-status').value       = v.status || 'active';
    document.getElementById('f-insurance').value    = v.insuranceExpiry || '';
    document.getElementById('f-fitness').value      = v.fitnessExpiry || '';
    document.getElementById('f-permit').value       = v.permitExpiry || '';
    document.getElementById('f-puc').value          = v.pucExpiry || '';
    document.getElementById('f-service-km').value   = v.nextServiceKm || '';
    document.getElementById('f-gps').value          = v.gpsDeviceId || '';
    document.getElementById('f-notes').value        = v.notes || '';
    openModal('fleet-modal');
  };

  window.viewVehicle = async (id) => {
    const v = _fleet.find(x => x.id === id); if (!v) return;
    const driver = _drivers.find(d => d.id === v.assignedDriverId);

    // Fetch trip history + fuel logs for this vehicle
    let trips = [], fuelLogs = [];
    try {
      trips = await dbGetAll(TMS_COLLECTIONS.TRIPS, [
        where('vehicleId','==',id),
        orderBy('createdAt','desc'),
      ]);
    } catch(_) {}

    // Also pull from LAMDB (lam-driver.js logs fuel to tms_fuel with vehicleId)
    try {
      const allFuel = window.LAMDB
        ? await window.LAMDB.dbGetAll(TMS_COLLECTIONS.FUEL).catch(() => [])
        : await dbGetAll(TMS_COLLECTIONS.FUEL, [where('vehicleId','==',id)]).catch(() => []);
      fuelLogs = allFuel.filter(f => f.vehicleId === id);
    } catch(_) {}

    const totalTrips = trips.length;
    const totalKm    = trips.reduce((s,t) => s + (Number(t.distanceKm)||0), 0);

    // Monthly fuel spend calculation
    const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthFuel = fuelLogs.filter(f => (f.date||f.createdAt||'').startsWith(thisMonth));
    const monthSpend = monthFuel.reduce((s,f) => s + (Number(f.amountPaid||f.totalCost)||0), 0);
    const monthLitres = monthFuel.reduce((s,f) => s + (Number(f.litresFilled||f.litres)||0), 0);
    const totalFuelSpend = fuelLogs.reduce((s,f) => s + (Number(f.amountPaid||f.totalCost)||0), 0);

    document.getElementById('fleet-view-title').textContent = v.regNumber || 'Vehicle Details';
    document.getElementById('fleet-view-edit-btn').onclick = () => { closeModal('fleet-view-modal'); editVehicle(id); };

    document.getElementById('fleet-view-body').innerHTML = `
      <!-- Status Banner -->
      <div style="display:flex;align-items:center;gap:16px;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-lg);margin-bottom:20px;">
        <div style="width:56px;height:56px;background:rgba(10,132,255,0.12);border-radius:var(--radius-lg);display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;">🚛</div>
        <div style="flex:1;">
          <div style="font-family:var(--font-display);font-size:20px;font-weight:700;">${escHtml(v.regNumber||'—')}</div>
          <div style="font-size:12px;color:var(--text-secondary);">${escHtml(v.make||'')} ${escHtml(v.model||'')} · ${escHtml(v.vehicleType||'—')} · ${escHtml(v.year||'')}</div>
        </div>
        <div>${badge(v.status||'idle')}</div>
      </div>

      <!-- Quick Stats -->
      <div class="grid-3" style="margin-bottom:20px;">
        ${[
          ['Total Trips', totalTrips, '🗺️'],
          ['Total KM',    formatNumber(totalKm)+' km', '📍'],
          ['This Month Fuel', monthSpend > 0 ? '₹'+formatNumber(monthSpend) : '—', '⛽'],
        ].map(([l,val,i]) => `
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:14px;text-align:center;">
            <div style="font-size:20px;">${i}</div>
            <div style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:4px 0;">${val}</div>
            <div style="font-size:11px;color:var(--text-muted);">${l}</div>
          </div>
        `).join('')}
      </div>

      <!-- Details Grid -->
      <div class="grid-2" style="gap:10px;margin-bottom:16px;">
        ${[
          ['Assigned Driver',   driver?.name || 'Unassigned'],
          ['Fuel Type',         v.fuelType],
          ['GPS Device ID',     v.gpsDeviceId],
          ['Current Odometer',  formatNumber(v.currentKm||0)+' km'],
          ['Insurance Expiry',  v.insuranceExpiry || '—'],
          ['Fitness Expiry',    v.fitnessExpiry   || '—'],
          ['Permit Expiry',     v.permitExpiry    || '—'],
          ['PUC Expiry',        v.pucExpiry       || '—'],
          ['Next Service At',   v.nextServiceKm ? formatNumber(v.nextServiceKm)+' km' : '—'],
        ].map(([l,val]) => `
          <div style="padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">${l}</div>
            <div style="font-size:13px;margin-top:3px;">${escHtml(String(val||'—'))}</div>
          </div>
        `).join('')}
      </div>

      <!-- Fuel Spend Summary -->
      ${fuelLogs.length > 0 ? `
        <div style="margin-bottom:16px;padding:14px;background:rgba(217,119,6,0.06);
                    border:1px solid rgba(217,119,6,0.2);border-radius:var(--radius-lg);">
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);
                      text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">
            ⛽ Fuel Summary
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
            <div style="text-align:center;">
              <div style="font-size:16px;font-weight:800;color:#D97706;">₹${Number(monthSpend||0).toLocaleString('en-IN')}</div>
              <div style="font-size:10px;color:var(--text-muted);">This Month</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:16px;font-weight:800;color:#D97706;">${monthLitres.toFixed(0)}L</div>
              <div style="font-size:10px;color:var(--text-muted);">Litres This Month</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:16px;font-weight:800;color:#D97706;">₹${Number(totalFuelSpend||0).toLocaleString('en-IN')}</div>
              <div style="font-size:10px;color:var(--text-muted);">Total All Time</div>
            </div>
          </div>
          <div style="margin-top:10px;font-size:11px;color:var(--text-muted);text-align:center;">
            ${fuelLogs.length} fuel log${fuelLogs.length!==1?'s':''} recorded
          </div>
        </div>
      ` : ''}

      <!-- Recent Trips -->
      ${trips.length ? `
        <div style="margin-top:16px;">
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Recent Trips</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${trips.slice(0,4).map(t => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <div>
                  <div style="font-size:12px;font-weight:600;">${escHtml(t.tripNumber||'—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">${escHtml(t.origin||'—')} → ${escHtml(t.destination||'—')}</div>
                </div>
                <div style="text-align:right;">
                  ${badge(t.status||'planned')}
                  <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">${formatDate(t.createdAt)}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;
    openModal('fleet-view-modal');
  };

  window.assignDriver = (vehicleId) => {
    document.getElementById('assign-driver-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend', assignDriverModal(vehicleId));
    openModal('assign-driver-modal');
  };

  window.confirmAssignDriver = async () => {
    const vehicleId = document.getElementById('ad-vehicle-id').value;
    const driverId  = document.getElementById('ad-driver').value;
    try {
      await dbUpdate(TMS_COLLECTIONS.FLEET, vehicleId, { assignedDriverId: driverId || null });
      // If driver selected, update driver's assigned vehicle
      if (driverId) await dbUpdate(TMS_COLLECTIONS.DRIVERS, driverId, { assignedVehicleId: vehicleId });
      Toast.success('Assigned', 'Driver assigned to vehicle.');
      closeModal('assign-driver-modal');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.logFuel = (vehicleId) => {
    document.getElementById('fuel-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend', fuelModal(vehicleId));
    openModal('fuel-modal');
  };

  window.calcFuelCost = () => {
    const litres = Number(document.getElementById('fuel-litres')?.value) || 0;
    const rate   = Number(document.getElementById('fuel-rate')?.value)   || 0;
    const costEl = document.getElementById('fuel-cost');
    if (costEl) costEl.value = (litres * rate).toFixed(2);
  };

  window.saveFuelLog = async () => {
    if (!validateForm([
      { id:'fuel-date',   label:'Date',     required:true },
      { id:'fuel-km',     label:'Odometer', required:true },
      { id:'fuel-litres', label:'Litres',   required:true },
    ])) return;
    const btn = document.getElementById('fuel-save-btn');
    setLoading(btn, true);
    const vehicleId = document.getElementById('fuel-vehicle-id').value;
    const km = Number(document.getElementById('fuel-km').value);
    const data = {
      vehicleId,
      date:       document.getElementById('fuel-date').value,
      odometerKm: km,
      litres:     Number(document.getElementById('fuel-litres').value),
      ratePerLitre:Number(document.getElementById('fuel-rate').value)||0,
      totalCost:  Number(document.getElementById('fuel-cost').value)||0,
      station:    document.getElementById('fuel-station').value.trim(),
      billNo:     document.getElementById('fuel-bill').value.trim(),
      notes:      document.getElementById('fuel-notes').value.trim(),
      companyId:  AuthState.company?.id || null,
    };
    try {
      await dbCreate(TMS_COLLECTIONS.FUEL, data);
      // Update vehicle odometer
      await dbUpdate(TMS_COLLECTIONS.FLEET, vehicleId, { currentKm: km });
      Toast.success('Fuel Logged', `${data.litres}L logged for ₹${Number(data.totalCost||0).toLocaleString('en-IN')}.`);
      closeModal('fuel-modal');
    } catch(e) { Toast.error('Failed', e.message); }
    finally { setLoading(btn, false); }
  };

  window.logMaintenance = (vehicleId) => {
    document.getElementById('maintenance-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend', maintenanceModal(vehicleId));
    openModal('maintenance-modal');
  };

  window.saveMaintenance = async () => {
    if (!validateForm([
      { id:'maint-type', label:'Service Type', required:true },
      { id:'maint-date', label:'Date',         required:true },
      { id:'maint-cost', label:'Cost',         required:true },
    ])) return;
    const btn = document.getElementById('maint-save-btn');
    setLoading(btn, true);
    const vehicleId = document.getElementById('maint-vehicle-id').value;
    const nextKm    = Number(document.getElementById('maint-next-km').value) || null;
    const afterStatus = document.getElementById('maint-after-status').value;
    const data = {
      vehicleId,
      serviceType:  document.getElementById('maint-type').value,
      date:         document.getElementById('maint-date').value,
      odometerKm:   Number(document.getElementById('maint-km').value)||0,
      cost:         Number(document.getElementById('maint-cost').value)||0,
      nextServiceKm:nextKm,
      serviceCentre:document.getElementById('maint-centre').value.trim(),
      description:  document.getElementById('maint-desc').value.trim(),
      companyId:    AuthState.company?.id || null,
    };
    try {
      await dbCreate(TMS_COLLECTIONS.MAINTENANCE, data);
      // Update vehicle status + next service km
      const updatePayload = { status: afterStatus };
      if (nextKm) updatePayload.nextServiceKm = nextKm;
      await dbUpdate(TMS_COLLECTIONS.FLEET, vehicleId, updatePayload);
      Toast.success('Maintenance Logged', `Service recorded. Vehicle set to ${afterStatus}.`);
      closeModal('maintenance-modal');
    } catch(e) { Toast.error('Failed', e.message); }
    finally { setLoading(btn, false); }
  };

  window.deleteVehicle = async (id) => {
    const v = _fleet.find(x => x.id === id);
    if (!confirm(`Delete vehicle "${v?.regNumber}"? All associated trips/fuel/maintenance will remain.`)) return;
    try {
      await dbDelete(TMS_COLLECTIONS.FLEET, id);
      Toast.success('Deleted', 'Vehicle removed.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.exportFleet = () => {
    const csv = [
      ['Reg Number','Type','Make','Model','Year','Fuel','Payload(kg)','Odometer','Status','Driver','Insurance Expiry'],
      ..._filt.map(v => {
        const d = _drivers.find(x => x.id === v.assignedDriverId);
        return [v.regNumber,v.vehicleType,v.make,v.model,v.year,v.fuelType,v.payloadCapacity,v.currentKm,v.status,d?.name||'',v.insuranceExpiry];
      })
    ].map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    a.download = 'fleet_export.csv';
    a.click();
    Toast.success('Exported', `${_filt.length} vehicles exported.`);
  };
}

function clearFleetForm() {
  document.getElementById('fleet-id').value = '';
  ['f-reg','f-make','f-model','f-year','f-payload','f-km','f-insurance','f-fitness','f-permit','f-puc','f-service-km','f-gps','f-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['f-type','f-fuel','f-status'].forEach(id => {
    const el = document.getElementById(id); if (el) el.selectedIndex = 0;
  });
  const drv = document.getElementById('f-driver'); if (drv) drv.value = '';
}
