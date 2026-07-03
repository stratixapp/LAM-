// ============================================================
// LAM Driver Engine v1.0 — Mobile-First Driver Interface
// ============================================================
// Shown automatically when role = Driver after PIN login.
// Replaces the standard sidebar layout entirely.
//
//  1. DRIVER HOME SCREEN  — Today's + upcoming trips, big
//     status buttons, GPS-tagged status updates
//  2. POD CAPTURE         — Camera + signature + receiver name
//                           stored as base64 in IndexedDB
//  3. FUEL LOG            — Post-departure prompt, cost/km calc
//  4. TRIP HISTORY        — Last 30 trips, swipeable
//  5. GPS PING            — Every 5 min while en-route,
//                           queued to IndexedDB + Supabase-ready
//
// Collections used:
//   tms_trips       — existing trip records
//   tms_pod         — POD records (camera + sig + receiver)
//   tms_fuel        — fuel log records
//   lam_gps_pings   — GPS ping queue (Supabase-ready)
//   tms_drivers     — driver records (for driverId lookup)
//
// Dependencies: window.LAMDB, window.LAMGPS, window.LAMCamera
//               window.LAMMaps (optional — for route view)
//               window.LAMPDF  (optional — for POD PDF)
//
// Supabase hooks: window.LAMCloud?.push(op) fires on every
//   GPS ping. Define LAMCloud.push to start syncing.
// ============================================================

