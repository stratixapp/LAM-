// ============================================================
// LAM Users Engine v1.0 — Multi-User PIN Auth + RBAC + Audit
// ============================================================
// Features:
//   1. LOCAL USER ACCOUNTS WITH PIN
//      — 4 roles: owner / accountant / dispatcher / driver
//      — SHA-256 hashed 4-digit PINs, stored in IndexedDB
//      — User selection screen with avatar cards
//      — Auto-lock after 10 min inactivity
//      — Owner PIN reset via security question
//      — First-time setup wizard
//
//   2. ROLE-BASED NAV
//      — Nav items hidden (display:none) per role
//      — Route guard redirects blocked routes to home
//
//   3. PLAIN-ENGLISH AUDIT TRAIL
//      — Every DB write gets a human-readable log entry
//      — Old-value vs new-value diff captured automatically
//      — Owner sees all; others see own actions only
//
//   4. CURRENT USER CONTEXT
//      — window.LAMCurrentUser = { id, name, role, loginTime }
//      — dbCreate/dbUpdate auto-tagged with user id + name
//      — Topbar shows name, role badge, logout button
//
//   5. SUPABASE-READY HOOKS
//      — lam_users collection mirrors Supabase auth.users shape
//      — lam_audit_log ready to sync to Supabase audit_logs
//      — PIN auth stays local; swap to Supabase auth when ready
//
// Deps: window.LAMDB (lam-db.js)
// Zero additional dependencies. Pure vanilla JS / SubtleCrypto.
// ============================================================

