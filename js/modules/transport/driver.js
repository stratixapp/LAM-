// ============================================================
// LAM — Driver Management Module
// Interconnects: Fleet, Trips, POD, Performance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { TMS_COLLECTIONS } from './fleet.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, formatNumber } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, avatarCell, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

let _drivers = [], _filt = [], _page = 1;
let _fleet = [];
const PER = 15;
let _unsub = null;

export async function renderDrivers(container) {
  _fleet = await dbGetAll(TMS_COLLECTIONS.FLEET,
    AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []
  );

  container.innerHTML = pageShell({
    title: '👤 Driver Management',
    subtitle: 'Manage drivers, licenses, documents and performance records.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportDrivers()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openDriverModal()">+ Add Driver</button>
    `,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="driver-kpis"></div>
      ${searchBar({
        id: 'drivers',
        placeholder: 'Search name, license, phone…',
        filters: [
          { key: 'status', label: 'All Status', options: [
            { value: 'active',     label: 'Active' },
            { value: 'on-trip',    label: 'On Trip' },
            { value: 'off-duty',   label: 'Off Duty' },
            { value: 'inactive',   label: 'Inactive' },
          ]},
        ],
        onSearch: 'driverSearch',
        onFilter: 'driverFilter',
      })}
      <div id="drivers-table-wrap"></div>
      <div id="drivers-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', driverModal());
  setupModalClose(); setupMenuClose();
  registerDriverGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid
    ? [where('companyId','==',cid), orderBy('createdAt','desc')]
    : [orderBy('createdAt','desc')];

  _unsub = dbListen(TMS_COLLECTIONS.DRIVERS, c, data => {
    _drivers = data; _filt = [...data];
    renderDriverKPIs();
    renderDriverTable();
  });
}

function renderDriverKPIs() {
  const el = document.getElementById('driver-kpis'); if (!el) return;
  el.innerHTML = '';
  const total    = _drivers.length;
  const active   = _drivers.filter(d => d.status === 'active' || d.status === 'on-trip').length;
  const onTrip   = _drivers.filter(d => d.status === 'on-trip').length;
  const expiring = _drivers.filter(d => {
    if (!d.licenseExpiry) return false;
    const days = (new Date(d.licenseExpiry) - Date.now()) / 86400000;
    return days <= 30 && days > 0;
  }).length;

  [
    { label:'Total Drivers',    value:total,    icon:'👤', color:'kpi-blue'   },
    { label:'Available',        value:active - onTrip, icon:'✅', color:'kpi-green'  },
    { label:'Currently On Trip',value:onTrip,   icon:'🚛', color:'kpi-orange' },
    { label:'License Expiring', value:expiring, icon:'⚠️', color:expiring>0?'kpi-red':'kpi-blue' },
  ].forEach((k, i) => {
    el.innerHTML += `
      <div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
        <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${k.label}</div>
      </div>`;
  });
}

function renderDriverTable() {
  const wrap = document.getElementById('drivers-table-wrap');
  const pg   = document.getElementById('drivers-pagination');
  if (!wrap) return;
  const start    = (_page-1)*PER;
  const pageData = _filt.slice(start, start+PER);
  const countEl  = document.getElementById('drivers-count');
  if (countEl) countEl.textContent = `${_filt.length} driver${_filt.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id: 'drivers-table',
    columns: [
      { key: 'name',        label: 'Driver',        render: r => avatarCell(r.name, r.phone, 'var(--brand-secondary)', 'rgba(0,200,150,0.12)') },
      { key: 'licenseNo',   label: 'License No.',   render: r => `<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.licenseNo||'—')}</span>` },
      { key: 'licenseType', label: 'License Type',  render: r => `<span class="badge badge-blue">${escHtml(r.licenseType||'—')}</span>` },
      { key: 'licenseExpiry', label: 'License Exp.', render: r => {
        if (!r.licenseExpiry) return '—';
        const days = Math.ceil((new Date(r.licenseExpiry) - Date.now()) / 86400000);
        const color = days <= 0 ? 'var(--brand-danger)' : days <= 30 ? 'var(--brand-warning)' : 'var(--text-muted)';
        return `<span style="font-size:11px;color:${color};font-family:var(--font-mono);">${r.licenseExpiry}${days<=30?` (${days}d)`:''}</span>`;
      }},
      { key: 'assignedVehicleId', label: 'Vehicle', render: r => {
        const v = _fleet.find(x => x.id === r.assignedVehicleId);
        return v ? `<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${v.regNumber}</span>`
                 : `<span style="color:var(--text-muted);font-size:12px;">Unassigned</span>`;
      }},
      { key: 'totalTrips',  label: 'Trips',         render: r => `<span style="font-family:var(--font-mono);">${r.totalTrips||0}</span>` },
      { key: 'rating',      label: 'Rating',        render: r => {
        const stars = Math.round(Number(r.rating||0));
        return `<span style="color:var(--brand-warning);font-size:13px;">${'★'.repeat(stars)}${'☆'.repeat(5-stars)}</span>
                <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">${Number(r.rating||0).toFixed(1)}</span>`;
      }},
      { key: 'status',      label: 'Status',        render: r => badge(r.status||'active') },
      { key: 'actions',     label: '', sortable:false, render: r => actionsMenu(r.id, [
          { icon:'✏️', label:'Edit',             action:`editDriver('${r.id}')` },
          { icon:'📊', label:'Performance',      action:`viewDriverPerformance('${r.id}')` },
          { icon:'🗑',  label:'Delete',           action:`deleteDriver('${r.id}')`, danger:true },
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No drivers added yet',
  });
  pg.innerHTML = buildPagination({ id:'drivers', total:_filt.length, page:_page, perPage:PER, onChange:'setDriverPage' });
}

function driverModal() {
  return buildModal({
    id: 'driver-modal',
    title: '<span id="driver-modal-title">Add Driver</span>',
    size: 'lg',
    body: `
      <input type="hidden" id="driver-id">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Full Name <span class="required">*</span></label>
          <input type="text" id="dr-name" class="form-input" placeholder="Driver full name">
        </div>
        <div class="form-group">
          <label class="form-label">Phone <span class="required">*</span></label>
          <input type="tel" id="dr-phone" class="form-input" placeholder="9876543210" maxlength="10">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" id="dr-email" class="form-input" placeholder="driver@email.com">
        </div>
        <div class="form-group">
          <label class="form-label">Date of Birth</label>
          <input type="date" id="dr-dob" class="form-input">
        </div>
      </div>

      <div style="padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-md);margin:var(--space-3) 0;">
        <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:var(--space-3);">🪪 License Details</div>
        <div class="form-grid-3">
          <div class="form-group">
            <label class="form-label">License Number <span class="required">*</span></label>
            <input type="text" id="dr-license" class="form-input" placeholder="MH1234567890123" style="text-transform:uppercase;">
          </div>
          <div class="form-group">
            <label class="form-label">License Type</label>
            <select id="dr-license-type" class="form-select">
              <option value="LMV">LMV (Light Motor)</option>
              <option value="HMV">HMV (Heavy Motor)</option>
              <option value="HGV">HGV (Heavy Goods)</option>
              <option value="HPMV">HPMV (Heavy Passenger)</option>
              <option value="MGV">MGV (Medium Goods)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">License Expiry</label>
            <input type="date" id="dr-license-expiry" class="form-input">
          </div>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Aadhaar Number</label>
          <input type="text" id="dr-aadhaar" class="form-input" placeholder="XXXX XXXX XXXX" maxlength="12">
        </div>
        <div class="form-group">
          <label class="form-label">PAN Number</label>
          <input type="text" id="dr-pan" class="form-input" placeholder="AAAPL1234C" maxlength="10" style="text-transform:uppercase;">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Experience (years)</label>
          <input type="number" id="dr-exp" class="form-input" placeholder="5" min="0" max="50">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="dr-status" class="form-select">
            <option value="active">Active</option>
            <option value="off-duty">Off Duty</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Home Address</label>
        <textarea id="dr-address" class="form-textarea" rows="2" placeholder="Residential address…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Emergency Contact Name</label>
          <input type="text" id="dr-emg-name" class="form-input" placeholder="Contact person name">
        </div>
        <div class="form-group">
          <label class="form-label">Emergency Contact Phone</label>
          <input type="tel" id="dr-emg-phone" class="form-input" placeholder="9876543210" maxlength="10">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Bank Account (for salary)</label>
        <input type="text" id="dr-bank" class="form-input" placeholder="Account number">
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('driver-modal')">Cancel</button>
      <button class="btn btn-primary" id="driver-save-btn" onclick="saveDriver()">Save Driver</button>
    `,
  });
}

function registerDriverGlobals() {
  window.driverSearch = debounce((q) => {
    _filt = searchFilter(_drivers, q, ['name','phone','email','licenseNo']);
    _page = 1; renderDriverTable();
  }, 250);

  window.driverFilter = (key, val) => {
    _filt = val ? _drivers.filter(d => d[key] === val) : [..._drivers];
    _page = 1; renderDriverTable();
  };

  window.setDriverPage = (p) => { _page = p; renderDriverTable(); };

  window.openDriverModal = () => {
    document.getElementById('driver-modal-title').textContent = 'Add Driver';
    clearDriverForm();
    openModal('driver-modal');
  };

  window.saveDriver = async () => {
    if (!validateForm([
      { id:'dr-name',    label:'Name',    required:true },
      { id:'dr-phone',   label:'Phone',   required:true, minLength:10 },
      { id:'dr-license', label:'License', required:true },
    ])) return;
    const btn = document.getElementById('driver-save-btn');
    setLoading(btn, true);
    const id = document.getElementById('driver-id').value;
    const data = {
      name:           document.getElementById('dr-name').value.trim(),
      phone:          document.getElementById('dr-phone').value.trim(),
      email:          document.getElementById('dr-email').value.trim(),
      dob:            document.getElementById('dr-dob').value,
      licenseNo:      document.getElementById('dr-license').value.trim().toUpperCase(),
      licenseType:    document.getElementById('dr-license-type').value,
      licenseExpiry:  document.getElementById('dr-license-expiry').value,
      aadhaar:        document.getElementById('dr-aadhaar').value.trim(),
      pan:            document.getElementById('dr-pan').value.trim().toUpperCase(),
      experienceYears:Number(document.getElementById('dr-exp').value)||0,
      status:         document.getElementById('dr-status').value,
      address:        document.getElementById('dr-address').value.trim(),
      emergencyContactName: document.getElementById('dr-emg-name').value.trim(),
      emergencyContactPhone:document.getElementById('dr-emg-phone').value.trim(),
      bankAccount:    document.getElementById('dr-bank').value.trim(),
      companyId:      AuthState.company?.id || null,
    };
    try {
      if (id) {
        await dbUpdate(TMS_COLLECTIONS.DRIVERS, id, data);
        Toast.success('Updated', `${data.name} updated.`);
      } else {
        await dbCreate(TMS_COLLECTIONS.DRIVERS, data);
        Toast.success('Added', `${data.name} added.`);
      }
      closeModal('driver-modal');
      clearDriverForm();
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  window.editDriver = (id) => {
    const d = _drivers.find(x => x.id === id); if (!d) return;
    document.getElementById('driver-modal-title').textContent = 'Edit Driver';
    document.getElementById('driver-id').value         = d.id;
    document.getElementById('dr-name').value           = d.name||'';
    document.getElementById('dr-phone').value          = d.phone||'';
    document.getElementById('dr-email').value          = d.email||'';
    document.getElementById('dr-dob').value            = d.dob||'';
    document.getElementById('dr-license').value        = d.licenseNo||'';
    document.getElementById('dr-license-type').value   = d.licenseType||'HMV';
    document.getElementById('dr-license-expiry').value = d.licenseExpiry||'';
    document.getElementById('dr-aadhaar').value        = d.aadhaar||'';
    document.getElementById('dr-pan').value            = d.pan||'';
    document.getElementById('dr-exp').value            = d.experienceYears||'';
    document.getElementById('dr-status').value         = d.status||'active';
    document.getElementById('dr-address').value        = d.address||'';
    document.getElementById('dr-emg-name').value       = d.emergencyContactName||'';
    document.getElementById('dr-emg-phone').value      = d.emergencyContactPhone||'';
    document.getElementById('dr-bank').value           = d.bankAccount||'';
    openModal('driver-modal');
  };

  window.viewDriverPerformance = async (id) => {
    const d = _drivers.find(x => x.id === id); if (!d) return;
    let trips = [];
    try {
      trips = await dbGetAll(TMS_COLLECTIONS.TRIPS, [
        where('driverId','==',id),
        orderBy('createdAt','desc'),
      ]);
    } catch(_) {}

    const totalTrips    = trips.length;
    const completed     = trips.filter(t => t.status === 'delivered').length;
    const delayed       = trips.filter(t => t.delayed === true).length;
    const totalKm       = trips.reduce((s,t) => s+(Number(t.distanceKm)||0), 0);
    const onTimeRate    = totalTrips ? Math.round(((totalTrips - delayed) / totalTrips) * 100) : 100;

    // Build performance view modal
    document.getElementById('driver-perf-modal')?.remove();
    const html = buildModal({
      id: 'driver-perf-modal',
      title: `📊 Performance — ${d.name}`,
      size: 'lg',
      body: `
        <div class="grid-4" style="margin-bottom:20px;">
          ${[
            ['Total Trips',  totalTrips,           '🗺️'],
            ['Completed',    completed,             '✅'],
            ['On-Time %',    onTimeRate+'%',        '⏱️'],
            ['Total KM',     formatNumber(totalKm)+' km', '📍'],
          ].map(([l,v,i]) => `
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:14px;text-align:center;">
              <div style="font-size:20px;">${i}</div>
              <div style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:4px 0;">${v}</div>
              <div style="font-size:11px;color:var(--text-muted);">${l}</div>
            </div>
          `).join('')}
        </div>
        <!-- On-time rate bar -->
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;color:var(--text-secondary);">On-Time Delivery Rate</span>
            <span style="font-size:12px;font-weight:700;color:${onTimeRate>=90?'var(--brand-secondary)':onTimeRate>=75?'var(--brand-warning)':'var(--brand-danger)'};">${onTimeRate}%</span>
          </div>
          <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
            <div style="height:100%;width:${onTimeRate}%;background:${onTimeRate>=90?'var(--brand-secondary)':onTimeRate>=75?'var(--brand-warning)':'var(--brand-danger)'};border-radius:4px;transition:width 1s ease;"></div>
          </div>
        </div>
        <!-- Rating -->
        <div style="display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="font-size:36px;color:var(--brand-warning);">${'★'.repeat(Math.round(d.rating||0))}${'☆'.repeat(5-Math.round(d.rating||0))}</div>
          <div>
            <div style="font-size:22px;font-weight:700;font-family:var(--font-display);">${Number(d.rating||0).toFixed(1)}/5.0</div>
            <div style="font-size:12px;color:var(--text-muted);">Driver Rating</div>
          </div>
          <div style="margin-left:auto;">
            <button class="btn btn-secondary btn-sm" onclick="updateDriverRating('${id}')">Update Rating</button>
          </div>
        </div>
        ${trips.length ? `
          <div style="margin-top:16px;">
            <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Recent Trips</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${trips.slice(0,5).map(t => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                  <div>
                    <div style="font-size:12px;font-weight:600;">${escHtml(t.tripNumber||'—')}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${escHtml(t.origin||'—')} → ${escHtml(t.destination||'—')} · ${t.distanceKm||0}km</div>
                  </div>
                  <div style="text-align:right;">
                    ${badge(t.status||'planned')}
                    ${t.delayed ? '<div style="font-size:10px;color:var(--brand-danger);margin-top:2px;">⚠ Delayed</div>' : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      `,
      footer: `<button class="btn btn-secondary" onclick="closeModal('driver-perf-modal')">Close</button>`,
    });
    document.body.insertAdjacentHTML('beforeend', html);
    openModal('driver-perf-modal');
  };

  window.updateDriverRating = async (id) => {
    const rating = prompt('Enter new rating (1.0 - 5.0):');
    if (!rating) return;
    const r = parseFloat(rating);
    if (isNaN(r) || r < 1 || r > 5) { Toast.error('Invalid', 'Rating must be between 1.0 and 5.0'); return; }
    try {
      await dbUpdate(TMS_COLLECTIONS.DRIVERS, id, { rating: r });
      Toast.success('Rating Updated', `Driver rating set to ${r.toFixed(1)}`);
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.deleteDriver = async (id) => {
    const d = _drivers.find(x => x.id === id);
    if (!confirm(`Delete driver "${d?.name}"?`)) return;
    try {
      await dbDelete(TMS_COLLECTIONS.DRIVERS, id);
      Toast.success('Deleted', 'Driver removed.');
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.exportDrivers = () => {
    const csv = [
      ['Name','Phone','Email','License No.','License Type','Expiry','Experience','Status'],
      ..._filt.map(d => [d.name,d.phone,d.email,d.licenseNo,d.licenseType,d.licenseExpiry,d.experienceYears,d.status])
    ].map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    a.download = 'drivers_export.csv'; a.click();
    Toast.success('Exported', `${_filt.length} drivers exported.`);
  };
}

function clearDriverForm() {
  document.getElementById('driver-id').value = '';
  ['dr-name','dr-phone','dr-email','dr-dob','dr-license','dr-license-expiry','dr-aadhaar','dr-pan','dr-exp','dr-address','dr-emg-name','dr-emg-phone','dr-bank'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const lt = document.getElementById('dr-license-type'); if (lt) lt.value = 'HMV';
  const st = document.getElementById('dr-status');       if (st) st.value = 'active';
}

// Export for use in fleet module
export { _drivers };


// ── Driver GPS Utility ────────────────────────────────────────
window.getDriverLiveLocation = async (driverId, driverName) => {
  if (!window.LAMGPS) { Toast.info('GPS', 'GPS engine not loaded.'); return; }

  // Create quick location modal
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;width:100%;max-width:500px;">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:700;">📍 ${driverName || 'Driver'} — Live Location</div>
        <button onclick="this.closest('div').parentElement.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:18px;">✕</button>
      </div>
      <div style="padding:12px;"><canvas id="driver-loc-map" width="460" height="260" style="width:100%;border-radius:8px;"></canvas></div>
      <div id="driver-loc-info" style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center;">Getting location…</div>
    </div>
  `;
  document.body.appendChild(modal);

  setTimeout(async () => {
    try {
      const pos = await window.LAMGPS.getCurrentLocation({ highAccuracy: true });
      const canvas = document.getElementById('driver-loc-map');
      const info   = document.getElementById('driver-loc-info');
      if (!canvas) return;

      const map = new window.LAMGPS.LAMMap(canvas, { zoom: 14, center: pos });
      map.addMarker({ lat: pos.lat, lng: pos.lng, title: driverName || 'Driver', color: '#0A84FF', type: 'truck' });

      const addr = await window.LAMGPS.reverseGeocode(pos.lat, pos.lng);
      if (info) info.textContent = `📍 ${addr.slice(0, 80)}`;
    } catch (e) {
      const info = document.getElementById('driver-loc-info');
      if (info) info.textContent = `Location unavailable: ${e.message}`;
    }
  }, 150);
};