const LAMDriver = (() => {

  // ── Collections ──────────────────────────────────────────
  const C = {
    TRIPS:     'tms_trips',
    DRIVERS:   'tms_drivers',
    FLEET:     'tms_fleet',
    FUEL:      'tms_fuel',
    POD:       'tms_pod',
    GPS_PINGS: 'lam_gps_pings',
  };

  // ── Trip status flow ─────────────────────────────────────
  const STATUS_FLOW = [
    { key: 'planned',         label: 'Start Trip',              next: 'at-pickup',    color: '#2563EB', icon: '🚛' },
    { key: 'at-pickup',       label: 'Arrived at Pickup',       next: 'loading',      color: '#7C3AED', icon: '📍' },
    { key: 'loading',         label: 'Loaded & Departed',       next: 'in-transit',   color: '#D97706', icon: '📦' },
    { key: 'in-transit',      label: 'Arrived at Destination',  next: 'at-dest',      color: '#0891B2', icon: '🏁' },
    { key: 'at-dest',         label: 'Delivered ✓',             next: 'delivered',    color: '#059669', icon: '✅' },
    { key: 'delivered',       label: 'Completed',               next: null,           color: '#6B7280', icon: '✅' },
  ];

  const STATUS_LABELS = {
    planned:      'Planned',
    'at-pickup':  'At Pickup',
    loading:      'Loading',
    'in-transit': 'En Route',
    'at-dest':    'At Destination',
    delivered:    'Delivered',
    cancelled:    'Cancelled',
  };

  // ── State ─────────────────────────────────────────────────
  let _driverRecord  = null;   // tms_drivers record matching current user
  let _trips         = [];
  let _gpsTracker    = null;
  let _gpsPingTimer  = null;
  let _activeView    = 'home'; // 'home' | 'history' | 'pod' | 'fuel'
  let _mounted       = false;

  // ── Helpers ───────────────────────────────────────────────
  const db  = () => window.LAMDB;
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt = n  => Number(n || 0).toLocaleString('en-IN');
  const fmtDate = iso => iso
    ? new Date(iso).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
    : '—';
  const now = () => new Date().toISOString();

  // ── Find driver record linked to current LAM user ─────────
  async function _resolveDriverRecord() {
    const user = window.LAMCurrentUser;
    if (!user) return null;
    const drivers = await db().dbGetAll(C.DRIVERS).catch(() => []);
    // Match by lamUserId field (set when driver is linked) or by name
    return drivers.find(d =>
      d.lamUserId === user.id ||
      (d.name || '').toLowerCase() === (user.name || '').toLowerCase()
    ) || null;
  }

  // ══════════════════════════════════════════════════════════
  // MOUNT — Takes over the full app shell for Driver role
  // ══════════════════════════════════════════════════════════

  async function mount() {
    if (_mounted) return;
    _mounted = true;

    const user = window.LAMCurrentUser;
    if (!user || user.role !== 'driver') return;

    // Resolve driver record
    _driverRecord = await _resolveDriverRecord();

    // Hide the entire sidebar + topbar, make main-content full screen
    _hideDesktopChrome();

    // Inject Driver Shell into page-content
    const pageContent = document.getElementById('page-content');
    if (!pageContent) return;

    pageContent.style.cssText = 'padding:0;margin:0;height:100%;overflow:hidden;';

    _injectStyles();
    _renderShell(pageContent);
    await _loadAndRenderHome();
    _startGPSPing();
  }

  function unmount() {
    _mounted = false;
    _stopGPSPing();
    _showDesktopChrome();
    const shell = document.getElementById('lam-driver-shell');
    if (shell) shell.remove();
  }

  function _hideDesktopChrome() {
    const sidebar     = document.getElementById('sidebar');
    const topbar      = document.querySelector('.topbar');
    const mainContent = document.getElementById('main-content');
    if (sidebar)     { sidebar.style.display = 'none'; }
    if (topbar)      { topbar.style.display = 'none'; }
    if (mainContent) {
      mainContent.style.marginLeft = '0';
      mainContent.style.paddingTop = '0';
      mainContent.style.height = '100dvh';
      mainContent.style.overflow = 'hidden';
    }
  }

  function _showDesktopChrome() {
    const sidebar     = document.getElementById('sidebar');
    const topbar      = document.querySelector('.topbar');
    const mainContent = document.getElementById('main-content');
    if (sidebar)     sidebar.style.display = '';
    if (topbar)      topbar.style.display = '';
    if (mainContent) {
      mainContent.style.marginLeft = '';
      mainContent.style.paddingTop = '';
      mainContent.style.height = '';
      mainContent.style.overflow = '';
    }
  }

  function _renderShell(container) {
    const user = window.LAMCurrentUser;
    const initials = (user.name || 'D').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();

    container.innerHTML = `
      <div id="lam-driver-shell" style="
        display:flex; flex-direction:column;
        height:100dvh; background:#F0F2F5;
        font-family:var(--font-body,'Geist',system-ui,sans-serif);
        overflow:hidden; position:relative;
      ">

        <!-- ── Top Header ── -->
        <div id="drv-header" style="
          background:#fff; border-bottom:1px solid #EAECF0;
          padding:12px 16px 10px; flex-shrink:0;
          display:flex; align-items:center; justify-content:space-between;
          box-shadow:0 1px 4px rgba(0,0,0,0.06);
        ">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="
              width:36px;height:36px;border-radius:50%;
              background:${user.avatarColor || '#D97706'};
              color:#fff;display:flex;align-items:center;justify-content:center;
              font-size:13px;font-weight:700;flex-shrink:0;
            ">${initials}</div>
            <div>
              <div style="font-weight:700;font-size:14px;color:#0D1117;">${esc(user.name)}</div>
              <div style="font-size:11px;color:#8898AA;" id="drv-header-sub">Loading trips…</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <div id="drv-gps-dot" style="
              width:8px;height:8px;border-radius:50%;
              background:#6B7280;flex-shrink:0;
              transition:background 0.3s;
            " title="GPS status"></div>
            <button onclick="window.LAMDriver._showUserMenu()" style="
              background:none;border:none;cursor:pointer;
              font-size:20px;padding:4px;line-height:1;
              color:#4A5568;
            ">⋯</button>
          </div>
        </div>

        <!-- ── Page Content (scrollable) ── -->
        <div id="drv-page" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;"></div>

        <!-- ── Bottom Nav ── -->
        <nav id="drv-nav" style="
          background:#fff;border-top:1px solid #EAECF0;
          display:flex;flex-shrink:0;
          box-shadow:0 -2px 8px rgba(0,0,0,0.06);
          padding-bottom:env(safe-area-inset-bottom,0);
        ">
          ${[
            { key:'home',    icon:'🚛', label:'My Trips'  },
            { key:'history', icon:'📋', label:'History'   },
          ].map(t => `
            <button data-drv-tab="${t.key}"
              onclick="window.LAMDriver._switchTab('${t.key}')"
              style="
                flex:1;padding:10px 4px 8px;border:none;background:none;cursor:pointer;
                display:flex;flex-direction:column;align-items:center;gap:3px;
                font-family:inherit;transition:background 0.15s;
                min-height:56px;
              ">
              <span style="font-size:20px;">${t.icon}</span>
              <span style="font-size:10px;font-weight:600;color:#8898AA;
                           transition:color 0.15s;" class="drv-tab-label">${t.label}</span>
            </button>
          `).join('')}
        </nav>

      </div>
    `;

    // Set home tab active
    _setTabActive('home');
  }

  function _setTabActive(key) {
    document.querySelectorAll('[data-drv-tab]').forEach(btn => {
      const isActive = btn.dataset.drvTab === key;
      btn.style.background = isActive ? '#EFF6FF' : 'none';
      const label = btn.querySelector('.drv-tab-label');
      if (label) label.style.color = isActive ? '#2563EB' : '#8898AA';
    });
  }

  window.LAMDriver = window.LAMDriver || {};
  window.LAMDriver._switchTab = async function(key) {
    _activeView = key;
    _setTabActive(key);
    if (key === 'home')    await _loadAndRenderHome();
    if (key === 'history') await _renderHistory();
  };

  window.LAMDriver._showUserMenu = function() {
    const existing = document.getElementById('drv-user-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'drv-user-menu';
    menu.style.cssText = `
      position:fixed;top:60px;right:12px;z-index:9999;
      background:#fff;border:1px solid #EAECF0;border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,0.15);min-width:180px;overflow:hidden;
      font-family:inherit;
    `;
    menu.innerHTML = `
      <div style="padding:12px 14px;border-bottom:1px solid #EAECF0;">
        <div style="font-weight:600;font-size:13px;">${esc(window.LAMCurrentUser?.name || '')}</div>
        <div style="font-size:11px;color:#8898AA;">Driver</div>
      </div>
      <button onclick="window.LAMUsers?.logout();document.getElementById('drv-user-menu')?.remove()"
        style="display:block;width:100%;text-align:left;padding:12px 14px;
               background:none;border:none;cursor:pointer;font-size:13px;
               color:#DC2626;font-family:inherit;">
        🚪 Log Out
      </button>
    `;
    document.body.appendChild(menu);
    setTimeout(() => {
      const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }};
      document.addEventListener('click', close);
    }, 0);
  };

  // ══════════════════════════════════════════════════════════
  // HOME SCREEN — Today's Trips
  // ══════════════════════════════════════════════════════════

  async function _loadAndRenderHome() {
    const page = document.getElementById('drv-page');
    if (!page) return;

    page.innerHTML = `
      <div style="display:flex;justify-content:center;padding:48px;">
        <div class="spinner"></div>
      </div>
    `;

    // Load trips assigned to this driver
    _trips = await _loadDriverTrips();

    const today     = new Date().toISOString().slice(0, 10);
    const active    = _trips.filter(t => !['delivered','cancelled'].includes(t.status));
    const completed = _trips.filter(t => t.status === 'delivered');

    // Update header subtitle
    const sub = document.getElementById('drv-header-sub');
    if (sub) sub.textContent = `${active.length} active trip${active.length !== 1 ? 's' : ''}`;

    const noTrips = active.length === 0 && completed.length === 0;

    page.innerHTML = `
      <div style="padding:14px 12px 80px;">

        ${noTrips ? `
          <div style="text-align:center;padding:64px 24px;color:#8898AA;">
            <div style="font-size:48px;margin-bottom:12px;">🚛</div>
            <div style="font-size:16px;font-weight:600;color:#4A5568;margin-bottom:6px;">No trips assigned</div>
            <div style="font-size:13px;line-height:1.5;">Your dispatcher hasn't assigned any trips yet. Check back soon.</div>
          </div>
        ` : ''}

        ${active.length > 0 ? `
          <div style="font-size:11px;font-weight:700;color:#8898AA;text-transform:uppercase;
                      letter-spacing:0.8px;margin-bottom:10px;padding:0 2px;">
            Active Trips
          </div>
          ${active.map(t => _tripCard(t, false)).join('')}
        ` : ''}

        ${completed.length > 0 ? `
          <div style="font-size:11px;font-weight:700;color:#8898AA;text-transform:uppercase;
                      letter-spacing:0.8px;margin:20px 0 10px;padding:0 2px;">
            Completed Today
          </div>
          ${completed.slice(0,5).map(t => _tripCard(t, true)).join('')}
        ` : ''}
      </div>
    `;
  }

  async function _loadDriverTrips() {
    const user    = window.LAMCurrentUser;
    const allTrips = await db().dbGetAll(C.TRIPS).catch(() => []);
    if (!allTrips.length) return [];

    // Match trips where driverId links to this user
    // Strategy: driverId on trips matches tms_drivers.id
    // tms_drivers.lamUserId should equal LAMCurrentUser.id
    // Fallback: match by name
    const driverIds = new Set();

    if (_driverRecord) {
      driverIds.add(_driverRecord.id);
    } else {
      // Fuzzy name match
      const drivers = await db().dbGetAll(C.DRIVERS).catch(() => []);
      drivers.forEach(d => {
        if ((d.name||'').toLowerCase() === (user.name||'').toLowerCase() ||
            d.lamUserId === user.id) {
          driverIds.add(d.id);
        }
      });
    }

    // If no driver record, show trips with driverName matching user name
    const myTrips = allTrips.filter(t =>
      driverIds.has(t.driverId) ||
      (driverIds.size === 0 && (t.driverName||'').toLowerCase() === (user.name||'').toLowerCase())
    );

    // Sort: active first, then by startDate desc
    return myTrips.sort((a, b) => {
      const aActive = !['delivered','cancelled'].includes(a.status);
      const bActive = !['delivered','cancelled'].includes(b.status);
      if (aActive !== bActive) return aActive ? -1 : 1;
      return (b.startDate || b.createdAt || '').localeCompare(a.startDate || a.createdAt || '');
    });
  }

  function _tripCard(trip, isCompleted) {
    const flow    = STATUS_FLOW.find(s => s.key === trip.status) || STATUS_FLOW[0];
    const nextStep = STATUS_FLOW.find(s => s.key === flow.next);
    const bg = isCompleted ? '#fff' : '#fff';
    const opacity = isCompleted ? '0.7' : '1';

    return `
      <div style="
        background:${bg};border-radius:16px;margin-bottom:12px;
        border:1px solid ${isCompleted ? '#E2E8F0' : '#EAECF0'};
        box-shadow:${isCompleted ? 'none' : '0 2px 8px rgba(0,0,0,0.06)'};
        overflow:hidden;opacity:${opacity};
      " id="trip-card-${trip.id}">

        <!-- Card Header -->
        <div style="padding:14px 14px 10px;border-bottom:1px solid #F1F5F9;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:11px;color:#8898AA;font-weight:600;
                          font-family:var(--font-mono,'monospace');">
                ${esc(trip.tripNumber || '—')}
              </div>
              <div style="font-weight:700;font-size:15px;color:#0D1117;margin-top:2px;line-height:1.3;">
                ${esc(trip.destination || 'Unknown Destination')}
              </div>
            </div>
            <span style="
              padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;
              background:${flow.color}18;color:${flow.color};flex-shrink:0;margin-left:8px;
            ">${STATUS_LABELS[trip.status] || trip.status}</span>
          </div>
        </div>

        <!-- Trip Details -->
        <div style="padding:10px 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <div style="font-size:10px;color:#8898AA;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">From</div>
            <div style="font-size:13px;color:#0D1117;margin-top:2px;">${esc(trip.origin || '—')}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#8898AA;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Cargo</div>
            <div style="font-size:13px;color:#0D1117;margin-top:2px;">${esc(trip.cargoDescription || '—')}</div>
          </div>
          ${trip.startDate ? `
          <div>
            <div style="font-size:10px;color:#8898AA;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Departure</div>
            <div style="font-size:13px;color:#0D1117;margin-top:2px;">${fmtDate(trip.startDate)}</div>
          </div>` : ''}
          ${trip.freightCost ? `
          <div>
            <div style="font-size:10px;color:#8898AA;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Freight</div>
            <div style="font-size:13px;font-weight:700;color:#059669;margin-top:2px;">₹${fmt(trip.freightCost)}</div>
          </div>` : ''}
        </div>

        <!-- Action Button -->
        ${!isCompleted && nextStep ? `
          <div style="padding:0 14px 14px;">
            <button onclick="window.LAMDriver._advanceTripStatus('${trip.id}','${nextStep.key}')"
              style="
                width:100%;padding:16px;border:none;border-radius:12px;
                background:${flow.color};color:#fff;
                font-size:15px;font-weight:700;cursor:pointer;
                display:flex;align-items:center;justify-content:center;gap:8px;
                min-height:52px;touch-action:manipulation;
                font-family:inherit;transition:opacity 0.15s;
                box-shadow:0 3px 10px ${flow.color}44;
              "
              onpointerdown="this.style.opacity='0.8'"
              onpointerup="this.style.opacity='1'"
              id="trip-btn-${trip.id}">
              <span>${flow.icon}</span>
              <span>${flow.label}</span>
            </button>
          </div>
        ` : ''}

        <!-- View POD button if delivered -->
        ${isCompleted ? `
          <div style="padding:0 14px 12px;">
            <button onclick="window.LAMDriver._viewPOD('${trip.id}')"
              style="
                width:100%;padding:10px;border:1px solid #E2E8F0;border-radius:10px;
                background:#fff;color:#4A5568;font-size:13px;font-weight:600;
                cursor:pointer;font-family:inherit;touch-action:manipulation;
              ">
              📄 View POD
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ══════════════════════════════════════════════════════════
  // TRIP STATUS ADVANCEMENT
  // ══════════════════════════════════════════════════════════

  window.LAMDriver._advanceTripStatus = async function(tripId, newStatus) {
    const btn = document.getElementById(`trip-btn-${tripId}`);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    try {
      // Capture GPS coords
      let coords = null;
      try {
        coords = await window.LAMGPS?.getCurrentLocation({ timeout: 5000, highAccuracy: true });
      } catch {}

      const trip = _trips.find(t => t.id === tripId);
      if (!trip) throw new Error('Trip not found');

      // Build status update
      const update = {
        status: newStatus,
        [`${newStatus}At`]:     now(),
        [`${newStatus}Lat`]:    coords?.lat || null,
        [`${newStatus}Lng`]:    coords?.lng || null,
      };

      // Special: at-pickup → also update fleet status
      if (newStatus === 'at-pickup') {
        update.actualDepartureAt = null; // will be set on loading→in-transit
      }

      // Special: loading → in-transit = departed
      if (newStatus === 'in-transit') {
        update.actualDepartureAt = now();
        // Start GPS ping tracking
        _startGPSPingForTrip(tripId);
        // Show fuel log prompt after brief delay
        setTimeout(() => _showFuelLogPrompt(trip), 1000);
      }

      // Special: delivered → open POD
      if (newStatus === 'delivered') {
        _stopGPSPing();
        // Update fleet + driver status
        await db().dbSet(C.FLEET, trip.vehicleId, {
          ...(await db().dbGet(C.FLEET, trip.vehicleId).catch(()=>({}))),
          status: 'active',
        });
        await db().dbSet(C.DRIVERS, trip.driverId, {
          ...(await db().dbGet(C.DRIVERS, trip.driverId).catch(()=>({}))),
          status: 'active', currentTripId: null,
        });
      }

      await db().dbSet(C.TRIPS, tripId, { ...trip, ...update });

      // Refresh the trip in our local array
      const idx = _trips.findIndex(t => t.id === tripId);
      if (idx >= 0) _trips[idx] = { ..._trips[idx], ...update };

      // Re-render home
      await _loadAndRenderHome();

      // POD capture opens after re-render
      if (newStatus === 'delivered') {
        setTimeout(() => _openPODCapture(tripId), 300);
      }

    } catch (e) {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
      window.LAM?.Toast?.error('Error', e.message);
    }
  };

  // ══════════════════════════════════════════════════════════
  // POD CAPTURE
  // ══════════════════════════════════════════════════════════

  function _openPODCapture(tripId) {
    const trip  = _trips.find(t => t.id === tripId);
    if (!trip) return;

    const page = document.getElementById('drv-page');
    if (!page) return;

    page.innerHTML = `
      <div style="padding:16px 12px 80px;">

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <button onclick="window.LAMDriver._cancelPOD()" style="
            background:none;border:none;cursor:pointer;font-size:22px;
            color:#4A5568;padding:4px;touch-action:manipulation;
          ">←</button>
          <div>
            <div style="font-weight:700;font-size:16px;color:#0D1117;">Proof of Delivery</div>
            <div style="font-size:12px;color:#8898AA;">${esc(trip.tripNumber || tripId)}</div>
          </div>
        </div>

        <!-- Receiver Name -->
        <div style="margin-bottom:16px;">
          <label style="font-size:12px;font-weight:700;color:#4A5568;
                        display:block;margin-bottom:8px;">Receiver Name *</label>
          <input id="pod-receiver" type="text" placeholder="Full name of receiver"
            style="
              width:100%;padding:14px;border:2px solid #E2E8F0;border-radius:12px;
              font-size:15px;font-family:inherit;color:#0D1117;background:#fff;
              box-sizing:border-box;outline:none;
            "
            oninput="document.getElementById('pod-receiver').style.borderColor='#2563EB'">
        </div>

        <!-- Timestamp (auto, read-only) -->
        <div style="margin-bottom:16px;padding:12px 14px;background:#F8FAFC;
                    border-radius:12px;border:1px solid #E2E8F0;">
          <div style="font-size:11px;font-weight:700;color:#8898AA;text-transform:uppercase;
                      letter-spacing:0.5px;margin-bottom:4px;">Delivery Time</div>
          <div id="pod-timestamp" style="font-size:14px;font-weight:600;color:#0D1117;">
            ${new Date().toLocaleString('en-IN', {
              day:'numeric', month:'short', year:'numeric',
              hour:'2-digit', minute:'2-digit', hour12:true
            })}
          </div>
        </div>

        <!-- GPS -->
        <div id="pod-gps-display" style="margin-bottom:16px;padding:12px 14px;background:#F8FAFC;
                    border-radius:12px;border:1px solid #E2E8F0;">
          <div style="font-size:11px;font-weight:700;color:#8898AA;text-transform:uppercase;
                      letter-spacing:0.5px;margin-bottom:4px;">GPS Location</div>
          <div id="pod-gps-text" style="font-size:13px;color:#4A5568;">📡 Capturing…</div>
        </div>

        <!-- Camera Capture -->
        <div style="margin-bottom:16px;">
          <label style="font-size:12px;font-weight:700;color:#4A5568;
                        display:block;margin-bottom:8px;">Photo Evidence</label>
          <div id="pod-photo-area" style="
            border:2px dashed #CBD5E1;border-radius:14px;
            background:#FAFBFC;min-height:120px;
            display:flex;align-items:center;justify-content:center;
            overflow:hidden;position:relative;cursor:pointer;
            touch-action:manipulation;
          " onclick="window.LAMDriver._capturePODPhoto()">
            <div id="pod-photo-prompt" style="text-align:center;padding:20px;pointer-events:none;">
              <div style="font-size:32px;margin-bottom:6px;">📷</div>
              <div style="font-size:13px;font-weight:600;color:#4A5568;">Tap to take photo</div>
              <div style="font-size:11px;color:#8898AA;margin-top:4px;">Compressed to &lt;200KB</div>
            </div>
          </div>
        </div>

        <!-- Signature Pad -->
        <div style="margin-bottom:24px;">
          <label style="font-size:12px;font-weight:700;color:#4A5568;
                        display:block;margin-bottom:8px;">Receiver Signature *</label>
          <div id="pod-sig-container" style="
            border:2px solid #E2E8F0;border-radius:14px;overflow:hidden;
            background:#fff;
          "></div>
          <div style="font-size:11px;color:#8898AA;margin-top:6px;text-align:center;">
            Use your finger to sign
          </div>
        </div>

        <!-- Submit Button -->
        <button id="pod-submit-btn" onclick="window.LAMDriver._submitPOD('${tripId}')"
          style="
            width:100%;padding:18px;border:none;border-radius:14px;
            background:#059669;color:#fff;
            font-size:16px;font-weight:700;cursor:pointer;
            min-height:56px;touch-action:manipulation;font-family:inherit;
            box-shadow:0 4px 14px rgba(5,150,105,0.3);
          ">
          ✅ Confirm Delivery
        </button>

      </div>
    `;

    // Init signature pad
    const sigContainer = document.getElementById('pod-sig-container');
    if (sigContainer && window.LAMCamera) {
      window._podSigPad = window.LAMCamera.createSignaturePad(sigContainer, {
        height: 160,
        penColor: '#1E293B',
        bgColor: '#FFFFFF',
      });
    }

    // Auto-capture GPS
    window.LAMGPS?.getCurrentLocation({ timeout: 8000, highAccuracy: true })
      .then(coords => {
        const el = document.getElementById('pod-gps-text');
        if (el) el.textContent = `📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)} (±${Math.round(coords.accuracy)}m)`;
        window._podGPS = coords;
      })
      .catch(() => {
        const el = document.getElementById('pod-gps-text');
        if (el) el.textContent = '❌ GPS unavailable';
        window._podGPS = null;
      });
  }

  window.LAMDriver._capturePODPhoto = async function() {
    try {
      const result = await window.LAMCamera?.capture({
        facing: 'environment',
        allowGallery: true,
      });
      if (!result) return;

      // Compress to <200KB: LAMCamera.processImageFile already handles this
      window._podPhotoB64 = result.base64 || result.dataUrl?.split(',')[1];

      const area   = document.getElementById('pod-photo-area');
      const prompt = document.getElementById('pod-photo-prompt');
      if (area && result.dataUrl) {
        if (prompt) prompt.style.display = 'none';
        // Remove old preview
        area.querySelector('.pod-preview-img')?.remove();
        const img  = document.createElement('img');
        img.className = 'pod-preview-img';
        img.src = result.dataUrl;
        img.style.cssText = 'width:100%;max-height:220px;object-fit:cover;border-radius:12px;display:block;';
        area.appendChild(img);
        // Add retake button
        const retake = document.createElement('button');
        retake.textContent = '🔄 Retake';
        retake.style.cssText = `
          position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);
          color:#fff;border:none;border-radius:8px;padding:6px 12px;
          font-size:12px;cursor:pointer;font-family:inherit;
        `;
        retake.onclick = e => {
          e.stopPropagation();
          window.LAMDriver._capturePODPhoto();
        };
        area.style.position = 'relative';
        area.appendChild(retake);
      }
    } catch (e) {
      window.LAM?.Toast?.error('Camera Error', e.message);
    }
  };

  window.LAMDriver._submitPOD = async function(tripId) {
    const receiver = document.getElementById('pod-receiver')?.value.trim();
    if (!receiver) {
      document.getElementById('pod-receiver').style.borderColor = '#DC2626';
      window.LAM?.Toast?.error('Required', 'Please enter the receiver\'s name.');
      return;
    }

    const sigPad = window._podSigPad;
    if (!sigPad || sigPad.isEmpty?.()) {
      window.LAM?.Toast?.error('Required', 'Please get the receiver to sign.');
      return;
    }

    const btn = document.getElementById('pod-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      const sigB64 = sigPad.toDataURL?.()?.split(',')[1] || sigPad.getDataURL?.()?.split(',')[1];
      const ts     = now();
      const trip   = _trips.find(t => t.id === tripId);

      const podRecord = {
        id:           'pod_' + Date.now(),
        tripId,
        tripNumber:   trip?.tripNumber || '—',
        receiverName: receiver,
        timestamp:    ts,
        gpsLat:       window._podGPS?.lat || null,
        gpsLng:       window._podGPS?.lng || null,
        gpsAccuracy:  window._podGPS?.accuracy || null,
        signatureB64: sigB64 || null,
        photoB64:     window._podPhotoB64 || null,
        driverId:     _driverRecord?.id || window.LAMCurrentUser?.id,
        driverName:   window.LAMCurrentUser?.name,
        vehicleNumber: trip?.vehicleNumber || null,
        createdAt:    ts,
        _synced:      false,  // Supabase: push to pod_submissions table
      };

      await db().dbSet(C.POD, podRecord.id, podRecord);

      // Link POD to trip
      await db().dbSet(C.TRIPS, tripId, {
        ...(trip || {}),
        podId:      podRecord.id,
        podCaptured: true,
        deliveredAt: ts,
        receiverName: receiver,
      });

      // Supabase hook — push POD record when cloud is available
      window.LAMCloud?.push({ type: 'create', col: C.POD, record: podRecord, ts: Date.now() });

      // Clean up temp state
      window._podSigPad  = null;
      window._podPhotoB64 = null;
      window._podGPS     = null;

      window.LAM?.Toast?.success('Delivered! 🎉', 'POD captured and saved.');
      await _loadAndRenderHome();

    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm Delivery'; }
      window.LAM?.Toast?.error('Failed', e.message);
    }
  };

  window.LAMDriver._cancelPOD = async function() {
    window._podSigPad  = null;
    window._podPhotoB64 = null;
    window._podGPS     = null;
    await _loadAndRenderHome();
  };

  window.LAMDriver._viewPOD = async function(tripId) {
    const pods = await db().dbGetAll(C.POD).catch(() => []);
    const pod  = pods.find(p => p.tripId === tripId);
    const trip = _trips.find(t => t.id === tripId);

    if (!pod) {
      window.LAM?.Toast?.info('No POD', 'No proof of delivery was captured for this trip.');
      return;
    }

    _showPODViewer(pod, trip);
  };

  function _showPODViewer(pod, trip) {
    const page = document.getElementById('drv-page');
    if (!page) return;

    page.innerHTML = `
      <div style="padding:16px 12px 80px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <button onclick="window.LAMDriver._switchTab('home')" style="
            background:none;border:none;cursor:pointer;font-size:22px;color:#4A5568;padding:4px;
          ">←</button>
          <div>
            <div style="font-weight:700;font-size:16px;color:#0D1117;">Proof of Delivery</div>
            <div style="font-size:12px;color:#8898AA;">${esc(trip?.tripNumber || pod.tripNumber || '—')}</div>
          </div>
        </div>

        <div style="background:#fff;border-radius:16px;border:1px solid #EAECF0;overflow:hidden;margin-bottom:14px;">
          <div style="padding:14px;border-bottom:1px solid #F1F5F9;">
            <div style="font-size:11px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Receiver</div>
            <div style="font-weight:700;font-size:16px;color:#0D1117;">${esc(pod.receiverName || '—')}</div>
          </div>
          <div style="padding:14px;border-bottom:1px solid #F1F5F9;">
            <div style="font-size:11px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Time</div>
            <div style="font-size:14px;font-weight:600;color:#0D1117;">
              ${new Date(pod.timestamp).toLocaleString('en-IN', {
                day:'numeric',month:'short',year:'numeric',
                hour:'2-digit',minute:'2-digit',hour12:true
              })}
            </div>
          </div>
          ${pod.gpsLat ? `
          <div style="padding:14px;">
            <div style="font-size:11px;color:#8898AA;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">GPS</div>
            <div style="font-size:13px;color:#4A5568;">📍 ${pod.gpsLat.toFixed(5)}, ${pod.gpsLng.toFixed(5)}</div>
          </div>` : ''}
        </div>

        ${pod.photoB64 ? `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;color:#4A5568;margin-bottom:8px;">Photo</div>
          <img src="data:image/jpeg;base64,${pod.photoB64}"
            style="width:100%;border-radius:14px;border:1px solid #E2E8F0;display:block;">
        </div>` : ''}

        ${pod.signatureB64 ? `
        <div style="margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;color:#4A5568;margin-bottom:8px;">Signature</div>
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:12px;">
            <img src="data:image/png;base64,${pod.signatureB64}"
              style="width:100%;max-height:120px;object-fit:contain;display:block;">
          </div>
        </div>` : ''}

        <button onclick="window.LAMDriver._downloadPODPDF('${pod.id}')"
          style="
            width:100%;padding:16px;border:1px solid #2563EB;border-radius:12px;
            background:#EFF6FF;color:#2563EB;font-size:14px;font-weight:700;
            cursor:pointer;font-family:inherit;touch-action:manipulation;
          ">
          ⬇ Download POD as PDF
        </button>
      </div>
    `;
  }

  window.LAMDriver._downloadPODPDF = async function(podId) {
    if (!window.LAMPDF) {
      window.LAM?.Toast?.warning('Not Available', 'PDF engine not loaded.');
      return;
    }
    const pods = await db().dbGetAll(C.POD).catch(() => []);
    const pod  = pods.find(p => p.id === podId);
    if (!pod) return;

    try {
      // Use LAMPDF.deliveryNote as the closest match
      const tripData = _trips.find(t => t.id === pod.tripId) || {};
      window.LAMPDF.deliveryNote({
        ...tripData,
        receiverName:     pod.receiverName,
        deliveredAt:      pod.timestamp,
        podSignatureB64:  pod.signatureB64,
        podPhotoB64:      pod.photoB64,
        gpsLat:           pod.gpsLat,
        gpsLng:           pod.gpsLng,
      }, {}, {}, []);
    } catch (e) {
      window.LAM?.Toast?.error('PDF Error', e.message);
    }
  };

  // ══════════════════════════════════════════════════════════
  // FUEL LOG
  // ══════════════════════════════════════════════════════════

  function _showFuelLogPrompt(trip) {
    const existing = document.getElementById('drv-fuel-prompt');
    if (existing) return;

    const sheet = document.createElement('div');
    sheet.id = 'drv-fuel-prompt';
    sheet.style.cssText = `
      position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:#fff;border-radius:20px 20px 0 0;
      box-shadow:0 -8px 32px rgba(0,0,0,0.18);
      padding:20px 16px calc(env(safe-area-inset-bottom,0px) + 16px);
      font-family:var(--font-body,'Geist',system-ui,sans-serif);
      transform:translateY(100%);transition:transform 0.3s ease;
    `;

    sheet.innerHTML = `
      <div style="width:40px;height:4px;background:#E2E8F0;border-radius:2px;
                  margin:0 auto 16px;"></div>
      <div style="font-weight:700;font-size:16px;color:#0D1117;margin-bottom:4px;">
        ⛽ Log Fuel Fill-up?
      </div>
      <div style="font-size:13px;color:#8898AA;margin-bottom:20px;">
        Optional — helps track fuel costs per km
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div>
          <label style="font-size:11px;font-weight:700;color:#4A5568;display:block;margin-bottom:5px;">
            Odometer (km)
          </label>
          <input id="fuel-odometer" type="number" inputmode="numeric"
            placeholder="e.g. 45230" class="drv-input"
            style="${_inputStyle()}">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#4A5568;display:block;margin-bottom:5px;">
            Litres Filled
          </label>
          <input id="fuel-litres" type="number" inputmode="decimal"
            placeholder="e.g. 40" class="drv-input"
            style="${_inputStyle()}"
            oninput="window.LAMDriver._calcFuelCost()">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#4A5568;display:block;margin-bottom:5px;">
            Amount Paid (₹)
          </label>
          <input id="fuel-amount" type="number" inputmode="decimal"
            placeholder="e.g. 3800" class="drv-input"
            style="${_inputStyle()}"
            oninput="window.LAMDriver._calcFuelCost()">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#4A5568;display:block;margin-bottom:5px;">
            Pump / Station
          </label>
          <input id="fuel-pump" type="text"
            placeholder="e.g. HP Petrol, NH17" class="drv-input"
            style="${_inputStyle()}">
        </div>
      </div>

      <div id="fuel-cost-per-km" style="
        padding:10px 12px;background:#F0FDF4;border-radius:10px;
        font-size:12px;font-weight:600;color:#059669;
        margin-bottom:14px;display:none;
      "></div>

      <div style="margin-bottom:16px;">
        <label style="font-size:11px;font-weight:700;color:#4A5568;display:block;margin-bottom:5px;">
          Receipt Photo (optional)
        </label>
        <button onclick="window.LAMDriver._captureFuelReceipt()"
          id="fuel-receipt-btn"
          style="
            width:100%;padding:12px;border:2px dashed #CBD5E1;border-radius:10px;
            background:#FAFBFC;color:#4A5568;font-size:13px;font-weight:600;
            cursor:pointer;font-family:inherit;touch-action:manipulation;
          ">
          📷 Tap to capture receipt
        </button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <button onclick="document.getElementById('drv-fuel-prompt').remove()"
          style="
            padding:14px;border:1px solid #E2E8F0;border-radius:12px;
            background:#fff;color:#4A5568;font-size:14px;font-weight:600;
            cursor:pointer;font-family:inherit;touch-action:manipulation;
          ">
          Skip
        </button>
        <button onclick="window.LAMDriver._submitFuelLog('${trip.id}','${esc(trip.vehicleId||'')}','${esc(trip.vehicleNumber||'')}')"
          style="
            padding:14px;border:none;border-radius:12px;
            background:#D97706;color:#fff;font-size:14px;font-weight:700;
            cursor:pointer;font-family:inherit;touch-action:manipulation;
            box-shadow:0 3px 10px rgba(217,119,6,0.3);
          ">
          ⛽ Save Log
        </button>
      </div>
    `;

    document.body.appendChild(sheet);
    requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)'; });

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'drv-fuel-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.4);';
    backdrop.onclick = () => { sheet.remove(); backdrop.remove(); };
    document.body.insertBefore(backdrop, sheet);
  }

  window.LAMDriver._calcFuelCost = function() {
    const litres = parseFloat(document.getElementById('fuel-litres')?.value) || 0;
    const amount = parseFloat(document.getElementById('fuel-amount')?.value) || 0;
    const el     = document.getElementById('fuel-cost-per-km');
    if (!el) return;
    if (litres > 0 && amount > 0) {
      const perLitre = (amount / litres).toFixed(2);
      el.style.display = 'block';
      el.textContent = `₹${perLitre}/litre · Approx ₹${(amount / (litres * 4)).toFixed(1)} per km (12kmpl est.)`;
    } else {
      el.style.display = 'none';
    }
  };

  window.LAMDriver._captureFuelReceipt = async function() {
    try {
      const result = await window.LAMCamera?.capture({ facing: 'environment', allowGallery: true });
      if (!result) return;
      window._fuelReceiptB64 = result.base64 || result.dataUrl?.split(',')[1];
      const btn = document.getElementById('fuel-receipt-btn');
      if (btn) {
        btn.textContent = '✅ Receipt captured';
        btn.style.borderColor = '#059669';
        btn.style.color = '#059669';
      }
    } catch (e) {
      window.LAM?.Toast?.error('Camera Error', e.message);
    }
  };

  window.LAMDriver._submitFuelLog = async function(tripId, vehicleId, vehicleNumber) {
    const odometer = parseFloat(document.getElementById('fuel-odometer')?.value) || 0;
    const litres   = parseFloat(document.getElementById('fuel-litres')?.value) || 0;
    const amount   = parseFloat(document.getElementById('fuel-amount')?.value) || 0;
    const pump     = document.getElementById('fuel-pump')?.value.trim() || '';

    if (!litres && !amount) {
      window.LAM?.Toast?.warning('Missing', 'Enter at least litres or amount.');
      return;
    }

    let coords = null;
    try { coords = await window.LAMGPS?.getCurrentLocation({ timeout: 4000 }); } catch {}

    const fuelRecord = {
      id:            'fuel_' + Date.now(),
      tripId,
      vehicleId:     vehicleId || null,
      vehicleNumber: vehicleNumber || null,
      driverId:      _driverRecord?.id || window.LAMCurrentUser?.id,
      driverName:    window.LAMCurrentUser?.name,
      odometerKm:    odometer,
      litresFilled:  litres,
      amountPaid:    amount,
      costPerLitre:  litres > 0 ? +(amount / litres).toFixed(2) : null,
      pumpName:      pump,
      receiptB64:    window._fuelReceiptB64 || null,
      gpsLat:        coords?.lat || null,
      gpsLng:        coords?.lng || null,
      date:          new Date().toISOString().slice(0, 10),
      createdAt:     now(),
      _synced:       false,
    };

    try {
      await db().dbSet(C.FUEL, fuelRecord.id, fuelRecord);
      // Update vehicle odometer
      if (vehicleId && odometer) {
        const fleet = await db().dbGet(C.FLEET, vehicleId).catch(() => ({}));
        await db().dbSet(C.FLEET, vehicleId, { ...(fleet || {}), currentKm: odometer });
      }
      window._fuelReceiptB64 = null;
      document.getElementById('drv-fuel-prompt')?.remove();
      document.getElementById('drv-fuel-backdrop')?.remove();
      window.LAM?.Toast?.success('Fuel Logged', `₹${fmt(amount)} · ${litres}L recorded.`);
    } catch (e) {
      window.LAM?.Toast?.error('Failed', e.message);
    }
  };

  function _inputStyle() {
    return `
      width:100%;padding:12px;border:2px solid #E2E8F0;border-radius:10px;
      font-size:14px;font-family:inherit;color:#0D1117;background:#fff;
      box-sizing:border-box;outline:none;
    `;
  }

  // ══════════════════════════════════════════════════════════
  // TRIP HISTORY
  // ══════════════════════════════════════════════════════════

  async function _renderHistory() {
    const page = document.getElementById('drv-page');
    if (!page) return;

    page.innerHTML = `
      <div style="display:flex;justify-content:center;padding:48px;">
        <div class="spinner"></div>
      </div>
    `;

    const allTrips = await _loadDriverTrips();
    const history  = allTrips
      .filter(t => t.status === 'delivered' || t.status === 'cancelled')
      .slice(0, 30);

    // Load fuel logs for cost calculation
    const allFuel = await db().dbGetAll(C.FUEL).catch(() => []);
    const driverId = _driverRecord?.id || window.LAMCurrentUser?.id;
    const myFuel   = allFuel.filter(f => f.driverId === driverId);
    const fuelByTrip = {};
    myFuel.forEach(f => {
      fuelByTrip[f.tripId] = (fuelByTrip[f.tripId] || 0) + (f.amountPaid || 0);
    });

    if (!history.length) {
      page.innerHTML = `
        <div style="text-align:center;padding:64px 24px;color:#8898AA;">
          <div style="font-size:48px;margin-bottom:12px;">📋</div>
          <div style="font-size:16px;font-weight:600;color:#4A5568;margin-bottom:6px;">No trip history yet</div>
          <div style="font-size:13px;">Your completed trips will appear here.</div>
        </div>
      `;
      return;
    }

    page.innerHTML = `
      <div style="padding:14px 12px 80px;">
        <div style="font-size:11px;font-weight:700;color:#8898AA;text-transform:uppercase;
                    letter-spacing:0.8px;margin-bottom:12px;padding:0 2px;">
          Last ${history.length} Trips
        </div>
        ${history.map(t => {
          const fuel = fuelByTrip[t.id];
          return `
            <div style="
              background:#fff;border-radius:14px;margin-bottom:10px;
              border:1px solid #E2E8F0;overflow:hidden;
            ">
              <div style="padding:12px 14px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                  <div>
                    <div style="font-size:10px;color:#8898AA;font-family:monospace;">${esc(t.tripNumber||'—')}</div>
                    <div style="font-weight:700;font-size:14px;color:#0D1117;margin-top:2px;">
                      ${esc(t.origin||'—')} → ${esc(t.destination||'—')}
                    </div>
                  </div>
                  <span style="
                    padding:3px 8px;border-radius:20px;font-size:10px;font-weight:600;
                    background:${t.status==='delivered'?'#ECFDF5':'#FEF2F2'};
                    color:${t.status==='delivered'?'#059669':'#DC2626'};
                    flex-shrink:0;margin-left:8px;
                  ">${STATUS_LABELS[t.status]||t.status}</span>
                </div>
                <div style="display:flex;gap:16px;flex-wrap:wrap;">
                  <div>
                    <span style="font-size:11px;color:#8898AA;">Date</span>
                    <span style="font-size:12px;font-weight:600;color:#4A5568;margin-left:6px;">
                      ${fmtDate(t.startDate)}
                    </span>
                  </div>
                  ${t.freightCost ? `<div>
                    <span style="font-size:11px;color:#8898AA;">Freight</span>
                    <span style="font-size:12px;font-weight:700;color:#059669;margin-left:6px;">
                      ₹${fmt(t.freightCost)}
                    </span>
                  </div>` : ''}
                  ${fuel ? `<div>
                    <span style="font-size:11px;color:#8898AA;">Fuel</span>
                    <span style="font-size:12px;font-weight:600;color:#D97706;margin-left:6px;">
                      ₹${fmt(fuel)}
                    </span>
                  </div>` : ''}
                </div>
              </div>
              ${t.podCaptured ? `
              <div style="border-top:1px solid #F1F5F9;padding:10px 14px;">
                <button onclick="window.LAMDriver._viewPOD('${t.id}')"
                  style="
                    padding:8px 14px;border:1px solid #DBEAFE;border-radius:8px;
                    background:#EFF6FF;color:#2563EB;font-size:12px;font-weight:600;
                    cursor:pointer;font-family:inherit;touch-action:manipulation;
                  ">
                  📄 View POD
                </button>
              </div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ══════════════════════════════════════════════════════════
  // GPS PING (every 5 min while en-route)
  // ══════════════════════════════════════════════════════════

  function _startGPSPing() {
    if (!window.LAMGPS) return;
    _stopGPSPing();

    // Update dot on first position
    window.LAMGPS.getCurrentLocation({ timeout: 8000, highAccuracy: true })
      .then(coords => _updateGPSDot(true, coords))
      .catch(() => _updateGPSDot(false));

    // Every 5 minutes: record ping for active trips
    _gpsPingTimer = setInterval(() => _recordGPSPing(), 5 * 60 * 1000);
  }

  function _startGPSPingForTrip(tripId) {
    // Immediate first ping when trip goes in-transit
    _recordGPSPing(tripId);
  }

  function _stopGPSPing() {
    if (_gpsPingTimer) { clearInterval(_gpsPingTimer); _gpsPingTimer = null; }
    if (_gpsTracker)   { _gpsTracker.stop(); _gpsTracker = null; }
  }

  async function _recordGPSPing(forceTripId) {
    try {
      const coords = await window.LAMGPS.getCurrentLocation({ timeout: 10000, highAccuracy: true });
      _updateGPSDot(true, coords);

      // Find active in-transit trips for this driver
      const activeTripIds = forceTripId
        ? [forceTripId]
        : _trips
            .filter(t => t.status === 'in-transit')
            .map(t => t.id);

      if (!activeTripIds.length) return;

      for (const tripId of activeTripIds) {
        const ping = {
          id:        'gps_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
          tripId,
          driverId:  _driverRecord?.id || window.LAMCurrentUser?.id,
          lat:       coords.lat,
          lng:       coords.lng,
          accuracy:  coords.accuracy,
          timestamp: now(),
          createdAt: now(),
          _synced:   false,
          // Supabase: push to location_logs table
          // columns: trip_id, driver_id, lat, lng, accuracy, timestamp
        };

        await db().dbSet(C.GPS_PINGS, ping.id, ping);

        // Supabase hook
        window.LAMCloud?.push({ type: 'create', col: 'location_logs', record: ping, ts: Date.now() });

        // Update trip's last known location (for Owner Fleet Tracker map)
        const trip = _trips.find(t => t.id === tripId);
        if (trip) {
          await db().dbSet(C.TRIPS, tripId, {
            ...trip,
            lastKnownLat: coords.lat,
            lastKnownLng: coords.lng,
            lastPingAt:   now(),
          });
          // Update local cache
          const idx = _trips.findIndex(t => t.id === tripId);
          if (idx >= 0) {
            _trips[idx].lastKnownLat = coords.lat;
            _trips[idx].lastKnownLng = coords.lng;
          }
        }
      }
    } catch {
      _updateGPSDot(false);
    }
  }

  function _updateGPSDot(active, coords) {
    const dot = document.getElementById('drv-gps-dot');
    if (!dot) return;
    dot.style.background = active ? '#059669' : '#6B7280';
    dot.title = active && coords
      ? `GPS active — ${coords.lat?.toFixed(4)}, ${coords.lng?.toFixed(4)}`
      : 'GPS inactive';
  }

  // ══════════════════════════════════════════════════════════
  // STYLES
  // ══════════════════════════════════════════════════════════

  function _injectStyles() {
    if (document.getElementById('lam-driver-styles')) return;
    const s = document.createElement('style');
    s.id = 'lam-driver-styles';
    s.textContent = `
      /* Driver shell — full viewport */
      #lam-driver-shell * { box-sizing:border-box; }
      #lam-driver-shell button:active { opacity:0.75; }
      #drv-page::-webkit-scrollbar { display:none; }
      #drv-page { scrollbar-width:none; }

      /* Spinner — reuse LAM's if available */
      @keyframes drv-spin { to { transform:rotate(360deg); } }
      #lam-driver-shell .spinner {
        width:28px;height:28px;border-radius:50%;
        border:3px solid #E2E8F0;border-top-color:#2563EB;
        animation:drv-spin 0.7s linear infinite;
      }

      /* Touch ripple on trip action buttons */
      @keyframes drv-pulse {
        0%   { box-shadow:0 0 0 0 rgba(37,99,235,0.4); }
        70%  { box-shadow:0 0 0 12px rgba(37,99,235,0); }
        100% { box-shadow:0 0 0 0 rgba(37,99,235,0); }
      }
    `;
    document.head.appendChild(s);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  Object.assign(window.LAMDriver, {
    mount,
    unmount,
    getActiveTrips:   () => _trips.filter(t => !['delivered','cancelled'].includes(t.status)),
    getDriverRecord:  () => _driverRecord,
    get _mounted()    { return _mounted; },
    // Owner/Accountant can view POD via trip detail page
    openPODViewer:    async (tripId) => {
      const pods = await db().dbGetAll(C.POD).catch(() => []);
      return pods.find(p => p.tripId === tripId) || null;
    },
    // GPS pings readable by fleet tracker
    getLastPingForTrip: async (tripId) => {
      const pings = await db().dbGetAll(C.GPS_PINGS).catch(() => []);
      return pings
        .filter(p => p.tripId === tripId)
        .sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''))
        [0] || null;
    },
  });

  return window.LAMDriver;

})();

window.LAMDriver = window.LAMDriver || LAMDriver;
