// ============================================================
// LAM — LocalStorage DB Adapter v6
// Drop-in replacement for Firebase — same API, pure frontend.
// When ready to connect your own backend, swap the _store
// functions below with your API calls. All modules stay the same.
// ============================================================


// ── DotBase Backend Connection ────────────────────────────────
// Call connectDotBase() to switch from localStorage to DotBase API.
// Usage: import { connectDotBase } from './js/core/firebase.js'
//        connectDotBase({ url:'https://api.yourdotbase.com', apiKey:'sk_...', projectId:'...' })

let _dotbase = null  // { url, apiKey, projectId }

export function connectDotBase({ url, apiKey, projectId }) {
  _dotbase = { url: url.replace(/\/+$/, ''), apiKey, projectId: projectId || null }
  console.log('LAM: DotBase backend connected →', _dotbase.url)
}

export function getDotBaseConfig() { return _dotbase ? { ..._dotbase } : null }
export function isBackendConnected() { return _dotbase !== null }

// Make getDotBaseConfig available on window for auth.js cross-module access
if (typeof window !== 'undefined') {
  window.getDotBaseConfig = getDotBaseConfig
}

// ── DotBase REST API helper ───────────────────────────────────
async function _api(method, path, body) {
  if (!_dotbase) throw new Error('DotBase not connected')
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': _dotbase.apiKey },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${_dotbase.url}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(err.error?.message || `DotBase API error ${res.status}`)
  }
  return res.json()
}

function _colPath(col) {
  if (!_dotbase?.projectId) throw new Error('DotBase projectId not configured')
  return `/v1/projects/${_dotbase.projectId}/db/${col}/docs`
}

// ── Collection Registry ──────────────────────────────────────
export const COLLECTIONS = {
  USERS:            'users',
  COMPANIES:        'companies',
  BRANCHES:         'branches',
  EMPLOYEES:        'employees',
  VENDORS:          'vendors',
  CUSTOMERS:        'customers',
  PRODUCTS:         'products',
  CATEGORIES:       'categories',
  UNITS:            'units',
  WAREHOUSES:       'warehouses',
  ZONES:            'zones',
  INVENTORY:        'inventory',
  AUDIT_LOGS:       'audit_logs',
  INVOICES:         'invoices',
  PAYMENTS:         'payments',
  EXPENSES:         'expenses',
  ACCOUNTS:         'accounts',
  GL_ENTRIES:       'gl_entries',
  JOURNAL_ENTRIES:  'journal_entries',
  BANK_ACCOUNTS:    'bank_accounts',
  BANK_TXN:         'bank_txn',
  BUDGETS:          'budgets',
  CURRENCY_RATES:   'currency_rates',
  FLEET:            'fleet',
  DRIVERS:          'drivers',
  TRIPS:            'trips',
  FUEL:             'fuel',
  POD:              'pod',
  MAINTENANCE:      'maintenance',
  ASSETS:           'assets',
  ASSET_MAINT:      'asset_maint',
  ASSET_AUDIT:      'asset_audit',
  LEADS:            'leads',
  OPPORTUNITIES:    'opportunities',
  QUOTATIONS:       'quotations',
  ACTIVITIES:       'activities',
  TICKETS:          'tickets',
  COMMUNICATIONS:   'communications',
  SLA_CONFIGS:      'sla_configs',
  ATTENDANCE:       'attendance',
  LEAVES:           'leaves',
  PAYROLL:          'payroll',
  TIMESHEETS:       'timesheets',
  PROJECTS:         'projects',
  TASKS:            'tasks',
  MILESTONES:       'milestones',
  DISPATCH:         'dispatch',
  DELIVERY_NOTES:   'delivery_notes',
  PICK_PACKS:       'pick_packs',
  RETURNS:          'returns',
  BACKORDERS:       'backorders',
  TRANSFERS:        'transfers',
  CYCLE_COUNT:      'cycle_count',
  DAMAGE:           'damage',
  APPROVALS:        'approvals',
  BOM:              'bom',
  PRODUCTION:       'production',
  WORK_CENTERS:     'work_centers',
  INSPECTIONS:      'inspections',
  DEFECTS:          'defects',
  NCR:              'ncr',
  CONTRACTS:        'contracts',
  WARRANTIES:       'warranties',
  SERVICE_CALLS:    'service_calls',
  GST_CONFIG:       'gst_config',
  EWAYBILLS:        'ewaybills',
  GSTR3B:           'gstr3b',
  INVOICE_MATCHES:  'invoice_matches',
  IC_TRANSACTIONS:  'ic_transactions',
  SESSIONS:         'sessions',
  SALES:            'sales',
  API_KEYS:         'api_keys',
  API_LOGS:         'api_logs',
  WEBHOOKS:         'webhooks',
};