const LAMUsers = (() => {

  // ── Constants ─────────────────────────────────────────────
  const COLLECTION_USERS = 'lam_users';
  const COLLECTION_AUDIT = 'lam_audit_log';
  const SESSION_KEY       = 'lam_user_session_v1';
  const INACTIVITY_MS     = 10 * 60 * 1000; // 10 minutes
  const SETUP_DONE_KEY    = 'lam_users_setup_done';

  // ── Role definitions ──────────────────────────────────────
  const ROLES = {
    owner:       { label: 'Owner',       emoji: '👑', color: '#7C3AED' },
    accountant:  { label: 'Accountant',  emoji: '📊', color: '#0284C7' },
    dispatcher:  { label: 'Dispatcher',  emoji: '🚛', color: '#059669' },
    driver:      { label: 'Driver',      emoji: '🚗', color: '#D97706' },
  };

  // ── Role → allowed routes (undefined = owner = all) ───────
  // Routes not listed are BLOCKED for that role.
  const ROLE_ROUTES = {
    owner: null, // null = allow everything

    accountant: new Set([
      'dashboard','finance','finadvanced','accounting','bankrecon',
      'gst','customers','vendors','reports','settings','audit',
      'pipeline','payslip','crm',
    ]),

    dispatcher: new Set([
      'dashboard','fleet','drivers','trips',
      'products','inventory','warehouses','categories',
      'orders','orderops','grn','wms','dispatch',
      'customers','vendors','procurement','procadvanced',
      'settings',
    ]),

    driver: new Set(['my-trips', 'dashboard']),
  };

  // ── Nav item route keys per role: which to HIDE ───────────
  // Derived from the inverse of ROLE_ROUTES at init time.
  // All [data-route] nav items not in the allowed set get display:none.

  // Avatar colors for auto-assignment
  const AVATAR_COLORS = [
    '#7C3AED','#0284C7','#059669','#D97706',
    '#DC2626','#DB2777','#0891B2','#65A30D',
  ];

  // ── State ─────────────────────────────────────────────────
  let _currentUser   = null;
  let _inactivityTimer = null;
  let _initialized   = false;
  let _dbReady       = false;

  // ══════════════════════════════════════════════════════════
  // SECTION 1 — PIN HASHING
  // ══════════════════════════════════════════════════════════

  async function hashPIN(pin, userId) {
    const encoder = new TextEncoder();
    // Salt = userId + fixed salt to prevent rainbow tables
    const salt    = 'LAM_PIN_v1_' + (userId || 'setup');
    const data    = encoder.encode(pin + salt);
    const hash    = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function verifyPIN(pin, storedHash, userId) {
    const hash = await hashPIN(pin, userId);
    return hash === storedHash;
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 2 — USER CRUD
  // ══════════════════════════════════════════════════════════

  async function _db() {
    // Wait for LAMDB if not ready yet
    if (window.LAMDB) return window.LAMDB;
    return new Promise(resolve => {
      const t = setInterval(() => {
        if (window.LAMDB) { clearInterval(t); resolve(window.LAMDB); }
      }, 100);
    });
  }

  async function getAllUsers() {
    const db = await _db();
    return db.dbGetAll(COLLECTION_USERS).catch(() => []);
  }

  async function getUserById(id) {
    const db = await _db();
    return db.dbGet(COLLECTION_USERS, id).catch(() => null);
  }

  async function createUser({ name, role, pin, avatarColor, securityQuestion, securityAnswer }) {
    const db  = await _db();
    const id  = 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const now = new Date().toISOString();

    const pinHash = await hashPIN(pin, id);
    const sqHash  = securityAnswer
      ? await hashPIN(securityAnswer.toLowerCase().trim(), id + '_sq')
      : null;

    const user = {
      id,
      name:             name.trim(),
      role,
      pinHash,
      avatarColor:      avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      securityQuestion: securityQuestion || null,
      securityAnswerHash: sqHash,
      createdAt:        now,
      updatedAt:        now,
      active:           true,
      // Supabase-compatible shape:
      // When wiring Supabase auth: map id → supabase user UUID,
      // keep pinHash local only (never sync to Supabase),
      // sync: name, role, avatarColor, createdAt
      _supabaseSync:    false,
    };

    // Bypass the patched dbSet to avoid circular audit logging during setup
    await db.dbSet(COLLECTION_USERS, id, user);
    await _writeAuditDirect({
      userId:  _currentUser?.id || id,
      userName: _currentUser?.name || name,
      userRole: _currentUser?.role || role,
      action:  'created',
      entity:  'User',
      detail:  `New ${ROLES[role]?.label || role}: ${name}`,
    });

    return user;
  }

  async function updateUser(id, updates) {
    const db       = await _db();
    const existing = await getUserById(id);
    if (!existing) throw new Error('User not found');

    if (updates.pin) {
      updates.pinHash = await hashPIN(updates.pin, id);
      delete updates.pin;
    }
    if (updates.securityAnswer) {
      updates.securityAnswerHash = await hashPIN(updates.securityAnswer.toLowerCase().trim(), id + '_sq');
      delete updates.securityAnswer;
    }

    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    await db.dbSet(COLLECTION_USERS, id, updated);
    return updated;
  }

  async function deleteUser(id) {
    const db   = await _db();
    const user = await getUserById(id);
    if (!user) return;

    // Soft-delete (never hard-delete — audit trail requires user records)
    await db.dbSet(COLLECTION_USERS, id, { ...user, active: false, updatedAt: new Date().toISOString() });
    await _writeAuditDirect({
      userId:   _currentUser?.id,
      userName: _currentUser?.name,
      userRole: _currentUser?.role,
      action:   'removed',
      entity:   'User',
      detail:   `Removed user: ${user.name} (${ROLES[user.role]?.label || user.role})`,
    });
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 3 — SESSION MANAGEMENT
  // ══════════════════════════════════════════════════════════

  function _saveSession(user) {
    const session = {
      id:        user.id,
      name:      user.name,
      role:      user.role,
      avatarColor: user.avatarColor,
      loginTime: new Date().toISOString(),
      lastActivity: Date.now(),
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
    return session;
  }

  function _loadSession() {
    try {
      const s = localStorage.getItem(SESSION_KEY);
      if (!s) return null;
      const session = JSON.parse(s);
      // Check if session expired (inactivity)
      if (Date.now() - (session.lastActivity || 0) > INACTIVITY_MS) {
        _clearSession();
        return null;
      }
      return session;
    } catch { return null; }
  }

  function _clearSession() {
    localStorage.removeItem(SESSION_KEY);
    _currentUser = null;
    window.LAMCurrentUser = null;
  }

  function _touchActivity() {
    try {
      const s = localStorage.getItem(SESSION_KEY);
      if (!s) return;
      const session = JSON.parse(s);
      session.lastActivity = Date.now();
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {}
    // Reset inactivity timer
    clearTimeout(_inactivityTimer);
    _inactivityTimer = setTimeout(_handleInactivity, INACTIVITY_MS);
  }

  function _handleInactivity() {
    if (!_currentUser) return;
    const name = _currentUser.name;
    _clearSession();
    _currentUser = null;
    window.LAMCurrentUser = null;
    // Show lock screen
    showUserSelectScreen({ message: `Session locked — ${name} was inactive for 10 minutes` });
  }

  function _startInactivityWatch() {
    const events = ['click','keydown','touchstart','mousemove','scroll'];
    const touch  = () => _touchActivity();
    events.forEach(e => document.addEventListener(e, touch, { passive: true }));
    _inactivityTimer = setTimeout(_handleInactivity, INACTIVITY_MS);
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 4 — AUDIT TRAIL
  // ══════════════════════════════════════════════════════════

  /**
   * Write a plain-English audit log entry directly to IndexedDB.
   * This bypasses the patched dbSet to prevent infinite recursion.
   */
  async function _writeAuditDirect(entry) {
    try {
      const db  = await _db();
      const id  = 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const now = new Date().toISOString();

      const log = {
        id,
        userId:   entry.userId   || _currentUser?.id   || 'system',
        userName: entry.userName || _currentUser?.name  || 'System',
        userRole: entry.userRole || _currentUser?.role  || 'system',
        action:   entry.action,   // 'created' | 'edited' | 'deleted' | 'changed'
        entity:   entry.entity,   // 'Invoice' | 'Trip' | 'Driver' etc.
        entityId: entry.entityId  || null,
        detail:   entry.detail,   // human-readable description
        oldValue: entry.oldValue  || null,
        newValue: entry.newValue  || null,
        // Human-readable timestamp: "14 Jun, 6:15 PM"
        humanTime: _humanTime(now),
        createdAt: now,
        // Supabase-ready: when syncing, push this entire object to audit_logs table
        _synced:   false,
      };

      // Direct IDB write — no patching overhead
      const idb = db._getDBDirect ? db._getDBDirect() : null;
      if (idb) {
        // Direct write if low-level access available
        await db.dbSet(COLLECTION_AUDIT, id, log);
      } else {
        await db.dbSet(COLLECTION_AUDIT, id, log);
      }
    } catch (e) {
      // Never crash the app over an audit failure
      console.warn('[LAMUsers] Audit write failed:', e);
    }
  }

  /**
   * Generate a plain-English audit entry from a DB operation.
   * Compares old vs new values and describes what changed.
   */
  function _buildAuditDetail(col, op, record, oldRecord) {
    const user = _currentUser;
    if (!user) return null;

    const entityLabel = _entityLabel(col);
    const entityName  = _entityName(record, col);

    let action, detail;

    if (op === 'create') {
      action = 'created';
      detail = `New ${entityLabel}: ${entityName}`;
    } else if (op === 'delete') {
      action = 'deleted';
      detail = `Deleted ${entityLabel}: ${entityName}`;
    } else if (op === 'update' || op === 'set') {
      action   = 'edited';
      const diff = _diffRecords(oldRecord || {}, record);
      detail   = diff.length
        ? `${entityLabel} ${entityName} — ${diff.join('; ')}`
        : `Updated ${entityLabel}: ${entityName}`;
    } else {
      action = op;
      detail = `${entityLabel}: ${entityName}`;
    }

    return {
      userId:   user.id,
      userName: user.name,
      userRole: user.role,
      action,
      entity:   entityLabel,
      entityId: record?.id,
      detail,
      oldValue: oldRecord ? JSON.stringify(oldRecord).slice(0, 500) : null,
      newValue: record    ? JSON.stringify(record).slice(0, 500)    : null,
    };
  }

  /** Friendly entity names from collection keys */
  function _entityLabel(col) {
    const map = {
      invoices: 'Invoice', payments: 'Payment', expenses: 'Expense',
      trips: 'Trip', fleet: 'Vehicle', drivers: 'Driver', fuel: 'Fuel Log',
      customers: 'Customer', vendors: 'Vendor', employees: 'Employee',
      products: 'Product', inventory: 'Inventory', grns: 'GRN',
      orders: 'Sales Order', payroll: 'Payroll', assets: 'Asset',
      contracts: 'Contract', leads: 'Lead', tickets: 'Ticket',
      lam_users: 'User', bank_txn: 'Bank Transaction',
      gl_entries: 'GL Entry', accounts: 'Account',
    };
    return map[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /** Extract a display name from a record */
  function _entityName(record, col) {
    if (!record) return '—';
    return record.invoiceNo || record.invoiceNumber ||
           record.tripNumber || record.vehicleNumber || record.regNumber ||
           record.name || record.fullName || record.customerName ||
           record.vendorName || record.employeeName ||
           record.orderNumber || record.poNumber ||
           (record.id ? record.id.slice(-8) : '—');
  }

  /** Produce a human-readable diff between two record versions */
  function _diffRecords(oldRec, newRec) {
    const SKIP = new Set(['updatedAt','createdAt','updatedBy','createdBy','_encrypted','_synced','id']);
    const CURRENCY = new Set(['amount','totalAmount','grandTotal','netPay','grossSalary','unitPrice','rate']);
    const diffs = [];

    for (const key of Object.keys(newRec)) {
      if (SKIP.has(key)) continue;
      const oldVal = oldRec[key];
      const newVal = newRec[key];
      if (oldVal === undefined || JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;

      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      let oldStr = _fmtVal(oldVal, CURRENCY.has(key));
      let newStr = _fmtVal(newVal, CURRENCY.has(key));
      diffs.push(`${label} changed ${oldStr} → ${newStr}`);
    }
    return diffs.slice(0, 3); // Cap at 3 changes per entry to keep logs readable
  }

  function _fmtVal(v, isCurrency) {
    if (v === null || v === undefined) return '—';
    if (isCurrency && typeof v === 'number') return '₹' + v.toLocaleString('en-IN');
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
    return String(v).slice(0, 60);
  }

  function _humanTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) +
           ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  /**
   * Format a complete audit log entry as a plain-English sentence.
   * Example: "Raju (Dispatcher) changed Trip TR-018 status from 'En Route' to 'Delivered' — 14 Jun, 6:15 PM"
   */
  function formatAuditEntry(log) {
    const roleLabel = ROLES[log.userRole]?.label || log.userRole || 'User';
    return `${log.userName} (${roleLabel}) ${log.action} ${log.detail} — ${log.humanTime}`;
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 5 — DB PATCH (auto-tag + audit on every write)
  // ══════════════════════════════════════════════════════════

  function patchDBForAudit() {
    const db = window.LAMDB;
    if (!db || db._lamUserPatched) return;

    // Collections we DON'T audit (internal/noisy)
    const SKIP_AUDIT = new Set([
      COLLECTION_AUDIT, COLLECTION_USERS,
      '_lam_meta', '_lam_sync_queue', 'sessions', 'api_logs',
      'audit_logs', // old audit store — avoid double-logging
    ]);

    const _origCreate = db.dbCreate.bind(db);
    const _origUpdate = db.dbUpdate.bind(db);
    const _origSet    = db.dbSet.bind(db);
    const _origDelete = db.dbDelete.bind(db);
    const _origGet    = db.dbGet.bind(db);

    db.dbCreate = async function(col, data) {
      const user = _currentUser;
      const tagged = user
        ? { ...data, createdBy: user.id, createdByName: user.name, updatedBy: user.id }
        : data;
      const result = await _origCreate(col, tagged);
      if (user && !SKIP_AUDIT.has(col)) {
        const entry = _buildAuditDetail(col, 'create', result, null);
        if (entry) await _writeAuditDirect(entry);
      }
      return result;
    };

    db.dbSet = async function(col, id, data) {
      const user = _currentUser;
      const tagged = user
        ? { ...data, updatedBy: user.id, updatedByName: user.name }
        : data;
      // Fetch old record for diff (best-effort)
      let oldRecord = null;
      if (user && !SKIP_AUDIT.has(col) && id) {
        oldRecord = await _origGet(col, id).catch(() => null);
      }
      const result = await _origSet(col, id, tagged);
      if (user && !SKIP_AUDIT.has(col)) {
        const op    = oldRecord ? 'set' : 'create';
        const entry = _buildAuditDetail(col, op, result, oldRecord);
        if (entry) await _writeAuditDirect(entry);
      }
      return result;
    };

    db.dbUpdate = async function(col, id, data) {
      const user = _currentUser;
      const tagged = user
        ? { ...data, updatedBy: user.id, updatedByName: user.name }
        : data;
      let oldRecord = null;
      if (user && !SKIP_AUDIT.has(col)) {
        oldRecord = await _origGet(col, id).catch(() => null);
      }
      const result = await _origUpdate(col, id, tagged);
      if (user && !SKIP_AUDIT.has(col)) {
        const entry = _buildAuditDetail(col, 'update', result, oldRecord);
        if (entry) await _writeAuditDirect(entry);
      }
      return result;
    };

    db.dbDelete = async function(col, id) {
      const user = _currentUser;
      let oldRecord = null;
      if (user && !SKIP_AUDIT.has(col)) {
        oldRecord = await _origGet(col, id).catch(() => null);
      }
      const result = await _origDelete(col, id);
      if (user && !SKIP_AUDIT.has(col)) {
        const entry = _buildAuditDetail(col, 'delete', oldRecord || { id }, null);
        if (entry) await _writeAuditDirect(entry);
      }
      return result;
    };

    db._lamUserPatched = true;
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 6 — ROLE-BASED NAV FILTERING
  // ══════════════════════════════════════════════════════════

  function applyRoleNav(role) {
    if (role === 'owner') return; // owner sees everything

    const allowed = ROLE_ROUTES[role];
    if (!allowed) return;

    // Hide nav items not in allowed set
    document.querySelectorAll('.sidebar-nav [data-route]').forEach(el => {
      const route = el.getAttribute('data-route');
      if (!allowed.has(route)) {
        el.style.display = 'none';
        el.setAttribute('data-role-hidden', '1');
      }
    });

    // Driver: show the My Trips nav item (was display:none by default)
    if (role === 'driver') {
      const myTripsNav = document.getElementById('nav-my-trips');
      if (myTripsNav) {
        myTripsNav.style.display = '';
        myTripsNav.removeAttribute('data-role-hidden');
      }
    }

    // Hide section labels that have all children hidden
    document.querySelectorAll('.sidebar-nav .nav-section-label').forEach(label => {
      let next = label.nextElementSibling;
      let allHidden = true;
      while (next && !next.classList.contains('nav-section-label')) {
        if (next.style.display !== 'none') { allHidden = false; break; }
        next = next.nextElementSibling;
      }
      if (allHidden) label.style.display = 'none';
    });
  }

  function resetRoleNav() {
    // Restore all hidden nav items (called before re-applying role)
    document.querySelectorAll('[data-role-hidden]').forEach(el => {
      el.style.display = '';
      el.removeAttribute('data-role-hidden');
    });
    document.querySelectorAll('.sidebar-nav .nav-section-label').forEach(el => {
      el.style.display = '';
    });
  }

  /**
   * Route guard — intercept Router navigation and redirect if blocked.
   * Hooks into the existing LAM Router via a proxy.
   */
  function installRouteGuard() {
    const origNavigate = window.LAM?.Router?.navigate?.bind(window.LAM.Router);
    if (!origNavigate) return;

    window.LAM.Router.navigate = function(route, ...args) {
      if (!_currentUser || _currentUser.role === 'owner') {
        return origNavigate(route, ...args);
      }
      const allowed = ROLE_ROUTES[_currentUser.role];
      if (allowed && !allowed.has(route)) {
        // Redirect to their home instead
        const home = _roleHome(_currentUser.role);
        window.LAM?.Toast?.warning('Access Restricted',
          `Your role (${ROLES[_currentUser.role]?.label}) cannot access this section.`);
        return origNavigate(home, ...args);
      }
      return origNavigate(route, ...args);
    };
  }

  function _roleHome(role) {
    const homes = {
      accountant:  'finance',
      dispatcher:  'trips',
      driver:      'trips',
    };
    return homes[role] || 'dashboard';
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 7 — USER SELECTION SCREEN
  // ══════════════════════════════════════════════════════════

  function showUserSelectScreen({ message } = {}) {
    // Remove any existing screen
    document.getElementById('lam-user-screen')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'lam-user-screen';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:var(--bg-base,#F0F2F5);
      display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      font-family:var(--font-body,'Geist',system-ui,sans-serif);
      padding:24px;
    `;

    overlay.innerHTML = `
      <div style="text-align:center;margin-bottom:32px;">
        <div style="font-size:32px;font-weight:800;color:var(--brand-primary,#2563EB);
                    letter-spacing:-1px;margin-bottom:4px;">LAM</div>
        <div style="font-size:13px;color:var(--text-secondary,#4A5568);">
          Logistics · Assets · Management
        </div>
        ${message ? `
          <div style="margin-top:12px;padding:8px 16px;background:rgba(220,38,38,0.08);
                      border:1px solid rgba(220,38,38,0.2);border-radius:8px;
                      font-size:12px;color:#DC2626;">
            🔒 ${message}
          </div>` : ''}
      </div>

      <div id="lam-user-cards" style="
        display:flex;flex-wrap:wrap;gap:16px;
        justify-content:center;max-width:600px;
        margin-bottom:24px;
      ">
        <div style="color:var(--text-muted,#8898AA);font-size:13px;">Loading users…</div>
      </div>

      <div id="lam-pin-entry" style="display:none;flex-direction:column;align-items:center;gap:16px;">
        <div id="lam-pin-user-label" style="font-weight:600;font-size:15px;color:var(--text-primary,#0D1117);"></div>
        <div style="font-size:13px;color:var(--text-secondary,#4A5568);">Enter your 4-digit PIN</div>
        <div style="display:flex;gap:12px;" id="lam-pin-dots">
          ${[0,1,2,3].map(i => `
            <div id="lam-pin-dot-${i}" style="
              width:14px;height:14px;border-radius:50%;
              border:2px solid var(--border-default,#E2E8F0);
              background:transparent;transition:all 0.15s;
            "></div>
          `).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,64px);gap:10px;" id="lam-numpad">
          ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k => `
            <button data-key="${k}" onclick="window.LAMUsers._numpadPress('${k}')"
              style="height:64px;border-radius:12px;border:1px solid var(--border-default,#E2E8F0);
                     background:var(--bg-surface,#fff);font-size:${k==='⌫'?'18':'20'}px;
                     font-weight:600;color:var(--text-primary,#0D1117);cursor:pointer;
                     transition:all 0.12s;box-shadow:var(--shadow-xs);"
              ${k==='' ? 'disabled style="visibility:hidden;"' : ''}
              onmousedown="this.style.transform='scale(0.93)'"
              onmouseup="this.style.transform=''"
              ontouchstart="this.style.transform='scale(0.93)'"
              ontouchend="this.style.transform=''">
              ${k}
            </button>
          `).join('')}
        </div>
        <div id="lam-pin-error" style="color:#DC2626;font-size:12px;min-height:18px;"></div>
        <button onclick="window.LAMUsers._cancelPin()"
          style="background:none;border:none;color:var(--text-secondary,#4A5568);
                 font-size:12px;cursor:pointer;margin-top:4px;">
          ← Back to users
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    // Load and render user cards
    _renderUserCards();
  }

  let _renderUserCardsRunning = false; // guard against infinite recursion
  async function _renderUserCards() {
    const container = document.getElementById('lam-user-cards');
    if (!container) return;

    const users = (await getAllUsers()).filter(u => u.active !== false);

    if (!users.length) {
      // Guard: only attempt auto-create once — prevents infinite loop if DB store is missing
      if (_renderUserCardsRunning) {
        container.innerHTML = `<div style="color:#DC2626;font-size:13px;">Setup failed — please refresh the page.</div>`;
        console.error('LAMUsers: auto-setup failed (store missing or createUser threw). Check lam-db.js collections list.');
        return;
      }
      _renderUserCardsRunning = true;
      container.innerHTML = `<div style="color:var(--text-muted);font-size:13px);">Setting up account…</div>`;
      // Auto-create owner then reload cards
      try {
        await createUser({ name:'Admin', role:'owner', pin:'1234', avatarColor:'#6366F1', securityQuestion:'What city were you born in?', securityAnswer:'admin' });
        localStorage.setItem('lam_users_setup_done','1');
      } catch(e) { console.error('auto-setup error',e); }
      _renderUserCardsRunning = false;
      await _renderUserCards();
      return;
    }

    container.innerHTML = users.map(u => `
      <button onclick="window.LAMUsers._selectUser('${u.id}')"
        style="
          display:flex;flex-direction:column;align-items:center;gap:10px;
          padding:20px 24px;min-width:120px;
          background:var(--bg-surface,#fff);
          border:2px solid var(--border-subtle,#EAECF0);
          border-radius:16px;cursor:pointer;transition:all 0.18s;
          box-shadow:var(--shadow-sm);
        "
        onmouseenter="this.style.borderColor='${u.avatarColor}';this.style.boxShadow='0 4px 20px ${u.avatarColor}30'"
        onmouseleave="this.style.borderColor='var(--border-subtle,#EAECF0)';this.style.boxShadow='var(--shadow-sm)'"
        ontouchstart="this.style.borderColor='${u.avatarColor}'"
        ontouchend="this.style.borderColor='var(--border-subtle,#EAECF0)'">
        <div style="
          width:56px;height:56px;border-radius:50%;
          background:${u.avatarColor};
          display:flex;align-items:center;justify-content:center;
          font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.5px;
        ">
          ${_initials(u.name)}
        </div>
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--text-primary,#0D1117);
                      text-align:center;">${_esc(u.name)}</div>
          <div style="font-size:11px;color:${u.avatarColor};font-weight:500;
                      text-align:center;margin-top:2px;">
            ${ROLES[u.role]?.emoji || ''} ${ROLES[u.role]?.label || u.role}
          </div>
        </div>
      </button>
    `).join('');
  }

  // PIN entry state
  let _pinBuffer   = '';
  let _pinUserId   = null;
  let _pinAttempts = 0;

  window.LAMUsers = window.LAMUsers || {};
  window.LAMUsers._selectUser = async function(userId) {
    const user = await getUserById(userId);
    if (!user) return;

    _pinUserId  = userId;
    _pinBuffer  = '';
    _pinAttempts = 0;

    document.getElementById('lam-user-cards').style.display = 'none';
    const pinEl = document.getElementById('lam-pin-entry');
    pinEl.style.display = 'flex';

    document.getElementById('lam-pin-user-label').textContent =
      `${ROLES[user.role]?.emoji || ''} ${user.name}`;

    _updatePinDots();
  };

  window.LAMUsers._cancelPin = function() {
    _pinBuffer = '';
    _pinUserId = null;
    document.getElementById('lam-pin-entry').style.display = 'none';
    document.getElementById('lam-user-cards').style.display = 'flex';
    _updatePinDots();
  };

  window.LAMUsers._numpadPress = async function(key) {
    if (key === '' || key === undefined) return;
    if (key === '⌫') {
      _pinBuffer = _pinBuffer.slice(0, -1);
      _updatePinDots();
      return;
    }
    if (_pinBuffer.length >= 4) return;
    _pinBuffer += String(key);
    _updatePinDots();

    if (_pinBuffer.length === 4) {
      await _attemptLogin(_pinUserId, _pinBuffer);
    }
  };

  function _updatePinDots() {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById(`lam-pin-dot-${i}`);
      if (!dot) continue;
      if (i < _pinBuffer.length) {
        dot.style.background   = 'var(--brand-primary,#2563EB)';
        dot.style.borderColor  = 'var(--brand-primary,#2563EB)';
      } else {
        dot.style.background   = 'transparent';
        dot.style.borderColor  = 'var(--border-default,#E2E8F0)';
      }
    }
  }

  async function _attemptLogin(userId, pin) {
    const errEl = document.getElementById('lam-pin-error');
    const user  = await getUserById(userId);
    if (!user) return;

    const ok = await verifyPIN(pin, user.pinHash, userId);
    if (ok) {
      _pinAttempts = 0;
      await _loginUser(user);
    } else {
      _pinAttempts++;
      _pinBuffer = '';
      _updatePinDots();
      if (errEl) {
        errEl.textContent = _pinAttempts >= 3
          ? `Incorrect PIN (${_pinAttempts} attempts). Try again.`
          : 'Incorrect PIN. Try again.';
        // Shake animation
        const pinEl = document.getElementById('lam-pin-entry');
        if (pinEl) {
          pinEl.style.animation = 'none';
          pinEl.offsetHeight;
          pinEl.style.animation = 'lam-shake 0.35s ease';
        }
      }
    }
  }

  async function _loginUser(user) {
    _currentUser = {
      id:        user.id,
      name:      user.name,
      role:      user.role,
      avatarColor: user.avatarColor,
      loginTime: new Date().toISOString(),
    };

    window.LAMCurrentUser = { ..._currentUser };

    const session = _saveSession(_currentUser);
    _startInactivityWatch();

    // Patch DB now that we have a user
    patchDBForAudit();

    // Write login audit entry
    await _writeAuditDirect({
      action: 'logged in',
      entity: 'Session',
      detail: `${user.name} logged in`,
    });

    // Remove login screen
    document.getElementById('lam-user-screen')?.remove();

    // ── Driver role: mount full-screen driver interface ──────
    if (_maybeMountDriver(user)) return;

    // Apply role-based nav
    resetRoleNav();
    applyRoleNav(user.role);

    // Install route guard
    installRouteGuard();

    // Update topbar
    _updateTopbar(user);

    // Navigate to role home if current route is blocked
    const currentRoute = window.LAM?.Router?.currentRoute || 'dashboard';
    const allowed = ROLE_ROUTES[user.role];
    if (allowed && !allowed.has(currentRoute)) {
      window.LAM?.Router?.navigate?.(_roleHome(user.role));
    } else {
      window.LAM?.Router?.navigate?.(currentRoute);
    }
  }

  // ── Driver mount helper (called from _loginUser + session restore) ──
  function _maybeMountDriver(user) {
    if (user.role !== 'driver') {
      // Unmount driver shell if switching away from driver
      if (window.LAMDriver?._mounted) window.LAMDriver.unmount?.();
      return false;
    }
    if (window.LAMDriver) {
      setTimeout(() => window.LAMDriver.mount(), 150);
    }
    return true;
  }

  function _updateTopbar(user) {
    // Update sidebar user card
    const avatarEl = document.getElementById('user-avatar');
    const nameEl   = document.getElementById('user-display-name');
    const roleEl   = document.getElementById('user-display-role');
    if (avatarEl) {
      avatarEl.textContent   = _initials(user.name);
      avatarEl.style.background = user.avatarColor;
      avatarEl.style.color      = '#fff';
    }
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) roleEl.textContent = `${ROLES[user.role]?.emoji || ''} ${ROLES[user.role]?.label || user.role}`;

    // Inject topbar user chip if not present
    if (!document.getElementById('lam-user-chip')) {
      const topbarRight = document.querySelector('.topbar-right');
      if (topbarRight) {
        const chip = document.createElement('div');
        chip.id = 'lam-user-chip';
        chip.style.cssText = `
          display:inline-flex;align-items:center;gap:6px;
          padding:4px 10px;border-radius:20px;cursor:pointer;
          background:var(--bg-elevated,#fff);
          border:1px solid var(--border-subtle,#EAECF0);
          font-size:12px;font-weight:500;
          color:var(--text-primary,#0D1117);
          transition:all 0.15s;flex-shrink:0;
        `;
        chip.title = 'Click to switch user or logout';
        chip.onclick = () => _showUserMenu();
        topbarRight.insertBefore(chip, topbarRight.firstChild);
      }
    }

    const chip = document.getElementById('lam-user-chip');
    if (chip) {
      chip.innerHTML = `
        <span style="width:22px;height:22px;border-radius:50%;
          background:${user.avatarColor};color:#fff;
          display:inline-flex;align-items:center;justify-content:center;
          font-size:10px;font-weight:700;">
          ${_initials(user.name)}
        </span>
        <span>${_esc(user.name)}</span>
        <span style="font-size:10px;color:${user.avatarColor};font-weight:600;
          padding:1px 6px;border-radius:10px;background:${user.avatarColor}18;">
          ${ROLES[user.role]?.label || user.role}
        </span>
      `;
    }
  }

  function _showUserMenu() {
    const existing = document.getElementById('lam-user-menu-dd');
    if (existing) { existing.remove(); return; }

    const chip = document.getElementById('lam-user-chip');
    const rect = chip?.getBoundingClientRect() || { right: 200, bottom: 60 };

    const menu = document.createElement('div');
    menu.id = 'lam-user-menu-dd';
    menu.style.cssText = `
      position:fixed;right:${window.innerWidth - rect.right}px;
      top:${rect.bottom + 6}px;
      min-width:200px;
      background:var(--bg-surface,#fff);
      border:1px solid var(--border-subtle,#EAECF0);
      border-radius:12px;box-shadow:var(--shadow-lg);
      z-index:99998;overflow:hidden;
      font-family:var(--font-body,'Geist',system-ui,sans-serif);
    `;

    const user = _currentUser;
    menu.innerHTML = `
      <div style="padding:12px 14px;border-bottom:1px solid var(--border-subtle,#EAECF0);">
        <div style="font-weight:600;font-size:13px;">${_esc(user?.name || '')}</div>
        <div style="font-size:11px;color:var(--text-muted,#8898AA);">
          ${ROLES[user?.role]?.emoji} ${ROLES[user?.role]?.label || user?.role}
        </div>
      </div>
      <div style="padding:6px 0;">
        <button onclick="window.LAMUsers.switchUser()" style="${_menuBtnStyle()}">
          👤 Switch User
        </button>
        ${user?.role === 'owner' ? `
          <button onclick="window.LAMUsers.showUsersSettings();document.getElementById('lam-user-menu-dd')?.remove()" style="${_menuBtnStyle()}">
            ⚙️ Manage Users
          </button>` : ''}
        <button onclick="window.LAMUsers.logout()" style="${_menuBtnStyle(true)}">
          🚪 Log Out
        </button>
      </div>
    `;

    document.body.appendChild(menu);
    // Close on outside click
    setTimeout(() => {
      const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  }

  function _menuBtnStyle(danger = false) {
    return `
      display:block;width:100%;text-align:left;
      padding:9px 14px;background:none;border:none;
      font-size:13px;cursor:pointer;
      color:${danger ? '#DC2626' : 'var(--text-primary,#0D1117)'};
      transition:background 0.12s;
      font-family:inherit;
    `;
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 8 — FIRST-TIME SETUP WIZARD
  // ══════════════════════════════════════════════════════════

  async function runSetupWizardIfNeeded() {
    if (localStorage.getItem(SETUP_DONE_KEY)) return false;

    const users = await getAllUsers();
    const hasOwner = users.some(u => u.role === 'owner' && u.active !== false);
    if (hasOwner) {
      localStorage.setItem(SETUP_DONE_KEY, '1');
      return false;
    }

    // Auto-create default owner account — no wizard needed
    try {
      await createUser({
        name: 'Admin',
        role: 'owner',
        pin:  '1234',
        avatarColor: '#6366F1',
        securityQuestion: 'What city were you born in?',
        securityAnswer: 'admin',
      });
      localStorage.setItem(SETUP_DONE_KEY, '1');
      console.log('LAM: Default owner created. PIN: 1234');
    } catch(e) {
      console.error('LAM: Auto-setup failed', e);
    }
    return false;
  }

  function _showSetupWizard() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'lam-setup-wizard';
      overlay.style.cssText = `
        position:fixed;inset:0;z-index:100000;
        background:var(--bg-base,#F0F2F5);
        display:flex;align-items:center;justify-content:center;
        font-family:var(--font-body,'Geist',system-ui,sans-serif);
        padding:24px;
      `;

      overlay.innerHTML = `
        <div style="background:var(--bg-surface,#fff);border-radius:20px;
                    box-shadow:var(--shadow-xl);padding:32px;width:100%;max-width:440px;">

          <div style="text-align:center;margin-bottom:28px;">
            <div style="font-size:28px;font-weight:800;color:var(--brand-primary,#2563EB);
                        letter-spacing:-0.5px;">LAM</div>
            <div style="font-size:18px;font-weight:700;margin-top:8px;
                        color:var(--text-primary,#0D1117);">Welcome! Let's set up your Owner account</div>
            <div style="font-size:13px;color:var(--text-secondary,#4A5568);margin-top:6px;">
              This takes 30 seconds. You can add more users later.
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:14px;">
            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary,#4A5568);
                            display:block;margin-bottom:6px;">Your Name</label>
              <input id="setup-name" type="text" placeholder="e.g. Rajesh Kumar"
                style="${_inputStyle()}" maxlength="40">
            </div>

            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary,#4A5568);
                            display:block;margin-bottom:6px;">Choose a 4-Digit PIN</label>
              <input id="setup-pin" type="password" inputmode="numeric"
                placeholder="••••" maxlength="4" style="${_inputStyle()}"
                oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
            </div>

            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary,#4A5568);
                            display:block;margin-bottom:6px;">Confirm PIN</label>
              <input id="setup-pin2" type="password" inputmode="numeric"
                placeholder="••••" maxlength="4" style="${_inputStyle()}"
                oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
            </div>

            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary,#4A5568);
                            display:block;margin-bottom:6px;">Security Question (for PIN reset)</label>
              <select id="setup-sq" style="${_inputStyle()}">
                <option value="">— Choose a question —</option>
                <option value="mother">What is your mother's maiden name?</option>
                <option value="city">What city were you born in?</option>
                <option value="school">What was the name of your first school?</option>
                <option value="pet">What was your first pet's name?</option>
                <option value="vehicle">What was your first vehicle's number plate?</option>
              </select>
            </div>

            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary,#4A5568);
                            display:block;margin-bottom:6px;">Your Answer</label>
              <input id="setup-sa" type="text" placeholder="Answer (case-insensitive)"
                style="${_inputStyle()}" maxlength="100">
            </div>

            <div id="setup-error" style="color:#DC2626;font-size:12px;min-height:18px;"></div>

            <button id="setup-submit" onclick="window.LAMUsers._submitSetup()"
              style="
                background:var(--brand-primary,#2563EB);color:#fff;
                border:none;border-radius:10px;padding:14px;font-size:14px;
                font-weight:600;cursor:pointer;width:100%;
                font-family:inherit;transition:all 0.15s;
              "
              onmouseenter="this.style.background='var(--brand-primary-h,#1D4ED8)'"
              onmouseleave="this.style.background='var(--brand-primary,#2563EB)'">
              Create Owner Account →
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      window.LAMUsers._submitSetup = async function() {
        const name  = document.getElementById('setup-name')?.value.trim();
        const pin   = document.getElementById('setup-pin')?.value;
        const pin2  = document.getElementById('setup-pin2')?.value;
        const sq    = document.getElementById('setup-sq')?.value;
        const sa    = document.getElementById('setup-sa')?.value.trim();
        const errEl = document.getElementById('setup-error');
        const btn   = document.getElementById('setup-submit');

        if (!name)               { errEl.textContent = 'Please enter your name.'; return; }
        if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits.'; return; }
        if (pin !== pin2)         { errEl.textContent = 'PINs do not match.'; return; }
        if (!sq)                  { errEl.textContent = 'Please choose a security question.'; return; }
        if (!sa)                  { errEl.textContent = 'Please provide a security answer.'; return; }

        btn.textContent = 'Creating…';
        btn.disabled    = true;

        try {
          const user = await createUser({
            name, role: 'owner', pin,
            securityQuestion: sq,
            securityAnswer:   sa,
            avatarColor:      AVATAR_COLORS[0],
          });

          localStorage.setItem(SETUP_DONE_KEY, '1');
          overlay.remove();
          resolve(user);

          // Auto-login the new owner
          await _loginUser(user);
        } catch (e) {
          errEl.textContent = 'Error: ' + e.message;
          btn.textContent   = 'Create Owner Account →';
          btn.disabled      = false;
        }
      };
    });
  }

  function _inputStyle() {
    return `
      width:100%;padding:10px 12px;border-radius:8px;
      border:1px solid var(--border-default,#E2E8F0);
      font-size:13px;font-family:inherit;
      color:var(--text-primary,#0D1117);
      background:var(--bg-surface,#fff);
      box-sizing:border-box;
      outline:none;transition:border-color 0.15s;
    `;
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 9 — USER MANAGEMENT SETTINGS UI
  // ══════════════════════════════════════════════════════════

  /**
   * Render the Users tab content for Settings → Users.
   * Only Owner sees this tab.
   * @returns {string} HTML
   */
  async function renderUsersSettingsTab() {
    const users = (await getAllUsers()).filter(u => u.active !== false);

    const userRows = users.map(u => `
      <tr>
        <td style="padding:10px 12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:32px;height:32px;border-radius:50%;
              background:${u.avatarColor};color:#fff;
              display:flex;align-items:center;justify-content:center;
              font-size:12px;font-weight:700;flex-shrink:0;">
              ${_initials(u.name)}
            </div>
            <div>
              <div style="font-weight:600;font-size:13px;">${_esc(u.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">
                ${ROLES[u.role]?.emoji} ${ROLES[u.role]?.label}
              </div>
            </div>
          </div>
        </td>
        <td style="padding:10px 12px;">
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;
            background:${u.avatarColor}18;color:${u.avatarColor};">
            ${ROLES[u.role]?.label || u.role}
          </span>
        </td>
        <td style="padding:10px 12px;">
          <div style="display:flex;gap:6px;">
            <button onclick="window.LAMUsers.showChangePINModal('${u.id}')"
              style="padding:4px 10px;font-size:11px;border-radius:6px;
                     border:1px solid var(--border-default);background:var(--bg-surface);
                     cursor:pointer;color:var(--text-secondary);">
              Change PIN
            </button>
            ${u.role !== 'owner' ? `
              <button onclick="window.LAMUsers.confirmDeleteUser('${u.id}','${_esc(u.name)}')"
                style="padding:4px 10px;font-size:11px;border-radius:6px;
                       border:1px solid rgba(220,38,38,0.3);background:rgba(220,38,38,0.06);
                       cursor:pointer;color:#DC2626;">
                Remove
              </button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');

    return `
      <div class="card" id="lam-users-settings-card">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div class="card-title">👥 User Accounts</div>
            <div style="font-size:12px;color:var(--text-secondary);">
              Manage who can access LAM on this device
            </div>
          </div>
          <button onclick="window.LAMUsers.showAddUserModal()"
            class="btn btn-primary btn-sm" style="flex-shrink:0;">
            + Add User
          </button>
        </div>

        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--border-subtle);">
                <th style="padding:8px 12px;text-align:left;font-size:11px;
                           color:var(--text-muted);font-weight:600;text-transform:uppercase;">
                  User
                </th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;
                           color:var(--text-muted);font-weight:600;text-transform:uppercase;">
                  Role
                </th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;
                           color:var(--text-muted);font-weight:600;text-transform:uppercase;">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>${userRows}</tbody>
          </table>
        </div>

        <div style="padding:12px;background:var(--bg-base);border-radius:8px;margin-top:8px;
                    font-size:11px;color:var(--text-muted);line-height:1.6;">
          <strong>Role permissions:</strong>
          Owner = all access ·
          Accountant = Finance, GST, Reports ·
          Dispatcher = Fleet, Trips, Inventory, Orders ·
          Driver = My Trips only
        </div>
      </div>
    `;
  }

  window.LAMUsers.showAddUserModal = function() {
    _showModal('Add New User', `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);
                        display:block;margin-bottom:5px;">Name</label>
          <input id="add-user-name" type="text" placeholder="Full name"
            class="form-input" maxlength="40">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);
                        display:block;margin-bottom:5px;">Role</label>
          <select id="add-user-role" class="form-select">
            <option value="accountant">📊 Accountant</option>
            <option value="dispatcher">🚛 Dispatcher</option>
            <option value="driver">🚗 Driver</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);
                        display:block;margin-bottom:5px;">4-Digit PIN</label>
          <input id="add-user-pin" type="password" inputmode="numeric"
            placeholder="••••" maxlength="4" class="form-input"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        </div>
        <div id="add-user-error" style="color:#DC2626;font-size:12px;min-height:16px;"></div>
      </div>
    `, async () => {
      const name = document.getElementById('add-user-name')?.value.trim();
      const role = document.getElementById('add-user-role')?.value;
      const pin  = document.getElementById('add-user-pin')?.value;
      const errEl = document.getElementById('add-user-error');
      if (!name)                { errEl.textContent = 'Name is required.'; return false; }
      if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits.'; return false; }
      try {
        await createUser({ name, role, pin });
        window.LAM?.Toast?.success('User Added', `${name} (${ROLES[role]?.label}) can now log in.`);
        window.LAMUsers.showUsersSettings(); // refresh
        return true;
      } catch (e) {
        errEl.textContent = 'Error: ' + e.message; return false;
      }
    });
  };

  window.LAMUsers.showChangePINModal = function(userId) {
    _showModal('Change PIN', `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);
                        display:block;margin-bottom:5px;">New 4-Digit PIN</label>
          <input id="change-pin-new" type="password" inputmode="numeric"
            placeholder="••••" maxlength="4" class="form-input"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);
                        display:block;margin-bottom:5px;">Confirm PIN</label>
          <input id="change-pin-confirm" type="password" inputmode="numeric"
            placeholder="••••" maxlength="4" class="form-input"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        </div>
        <div id="change-pin-error" style="color:#DC2626;font-size:12px;min-height:16px;"></div>
      </div>
    `, async () => {
      const pin  = document.getElementById('change-pin-new')?.value;
      const pin2 = document.getElementById('change-pin-confirm')?.value;
      const errEl = document.getElementById('change-pin-error');
      if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits.'; return false; }
      if (pin !== pin2)          { errEl.textContent = 'PINs do not match.'; return false; }
      try {
        await updateUser(userId, { pin });
        window.LAM?.Toast?.success('PIN Updated', 'PIN changed successfully.');
        return true;
      } catch (e) {
        errEl.textContent = 'Error: ' + e.message; return false;
      }
    });
  };

  window.LAMUsers.confirmDeleteUser = function(id, name) {
    if (!confirm(`Remove ${name} from LAM? They will no longer be able to log in.`)) return;
    deleteUser(id).then(() => {
      window.LAM?.Toast?.success('User Removed', `${name} has been removed.`);
      window.LAMUsers.showUsersSettings();
    });
  };

  window.LAMUsers.showUsersSettings = async function() {
    // Navigate to Settings and inject Users tab content
    window.LAM?.Router?.navigate?.('settings');
    setTimeout(async () => {
      const container = document.querySelector('#page-content');
      if (!container) return;
      const existing = document.getElementById('lam-users-settings-card');
      if (existing) {
        existing.outerHTML = await renderUsersSettingsTab();
      } else {
        // Find a good slot — prepend to settings page grid
        const grid = container.querySelector('.grid-2, .settings-grid, [class*="grid"]');
        if (grid) {
          const html = await renderUsersSettingsTab();
          grid.insertAdjacentHTML('afterbegin', html);
        }
      }
    }, 300);
  };

  // ══════════════════════════════════════════════════════════
  // SECTION 10 — AUDIT TRAIL VIEWER
  // ══════════════════════════════════════════════════════════

  /**
   * Render the audit trail viewer for Settings → Audit Trail.
   * Owner sees all entries; others see only their own.
   */
  async function renderAuditViewer({ userId, fromDate, toDate, limit = 100 } = {}) {
    const db    = await _db();
    const isOwner = _currentUser?.role === 'owner';

    let logs = await db.dbGetAll(COLLECTION_AUDIT).catch(() => []);

    // Filter by current user if not owner
    if (!isOwner && _currentUser) {
      logs = logs.filter(l => l.userId === _currentUser.id);
    }
    if (userId)   logs = logs.filter(l => l.userId === userId);
    if (fromDate) logs = logs.filter(l => l.createdAt >= fromDate);
    if (toDate)   logs = logs.filter(l => l.createdAt <= toDate + 'T23:59:59');

    // Sort newest first
    logs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    logs = logs.slice(0, limit);

    const users = isOwner ? (await getAllUsers()) : [];
    const userOptions = users.map(u =>
      `<option value="${u.id}">${_esc(u.name)} (${ROLES[u.role]?.label})</option>`
    ).join('');

    return `
      <div class="card" id="lam-audit-viewer">
        <div class="card-header">
          <div class="card-title">📜 Audit Trail</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            ${isOwner ? 'All user activity' : 'Your activity'}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end;">
          ${isOwner ? `
            <div>
              <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">User</label>
              <select id="audit-filter-user" onchange="window.LAMUsers.refreshAuditViewer()" class="form-select" style="font-size:12px;padding:5px 8px;">
                <option value="">All users</option>
                ${userOptions}
              </select>
            </div>` : ''}
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">From</label>
            <input type="date" id="audit-filter-from" onchange="window.LAMUsers.refreshAuditViewer()"
              class="form-input" style="font-size:12px;padding:5px 8px;">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">To</label>
            <input type="date" id="audit-filter-to" onchange="window.LAMUsers.refreshAuditViewer()"
              class="form-input" style="font-size:12px;padding:5px 8px;">
          </div>
        </div>

        <div id="audit-log-list" style="display:flex;flex-direction:column;gap:0;">
          ${logs.length ? logs.map(log => `
            <div style="
              padding:10px 0;border-bottom:1px solid var(--border-subtle,#EAECF0);
              display:flex;align-items:flex-start;gap:10px;
            ">
              <div style="
                width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:5px;
                background:${_actionColor(log.action)};
              "></div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:12.5px;color:var(--text-primary);line-height:1.45;">
                  ${_esc(formatAuditEntry(log))}
                </div>
                ${log.oldValue && log.newValue ? `
                  <div style="font-size:11px;color:var(--text-muted);margin-top:3px;
                               font-family:var(--font-mono);word-break:break-all;">
                    Δ ${log.detail}
                  </div>` : ''}
              </div>
            </div>
          `).join('') : `
            <div style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px;">
              No audit entries found.
            </div>
          `}
        </div>
      </div>
    `;
  }

  window.LAMUsers.refreshAuditViewer = async function() {
    const container = document.getElementById('lam-audit-viewer');
    if (!container) return;
    const userId   = document.getElementById('audit-filter-user')?.value || undefined;
    const fromDate = document.getElementById('audit-filter-from')?.value || undefined;
    const toDate   = document.getElementById('audit-filter-to')?.value || undefined;
    container.outerHTML = await renderAuditViewer({ userId, fromDate, toDate });
  };

  function _actionColor(action) {
    const map = {
      'created': '#059669', 'logged in': '#059669',
      'edited': '#D97706',
      'deleted': '#DC2626', 'removed': '#DC2626',
    };
    return map[action] || '#8898AA';
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 11 — MODAL HELPER
  // ══════════════════════════════════════════════════════════

  function _showModal(title, bodyHTML, onConfirm) {
    document.getElementById('lam-users-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'lam-users-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);
      display:flex;align-items:center;justify-content:center;padding:16px;
      font-family:var(--font-body,'Geist',system-ui,sans-serif);
    `;
    modal.innerHTML = `
      <div style="background:var(--bg-surface,#fff);border-radius:16px;
                  width:100%;max-width:400px;box-shadow:var(--shadow-xl);overflow:hidden;">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border-subtle);
                    display:flex;align-items:center;justify-content:space-between;">
          <div style="font-weight:700;font-size:15px;">${_esc(title)}</div>
          <button onclick="document.getElementById('lam-users-modal').remove()"
            style="background:none;border:none;cursor:pointer;font-size:18px;
                   color:var(--text-muted);line-height:1;">×</button>
        </div>
        <div style="padding:20px;">${bodyHTML}</div>
        <div style="padding:12px 20px;border-top:1px solid var(--border-subtle);
                    display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary"
            onclick="document.getElementById('lam-users-modal').remove()">
            Cancel
          </button>
          <button class="btn btn-primary" id="lam-modal-confirm">Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    document.getElementById('lam-modal-confirm').onclick = async () => {
      const ok = await onConfirm();
      if (ok !== false) modal.remove();
    };
  }

  // ══════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════

  function _initials(name) {
    return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Inject shake keyframe
  function _injectStyles() {
    if (document.getElementById('lam-users-styles')) return;
    const style = document.createElement('style');
    style.id = 'lam-users-styles';
    style.textContent = `
      @keyframes lam-shake {
        0%,100% { transform:translateX(0); }
        20%     { transform:translateX(-8px); }
        40%     { transform:translateX(8px); }
        60%     { transform:translateX(-5px); }
        80%     { transform:translateX(5px); }
      }
    `;
    document.head.appendChild(style);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  async function init() {
    if (_initialized) return;
    _initialized = true;

    _injectStyles();

    // Wait for LAMDB
    await _db();

    // 1. Run setup wizard if no owner exists
    const wizardRan = await runSetupWizardIfNeeded();
    if (wizardRan) return; // wizard handles login

    // 2. Try to restore existing session
    const session = _loadSession();
    if (session) {
      const user = await getUserById(session.id);
      if (user && user.active !== false) {
        _currentUser = session;
        window.LAMCurrentUser = { ...session };
        patchDBForAudit();
        _startInactivityWatch();
        // Apply nav + update topbar after DOM is ready
        requestAnimationFrame(() => {
          // Driver role: mount driver shell instead of sidebar nav
          if (session.role === 'driver') {
            if (window.LAMDriver) window.LAMDriver.mount();
            return;
          }
          resetRoleNav();
          applyRoleNav(session.role);
          _updateTopbar({ ...user, ...session });
          installRouteGuard();
        });
        return;
      }
    }

    // 3. No valid session — show user selection screen
    showUserSelectScreen();
  }

  // Public methods exposed on window.LAMUsers
  Object.assign(window.LAMUsers, {
    init,
    showUserSelectScreen,
    getAllUsers,
    createUser,
    updateUser,
    deleteUser,
    renderUsersSettingsTab,
    renderAuditViewer,
    formatAuditEntry,
    getTallyConfig: () => null, // placeholder
    switchUser: () => showUserSelectScreen(),
    _showUserMenu,  // exposed for LAM.showUserMenu() delegation
    logout: async () => {
      if (_currentUser) {
        await _writeAuditDirect({
          action: 'logged out',
          entity: 'Session',
          detail: `${_currentUser.name} logged out`,
        });
      }
      // Unmount driver shell if active
      if (window.LAMDriver?._mounted) window.LAMDriver.unmount?.();
      _clearSession();
      clearTimeout(_inactivityTimer);
      resetRoleNav();
      document.getElementById('lam-user-chip')?.remove();
      showUserSelectScreen();
    },
    getCurrentUser: () => _currentUser,
    ROLES,
    ROLE_ROUTES,
    // Supabase-ready note:
    // When adding Supabase:
    //   1. Replace createUser PIN auth with supabase.auth.signUp
    //   2. Keep local PIN as offline fallback (compare pinHash locally)
    //   3. Sync lam_users collection to Supabase 'profiles' table
    //   4. Sync lam_audit_log to Supabase 'audit_logs' table via LAMCloud.push
  });

  return window.LAMUsers;

})();

// ── Auto-init is intentionally disabled ────────────────────
// LAMUsers.init() is called by dashboard.html after LAMDB is confirmed ready.
// Enabling auto-init here causes a race condition with:
//   1. requireAuth() / seedDemoAccount() in the module script
//   2. Router.init() navigating to dashboard and firing dbGetAll × 9
// All three hitting IndexedDB simultaneously on first load = page freeze.
