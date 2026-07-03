// ============================================================
// LAM Cloud Engine v1.0
// ============================================================
// 1. SUPABASE SYNC ENGINE — offline-first, eventual consistency
// 2. E-WAY BILL FORM      — full NIC-format JSON generation
// 3. RAZORPAY PAYMENT LINKS — client-side, no backend needed
// 4. DATA EXPORT SUITE    — one ZIP for CA handoff
// 5. SUPABASE SQL MIGRATION — generated setup script
//
// All cloud ops are background async — never blocks UI.
// If Supabase is down, app works perfectly — queues up.
//
// Supabase-ready hooks used by lam-safety.js + lam-driver.js:
//   window.LAMCloud = { push, pull, isActive, status }
//
// Zero dependencies. Razorpay loaded on-demand from CDN.
// ============================================================

const LAMCloud = (() => {

  // ── Constants ─────────────────────────────────────────────
  const LS_SUPABASE_URL = 'lam_supabase_url';
  const LS_SUPABASE_KEY = 'lam_supabase_anon_key';
  const LS_LAST_SYNC    = 'lam_last_sync_at';
  const LS_RZP_KEY      = 'lam_razorpay_key_id';
  const SYNC_QUEUE_COL  = 'lam_sync_queue';
  const SYNC_INTERVAL   = 30_000; // 30 seconds
  const COMPANY_ID_KEY  = 'lam_company_id';

  // ── All LAM collections to sync ───────────────────────────
  const SYNC_COLLECTIONS = [
    'invoices','payments','expenses','customers','vendors','products',
    'inventory','tms_trips','tms_fleet','tms_drivers','tms_fuel','tms_pod',
    'lam_gps_pings','employees','payroll','assets','contracts',
    'gl_entries','bank_txn','budgets','leads','orders','grns',
    'lam_users','lam_audit_log',
  ];

  // ── State ─────────────────────────────────────────────────
  let _url        = null;
  let _key        = null;
  let _syncTimer  = null;
  let _syncing    = false;
  let _active     = false;
  let _pendingCnt = 0;
  let _lastSync   = null;
  let _badgeEl    = null;

  const _db = () => window.LAMDB;
  const _companyId = () =>
    localStorage.getItem(COMPANY_ID_KEY) ||
    window.LAMCurrentUser?.companyId || 'default';

  // ══════════════════════════════════════════════════════════
  // SECTION 1 — SUPABASE CONFIG
  // ══════════════════════════════════════════════════════════

  function configure(url, key) {
    _url    = (url || '').trim().replace(/\/$/, '');
    _key    = (key || '').trim();
    _active = !!(url && key);
    if (_active) {
      localStorage.setItem(LS_SUPABASE_URL, _url);
      localStorage.setItem(LS_SUPABASE_KEY, _key);
    }
  }

  function loadConfig() {
    _url    = localStorage.getItem(LS_SUPABASE_URL) || null;
    _key    = localStorage.getItem(LS_SUPABASE_KEY) || null;
    _active = !!(_url && _key);
  }

  function clearConfig() {
    localStorage.removeItem(LS_SUPABASE_URL);
    localStorage.removeItem(LS_SUPABASE_KEY);
    _url = _key = null; _active = false;
    _stopSyncTimer();
    _updateBadge();
  }

  async function testConnection() {
    if (!_url || !_key) return { ok: false, error: 'Not configured' };
    try {
      const r = await _sbFetch('GET', '/rest/v1/', null, { timeout: 5000 });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── Supabase HTTP helper ───────────────────────────────────
  async function _sbFetch(method, path, body, opts = {}) {
    const ctrl = new AbortController();
    const tid   = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try {
      const res = await fetch(_url + path, {
        method,
        signal:  ctrl.signal,
        headers: {
          'apikey':        _key,
          'Authorization': `Bearer ${_key}`,
          'Content-Type':  'application/json',
          'Prefer':        method === 'POST' ? 'resolution=merge-duplicates' : '',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      clearTimeout(tid);
      return res;
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  async function _sbUpsert(table, record) {
    if (!_active) return false;
    try {
      const r = await _sbFetch('POST', `/rest/v1/${table}`, record);
      return r.ok || r.status === 201 || r.status === 200;
    } catch { return false; }
  }

  async function _sbDelete(table, id) {
    if (!_active) return false;
    try {
      const r = await _sbFetch('DELETE', `/rest/v1/${table}?id=eq.${id}`);
      return r.ok;
    } catch { return false; }
  }

  async function _sbQuery(table, params = '') {
    if (!_active) return null;
    try {
      const r = await _sbFetch('GET', `/rest/v1/${table}?${params}`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 2 — SYNC ENGINE
  // ══════════════════════════════════════════════════════════

  /**
   * Push a DB operation to the sync queue.
   * Called by every dbCreate/dbUpdate/dbDelete via LAMCloud.push()
   *
   * op: { type:'create'|'update'|'delete', col, record, ts }
   */
  async function push(op) {
    if (!op?.col || op.col === SYNC_QUEUE_COL) return;

    const db = _db();
    if (!db) return;

    const entry = {
      id:        'sq_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      opType:    op.type || 'update',
      col:       op.col,
      recordId:  op.record?.id,
      record:    op.record,
      ts:        op.ts || Date.now(),
      userId:    window.LAMCurrentUser?.id || null,
      companyId: _companyId(),
      _synced:   false,
    };

    try {
      await db.dbSet(SYNC_QUEUE_COL, entry.id, entry);
      _pendingCnt++;
      _updateBadge();
    } catch {}

    // If online and Supabase configured, try immediate drain
    if (_active && navigator.onLine) {
      _drainQueueDebounced();
    }
  }

  const _drainQueueDebounced = (() => {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(_drainQueue, 2000);
    };
  })();

  async function _drainQueue() {
    if (_syncing || !_active || !navigator.onLine) return;
    _syncing = true;
    _updateBadge('syncing');

    const db = _db();
    if (!db) { _syncing = false; return; }

    try {
      const queue = await db.dbGetAll(SYNC_QUEUE_COL).catch(() => []);
      const pending = queue.filter(e => !e._synced).sort((a,b) => a.ts - b.ts);

      if (!pending.length) {
        _pendingCnt = 0;
        _lastSync   = new Date();
        localStorage.setItem(LS_LAST_SYNC, _lastSync.toISOString());
        _updateBadge('synced');
        _syncing = false;
        return;
      }

      let successCount = 0;
      for (const entry of pending) {
        let ok = false;
        const sbTable = _colToTable(entry.col);

        if (entry.opType === 'delete') {
          ok = await _sbDelete(sbTable, entry.recordId);
        } else {
          // Map record to Supabase row shape
          const row = _toSupabaseRow(entry.record, entry.companyId);
          ok = await _sbUpsert(sbTable, row);
        }

        if (ok) {
          await db.dbSet(SYNC_QUEUE_COL, entry.id, { ...entry, _synced: true });
          successCount++;
        }
      }

      _pendingCnt = Math.max(0, pending.length - successCount);
      if (successCount > 0) {
        _lastSync = new Date();
        localStorage.setItem(LS_LAST_SYNC, _lastSync.toISOString());
      }
      _updateBadge(_pendingCnt > 0 ? 'pending' : 'synced');
    } catch (e) {
      console.warn('[LAMCloud] Drain error:', e);
      _updateBadge('error');
    } finally {
      _syncing = false;
    }
  }

  /**
   * Pull remote changes newer than last_sync_at.
   * Server wins unless record.updatedBy === current user.
   */
  async function pull() {
    if (!_active || !navigator.onLine) return;
    const db = _db();
    if (!db) return;

    const since = localStorage.getItem(LS_LAST_SYNC) || '1970-01-01T00:00:00Z';
    const cid   = _companyId();

    for (const col of SYNC_COLLECTIONS) {
      try {
        const table  = _colToTable(col);
        const params = `company_id=eq.${cid}&updated_at=gt.${since}&deleted_at=is.null&limit=500`;
        const rows   = await _sbQuery(table, params);
        if (!Array.isArray(rows)) continue;

        for (const row of rows) {
          const localRecord = await db.dbGet(col, row.id).catch(() => null);
          const remote = _fromSupabaseRow(row);

          if (!localRecord) {
            // New record from another device
            await db.dbSet(col, remote.id, remote);
          } else {
            // Conflict: server wins unless current user last edited this record
            const currentUserId = window.LAMCurrentUser?.id;
            const localWins = localRecord.updatedBy === currentUserId &&
              new Date(localRecord.updatedAt || 0) >= new Date(row.updated_at || 0);
            if (!localWins) {
              await db.dbSet(col, remote.id, { ...localRecord, ...remote });
            }
          }
        }
      } catch {}
    }
  }

  function _colToTable(col) {
    // Supabase table names: sanitised collection names
    return col.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  }

  function _toSupabaseRow(record, companyId) {
    return {
      id:         record?.id,
      data:       record,
      created_at: record?.createdAt || new Date().toISOString(),
      updated_at: record?.updatedAt || new Date().toISOString(),
      created_by: record?.createdBy || window.LAMCurrentUser?.id || null,
      company_id: companyId || _companyId(),
      deleted_at: record?._deleted ? new Date().toISOString() : null,
    };
  }

  function _fromSupabaseRow(row) {
    return { ...(row.data || {}), id: row.id };
  }

  // ── Sync timer ─────────────────────────────────────────────
  function _startSyncTimer() {
    _stopSyncTimer();
    if (!_active) return;
    _drainQueue();       // immediate drain on start
    pull();              // pull remote changes
    _syncTimer = setInterval(async () => {
      await _drainQueue();
      await pull();
    }, SYNC_INTERVAL);
  }

  function _stopSyncTimer() {
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  }

  // ── Sync status badge ──────────────────────────────────────
  function injectSyncBadge() {
    if (document.getElementById('lam-sync-badge')) {
      _badgeEl = document.getElementById('lam-sync-badge');
      return;
    }
    _badgeEl = document.createElement('div');
    _badgeEl.id = 'lam-sync-badge';
    _badgeEl.style.cssText = `
      display:inline-flex;align-items:center;gap:5px;
      font-size:11px;font-weight:500;padding:4px 10px;border-radius:20px;
      cursor:pointer;transition:all 0.2s;white-space:nowrap;flex-shrink:0;
      background:var(--surface-2,#1e1e1e);color:var(--text-secondary,#888);
      border:1px solid var(--border-subtle,#333);
    `;
    _badgeEl.onclick = () => window.LAM?.Router?.navigate?.('settings');
    _badgeEl.title = 'Cloud Sync — click to configure';

    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) {
      const backupBadge = document.getElementById('lam-backup-badge');
      if (backupBadge) topbarRight.insertBefore(_badgeEl, backupBadge);
      else topbarRight.insertBefore(_badgeEl, topbarRight.firstChild);
    }

    _updateBadge();
  }

  function _updateBadge(state) {
    if (!_badgeEl) return;
    if (!_active) {
      _badgeEl.style.display = 'none';
      return;
    }
    _badgeEl.style.display = 'inline-flex';

    const states = {
      syncing: { bg:'rgba(10,132,255,0.12)', color:'#0A84FF', icon:'⏳', text:'Syncing…' },
      synced:  {
        bg:'rgba(48,209,88,0.10)', color:'#30D158', icon:'☁️',
        text: _lastSync ? `Synced ${_relTime(_lastSync)}` : 'Synced',
      },
      pending: { bg:'rgba(255,214,10,0.10)', color:'#FFD60A', icon:'⚠️', text:`${_pendingCnt} pending` },
      error:   { bg:'rgba(255,69,58,0.10)',  color:'#FF453A', icon:'✗',  text:'Sync error' },
      idle:    { bg:'var(--surface-2,#1e1e1e)', color:'var(--text-secondary,#888)', icon:'☁️', text:'Cloud' },
    };

    const s = states[state || (_pendingCnt > 0 ? 'pending' : _lastSync ? 'synced' : 'idle')];
    _badgeEl.style.background  = s.bg;
    _badgeEl.style.color       = s.color;
    _badgeEl.style.borderColor = s.color + '44';
    _badgeEl.innerHTML         = `<span>${s.icon}</span><span>${s.text}</span>`;
  }

  function _relTime(d) {
    const diff = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (diff < 1)  return 'just now';
    if (diff < 60) return `${diff}m ago`;
    return `${Math.floor(diff/60)}h ago`;
  }

  // Start badge refresh every minute
  setInterval(() => {
    if (_lastSync) _updateBadge(_pendingCnt > 0 ? 'pending' : 'synced');
  }, 60_000);

  // ══════════════════════════════════════════════════════════
  // SECTION 3 — E-WAY BILL (Full NIC Format)
  // ══════════════════════════════════════════════════════════

  // NIC-format state codes
  const STATE_CODES = {
    'Andaman and Nicobar Islands':'35','Andhra Pradesh':'37','Arunachal Pradesh':'12',
    'Assam':'18','Bihar':'10','Chandigarh':'04','Chhattisgarh':'22','Dadra and Nagar Haveli':'26',
    'Daman and Diu':'25','Delhi':'07','Goa':'30','Gujarat':'24','Haryana':'06',
    'Himachal Pradesh':'02','Jammu and Kashmir':'01','Jharkhand':'20','Karnataka':'29',
    'Kerala':'32','Lakshadweep':'31','Madhya Pradesh':'23','Maharashtra':'27','Manipur':'14',
    'Meghalaya':'17','Mizoram':'15','Nagaland':'13','Odisha':'21','Pondicherry':'34',
    'Punjab':'03','Rajasthan':'08','Sikkim':'11','Tamil Nadu':'33','Telangana':'36',
    'Tripura':'16','Uttar Pradesh':'09','Uttarakhand':'05','West Bengal':'19',
  };

  /**
   * Generate NIC portal-compatible e-Way Bill JSON.
   * @param {object} form — all e-Way Bill form fields
   * @returns {object} NIC JSON payload
   */
  function generateEWayBillJSON(form) {
    const {
      supplyType = 'O', subSupplyType = '1', docType = 'INV',
      docNo, docDate,
      fromGSTIN, fromName, fromAddr1, fromAddr2, fromCity, fromPincode, fromStateCode,
      toGSTIN, toName, toAddr1, toAddr2, toCity, toPincode, toStateCode,
      items = [],
      transporterId, transporterName, transDocNo, transDocDate,
      vehicleNo, vehicleType = 'R', transDistance,
      transportMode = '1',
    } = form;

    const itemList = items.map((it, i) => ({
      itemNo:        i + 1,
      productName:   it.productName || it.description || '',
      productDesc:   it.productDesc || it.productName || '',
      hsnCode:       it.hsnCode || '',
      quantity:      Number(it.quantity || 0),
      qtyUnit:       it.unit || 'NOS',
      taxableAmount: Number(it.taxableValue || 0),
      sgstRate:      Number(it.sgstRate || 0),
      cgstRate:      Number(it.cgstRate || 0),
      igstRate:      Number(it.igstRate || 0),
      cessRate:      Number(it.cessRate || 0),
      cessNonAdvol:  0,
    }));

    const totalValue   = itemList.reduce((s,i) => s + i.taxableAmount, 0);
    const totalCGST    = itemList.reduce((s,i) => s + (i.taxableAmount * i.cgstRate / 100), 0);
    const totalSGST    = itemList.reduce((s,i) => s + (i.taxableAmount * i.sgstRate / 100), 0);
    const totalIGST    = itemList.reduce((s,i) => s + (i.taxableAmount * i.igstRate / 100), 0);
    const totalCess    = itemList.reduce((s,i) => s + (i.taxableAmount * i.cessRate / 100), 0);
    const totInvValue  = totalValue + totalCGST + totalSGST + totalIGST + totalCess;

    return {
      version:    '1.0.0621',
      billLists: null,
      userGstin:  fromGSTIN,
      supplyType,
      subSupplyType,
      subSupplyDesc: '',
      docType,
      docNo:          docNo || '',
      docDate:        docDate || '',
      fromGstin:      fromGSTIN || '',
      fromTrdName:    fromName  || '',
      fromAddr1:      fromAddr1 || '',
      fromAddr2:      fromAddr2 || '',
      fromPlace:      fromCity  || '',
      fromPincode:    Number(fromPincode || 0),
      actFromStateCode: Number(fromStateCode || 32),
      fromStateCode:  Number(fromStateCode || 32),
      toGstin:        toGSTIN || '',
      toTrdName:      toName  || '',
      toAddr1:        toAddr1 || '',
      toAddr2:        toAddr2 || '',
      toPlace:        toCity  || '',
      toPincode:      Number(toPincode || 0),
      actToStateCode: Number(toStateCode || 32),
      toStateCode:    Number(toStateCode || 32),
      totInvValue:    Math.round(totInvValue * 100) / 100,
      totalValue:     Math.round(totalValue * 100) / 100,
      cgstValue:      Math.round(totalCGST  * 100) / 100,
      sgstValue:      Math.round(totalSGST  * 100) / 100,
      igstValue:      Math.round(totalIGST  * 100) / 100,
      cessValue:      Math.round(totalCess  * 100) / 100,
      cessNonAdvolValue: 0,
      otherValue:     0,
      paymentDetails: '',
      dispatchFromGSTIN:   '',
      dispatchFromTrdName: '',
      shipToGSTIN:  '',
      shipToTrdName:'',
      itemList,
      transactionType: 1,
      transporterId:   transporterId  || '',
      transporterName: transporterName || '',
      transDocNo:      transDocNo || '',
      transDocDate:    transDocDate || '',
      vehicleNo:       (vehicleNo || '').toUpperCase().replace(/\s/g,''),
      vehicleType,
      transDistance:   Number(transDistance || 0),
      transportMode,
    };
  }

  /**
   * Inject the full e-Way Bill form to replace the existing stub in gst.js.
   * Called by renderEWayBillTab override.
   */
  function renderEWayBillForm(container, prefill = {}) {
    const states  = Object.entries(STATE_CODES);
    const stateOpts = states.map(([name, code]) =>
      `<option value="${code}" ${code === '32' ? 'selected' : ''}>${name} (${code})</option>`
    ).join('');

    container.innerHTML = `
      <div class="alert alert-info" style="margin-bottom:16px;">
        <span class="alert-icon">🚚</span>
        <div>
          <div class="alert-title">e-Way Bill — NIC Portal Format</div>
          <div class="alert-text">
            Fill the form and click <strong>Generate e-Way Bill JSON</strong>.
            Upload the downloaded JSON at
            <a href="https://ewaybillgst.gov.in" target="_blank" style="color:var(--brand-primary);">
              ewaybillgst.gov.in
            </a> to get your EWB number.
            API auto-generation coming with Supabase + DotBase integration.
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:20px;" id="ewb-full-form">

        <!-- SECTION A: Transaction Details -->
        <div class="card">
          <div class="card-header"><div class="card-title">📋 Transaction Details</div></div>
          <div class="form-grid-3" style="gap:12px;">
            <div class="form-group">
              <label class="form-label">Supply Type *</label>
              <select id="ewb-supply-type" class="form-select">
                <option value="O">Outward</option><option value="I">Inward</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Sub-Type *</label>
              <select id="ewb-sub-type" class="form-select">
                <option value="1">Supply</option><option value="2">Import</option>
                <option value="3">Export</option><option value="4">Job Work</option>
                <option value="5">For Own Use</option><option value="6">Job Work Returns</option>
                <option value="7">Sales Return</option><option value="8">Others</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Document Type *</label>
              <select id="ewb-doc-type" class="form-select">
                <option value="INV">Tax Invoice</option><option value="BIL">Bill of Supply</option>
                <option value="BOE">Bill of Entry</option><option value="CHL">Delivery Challan</option>
                <option value="OTH">Others</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Document No. *</label>
              <input type="text" id="ewb-doc-no" class="form-input"
                value="${prefill.invoiceNumber || ''}" placeholder="INV-001">
            </div>
            <div class="form-group">
              <label class="form-label">Document Date *</label>
              <input type="date" id="ewb-doc-date" class="form-input"
                value="${prefill.invoiceDate || new Date().toISOString().slice(0,10)}">
            </div>
          </div>
        </div>

        <!-- SECTION B: From Details -->
        <div class="card">
          <div class="card-header"><div class="card-title">📤 From (Consignor / Supplier)</div></div>
          <div class="form-grid-2" style="gap:12px;">
            <div class="form-group">
              <label class="form-label">GSTIN *</label>
              <input type="text" id="ewb-from-gstin" class="form-input" maxlength="15"
                style="text-transform:uppercase;"
                value="${prefill.fromGSTIN || ''}" placeholder="32AABCC1234D1Z5">
            </div>
            <div class="form-group">
              <label class="form-label">Trade Name *</label>
              <input type="text" id="ewb-from-name" class="form-input"
                value="${prefill.fromName || ''}" placeholder="Your Company Name">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 1 *</label>
              <input type="text" id="ewb-from-addr1" class="form-input"
                value="${prefill.fromAddr1 || ''}" placeholder="Door No, Street">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 2</label>
              <input type="text" id="ewb-from-addr2" class="form-input"
                value="${prefill.fromAddr2 || ''}" placeholder="Area, Locality">
            </div>
            <div class="form-group">
              <label class="form-label">City *</label>
              <input type="text" id="ewb-from-city" class="form-input"
                value="${prefill.fromCity || ''}" placeholder="Kottayam">
            </div>
            <div class="form-group">
              <label class="form-label">Pincode *</label>
              <input type="text" id="ewb-from-pin" class="form-input"
                value="${prefill.fromPincode || ''}" maxlength="6" placeholder="686001">
            </div>
            <div class="form-group">
              <label class="form-label">State *</label>
              <select id="ewb-from-state" class="form-select">${stateOpts}</select>
            </div>
          </div>
        </div>

        <!-- SECTION C: To Details -->
        <div class="card">
          <div class="card-header"><div class="card-title">📥 To (Consignee / Recipient)</div></div>
          <div class="form-grid-2" style="gap:12px;">
            <div class="form-group">
              <label class="form-label">GSTIN *</label>
              <input type="text" id="ewb-to-gstin" class="form-input" maxlength="15"
                style="text-transform:uppercase;"
                value="${prefill.toGSTIN || ''}" placeholder="GSTIN or URP">
            </div>
            <div class="form-group">
              <label class="form-label">Trade Name *</label>
              <input type="text" id="ewb-to-name" class="form-input"
                value="${prefill.toName || ''}" placeholder="Customer Name">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 1 *</label>
              <input type="text" id="ewb-to-addr1" class="form-input"
                value="${prefill.toAddr1 || ''}" placeholder="Door No, Street">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 2</label>
              <input type="text" id="ewb-to-addr2" class="form-input"
                value="${prefill.toAddr2 || ''}" placeholder="Area, Locality">
            </div>
            <div class="form-group">
              <label class="form-label">City *</label>
              <input type="text" id="ewb-to-city" class="form-input"
                value="${prefill.toCity || ''}" placeholder="Ernakulam">
            </div>
            <div class="form-group">
              <label class="form-label">Pincode *</label>
              <input type="text" id="ewb-to-pin" class="form-input"
                value="${prefill.toPincode || ''}" maxlength="6" placeholder="682001">
            </div>
            <div class="form-group">
              <label class="form-label">State *</label>
              <select id="ewb-to-state" class="form-select">${stateOpts}</select>
            </div>
          </div>
        </div>

        <!-- SECTION D: Item Details -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">📦 Item Details</div>
            <button class="btn btn-secondary btn-sm" onclick="window.LAMCloud.addEWBItem()">+ Add Item</button>
          </div>
          <div id="ewb-items-container">
            <div class="table-container">
              <table class="table" id="ewb-items-table">
                <thead>
                  <tr>
                    <th>Product Name</th><th>HSN</th><th>Unit</th>
                    <th>Qty</th><th>Taxable Value (₹)</th>
                    <th>CGST%</th><th>SGST%</th><th>IGST%</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="ewb-items-body"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- SECTION E: Transport Details -->
        <div class="card">
          <div class="card-header"><div class="card-title">🚛 Transport Details</div></div>
          <div class="form-grid-3" style="gap:12px;">
            <div class="form-group">
              <label class="form-label">Transport Mode *</label>
              <select id="ewb-trans-mode" class="form-select">
                <option value="1">Road</option><option value="2">Rail</option>
                <option value="3">Air</option><option value="4">Ship</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Vehicle No. *</label>
              <input type="text" id="ewb-vehicle-no" class="form-input"
                style="text-transform:uppercase;"
                value="${prefill.vehicleNo || ''}" placeholder="KL01AB1234">
            </div>
            <div class="form-group">
              <label class="form-label">Distance (KM) *</label>
              <input type="number" id="ewb-distance" class="form-input"
                value="${prefill.distanceKm || ''}" placeholder="150" min="0">
            </div>
            <div class="form-group">
              <label class="form-label">Transporter GSTIN</label>
              <input type="text" id="ewb-trans-gstin" class="form-input"
                style="text-transform:uppercase;" placeholder="Transporter GSTIN (if applicable)">
            </div>
            <div class="form-group">
              <label class="form-label">Transport Doc No.</label>
              <input type="text" id="ewb-trans-doc-no" class="form-input" placeholder="LR/GR Number">
            </div>
            <div class="form-group">
              <label class="form-label">Transport Doc Date</label>
              <input type="date" id="ewb-trans-doc-date" class="form-input">
            </div>
          </div>
        </div>

        <!-- ACTIONS -->
        <div class="card">
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="window.LAMCloud.downloadEWBJSON()">
              ⬇ Generate & Download JSON
            </button>
            <button class="btn btn-secondary" onclick="window.LAMCloud.printEWBPDF()">
              🖨️ Print e-Way Bill
            </button>
            <button class="btn btn-ghost btn-sm" onclick="window.LAMCloud.resetEWBForm()">
              ↺ Reset
            </button>
          </div>
          <div style="margin-top:10px;padding:10px;background:var(--bg-elevated);border-radius:8px;
                      font-size:11px;color:var(--text-muted);line-height:1.6;">
            <strong>Next steps after download:</strong>
            Visit <a href="https://ewaybillgst.gov.in" target="_blank"
              style="color:var(--brand-primary);">ewaybillgst.gov.in</a>
            → Login → e-Way Bill → Generate New → Import JSON.
            Your EWB number will be generated by the NIC portal.
          </div>
        </div>

      </div>
    `;

    // Add first item row
    window.LAMCloud.addEWBItem(prefill.items?.[0]);
  }

  let _ewbItemIdx = 0;

  window.LAMCloud = window.LAMCloud || {};

  window.LAMCloud.addEWBItem = function(prefill = {}) {
    _ewbItemIdx++;
    const i = _ewbItemIdx;
    const tbody = document.getElementById('ewb-items-body');
    if (!tbody) return;
    const row = document.createElement('tr');
    row.id = `ewb-item-${i}`;
    row.innerHTML = `
      <td><input type="text" class="form-input" id="ewb-item-name-${i}"
        value="${prefill.productName || prefill.description || ''}" placeholder="Product name"></td>
      <td><input type="text" class="form-input" id="ewb-item-hsn-${i}"
        value="${prefill.hsnCode || ''}" placeholder="8704" maxlength="8" style="width:80px;"></td>
      <td><input type="text" class="form-input" id="ewb-item-unit-${i}"
        value="${prefill.unit || 'NOS'}" placeholder="NOS" style="width:60px;"></td>
      <td><input type="number" class="form-input" id="ewb-item-qty-${i}"
        value="${prefill.quantity || 1}" min="0" style="width:70px;"></td>
      <td><input type="number" class="form-input" id="ewb-item-val-${i}"
        value="${prefill.taxableValue || prefill.subtotal || ''}" min="0" placeholder="0"></td>
      <td><input type="number" class="form-input" id="ewb-item-cgst-${i}"
        value="${prefill.cgstRate || 9}" min="0" max="28" style="width:60px;"></td>
      <td><input type="number" class="form-input" id="ewb-item-sgst-${i}"
        value="${prefill.sgstRate || 9}" min="0" max="28" style="width:60px;"></td>
      <td><input type="number" class="form-input" id="ewb-item-igst-${i}"
        value="${prefill.igstRate || 0}" min="0" max="28" style="width:60px;"></td>
      <td><button onclick="document.getElementById('ewb-item-${i}').remove()"
        style="background:none;border:none;cursor:pointer;color:var(--color-danger);">🗑</button></td>
    `;
    tbody.appendChild(row);
  };

  function _collectEWBForm() {
    const g = id => document.getElementById(id)?.value?.trim() || '';
    const n = id => Number(document.getElementById(id)?.value) || 0;

    // Collect items
    const items = [];
    document.querySelectorAll('[id^="ewb-item-name-"]').forEach(el => {
      const i = el.id.replace('ewb-item-name-', '');
      items.push({
        productName:  g(`ewb-item-name-${i}`),
        hsnCode:      g(`ewb-item-hsn-${i}`),
        unit:         g(`ewb-item-unit-${i}`),
        quantity:     n(`ewb-item-qty-${i}`),
        taxableValue: n(`ewb-item-val-${i}`),
        cgstRate:     n(`ewb-item-cgst-${i}`),
        sgstRate:     n(`ewb-item-sgst-${i}`),
        igstRate:     n(`ewb-item-igst-${i}`),
        cessRate:     0,
      });
    });

    return {
      supplyType:     g('ewb-supply-type'),
      subSupplyType:  g('ewb-sub-type'),
      docType:        g('ewb-doc-type'),
      docNo:          g('ewb-doc-no'),
      docDate:        g('ewb-doc-date'),
      fromGSTIN:      g('ewb-from-gstin'),
      fromName:       g('ewb-from-name'),
      fromAddr1:      g('ewb-from-addr1'),
      fromAddr2:      g('ewb-from-addr2'),
      fromCity:       g('ewb-from-city'),
      fromPincode:    g('ewb-from-pin'),
      fromStateCode:  n('ewb-from-state'),
      toGSTIN:        g('ewb-to-gstin'),
      toName:         g('ewb-to-name'),
      toAddr1:        g('ewb-to-addr1'),
      toAddr2:        g('ewb-to-addr2'),
      toCity:         g('ewb-to-city'),
      toPincode:      g('ewb-to-pin'),
      toStateCode:    n('ewb-to-state'),
      items,
      transportMode:  g('ewb-trans-mode'),
      vehicleNo:      g('ewb-vehicle-no'),
      transDistance:  n('ewb-distance'),
      transporterId:  g('ewb-trans-gstin'),
      transDocNo:     g('ewb-trans-doc-no'),
      transDocDate:   g('ewb-trans-doc-date'),
    };
  }

  window.LAMCloud.downloadEWBJSON = function() {
    const form    = _collectEWBForm();
    if (!form.docNo || !form.fromGSTIN) {
      window.LAM?.Toast?.error('Incomplete', 'Document number and From GSTIN are required.');
      return;
    }
    const payload = generateEWayBillJSON(form);
    const blob    = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
    const a       = document.createElement('a');
    a.href        = URL.createObjectURL(blob);
    a.download    = `EWayBill_${form.docNo}_${form.docDate || new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    window.LAM?.Toast?.success('Downloaded!', 'Upload at ewaybillgst.gov.in to get your EWB number.');
  };

  window.LAMCloud.printEWBPDF = function() {
    const form = _collectEWBForm();
    if (!window.LAMPDF) {
      window.LAM?.Toast?.warning('Not Available', 'PDF engine not loaded.');
      return;
    }
    const totalVal = form.items.reduce((s,i) => s + i.taxableValue, 0);
    const totalGST  = form.items.reduce((s,i) =>
      s + i.taxableValue * (i.cgstRate + i.sgstRate + i.igstRate) / 100, 0);
    // Use deliveryNote as the closest proxy for e-Way Bill print
    window.LAMPDF.deliveryNote({
      dnNumber:        form.docNo,
      date:            form.docDate,
      driverName:      '',
      vehicle:         form.vehicleNo,
      notes:           `e-Way Bill | Vehicle: ${form.vehicleNo} | Dist: ${form.transDistance}km | Mode: ${['','Road','Rail','Air','Ship'][form.transportMode]||'Road'}`,
      customerName:    form.toName,
      deliveryAddress: `${form.toAddr1}, ${form.toAddr2}, ${form.toCity} - ${form.toPincode}`,
    }, { name: form.fromName, address: `${form.fromAddr1}, ${form.fromCity}` },
    { name: form.toName }, form.items.map(i => ({
      productName:  i.productName,
      unit:         i.unit,
      qty:          i.quantity,
      orderedQty:   i.quantity,
      deliveredQty: i.quantity,
      remarks:      `HSN: ${i.hsnCode} | Tax: ₹${(i.taxableValue*(i.cgstRate+i.sgstRate+i.igstRate)/100).toFixed(0)}`,
    })));
  };

  window.LAMCloud.resetEWBForm = function() {
    document.getElementById('ewb-full-form')?.querySelectorAll('input,select')
      .forEach(el => { if (el.type === 'text'||el.type==='number') el.value=''; });
    document.getElementById('ewb-items-body').innerHTML = '';
    _ewbItemIdx = 0;
    window.LAMCloud.addEWBItem();
  };

  // ══════════════════════════════════════════════════════════
  // SECTION 4 — RAZORPAY PAYMENT LINKS
  // ══════════════════════════════════════════════════════════

  function getRZPKey() {
    return localStorage.getItem(LS_RZP_KEY) || '';
  }

  function saveRZPKey(key) {
    localStorage.setItem(LS_RZP_KEY, key.trim());
  }

  /**
   * Open Razorpay checkout for an invoice.
   * Uses Razorpay's hosted checkout flow — no backend required.
   * On success: marks invoice as paid in IndexedDB.
   */
  async function openRazorpayCheckout(invoiceId) {
    const rzpKey = getRZPKey();
    if (!rzpKey) {
      window.LAM?.Toast?.error('Not Configured',
        'Add your Razorpay Key ID in Settings → Payments first.');
      return;
    }

    const db  = _db();
    if (!db) return;
    const inv = await db.dbGet('invoices', invoiceId).catch(() => null);
    if (!inv) { window.LAM?.Toast?.error('Not Found', 'Invoice not found.'); return; }

    if (inv.paymentStatus === 'paid') {
      window.LAM?.Toast?.info('Already Paid', 'This invoice is already marked as paid.');
      return;
    }

    // Load Razorpay SDK on demand
    if (!window.Razorpay) {
      await _loadScript('https://checkout.razorpay.com/v1/checkout.js');
    }

    const company   = (await db.dbGetAll('companies').catch(() => []))[0] || {};
    const customers = await db.dbGetAll('customers').catch(() => []);
    const customer  = customers.find(c => c.id === inv.customerId) || {};

    const amountPaise = Math.round(Number(inv.totalAmount || inv.grandTotal || 0) * 100);
    if (amountPaise <= 0) {
      window.LAM?.Toast?.error('Invalid Amount', 'Invoice amount must be greater than 0.');
      return;
    }

    const options = {
      key:          rzpKey,
      amount:       amountPaise,
      currency:     'INR',
      name:         company.name || 'LAM Business',
      description:  `Invoice ${inv.invoiceNumber || inv.id}`,
      image:        company.logoUrl || '',
      notes: {
        invoice_id:   inv.id,
        invoice_no:   inv.invoiceNumber || '',
        customer_name: customer.name || '',
      },
      prefill: {
        name:  customer.name  || '',
        email: customer.email || '',
        contact: (customer.phone || '').replace(/\D/g,''),
      },
      theme: { color: '#2563EB' },

      handler: async function(response) {
        // Payment success — mark invoice as paid in IndexedDB
        const now = new Date().toISOString();
        const updatedInv = {
          ...inv,
          paymentStatus:    'paid',
          paidAt:           now,
          paymentMethod:    'razorpay',
          razorpayPaymentId: response.razorpay_payment_id,
          razorpayOrderId:   response.razorpay_order_id || null,
          updatedAt:        now,
        };
        await db.dbSet('invoices', invoiceId, updatedInv);

        // Record in payments collection
        await db.dbSet('fin_payments', 'pay_' + Date.now(), {
          id:            'pay_' + Date.now(),
          invoiceId,
          invoiceNumber: inv.invoiceNumber,
          customerId:    inv.customerId,
          amount:        Number(inv.totalAmount || 0),
          method:        'razorpay',
          reference:     response.razorpay_payment_id,
          date:          now.slice(0,10),
          createdAt:     now,
        });

        window.LAM?.Toast?.success(
          '💳 Payment Received!',
          `₹${Number(inv.totalAmount||0).toLocaleString('en-IN')} received for ${inv.invoiceNumber || invoiceId}.`
        );

        // Generate receipt PDF
        if (window.LAMPDF) {
          setTimeout(() => {
            window.LAMPDF.invoice(updatedInv, company, customer);
          }, 500);
        }

        // Cloud sync
        window.LAMCloud?.push({ type:'update', col:'invoices', record: updatedInv, ts: Date.now() });
      },

      modal: {
        ondismiss: function() {
          window.LAM?.Toast?.info('Payment Cancelled', 'The payment was not completed.');
        },
      },
    };

    try {
      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function(resp) {
        window.LAM?.Toast?.error('Payment Failed', resp.error?.description || 'Payment could not be processed.');
      });
      rzp.open();
    } catch (e) {
      window.LAM?.Toast?.error('Razorpay Error', e.message);
    }
  }

  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 5 — DATA EXPORT SUITE
  // ══════════════════════════════════════════════════════════

  /**
   * Full data export — all formats, bundled as a ZIP.
   * Uses the pure-JS ZIP builder already in gst-export.js.
   */
  async function runFullExport(onStatus) {
    const emit = onStatus || (() => {});
    const db   = _db();
    if (!db) { emit('Error: Database not ready'); return; }

    const companies = await db.dbGetAll('companies').catch(() => []);
    const company   = companies[0] || {};
    const cName     = (company.name || 'LAM').replace(/\s+/g,'_');
    const dateStr   = new Date().toISOString().slice(0,10);
    const zipFiles  = [];

    emit('Loading invoices…');
    const invoices  = await db.dbGetAll('invoices').catch(() => []);
    const expenses  = await db.dbGetAll('expenses').catch(() => []);
    const trips     = await db.dbGetAll('tms_trips').catch(() => []);
    const customers = await db.dbGetAll('customers').catch(() => []);
    const payments  = await db.dbGetAll('fin_payments').catch(() => []);
    const period    = new Date().toISOString().slice(0,7);

    // 1. GSTR-1 JSON
    if (window.GSTExport?.buildGSTR1) {
      emit('Building GSTR-1…');
      try {
        const gstr1 = window.GSTExport.buildGSTR1(period, {
          invoices, customers,
          sellerGSTIN: company.gstin || '',
          sellerStateCode: '32',
        });
        zipFiles.push({ name: `GSTR1_${period}.json`, data: JSON.stringify(gstr1, null, 2) });
      } catch {}
    }

    // 2. GSTR-3B JSON
    if (window.GSTExport?.buildGSTR3B) {
      emit('Building GSTR-3B…');
      try {
        const gstr3b = window.GSTExport.buildGSTR3B(period, {
          invoices, sellerGSTIN: company.gstin || '', sellerStateCode: '32'
        });
        zipFiles.push({ name: `GSTR3B_${period}.json`, data: JSON.stringify(gstr3b, null, 2) });
      } catch {}
    }

    // 3. Tally XML
    if (window.LAMSafety?.exportTallyXML) {
      emit('Building Tally XML…');
      try {
        const cfg = window.LAMSafety.getTallyConfig?.() || {};
        const tallyPayload = { fromDate: period + '-01', toDate: period + '-31', noDownload: true };
        // Build inline since exportTallyXML downloads directly
        // We'll add the XML separately via a workaround
        const tallyInvs = invoices.filter(i =>
          (i.invoiceDate || i.createdAt || '').startsWith(period));
        if (tallyInvs.length > 0 && window.LAMSafety?._buildTallyVoucher) {
          const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));
          const voucherBlocks = tallyInvs.map(inv =>
            window.LAMSafety._buildTallyVoucher(inv, cfg, customerMap)).join('');
          const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${voucherBlocks}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
          zipFiles.push({ name: `${cName}_Tally_${period}.xml`, data: xml });
        }
      } catch {}
    }

    // 4. Invoices Excel
    if (window.LAMEXCEL?.invoices && invoices.length) {
      emit('Building Invoices Excel…');
      try {
        // LAMEXCEL.invoices downloads directly — capture via override
        const xlsxBytes = await _captureExcelAsBytes(() => window.LAMEXCEL.invoices(invoices, company));
        if (xlsxBytes) zipFiles.push({ name: `Invoices_${dateStr}.xlsx`, data: xlsxBytes, binary: true });
        else zipFiles.push({ name: `Invoices_${dateStr}.csv`, data: _invoicesToCSV(invoices, customers) });
      } catch { zipFiles.push({ name: `Invoices_${dateStr}.csv`, data: _invoicesToCSV(invoices, customers) }); }
    }

    // 5. Expenses Excel
    if (expenses.length) {
      emit('Building Expenses CSV…');
      zipFiles.push({ name: `Expenses_${dateStr}.csv`, data: _expensesToCSV(expenses) });
    }

    // 6. Trips Excel
    if (trips.length) {
      emit('Building Trips CSV…');
      zipFiles.push({ name: `Trips_${dateStr}.csv`, data: _tripsToCSV(trips) });
    }

    // 7. Customer Ledger CSV
    if (customers.length && invoices.length) {
      emit('Building Customer Ledger…');
      zipFiles.push({ name: `CustomerLedger_${dateStr}.csv`, data: _customerLedgerCSV(customers, invoices, payments) });
    }

    // 8. Complete Backup JSON
    emit('Building full backup…');
    const backup = await _buildFullBackup(db);
    zipFiles.push({ name: `LAM_FullBackup_${dateStr}.json`, data: backup });

    // 9. README for CA
    zipFiles.push({ name: 'README_for_CA.txt', data: _caReadme(cName, period, zipFiles) });

    // Build and download ZIP
    emit('Compressing ZIP…');
    const zipBlob = await _buildZip(zipFiles);
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(zipBlob);
    a.download = `LAM_Export_${cName}_${dateStr}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);

    emit(`✅ Export complete! ${zipFiles.length} files packed.`);
    window.LAM?.Toast?.success('Export Ready', `${zipFiles.length} files downloaded as ZIP.`);

    return { ok: true, files: zipFiles.length };
  }

  function _invoicesToCSV(invoices, customers) {
    const custMap = Object.fromEntries((customers||[]).map(c=>[c.id,c]));
    const hdr = ['Invoice No','Date','Customer','GSTIN','Due Date','Status','Subtotal','GST','Total'];
    const rows = invoices.map(i => [
      i.invoiceNumber||'', i.invoiceDate||'',
      custMap[i.customerId]?.name||i.customerName||'',
      custMap[i.customerId]?.gstin||'',
      i.dueDate||'', i.paymentStatus||'unpaid',
      i.subtotal||0, i.gstAmount||0, i.totalAmount||0,
    ]);
    return [hdr, ...rows].map(r => r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  function _expensesToCSV(expenses) {
    const hdr = ['Date','Category','Description','Amount','Payment Mode','Reference'];
    const rows = expenses.map(e => [e.date||'',e.category||'',e.description||'',e.amount||0,e.paymentMode||'',e.reference||'']);
    return [hdr,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  function _tripsToCSV(trips) {
    const hdr = ['Trip No','Start Date','Origin','Destination','Driver','Vehicle','Distance(km)','Freight(₹)','Status'];
    const rows = trips.map(t=>[t.tripNumber||'',t.startDate||'',t.origin||'',t.destination||'',t.driverName||'',t.vehicleNumber||'',t.distanceKm||0,t.freightCost||0,t.status||'']);
    return [hdr,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  function _customerLedgerCSV(customers, invoices, payments) {
    const hdr = ['Customer','GSTIN','Phone','Invoice No','Invoice Date','Amount','Paid','Balance','Status'];
    const rows = [];
    customers.forEach(cust => {
      const custInvs = invoices.filter(i => i.customerId === cust.id);
      custInvs.forEach(inv => {
        const paid = (payments||[]).filter(p=>p.invoiceId===inv.id).reduce((s,p)=>s+Number(p.amount||0),0);
        rows.push([cust.name||'',cust.gstin||'',cust.phone||'',
          inv.invoiceNumber||'',inv.invoiceDate||'',inv.totalAmount||0,paid,
          Math.max(0,(Number(inv.totalAmount||0)-paid)),inv.paymentStatus||'']);
      });
    });
    return [hdr,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  async function _buildFullBackup(db) {
    const collections = window.LAMSafety?._getAllCollections?.() || [];
    const snapshot = { magic:'LAM_EXPORT_v1', exportedAt: new Date().toISOString(), data:{} };
    for (const col of collections) {
      try { const items = await db.dbGetAll(col); if (items?.length) snapshot.data[col] = items; } catch {}
    }
    return JSON.stringify(snapshot, null, 2);
  }

  function _caReadme(cName, period, files) {
    return `LAM Data Export — ${cName}
Generated: ${new Date().toLocaleString('en-IN')}
Period: ${period}

FILES IN THIS ZIP:
${files.map(f => `  • ${f.name}`).join('\n')}

GUIDE FOR YOUR CA:
  GSTR1_*.json    — Upload at GST portal for GSTR-1 filing
  GSTR3B_*.json   — Upload at GST portal for GSTR-3B filing
  *_Tally_*.xml   — Import in TallyPrime: Gateway → Import → Vouchers
  Invoices_*.csv  — Open in Excel for invoice reconciliation
  Expenses_*.csv  — Open in Excel for expense audit
  Trips_*.csv     — Fleet & logistics cost data
  CustomerLedger  — Receivables summary per customer
  LAM_FullBackup  — Complete data snapshot (JSON)

Generated by LAM v9 — Logistics Assets Management
Developed by Stratix Ecosystem | stratixapp@gmail.com
Contact: stratixecosystem1@gmail.com | stratixgrowup@gmail.com
`;
  }

  // Excel capture: LAMEXCEL.invoices downloads — we intercept via Blob URL override
  async function _captureExcelAsBytes(fn) {
    // LAMEXCEL uses an <a> click to download — we can't intercept cleanly
    // Return null to fall back to CSV
    return null;
  }

  // ── Pure-JS ZIP builder (no dependencies) ──────────────────
  async function _buildZip(files) {
    // Uses the same pure-JS ZIP engine as gst-export.js
    // Reproduced here for self-containment.
    const enc    = new TextEncoder();
    const parts  = [];
    const cdirs  = [];
    let   offset = 0;

    const crc32 = (data) => {
      let c = 0xFFFFFFFF;
      const t = new Uint32Array(256);
      for (let i=0;i<256;i++){let r=i;for(let j=0;j<8;j++) r=r&1?0xEDB88320^(r>>>1):r>>>1;t[i]=r;}
      for (let i=0;i<data.length;i++) c=t[(c^data[i])&0xFF]^(c>>>8);
      return (c^0xFFFFFFFF)>>>0;
    };

    const u32le = n => new Uint8Array([n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF]);
    const u16le = n => new Uint8Array([n&0xFF,(n>>8)&0xFF]);
    const dosDate = () => { const d=new Date(); return new Uint8Array([(d.getHours()<<11|d.getMinutes()<<5|d.getSeconds()>>1)&0xFF,((d.getHours()<<11|d.getMinutes()<<5|d.getSeconds()>>1)>>8)&0xFF,((d.getFullYear()-1980)<<9|((d.getMonth()+1)<<5)|d.getDate())&0xFF,(((d.getFullYear()-1980)<<9|((d.getMonth()+1)<<5)|d.getDate())>>8)&0xFF]); };

    const concat = (...arrays) => { const t=arrays.reduce((s,a)=>s+(a?.length||0),0),r=new Uint8Array(t);let off=0;arrays.forEach(a=>{if(a){r.set(a,off);off+=a.length;}});return r; };

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const data      = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
      const crc       = crc32(data);
      const lfh = concat(
        new Uint8Array([0x50,0x4B,0x03,0x04]),u16le(20),u16le(0),u16le(0),
        dosDate(),u32le(crc),u32le(data.length),u32le(data.length),
        u16le(nameBytes.length),u16le(0),nameBytes,data
      );
      const cde = concat(
        new Uint8Array([0x50,0x4B,0x01,0x02]),u16le(0x0314),u16le(20),
        u16le(0),u16le(0),dosDate(),u32le(crc),u32le(data.length),u32le(data.length),
        u16le(nameBytes.length),u16le(0),u16le(0),u16le(0),u16le(0),u32le(0),u32le(offset),
        nameBytes
      );
      parts.push(lfh); cdirs.push(cde);
      offset += lfh.length;
    }

    const cdData = concat(...cdirs);
    const eocd   = concat(
      new Uint8Array([0x50,0x4B,0x05,0x06]),u16le(0),u16le(0),
      u16le(files.length),u16le(files.length),
      u32le(cdData.length),u32le(offset),u16le(0)
    );
    const zip = concat(...parts, cdData, eocd);
    return new Blob([zip], { type:'application/zip' });
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 6 — SUPABASE SQL MIGRATION GENERATOR
  // ══════════════════════════════════════════════════════════

  function generateSetupSQL() {
    const tables = SYNC_COLLECTIONS;

    const tableSQL = tables.map(col => {
      const tbl = _colToTable(col);
      return `
-- Table: ${tbl}
CREATE TABLE IF NOT EXISTS public.${tbl} (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT,
  company_id  TEXT NOT NULL DEFAULT 'default',
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_${tbl}_company ON public.${tbl}(company_id);
CREATE INDEX IF NOT EXISTS idx_${tbl}_updated ON public.${tbl}(updated_at);

ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "${tbl}_company_isolation"
  ON public.${tbl} FOR ALL
  USING (company_id = current_setting('app.company_id', true));

CREATE OR REPLACE TRIGGER trg_${tbl}_updated_at
  BEFORE UPDATE ON public.${tbl}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;
    }).join('\n');

    return `-- ================================================
-- LAM v9 Supabase Setup SQL
-- Run this ONCE in your Supabase SQL Editor
-- Generated: ${new Date().toISOString()}
-- ================================================

-- Updated-at trigger function (run once)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

${tableSQL}

-- GPS pings table (high-volume, separate structure)
CREATE TABLE IF NOT EXISTS public.location_logs (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL,
  driver_id   TEXT,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy    REAL,
  timestamp   TIMESTAMPTZ NOT NULL,
  company_id  TEXT NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  _synced     BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_loc_trip    ON public.location_logs(trip_id);
CREATE INDEX IF NOT EXISTS idx_loc_ts      ON public.location_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_loc_company ON public.location_logs(company_id);
ALTER TABLE public.location_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "loc_company_isolation"
  ON public.location_logs FOR ALL
  USING (company_id = current_setting('app.company_id', true));

-- ================================================
-- HOW TO USE:
-- 1. Open your Supabase project → SQL Editor
-- 2. Paste this entire script and click Run
-- 3. Go to Settings → Cloud Sync in LAM
-- 4. Enter your Project URL and anon key
-- 5. Click Test Connection → Save
-- ================================================
`;
  }

  function downloadSetupSQL() {
    const sql  = generateSetupSQL();
    const blob = new Blob([sql], { type:'text/sql' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `LAM_Supabase_Setup_${new Date().toISOString().slice(0,10)}.sql`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ══════════════════════════════════════════════════════════
  // SETTINGS CARDS (injected into settings.js)
  // ══════════════════════════════════════════════════════════

  function renderCloudSettingsCard() {
    const url = localStorage.getItem(LS_SUPABASE_URL) || '';
    const key = localStorage.getItem(LS_SUPABASE_KEY) || '';
    const configured = !!(url && key);

    return `
      <div class="card" id="lam-cloud-settings-card">
        <div class="card-header">
          <div class="card-title">☁️ Cloud Sync (Supabase)</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            Optional — app works 100% offline without this
          </div>
        </div>

        ${configured ? `
          <div class="alert alert-success" style="margin-bottom:12px;">
            <span class="alert-icon">✅</span>
            <div>
              <div class="alert-title">Supabase Connected</div>
              <div class="alert-text">${url.slice(0,40)}…</div>
            </div>
          </div>
        ` : `
          <div class="alert alert-info" style="margin-bottom:12px;">
            <span class="alert-icon">ℹ️</span>
            <div>
              <div class="alert-title">Not configured</div>
              <div class="alert-text">Enter your Supabase credentials to enable cloud sync across devices.</div>
            </div>
          </div>
        `}

        <div style="display:flex;flex-direction:column;gap:10px;">
          <div class="form-group">
            <label class="form-label">Supabase Project URL</label>
            <input type="url" id="cloud-sb-url" class="form-input"
              value="${url}" placeholder="https://xxxx.supabase.co">
          </div>
          <div class="form-group">
            <label class="form-label">Supabase Anon Key (public, safe)</label>
            <input type="text" id="cloud-sb-key" class="form-input"
              value="${key}" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…">
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="cloud-save-btn"
              onclick="window.LAMCloud._saveCloudConfig()">
              💾 Save & Connect
            </button>
            <button class="btn btn-secondary btn-sm"
              onclick="window.LAMCloud._testConnection()">
              🔌 Test Connection
            </button>
            ${configured ? `
              <button class="btn btn-ghost btn-sm"
                onclick="window.LAMCloud._clearCloudConfig()">
                ✕ Disconnect
              </button>` : ''}
          </div>
          <div id="cloud-test-result" style="font-size:12px;min-height:16px;"></div>

          <div style="border-top:1px solid var(--border-subtle);padding-top:12px;margin-top:4px;">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;">First-time setup</div>
            <button class="btn btn-secondary btn-sm"
              onclick="window.LAMCloud.downloadSetupSQL()">
              ⬇ Download Supabase Setup SQL
            </button>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.5;">
              Run this SQL once in your Supabase SQL Editor to create all tables,
              indexes, and Row Level Security policies.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPaymentsSettingsCard() {
    const rzpKey = getRZPKey();
    return `
      <div class="card" id="lam-payments-settings-card">
        <div class="card-header">
          <div class="card-title">💳 Razorpay Payments</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            Accept payments directly from invoices — no backend needed
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="alert alert-info" style="margin:0;">
            <span class="alert-icon">🔑</span>
            <div>
              <div class="alert-title">Public Key Only — Safe in Frontend</div>
              <div class="alert-text">
                Only enter your Razorpay <strong>Key ID</strong> (starts with rzp_live_ or rzp_test_).
                Never enter the Key Secret here. Payments open Razorpay's secure hosted page.
              </div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Razorpay Key ID</label>
            <input type="text" id="rzp-key-input" class="form-input"
              value="${rzpKey}" placeholder="rzp_live_xxxxxxxxxxxxx or rzp_test_xxx">
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm"
              onclick="window.LAMCloud._saveRZPKey()">
              💾 Save Key
            </button>
            ${rzpKey ? `
              <span style="font-size:12px;color:var(--color-success,#059669);
                           align-self:center;font-weight:600;">
                ✅ ${rzpKey.startsWith('rzp_live_') ? 'Live Mode' : 'Test Mode'} configured
              </span>` : ''}
          </div>
          <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;
                      font-size:11px;color:var(--text-muted);line-height:1.6;">
            <strong>How to use:</strong> Open any unpaid invoice →
            Actions menu → 💳 Request Payment →
            Customer sees Razorpay checkout page →
            Payment confirmed automatically in LAM.
            <br><br>
            <strong>Note:</strong> For automatic webhook confirmation
            (without the customer returning to the page), connect DotBase/Supabase backend later.
          </div>
        </div>
      </div>
    `;
  }

  function renderExportSettingsCard() {
    return `
      <div class="card" id="lam-export-settings-card">
        <div class="card-header">
          <div class="card-title">📦 Data Export Suite</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            One-click full export for CA handoff
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div id="export-status-log" style="
            background:var(--bg-elevated);border-radius:8px;padding:12px;
            font-size:11px;color:var(--text-secondary);min-height:36px;
            font-family:var(--font-mono);line-height:1.8;display:none;
          "></div>

          <button class="btn btn-primary" id="full-export-btn"
            onclick="window.LAMCloud.startFullExport()">
            📦 Download Full Export ZIP
          </button>

          <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;
                      font-size:11px;color:var(--text-muted);line-height:1.6;">
            <strong>Includes:</strong>
            GSTR-1 JSON · GSTR-3B JSON · Tally XML ·
            Invoices CSV · Expenses CSV · Trips CSV ·
            Customer Ledger CSV · Complete Backup JSON · README for CA
          </div>
        </div>
      </div>
    `;
  }

  // Settings-wired actions
  window.LAMCloud._saveCloudConfig = function() {
    const url = document.getElementById('cloud-sb-url')?.value?.trim();
    const key = document.getElementById('cloud-sb-key')?.value?.trim();
    if (!url || !key) {
      window.LAM?.Toast?.error('Required', 'Enter both URL and anon key.');
      return;
    }
    configure(url, key);
    _startSyncTimer();
    injectSyncBadge();
    window.LAM?.Toast?.success('Cloud Sync Enabled', 'Supabase connected. Syncing in background.');
    document.getElementById('lam-cloud-settings-card')?.replaceWith?.(
      document.createRange().createContextualFragment(renderCloudSettingsCard())
    );
  };

  window.LAMCloud._testConnection = async function() {
    const url = document.getElementById('cloud-sb-url')?.value?.trim();
    const key = document.getElementById('cloud-sb-key')?.value?.trim();
    const el  = document.getElementById('cloud-test-result');
    if (!el) return;
    const orig = { _url, _key };
    _url = url; _key = key;
    el.textContent = '🔄 Testing…'; el.style.color = 'var(--text-muted)';
    const result = await testConnection();
    el.textContent = result.ok ? '✅ Connection successful!' : `❌ Failed: ${result.error}`;
    el.style.color = result.ok ? 'var(--color-success,#059669)' : 'var(--color-danger,#DC2626)';
    if (!orig._url) { _url = null; _key = null; }
  };

  window.LAMCloud._clearCloudConfig = function() {
    if (!confirm('Disconnect Supabase? Local data is safe — sync will stop.')) return;
    clearConfig();
    window.LAM?.Toast?.info('Disconnected', 'Cloud sync disabled.');
  };

  window.LAMCloud._saveRZPKey = function() {
    const key = document.getElementById('rzp-key-input')?.value?.trim();
    if (!key) { window.LAM?.Toast?.error('Required', 'Enter your Razorpay Key ID.'); return; }
    saveRZPKey(key);
    window.LAM?.Toast?.success('Saved', `Razorpay ${key.startsWith('rzp_live_') ? 'Live' : 'Test'} mode ready.`);
  };

  window.LAMCloud.startFullExport = async function() {
    const btn    = document.getElementById('full-export-btn');
    const logEl  = document.getElementById('export-status-log');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }

    await runFullExport(msg => {
      if (logEl) logEl.textContent += (logEl.textContent ? '\n' : '') + '› ' + msg;
    });

    if (btn) { btn.disabled = false; btn.textContent = '📦 Download Full Export ZIP'; }
  };

  // ══════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════

  function init() {
    // Load config from localStorage
    _url    = localStorage.getItem(LS_SUPABASE_URL) || null;
    _key    = localStorage.getItem(LS_SUPABASE_KEY) || null;
    _active = !!(_url && _key);

    // Load last sync time
    const ls = localStorage.getItem(LS_LAST_SYNC);
    if (ls) _lastSync = new Date(ls);

    // Inject sync badge into topbar
    const onDOM = () => {
      injectSyncBadge();
      if (_active) _startSyncTimer();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDOM);
    } else {
      onDOM();
    }

    // Re-check pending queue count
    const db = _db();
    if (db) {
      db.dbGetAll(SYNC_QUEUE_COL).then(q => {
        _pendingCnt = (q || []).filter(e => !e._synced).length;
        _updateBadge();
      }).catch(() => {});
    }
  }

  // ── Public API ─────────────────────────────────────────────
  Object.assign(window.LAMCloud, {
    push,
    pull,
    get isActive() { return _active; },
    get status()   { return { active: _active, pending: _pendingCnt, lastSync: _lastSync }; },
    configure,
    testConnection,
    clearConfig,
    injectSyncBadge,
    renderCloudSettingsCard,
    renderPaymentsSettingsCard,
    renderExportSettingsCard,
    openRazorpayCheckout,
    generateEWayBillJSON,
    renderEWayBillForm,
    downloadSetupSQL,
    generateSetupSQL,
    runFullExport,
    getRZPKey,
    init,
    // Exposed for gst.js override
    _renderEWayBillFull: (container, prefill) => renderEWayBillForm(container, prefill),
  });

  return window.LAMCloud;

})();

window.LAMCloud = window.LAMCloud || LAMCloud;
setTimeout(() => LAMCloud.init(), 800);