// ── ID Generator ─────────────────────────────────────────────
function genId() {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,8).toUpperCase();
}

function nowISO() { return new Date().toISOString(); }

// Firebase-compatible timestamp helpers
export function serverTimestamp() { return nowISO(); }
export const Timestamp = {
  now:      ()  => ({ toDate: () => new Date(), seconds: Math.floor(Date.now()/1000) }),
  fromDate: (d) => ({ toDate: () => d, seconds: Math.floor(d.getTime()/1000) }),
};
export function increment(n) { return { __increment: n }; }

// ── Storage Layer (IndexedDB via LAMDB, localStorage fallback) ────
// LAMDB is loaded as a script tag before this module runs.
// All reads/writes go through LAMDB if available, localStorage otherwise.

const LS_PREFIX = 'lam_db_';

function _load(col) {
  // Legacy localStorage fallback (used only if LAMDB not ready)
  try { const r = localStorage.getItem(LS_PREFIX + col); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

function _save(col, data) {
  // Legacy localStorage fallback
  try { localStorage.setItem(LS_PREFIX + col, JSON.stringify(data)); }
  catch(e) { console.error('LAM storage error:', e); }
}

function _loadAll(col) {
  return Object.values(_load(col));
}

// Check if IndexedDB engine is available
function _hasIDB() {
  // Use the public isReady getter — _db is private inside the IIFE.
  // Previously used _db !== undefined which was always true (null !== undefined),
  // causing dbGet to try IDB before init() completed → silent fail → no session.
  return typeof window !== 'undefined' && window.LAMDB?.isReady === true;
}

// ── Real-time listener simulation ────────────────────────
const _listeners = {};
let _syncCh = null;

function _getBroadcastChannel() {
  if (!_syncCh) {
    try {
      _syncCh = new BroadcastChannel('lam_data_sync');
      _syncCh.onmessage = (e) => {
        const col = e.data?.collection;
        if (col) _notifyLocal(col);
      };
    } catch {}
  }
  return _syncCh;
}

function _notify(col) {
  _notifyLocal(col);
  try { _getBroadcastChannel()?.postMessage({ type: 'write', collection: col, ts: Date.now() }); } catch {}
}

function _notifyLocal(col) {
  const subs = _listeners[col];
  if (!subs || !subs.size) return;
  const all = _loadAll(col);
  subs.forEach(({ constraints, cb }) => {
    try { cb(_applyConstraints(all, constraints)); } catch(e) { console.error(e); }
  });
}

// ── Query Constraint Builders ─────────────────────────────────
export function where(field, op, value)  { return { type: 'where',   field, op, value }; }
export function orderBy(field, dir='asc') { return { type: 'orderBy', field, dir }; }
export function limit(n)                  { return { type: 'limit',   n }; }

function _applyConstraints(items, constraints = []) {
  let result = [...items];

  // Apply where filters
  for (const c of constraints) {
    if (c.type !== 'where') continue;
    result = result.filter(item => {
      const v = item[c.field];
      switch (c.op) {
        case '==':              return v === c.value;
        case '!=':              return v !== c.value;
        case '>':               return v >   c.value;
        case '>=':              return v >=  c.value;
        case '<':               return v <   c.value;
        case '<=':              return v <=  c.value;
        case 'array-contains':  return Array.isArray(v) && v.includes(c.value);
        case 'in':              return Array.isArray(c.value) && c.value.includes(v);
        default:                return true;
      }
    });
  }

  // Apply orderBy (last wins if multiple)
  for (const c of constraints) {
    if (c.type !== 'orderBy') continue;
    result.sort((a, b) => {
      const va = a[c.field] ?? '';
      const vb = b[c.field] ?? '';
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return c.dir === 'desc' ? -cmp : cmp;
    });
  }

  // Default sort: newest first (createdAt desc) when no orderBy
  const hasOrderBy = constraints.some(c => c.type === 'orderBy');
  if (!hasOrderBy) {
    result.sort((a, b) => (b.createdAt || '') < (a.createdAt || '') ? -1 : 1);
  }

  // Apply limit
  for (const c of constraints) {
    if (c.type === 'limit') result = result.slice(0, c.n);
  }

  return result;
}

// ── Increment resolver ────────────────────────────────────────
function _resolveIncrements(data, existing) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = (Number(existing[k]) || 0) + Number(v.__increment);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Auth stub (current user for createdBy tracking) ──────────
export const auth = {
  get currentUser() {
    try { const s = localStorage.getItem('lam_session'); return s ? JSON.parse(s) : null; }
    catch { return null; }
  }
};

// ── CRUD ─────────────────────────────────────────────────────

export async function dbCreate(col, data) {
  // Try DotBase backend first
  if (_dotbase) {
    try {
      const res = await _api('POST', _colPath(col), data);
      const record = res.data || res;
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('DotBase.dbCreate failed, falling back:', e); }
  }
  // IndexedDB
  if (_hasIDB()) {
    try {
      const record = await window.LAMDB.dbCreate(col, data);
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('LAMDB.dbCreate failed:', e); }
  }
  // localStorage fallback
  const store = _load(col);
  const id    = genId();
  const now   = nowISO();
  const resolved = _resolveIncrements(data, {});
  const record = { ...resolved, id, createdAt: now, updatedAt: now, createdBy: auth.currentUser?.uid || null };
  store[id] = record;
  _save(col, store);
  _notify(col);
  return { ...record };
}

export async function dbSet(col, id, data) {
  if (!id) return dbCreate(col, data);
  if (_dotbase) {
    try {
      // Try update first, fall back to create if not found
      const path = `${_colPath(col)}/${id}`;
      let res;
      try { res = await _api('PATCH', path, data); }
      catch { res = await _api('POST', _colPath(col), { ...data, id }); }
      const record = res.data || res;
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('DotBase.dbSet failed:', e); }
  }
  if (_hasIDB()) {
    try {
      const record = await window.LAMDB.dbSet(col, id, data);
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('LAMDB.dbSet failed:', e); }
  }
  const store    = _load(col);
  const existing = store[id] || {};
  const now      = nowISO();
  const resolved = _resolveIncrements(data, existing);
  const record   = { ...existing, ...resolved, id, updatedAt: now };
  if (!record.createdAt) record.createdAt = now;
  store[id] = record;
  _save(col, store);
  _notify(col);
  return { ...record };
}

export async function dbUpdate(col, id, data) {
  if (_dotbase) {
    try {
      const res = await _api('PATCH', `${_colPath(col)}/${id}`, data);
      const record = res.data || res;
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('DotBase.dbUpdate failed:', e); }
  }
  if (_hasIDB()) {
    try {
      const record = await window.LAMDB.dbUpdate(col, id, data);
      _notify(col);
      window.LAMLAN?.broadcastWrite?.(col, record);
      return record;
    } catch(e) { console.warn('LAMDB.dbUpdate failed:', e); }
  }
  const store = _load(col);
  if (!store[id]) throw new Error(`${col}/${id} not found`);
  const existing = store[id];
  const resolved = _resolveIncrements(data, existing);
  store[id] = { ...existing, ...resolved, updatedAt: nowISO() };
  _save(col, store);
  _notify(col);
  return { ...store[id] };
}

export async function dbDelete(col, id) {
  if (_dotbase) {
    try {
      await _api('DELETE', `${_colPath(col)}/${id}`);
      _notify(col);
      window.LAMLAN?.broadcastDelete?.(col, id);
      return id;
    } catch(e) { console.warn('DotBase.dbDelete failed:', e); }
  }
  if (_hasIDB()) {
    try {
      await window.LAMDB.dbDelete(col, id);
      _notify(col);
      window.LAMLAN?.broadcastDelete?.(col, id);
      return id;
    } catch(e) { console.warn('LAMDB.dbDelete failed:', e); }
  }
  const store = _load(col);
  delete store[id];
  _save(col, store);
  _notify(col);
  return id;
}

export async function dbGet(col, id) {
  if (!id) return null;
  if (_dotbase) {
    try {
      const res = await _api('GET', `${_colPath(col)}/${id}`);
      return res.data || res;
    } catch(e) { console.warn('DotBase.dbGet failed:', e); }
  }
  if (_hasIDB()) {
    try { return await window.LAMDB.dbGet(col, id); }
    catch(e) { console.warn('LAMDB.dbGet failed:', e); }
  }
  const store = _load(col);
  return store[id] ? { ...store[id] } : null;
}

export async function dbGetAll(col, constraints = []) {
  if (_dotbase) {
    try {
      // Convert constraints to query params
      const params = new URLSearchParams({ limit: 100 });
      const filters = {};
      constraints.forEach(c => {
        if (c.type === 'where' && c.op === '==') filters[c.field] = c.value;
        if (c.type === 'limit') params.set('limit', c.n);
        if (c.type === 'orderBy') { params.set('sortBy', c.field); params.set('sortDir', c.dir); }
      });
      if (Object.keys(filters).length) {
        Object.entries(filters).forEach(([k,v]) => params.append(`filter[${k}]`, v));
      }
      const res = await _api('GET', `${_colPath(col)}?${params}`);
      return res.data || res.documents || res || [];
    } catch(e) { console.warn('DotBase.dbGetAll failed:', e); }
  }
  if (_hasIDB()) {
    try { return await window.LAMDB.dbGetAll(col, constraints); }
    catch(e) { console.warn('LAMDB.dbGetAll failed:', e); }
  }
  const items = _loadAll(col);
  return _applyConstraints(items, constraints);
}

export function dbListen(col, constraints = [], callback) {
  // DotBase SSE real-time if backend connected
  if (_dotbase) {
    // Seed with current data immediately
    dbGetAll(col, constraints).then(items => {
      try { callback(items); } catch {}
    }).catch(() => {});

    // Open SSE stream via fetch (supports custom headers unlike EventSource)
    const pid    = _dotbase.projectId;
    const url    = `${_dotbase.url}/v1/projects/${pid}/db/${col}/stream`;
    const ctrl   = new AbortController();

    (async () => {
      try {
        const res = await fetch(url, {
          headers: { 'X-API-Key': _dotbase.apiKey },
          signal:  ctrl.signal,
        });
        if (!res.ok) throw new Error(`SSE ${res.status}`);
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buf     = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const chunk of parts) {
            const line = chunk.replace(/^data:\s*/m, '').trim();
            if (!line || line.startsWith(':')) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.event === 'connected') continue;
              // Re-fetch on any write change
              const items = await dbGetAll(col, constraints).catch(() => []);
              callback(items);
            } catch {}
          }
        }
      } catch(e) {
        if (e.name !== 'AbortError') {
          console.warn('LAM SSE disconnected, retrying in 5s:', e.message);
          setTimeout(() => {
            if (!ctrl.signal.aborted) dbListen(col, constraints, callback);
          }, 5000);
        }
      }
    })();

    return () => ctrl.abort();
  }

  // LAMDB cross-tab listener
  if (_hasIDB()) {
    try { return window.LAMDB.dbListen(col, constraints, callback); }
    catch(e) { console.warn('LAMDB.dbListen failed:', e); }
  }

  // localStorage fallback
  if (!_listeners[col]) _listeners[col] = new Set();
  const entry = { constraints, cb: callback };
  _listeners[col].add(entry);
  const items = _loadAll(col);
  try { callback(_applyConstraints(items, constraints)); } catch(e) { console.error(e); }
  return () => { _listeners[col]?.delete(entry); };
}

export async function dbBatch(operations) {
  for (const op of operations) {
    const id = op.id || genId();
    if (op.type === 'set')    await dbSet(op.collection, id, op.data);
    if (op.type === 'update') await dbUpdate(op.collection, id, op.data);
    if (op.type === 'delete') await dbDelete(op.collection, id);
  }
}

// ── Stubs so modules that import these don't crash ───────────
export const db = null;
export const signInWithEmailAndPassword     = () => Promise.reject(new Error('Use auth.js'));
export const signOut                        = () => Promise.resolve();
export const onAuthStateChanged             = () => () => {};
export const createUserWithEmailAndPassword = () => Promise.reject(new Error('Use auth.js'));
export const sendPasswordResetEmail         = () => Promise.resolve();
export const updateProfile                  = () => Promise.resolve();
