// ============================================================
// LAM DB Engine v1 — IndexedDB with same API as localStorage adapter
// Replaces _load/_save in firebase.js with unlimited IndexedDB storage.
// Supports: indexes, cursors, transactions, bulk ops, migrations.
// Zero dependency. Drop-in. All modules unchanged.
// ============================================================

const LAMDB = (() => {

  const DB_NAME    = 'LAM_Database';
  const DB_VERSION = 10; // v10: registered all 68 missing module collections — fixes IDB NotFoundError crash
  const LS_PREFIX  = 'lam_db_'; // for migration from localStorage

  // Collections that get dedicated indexes for fast querying
  const INDEXED_COLLECTIONS = {
    invoices:            ['customerId','paymentStatus','invoiceDate','dueDate','companyId'],
    employees:           ['companyId','department','status','email'],
    products:            ['companyId','category','status','sku','barcode'],
    trips:               ['companyId','driverId','status','date'],
    tms_trips:           ['companyId','driverId','status','date','vehicleId'],
    inventory:           ['companyId','warehouseId','productId'],
    audit_logs:          ['companyId','userId','action','module','createdAt'],
    lam_audit_log:       ['companyId','userId','action','module','createdAt'],
    gl_entries:          ['companyId','accountId','date','type'],
    bank_txn:            ['companyId','bankAccountId','date','type'],
    attendance:          ['companyId','employeeId','date'],
    hr_attendance:       ['companyId','employeeId','date'],
    payroll:             ['companyId','employeeId','month'],
    hr_payroll:          ['companyId','employeeId','month'],
    hr_leaves:           ['companyId','employeeId','status','type'],
    leaves:              ['companyId','employeeId','status','type'],
    leads:               ['companyId','status','assignedTo'],
    tickets:             ['companyId','status','priority','customerId'],
    tasks:               ['companyId','projectId','assignedTo','status'],
    delivery_notes:      ['companyId','orderId','status','date'],
    grns:                ['companyId','vendorId','status','date'],
    fleet:               ['companyId','status','type'],
    drivers:             ['companyId','status'],
    customers:           ['companyId','status','name'],
    vendors:             ['companyId','status','name'],
    assets:              ['companyId','category','status'],
    contracts:           ['companyId','customerId','status','expiryDate'],
    // New indexes for v9
    sales_orders:        ['companyId','customerId','status','date'],
    purchase_orders:     ['companyId','vendorId','status','date'],
    fin_payments:        ['companyId','invoiceId','date','method'],
    expenses:            ['companyId','category','date'],
    lam_gps_pings:       ['companyId','driverId','tripId'],
    pos_sessions:        ['companyId','date','status'],
    pos_items:           ['companyId','sessionId','productId'],
    quality_checks:      ['companyId','status','type'],
    multi_companies:     ['parentId','status'],
    opportunities:       ['companyId','status','assignedTo'],
    activities:          ['companyId','relatedId','type','date'],
    service_calls:       ['companyId','customerId','status','date'],
    production:          ['companyId','status','date'],
    asset_depreciation:  ['companyId','assetId','date'],
  };

  let _db = null;
  let _initPromise = null;

  // ── DB Initialization ─────────────────────────────────────
  function init() {
    if (_initPromise) return _initPromise;

    _initPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB not supported'));
        return;
      }

      // 8s timeout — if IDB is blocked (another tab has old version open),
      // fail fast so the app doesn't hang on "Initializing LAM..."
      const timeout = setTimeout(() => {
        console.error('LAM DB: init timed out after 8s — IDB may be blocked');
        resolve(null); // resolve null so app continues in localStorage-only mode
      }, 8000);

      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        clearTimeout(timeout);
        const db      = e.target.result;
        const oldVer  = e.oldVersion;

        // v3 → v4: Fix _lam_meta keyPath (was created with keyPath:'id', must be keyPath:'key')
        if (oldVer < 4 && db.objectStoreNames.contains('_lam_meta')) {
          db.deleteObjectStore('_lam_meta');
        }

        // Create or upgrade object stores
        const allCollections = _getAllCollections();

        allCollections.forEach(col => {
          let store;
          if (!db.objectStoreNames.contains(col)) {
            store = db.createObjectStore(col, { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
            store.createIndex('companyId', 'companyId', { unique: false });
          } else {
            store = e.target.transaction.objectStore(col);
          }

          // Add collection-specific indexes
          const indexes = INDEXED_COLLECTIONS[col] || [];
          indexes.forEach(field => {
            if (!store.indexNames.contains(field)) {
              try {
                store.createIndex(field, field, { unique: false });
              } catch {}
            }
          });

          // Compound index for common queries
          if (INDEXED_COLLECTIONS[col]?.includes('companyId') && !store.indexNames.contains('companyId_createdAt')) {
            try {
              store.createIndex('companyId_createdAt', ['companyId', 'createdAt'], { unique: false });
            } catch {}
          }
        });

        // Migration store for tracking
        if (!db.objectStoreNames.contains('_lam_meta')) {
          db.createObjectStore('_lam_meta',       { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('_lam_sync_queue')) {
          db.createObjectStore('_lam_sync_queue', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('_lam_encrypted')) {
          db.createObjectStore('_lam_encrypted',  { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        clearTimeout(timeout);
        _db = e.target.result;

        // Handle unexpected version changes
        _db.onversionchange = () => {
          _db.close();
          _db = null;
          _initPromise = null;
          console.warn('LAM DB: version change detected, closing connection');
        };

        // Run localStorage migration on first open
        _migrateFromLocalStorage().then(() => resolve(_db));
      };

      req.onerror = (e) => {
        clearTimeout(timeout);
        console.error('LAM DB open error:', e.target.error);
        reject(e.target.error);
      };

      req.onblocked = () => {
        clearTimeout(timeout);
        console.warn('LAM DB blocked — another tab has an old DB version open. Close other LAM tabs and refresh.');
        // Resolve null so app continues without IDB — localStorage fallback active
        resolve(null);
      };
    });

    return _initPromise;
  }

  // ── Migration from localStorage ───────────────────────────
  async function _migrateFromLocalStorage() {
    const db = _db;

    // Check if already migrated
    const meta = await _idbGet(db, '_lam_meta', 'ls_migrated');
    if (meta) return;

    console.log('LAM DB: migrating from localStorage...');
    let migrated = 0;

    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LS_PREFIX)) continue;
      const col = key.slice(LS_PREFIX.length);

      try {
        const records = JSON.parse(localStorage.getItem(key) || '{}');
        const items   = Object.values(records);
        if (!items.length) continue;

        // Check store exists
        if (!db.objectStoreNames.contains(col)) continue;

        const tx    = db.transaction(col, 'readwrite');
        const store = tx.objectStore(col);
        for (const item of items) {
          if (item && item.id && typeof item.id === 'string' && item.id.trim()) {
            store.put(item);
          }
        }
        await _txComplete(tx);
        migrated += items.length;

        // Remove from localStorage after migration
        localStorage.removeItem(key);
      } catch (e) {
        console.warn(`LAM DB: migration failed for ${col}:`, e);
      }
    }

    // Mark migration done
    try {
      const metaTx = db.transaction('_lam_meta', 'readwrite');
      metaTx.objectStore('_lam_meta').put({
        key:        'ls_migrated',
        value:      true,
        migratedAt: new Date().toISOString(),
        recordCount: migrated,
      });
      await _txComplete(metaTx);
    } catch (e) {
      console.warn('LAM DB: could not write migration marker:', e.message);
    }

    console.log(`LAM DB: migrated ${migrated} records from localStorage`);
  }

  // ── IDB helpers ───────────────────────────────────────────
  function _txComplete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
    });
  }

  function _idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(storeName)) { resolve(null); return; }
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  function _ensureStore(db, col) {
    if (!db.objectStoreNames.contains(col)) {
      // Store doesn't exist — need schema upgrade
      // For now return false and caller will handle gracefully
      return false;
    }
    return true;
  }

  async function _getDB() {
    if (_db) return _db;
    return init();
  }

  function _getAllCollections() {
    // ── COMPLETE store list — every collection used by any module ──
    // Bumping DB_VERSION forces onupgradeneeded to create missing stores.
    // lam-db.js is the single source of truth; lam-safety.js mirrors this.
    return [
      // ── Core / Auth ───────────────────────────────────────────────
      'users', 'companies', 'branches', 'sessions',

      // ── People ────────────────────────────────────────────────────
      'employees', 'vendors', 'customers',

      // ── Products / Warehouse ──────────────────────────────────────
      'products', 'categories', 'units', 'warehouses', 'zones',
      'inventory', 'grns', 'dispatch', 'delivery_notes', 'pick_packs',
      'returns', 'backorders', 'transfers', 'cycle_count', 'damage', 'approvals',

      // ── Orders ────────────────────────────────────────────────────
      'invoices', 'payments', 'expenses', 'sales_orders', 'purchase_orders',

      // ── Finance ───────────────────────────────────────────────────
      'accounts', 'gl_entries', 'journal_entries',
      'bank_accounts', 'bank_txn', 'budgets', 'currency_rates',
      'fin_payments', 'fin_expenses',

      // ── GST / Compliance ──────────────────────────────────────────
      'gst_config', 'ewaybills', 'gstr3b', 'invoice_matches',

      // ── Transport / Fleet ─────────────────────────────────────────
      'fleet', 'drivers', 'trips', 'tms_trips', 'fuel', 'pod',
      'maintenance', 'lam_gps_pings',

      // ── HR ────────────────────────────────────────────────────────
      'attendance', 'leaves', 'payroll', 'timesheets',
      'hr_attendance', 'hr_payroll', 'hr_leaves',   // HR module private stores

      // ── Assets ────────────────────────────────────────────────────
      'assets', 'asset_maint', 'asset_audit', 'asset_depreciation',

      // ── CRM / Sales ───────────────────────────────────────────────
      'leads', 'opportunities', 'quotations', 'activities',
      'tickets', 'communications', 'sla_configs',

      // ── Projects ──────────────────────────────────────────────────
      'projects', 'tasks', 'milestones',

      // ── Manufacturing / QC ────────────────────────────────────────
      'bom', 'production', 'work_centers',
      'inspections', 'defects', 'ncr', 'quality_checks',

      // ── Service / Contracts ───────────────────────────────────────
      'contracts', 'warranties', 'service_calls',

      // ── POS ───────────────────────────────────────────────────────
      'sales', 'pos_sessions', 'pos_items',

      // ── Multi-company ─────────────────────────────────────────────
      'multi_companies', 'multi_ic_transactions', 'multi_consolidations',
      'ic_transactions',

      // ── API / Integrations ────────────────────────────────────────
      'api_keys', 'api_logs', 'webhooks',

      // ── Audit / Logs ─────────────────────────────────────────────
      'audit_logs',

      // ── lam-users.js private stores ───────────────────────────────
      'lam_users', 'lam_audit_log',

      // ── Accounting (fin-advanced) ─────────────────────────────────
      'acc_chart_of_accounts', 'acc_gl_entries', 'acc_journal_entries', 'acc_periods',
      'fin_invoices', 'fin_budgets', 'fin_currency_rates',

      // ── Bank reconciliation ───────────────────────────────────────
      'bank_reconciliations', 'bank_statements', 'bank_transactions',

      // ── GST extended ─────────────────────────────────────────────
      'gst_einvoices', 'gst_ewaybills', 'gst_gstr1_data', 'gst_gstr3b_data',

      // ── HR extended (v10) ─────────────────────────────────────────
      'hr_leave_balances', 'hr_pay_config',

      // ── TMS extended (transport) ──────────────────────────────────
      'tms_fleet', 'tms_drivers', 'tms_fuel', 'tms_maintenance', 'tms_pod',

      // ── WMS extended (warehouse) ──────────────────────────────────
      'wms_cycle_count', 'wms_damage', 'wms_dispatch', 'wms_transfers',

      // ── OMS (order management) ────────────────────────────────────
      'oms_backorders', 'oms_delivery_notes', 'oms_pick_packs', 'oms_returns',

      // ── CRM extended ─────────────────────────────────────────────
      'crm_leads', 'crm_opportunities', 'crm_quotations', 'crm_activities',
      'crm_tickets', 'crm_communications', 'crm_sla_configs',

      // ── Procurement extended ──────────────────────────────────────
      'proc_approvals', 'proc_invoice_matches',

      // ── Projects ─────────────────────────────────────────────────
      'proj_projects', 'proj_tasks', 'proj_milestones',
      'proj_timesheets', 'proj_expenses',

      // ── Manufacturing extended ────────────────────────────────────
      'mfg_bom', 'mfg_production_orders', 'mfg_operations',
      'mfg_work_centers', 'mfg_mrp_runs',

      // ── Quality Control extended ──────────────────────────────────
      'qc_inspections', 'qc_defects', 'qc_ncr', 'qc_checklists',

      // ── Service & Contracts extended ──────────────────────────────
      'svc_contracts', 'svc_warranties', 'svc_service_calls', 'svc_renewals',

      // ── POS extended ─────────────────────────────────────────────
      'pos_sales', 'pos_shifts',

      // ── Asset maintenance ─────────────────────────────────────────
      'asset_maintenance',

      // ── API & Webhooks extended ───────────────────────────────────
      'api_webhooks',

      // ── Warehouse staff ───────────────────────────────────────────
      'warehouse_staff',
    ];
  }

  // Lazy store creator — called when a module first accesses a collection
  async function _ensureStore(collectionName) {
    if (!_db) return;
    if (_db.objectStoreNames.contains(collectionName)) return;
    // Need to version-bump to add a new store
    const currentVersion = _db.version;
    _db.close();
    _db = null;
    _initPromise = null;
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, currentVersion + 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(collectionName)) {
          const store = db.createObjectStore(collectionName, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('companyId', 'companyId', { unique: false });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(); };
      req.onerror   = (e) => { reject(e.target.error); };
    });
  }

  // ── ID Generator ──────────────────────────────────────────
  function genId() {
    return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,8).toUpperCase();
  }

  function nowISO() { return new Date().toISOString(); }

  // ── Increment resolver ────────────────────────────────────
  function resolveIncrements(data, existing) {
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

  // ── Constraint engine ─────────────────────────────────────
  function applyConstraints(items, constraints = []) {
    let result = [...items];

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

    // orderBy
    for (const c of constraints) {
      if (c.type !== 'orderBy') continue;
      result.sort((a, b) => {
        const va = a[c.field] ?? '';
        const vb = b[c.field] ?? '';
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return c.dir === 'desc' ? -cmp : cmp;
      });
    }

    // Default: newest first
    const hasOrder = constraints.some(c => c.type === 'orderBy');
    if (!hasOrder) {
      result.sort((a, b) => (b.createdAt || '') < (a.createdAt || '') ? -1 : 1);
    }

    // limit
    for (const c of constraints) {
      if (c.type === 'limit') result = result.slice(0, c.n);
    }

    return result;
  }

  // ── Get current user ID ───────────────────────────────────
  function _currentUid() {
    try {
      const s = localStorage.getItem('lam_session');
      return s ? JSON.parse(s)?.uid : null;
    } catch { return null; }
  }

  // ── CRUD Operations ───────────────────────────────────────

  async function dbCreate(col, data) {
    const db  = await _getDB();
    const id  = genId();
    const now = nowISO();

    if (!_ensureStore(db, col)) {
      console.warn(`LAM DB: store '${col}' not found, auto-creating will happen on next version upgrade`);
      return { ...data, id, createdAt: now, updatedAt: now };
    }

    const resolved = resolveIncrements(data, {});
    const record   = {
      ...resolved,
      id,
      createdAt:  now,
      updatedAt:  now,
      createdBy:  _currentUid(),
    };

    // Check if needs encryption
    if (LAMCRYPTO._shouldEncrypt(col)) {
      record._encrypted = true;
      const encrypted   = await LAMCRYPTO.encryptRecord(record);
      if (encrypted) Object.assign(record, encrypted);
    }

    const tx = db.transaction(col, 'readwrite');
    tx.objectStore(col).put(record);
    await _txComplete(tx);

    _notify(col, 'create', record);
    return { ...record };
  }

  async function dbSet(col, id, data) {
    if (!id) return dbCreate(col, data);
    const db = await _getDB();
    if (!_ensureStore(db, col)) return { ...data, id };

    const existing = await _idbGet(db, col, id) || {};
    const now      = nowISO();
    const resolved = resolveIncrements(data, existing);
    const record   = { ...existing, ...resolved, id, updatedAt: now };
    if (!record.createdAt) record.createdAt = now;

    if (LAMCRYPTO._shouldEncrypt(col)) {
      record._encrypted = true;
      const encrypted   = await LAMCRYPTO.encryptRecord(record);
      if (encrypted) Object.assign(record, encrypted);
    }

    const tx = db.transaction(col, 'readwrite');
    tx.objectStore(col).put(record);
    await _txComplete(tx);

    _notify(col, 'set', record);
    return { ...record };
  }

  async function dbUpdate(col, id, data) {
    const db = await _getDB();
    if (!_ensureStore(db, col)) throw new Error(`Store ${col} not found`);

    const existing = await _idbGet(db, col, id);
    if (!existing) throw new Error(`${col}/${id} not found`);

    const resolved = resolveIncrements(data, existing);
    const record   = { ...existing, ...resolved, updatedAt: nowISO() };

    if (LAMCRYPTO._shouldEncrypt(col)) {
      const encrypted = await LAMCRYPTO.encryptRecord(record);
      if (encrypted) Object.assign(record, encrypted);
    }

    const tx = db.transaction(col, 'readwrite');
    tx.objectStore(col).put(record);
    await _txComplete(tx);

    _notify(col, 'update', record);
    return { ...record };
  }

  async function dbDelete(col, id) {
    const db = await _getDB();
    if (!_ensureStore(db, col)) return id;

    const tx = db.transaction(col, 'readwrite');
    tx.objectStore(col).delete(id);
    await _txComplete(tx);

    _notify(col, 'delete', { id });
    return id;
  }

  async function dbGet(col, id) {
    if (!id) return null;
    const db  = await _getDB();
    if (!_ensureStore(db, col)) return null;

    const record = await _idbGet(db, col, id);
    if (!record) return null;

    if (record._encrypted) {
      return LAMCRYPTO.decryptRecord(record);
    }
    return record;
  }

  async function dbGetAll(col, constraints = []) {
    const db = await _getDB();
    if (!_ensureStore(db, col)) return [];

    // Optimized: try index-based query for single equality where clause
    const eqConstraint = constraints.find(c =>
      c.type === 'where' && c.op === '==' &&
      INDEXED_COLLECTIONS[col]?.includes(c.field)
    );

    let items;

    if (eqConstraint && constraints.filter(c => c.type === 'where').length === 1) {
      // Use index for single equality query
      items = await _getByIndex(db, col, eqConstraint.field, eqConstraint.value);
    } else {
      // Full scan with cursor
      items = await _getAll(db, col);
    }

    // Decrypt if needed
    if (LAMCRYPTO._shouldEncrypt(col)) {
      items = await Promise.all(items.map(r => r._encrypted ? LAMCRYPTO.decryptRecord(r) : r));
    }

    return applyConstraints(items, constraints);
  }

  function _getAll(db, col) {
    return new Promise((resolve, reject) => {
      const tx   = db.transaction(col, 'readonly');
      const req  = tx.objectStore(col).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  function _getByIndex(db, col, field, value) {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(col, 'readonly');
      const store = tx.objectStore(col);
      if (!store.indexNames.contains(field)) {
        // Index doesn't exist — fall back to full scan
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).filter(r => r[field] === value));
        req.onerror   = () => reject(req.error);
        return;
      }
      const req = store.index(field).getAll(IDBKeyRange.only(value));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  // ── Real-time listener system ─────────────────────────────
  const _listeners = new Map(); // col → Set of {constraints, cb}
  let _broadcastCh = null;

  function _getBroadcast() {
    if (!_broadcastCh) {
      try {
        _broadcastCh = new BroadcastChannel('lam_idb_sync');
        _broadcastCh.onmessage = (e) => {
          const { col, op, record } = e.data || {};
          if (col) _notifyLocal(col, op, record);
        };
      } catch {}
    }
    return _broadcastCh;
  }

  function _notify(col, op, record) {
    _notifyLocal(col, op, record);
    try {
      _getBroadcast()?.postMessage({ col, op, record: { id: record?.id }, ts: Date.now() });
    } catch {}
  }

  async function _notifyLocal(col, op, hint) {
    const subs = _listeners.get(col);
    if (!subs?.size) return;

    // Re-fetch current data for all subscribers
    const db   = await _getDB().catch(() => null);
    if (!db || !_ensureStore(db, col)) return;

    const all  = await _getAll(db, col);

    subs.forEach(({ constraints, cb }) => {
      try {
        const filtered = applyConstraints(all, constraints);
        cb(filtered);
      } catch (e) { console.error('LAM DB listener error:', e); }
    });
  }

  function dbListen(col, constraints = [], callback) {
    if (!_listeners.has(col)) _listeners.set(col, new Set());

    const entry = { constraints, cb: callback };
    _listeners.get(col).add(entry);

    // Fire immediately with current data
    _getDB().then(db => {
      if (!_ensureStore(db, col)) { callback([]); return; }
      return _getAll(db, col).then(all => {
        try { callback(applyConstraints(all, constraints)); } catch {}
      });
    }).catch(() => callback([]));

    return () => { _listeners.get(col)?.delete(entry); };
  }

  async function dbBatch(operations) {
    const db = await _getDB();
    // Group by collection for efficiency
    const byCol = {};
    operations.forEach(op => {
      if (!byCol[op.collection]) byCol[op.collection] = [];
      byCol[op.collection].push(op);
    });

    for (const [col, ops] of Object.entries(byCol)) {
      if (!_ensureStore(db, col)) continue;
      const tx    = db.transaction(col, 'readwrite');
      const store = tx.objectStore(col);
      const now   = nowISO();

      for (const op of ops) {
        const id = op.id || genId();
        if (op.type === 'set') {
          const rec = { ...op.data, id, updatedAt: now };
          if (!rec.createdAt) rec.createdAt = now;
          store.put(rec);
        } else if (op.type === 'update') {
          // Async get inside sync transaction — need pre-fetch approach
          store.put({ ...op.data, id, updatedAt: now });
        } else if (op.type === 'delete') {
          store.delete(id);
        }
      }

      await _txComplete(tx);
    }
    // Notify after all batch ops complete
    Object.keys(byCol).forEach(c => _notify(c, 'batch', {}));
  }

  // ── Storage stats ─────────────────────────────────────────
  async function getStorageStats() {
    const stats = { collections: {}, totalRecords: 0, estimatedMB: 0 };
    const db    = await _getDB();

    for (const col of db.objectStoreNames) {
      if (col.startsWith('_')) continue;
      try {
        const count = await new Promise(res => {
          const req = db.transaction(col, 'readonly').objectStore(col).count();
          req.onsuccess = () => res(req.result);
          req.onerror   = () => res(0);
        });
        if (count > 0) {
          stats.collections[col] = count;
          stats.totalRecords += count;
        }
      } catch {}
    }

    // Estimate storage using StorageManager if available
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      stats.usedMB    = Math.round((est.usage   || 0) / 1024 / 1024 * 10) / 10;
      stats.quotaMB   = Math.round((est.quota   || 0) / 1024 / 1024);
      stats.percentUsed = stats.quotaMB ? Math.round(stats.usedMB / stats.quotaMB * 100) : 0;
    }

    return stats;
  }

  // ── Export/Import (backup) ────────────────────────────────
  async function exportAllData() {
    const db     = await _getDB();
    const backup = { version: DB_VERSION, exportedAt: nowISO(), data: {} };

    for (const col of db.objectStoreNames) {
      if (col.startsWith('_')) continue;
      const items = await _getAll(db, col);
      if (items.length) backup.data[col] = items;
    }

    const json = JSON.stringify(backup);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `LAM_Backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    return { collections: Object.keys(backup.data).length, records: Object.values(backup.data).reduce((s,v) => s+v.length, 0) };
  }

  async function importData(file) {
    const text   = await file.text();
    const backup = JSON.parse(text);
    if (!backup?.data) throw new Error('Invalid backup file');

    const db = await _getDB();
    let imported = 0;

    for (const [col, items] of Object.entries(backup.data)) {
      if (!_ensureStore(db, col)) continue;
      const tx    = db.transaction(col, 'readwrite');
      const store = tx.objectStore(col);
      for (const item of items) {
        if (item?.id) { store.put(item); imported++; }
      }
      await _txComplete(tx);
    }

    // Notify all listeners
    _listeners.forEach((_, col) => _notifyLocal(col, 'import', {}));

    return imported;
  }

  // ── Persistence request (prevent eviction) ───────────────
  async function requestPersistence() {
    if (!navigator.storage?.persist) return false;
    const isPersistent = await navigator.storage.persist();
    console.log(`LAM DB: storage persistence ${isPersistent ? 'granted' : 'not granted'}`);
    return isPersistent;
  }

  return {
    init,
    get isReady() { return _db !== null; },
    dbCreate, dbSet, dbUpdate, dbDelete,
    dbGet, dbGetAll, dbListen, dbBatch,
    applyConstraints, resolveIncrements, genId,
    getStorageStats, exportAllData, importData,
    requestPersistence,
    // Exposed so lam-safety.js can read the canonical list for backups
    _collections: _getAllCollections(),
  };

})();

window.LAMDB = LAMDB;
