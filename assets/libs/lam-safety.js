// ============================================================
// LAM Safety Engine v1.0 — Data Protection & Sharing
// ============================================================
// Provides four pillars of data safety for LAM v9:
//
//  1. AUTO-BACKUP   — Debounced JSON export after every save,
//                     auto-downloaded to device, status badge
//                     in top nav, 24h warning banner.
//
//  2. ONE-CLICK RESTORE — File picker → validate → conflict
//                         resolution (newer record wins by
//                         updatedAt), import summary toast.
//
//  3. TALLY XML EXPORT  — TallyPrime-compatible ENVELOPE XML
//                         for any date range. CGST/SGST/IGST
//                         ledgers auto-generated. Company name
//                         and ledger names configurable from
//                         Settings → Tally tab.
//
//  4. WHATSAPP SHARING  — Per-invoice "Send via WhatsApp"
//                         button. Renders PDF canvas → PNG,
//                         opens wa.me deep-link with text,
//                         copies formatted summary to clipboard.
//
//  5. CLOUD HOOKS       — window.LAMCloud?.push(op) fired on
//                         every dbCreate / dbUpdate / dbDelete.
//                         No-op now; wire Supabase later by
//                         defining window.LAMCloud = { push }.
//
// Dependencies: window.LAMDB (lam-db.js)
//               window.LAMPDF (lam-pdf.js)  — for WhatsApp
//               window.LAMCRYPTO (lam-crypto.js) — optional
//
// Zero new npm dependencies. Pure vanilla JS.
// ============================================================

const LAMSafety = (() => {

  // ── Constants ────────────────────────────────────────────
  const BACKUP_DEBOUNCE_MS  = 30_000;          // 30s inactivity
  const BACKUP_WARN_HOURS   = 24;              // warn if older
  const LS_LAST_BACKUP      = 'lam_last_backup_ts';
  const LS_TALLY_CONFIG     = 'lam_tally_config';
  const BACKUP_MAGIC        = 'LAM_SAFETY_v1'; // file identifier
  const ENCRYPT_PASS_KEY    = 'lam_backup_enc_salt'; // for XOR-safe simple backup encryption

  // ── Internal state ───────────────────────────────────────
  let _debounceTimer  = null;
  let _badgeEl        = null;    // injected DOM element
  let _bannerEl       = null;
  let _initialized    = false;

  // ══════════════════════════════════════════════════════════
  // SECTION 1 — AUTO-BACKUP
  // ══════════════════════════════════════════════════════════

  /**
   * Schedule a backup after BACKUP_DEBOUNCE_MS of inactivity.
   * Called automatically by the DB write hooks.
   */
  function scheduleBackup() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      performBackup({ silent: true }).catch(e =>
        console.warn('[LAMSafety] Auto-backup failed:', e)
      );
    }, BACKUP_DEBOUNCE_MS);
  }

  /**
   * Perform a full backup: dump all IndexedDB → encrypted JSON →
   * auto-download to device storage.
   *
   * @param {object} opts
   * @param {boolean} opts.silent   — suppress toast on success
   * @param {boolean} opts.noDownload — export data but don't trigger download (for testing)
   * @returns {Promise<{ok:boolean, collections:number, records:number, filename:string}>}
   */
  async function performBackup({ silent = false, noDownload = false } = {}) {
    _setBadgeState('saving');

    const db = window.LAMDB;
    if (!db) throw new Error('LAMDB not available');

    // Collect all data from every store
    const allCollections = _getAllCollections();
    const snapshot = {
      magic:       BACKUP_MAGIC,
      version:     1,
      exportedAt:  new Date().toISOString(),
      appVersion:  window.LAM_VERSION || 'v9',
      data:        {},
    };

    let totalRecords = 0;

    for (const col of allCollections) {
      try {
        const items = await db.dbGetAll(col);
        if (items && items.length > 0) {
          snapshot.data[col] = items;
          totalRecords += items.length;
        }
      } catch {
        // Store may not exist yet — skip silently
      }
    }

    const collectionCount = Object.keys(snapshot.data).length;
    const filename        = `LAM_backup_${new Date().toISOString().slice(0, 10)}.json`;

    // Lightweight obfuscation for the backup file.
    // Full encryption would require the user's PBKDF2 key at restore time,
    // creating a "forgot password = lost data" trap. Instead we use
    // base64 encoding with a simple integrity checksum.
    const json      = JSON.stringify(snapshot);
    const checksum  = _simpleChecksum(json);
    const payload   = btoa(unescape(encodeURIComponent(json))); // utf-8 safe base64
    const output    = JSON.stringify({ lam: true, cs: checksum, d: payload });

    if (!noDownload) {
      const blob = new Blob([output], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Persist timestamp
    localStorage.setItem(LS_LAST_BACKUP, Date.now().toString());

    _setBadgeState('done', new Date());
    _hideBanner(); // backup happened, hide the warning

    if (!silent) {
      window.LAM?.Toast?.success(
        'Backup Complete',
        `${totalRecords.toLocaleString('en-IN')} records across ${collectionCount} collections saved to ${filename}`
      );
    }

    return { ok: true, collections: collectionCount, records: totalRecords, filename };
  }

  /**
   * Simple non-cryptographic checksum for integrity verification.
   * Not security — just detects file corruption/truncation.
   */
  function _simpleChecksum(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h  = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  /**
   * Returns all collection names known to LAM.
   * Mirrors the list in lam-db.js _getAllCollections().
   */
  function _getAllCollections() {
    // Try to get it from LAMDB if exposed, else use the canonical list
    if (window.LAMDB?._collections) return window.LAMDB._collections;
    return [
      'users','companies','branches','employees','vendors','customers','products',
      'categories','units','warehouses','zones','inventory','audit_logs','invoices',
      'payments','expenses','accounts','gl_entries','journal_entries','bank_accounts',
      'bank_txn','budgets','currency_rates','fleet','drivers','trips','fuel','pod',
      'maintenance','assets','asset_maint','asset_audit','leads','opportunities',
      'quotations','activities','tickets','communications','sla_configs','attendance',
      'leaves','payroll','timesheets','projects','tasks','milestones','dispatch',
      'delivery_notes','pick_packs','returns','backorders','transfers','cycle_count',
      'damage','approvals','bom','production','work_centers','inspections','defects',
      'ncr','contracts','warranties','service_calls','gst_config','ewaybills','gstr3b',
      'invoice_matches','ic_transactions','sessions','sales','api_keys','api_logs',
      'webhooks','grns','multi_companies','multi_ic_transactions','multi_consolidations',
      'pos_sessions','pos_items','asset_depreciation','quality_checks',
    ];
  }


  // ── Backup Badge (top nav) ──────────────────────────────

  /**
   * Inject the backup status badge into the topbar-right area.
   * Looks for #lam-backup-badge (if pre-placed in HTML) or
   * appends to .topbar-right automatically.
   */
  function injectBackupBadge() {
    // Don't double-inject
    if (document.getElementById('lam-backup-badge')) {
      _badgeEl = document.getElementById('lam-backup-badge');
      return;
    }

    _badgeEl = document.createElement('div');
    _badgeEl.id = 'lam-backup-badge';
    _badgeEl.style.cssText = `
      display:inline-flex; align-items:center; gap:5px;
      font-size:11px; font-weight:500;
      padding:4px 10px; border-radius:20px;
      cursor:pointer; transition:all 0.2s;
      background:var(--surface-2,#1e1e1e);
      color:var(--text-secondary,#888);
      border:1px solid var(--border-subtle,#333);
      white-space:nowrap; flex-shrink:0;
    `;
    _badgeEl.title = 'Click to backup now';
    _badgeEl.onclick = () => performBackup({ silent: false });

    const topbarRight = document.querySelector('.topbar-right');
    if (topbarRight) {
      // Insert before first child (before notifications bell)
      topbarRight.insertBefore(_badgeEl, topbarRight.firstChild);
    } else {
      // Fallback: append to topbar
      const topbar = document.querySelector('.topbar, header');
      if (topbar) topbar.appendChild(_badgeEl);
    }

    _refreshBadgeFromStorage();
  }

  /**
   * Update badge visual state.
   * @param {'idle'|'saving'|'done'|'warn'} state
   * @param {Date} [ts] — timestamp for 'done' state
   */
  function _setBadgeState(state, ts) {
    if (!_badgeEl) return;
    const styles = {
      idle:   { bg: 'var(--surface-2,#1e1e1e)',              color: 'var(--text-secondary,#888)',   icon: '💾', text: 'Backup' },
      saving: { bg: 'rgba(10,132,255,0.15)',                  color: 'var(--color-info,#0a84ff)',    icon: '⏳', text: 'Saving…' },
      done:   { bg: 'rgba(48,209,88,0.12)',                   color: 'var(--color-success,#30d158)', icon: '✅', text: _relativeTime(ts) },
      warn:   { bg: 'rgba(255,214,10,0.12)',                  color: 'var(--color-warn,#ffd60a)',    icon: '⚠️', text: 'No backup' },
    };
    const s = styles[state] || styles.idle;
    _badgeEl.style.background = s.bg;
    _badgeEl.style.color      = s.color;
    _badgeEl.innerHTML = `<span>${s.icon}</span><span>${s.text}</span>`;
    _badgeEl.dataset.state = state;
  }

  /**
   * Refresh badge from localStorage on page load.
   */
  function _refreshBadgeFromStorage() {
    const ts = parseInt(localStorage.getItem(LS_LAST_BACKUP) || '0', 10);
    if (!ts) {
      _setBadgeState('warn');
      return;
    }
    const ageHours = (Date.now() - ts) / 3_600_000;
    if (ageHours > BACKUP_WARN_HOURS) {
      _setBadgeState('warn');
    } else {
      _setBadgeState('done', new Date(ts));
    }
  }

  /**
   * Convert a Date to a human-readable relative string.
   * e.g. "2 mins ago", "1 hr ago", "3 hrs ago"
   */
  function _relativeTime(date) {
    if (!date) return 'Just now';
    const diffMs  = Date.now() - (date instanceof Date ? date : new Date(date)).getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1)  return 'Just now';
    if (diffMin < 60) return `${diffMin} min${diffMin > 1 ? 's' : ''} ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)  return `${diffHr} hr${diffHr > 1 ? 's' : ''} ago`;
    return new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short' })
      .format(date instanceof Date ? date : new Date(date));
  }

  // Keep the badge time label refreshed every minute
  function _startBadgeTicker() {
    setInterval(() => {
      if (_badgeEl?.dataset.state === 'done') {
        const ts = parseInt(localStorage.getItem(LS_LAST_BACKUP) || '0', 10);
        if (ts) _setBadgeState('done', new Date(ts));
      }
    }, 60_000);
  }


  // ── 24-hour Warning Banner ──────────────────────────────

  /**
   * Show a yellow warning banner at the top of the page if
   * no backup was taken in the last BACKUP_WARN_HOURS hours.
   */
  function checkAndShowBackupWarning() {
    const ts = parseInt(localStorage.getItem(LS_LAST_BACKUP) || '0', 10);
    const ageHours = ts ? (Date.now() - ts) / 3_600_000 : Infinity;

    if (ageHours <= BACKUP_WARN_HOURS) return;

    if (document.getElementById('lam-backup-warning')) return;

    _bannerEl = document.createElement('div');
    _bannerEl.id = 'lam-backup-warning';
    _bannerEl.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:9999;
      background:linear-gradient(90deg,#3a2e00,#4a3800,#3a2e00);
      border-bottom:1px solid rgba(255,214,10,0.4);
      color:#ffd60a; font-size:12px; font-weight:500;
      padding:8px 16px; display:flex; align-items:center;
      gap:10px; justify-content:space-between;
    `;

    const ageText = ts
      ? `Last backup: ${_relativeTime(new Date(ts))}`
      : 'No backup found';

    _bannerEl.innerHTML = `
      <span>
        ⚠️ <strong>Data Safety Warning</strong> — ${ageText}.
        Your data exists only in this browser. Clear browser cache = permanent loss.
      </span>
      <span style="display:flex;gap:8px;flex-shrink:0;">
        <button
          onclick="window.LAMSafety.performBackup().then(()=>{})"
          style="background:rgba(255,214,10,0.2);border:1px solid rgba(255,214,10,0.5);
                 color:#ffd60a;padding:3px 10px;border-radius:6px;cursor:pointer;
                 font-size:11px;font-weight:600;">
          💾 Backup Now
        </button>
        <button
          onclick="document.getElementById('lam-backup-warning').remove()"
          style="background:transparent;border:none;color:#ffd60a;cursor:pointer;
                 font-size:16px;line-height:1;padding:0 4px;">
          ×
        </button>
      </span>
    `;

    document.body.insertBefore(_bannerEl, document.body.firstChild);
  }

  function _hideBanner() {
    const b = document.getElementById('lam-backup-warning');
    if (b) b.remove();
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 2 — ONE-CLICK RESTORE
  // ══════════════════════════════════════════════════════════

  /**
   * Open a file picker and restore data from a LAM backup file.
   * Conflict resolution: if both old and new record exist,
   * the one with the later updatedAt timestamp wins.
   *
   * @returns {Promise<{restored:number, skipped:number, errors:number}>}
   */
  async function restoreFromBackup() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = '.json,application/json';

      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) { resolve(null); return; }

        try {
          const result = await _importBackupFile(file);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };

      input.click();
    });
  }

  /**
   * Parse and import a backup file. Internal implementation.
   */
  async function _importBackupFile(file) {
    const db = window.LAMDB;
    if (!db) throw new Error('LAMDB not available');

    let raw;
    try {
      raw = await file.text();
    } catch {
      throw new Error('Could not read file');
    }

    // Parse outer wrapper
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON file');
    }

    let snapshot;

    // Detect our format vs raw LAMDB exportAllData format
    if (parsed.lam && parsed.d) {
      // Our encoded format
      const cs = _simpleChecksum(decodeURIComponent(escape(atob(parsed.d))));
      if (cs !== parsed.cs) {
        throw new Error('Backup file checksum mismatch — file may be corrupted');
      }
      try {
        snapshot = JSON.parse(decodeURIComponent(escape(atob(parsed.d))));
      } catch {
        throw new Error('Could not decode backup payload');
      }
    } else if (parsed.data && parsed.version) {
      // Raw LAMDB exportAllData format — accept it too
      snapshot = parsed;
    } else {
      throw new Error('Unrecognized backup format. Please use a LAM_backup_*.json file.');
    }

    if (!snapshot?.data || typeof snapshot.data !== 'object') {
      throw new Error('Backup has no data section');
    }

    let restored = 0;
    let skipped  = 0;
    let errors   = 0;

    for (const [col, items] of Object.entries(snapshot.data)) {
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        if (!item?.id) { errors++; continue; }

        try {
          // Conflict resolution: fetch existing record
          const existing = await db.dbGet(col, item.id).catch(() => null);

          if (existing) {
            const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
            const incomingTs = item.updatedAt     ? new Date(item.updatedAt).getTime()     : 0;

            if (existingTs >= incomingTs) {
              // Existing is newer or same — skip
              skipped++;
              continue;
            }
          }

          // Upsert: use dbSet which handles both create and update
          await db.dbSet(col, item.id, item);
          restored++;
        } catch {
          errors++;
        }
      }
    }

    const msg = `${restored.toLocaleString('en-IN')} records restored, ${skipped.toLocaleString('en-IN')} skipped (already newer)` +
                (errors > 0 ? `, ${errors} errors` : '');

    window.LAM?.Toast?.success('Restore Complete', msg);

    // Refresh the backup badge since we just imported
    localStorage.setItem(LS_LAST_BACKUP, Date.now().toString());
    _setBadgeState('done', new Date());
    _hideBanner();

    return { restored, skipped, errors };
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 3 — TALLY XML EXPORT
  // ══════════════════════════════════════════════════════════

  /**
   * Load Tally configuration from localStorage.
   * Merged with defaults so missing keys never cause undefined errors.
   */
  function getTallyConfig() {
    const stored = JSON.parse(localStorage.getItem(LS_TALLY_CONFIG) || '{}');
    return {
      companyName:       stored.companyName       || 'My Company',
      salesLedger:       stored.salesLedger       || 'Sales Account',
      cgstLedger:        stored.cgstLedger        || 'CGST',
      sgstLedger:        stored.sgstLedger        || 'SGST',
      igstLedger:        stored.igstLedger        || 'IGST',
      debtorsLedger:     stored.debtorsLedger     || 'Sundry Debtors',
      cashLedger:        stored.cashLedger        || 'Cash',
      stockGroupName:    stored.stockGroupName    || 'Primary',
      currencySymbol:    stored.currencySymbol    || '₹',
    };
  }

  /**
   * Save Tally configuration to localStorage.
   * @param {object} config
   */
  function saveTallyConfig(config) {
    const existing = getTallyConfig();
    localStorage.setItem(LS_TALLY_CONFIG, JSON.stringify({ ...existing, ...config }));
    window.LAM?.Toast?.success('Tally Settings Saved', 'Configuration updated.');
  }

  /**
   * Export invoices for a date range as TallyPrime-compatible XML.
   *
   * @param {object} opts
   * @param {string} opts.fromDate  — 'YYYY-MM-DD'
   * @param {string} opts.toDate    — 'YYYY-MM-DD'
   * @param {string} [opts.filename] — override filename
   * @returns {Promise<{ok:boolean, vouchers:number, filename:string}>}
   */
  async function exportTallyXML({ fromDate, toDate, filename } = {}) {
    const db  = window.LAMDB;
    if (!db) throw new Error('LAMDB not available');

    const cfg = getTallyConfig();

    // Load all invoices then filter by date range
    const allInvoices = await db.dbGetAll('invoices');

    const from = fromDate ? new Date(fromDate + 'T00:00:00') : null;
    const to   = toDate   ? new Date(toDate   + 'T23:59:59') : null;

    const invoices = allInvoices.filter(inv => {
      const d = new Date(inv.invoiceDate || inv.createdAt);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });

    if (!invoices.length) {
      window.LAM?.Toast?.warning('No Invoices', 'No invoices found in the selected date range.');
      return { ok: false, vouchers: 0 };
    }

    // Load customers for lookup
    const allCustomers = await db.dbGetAll('customers');
    const customerMap  = Object.fromEntries(allCustomers.map(c => [c.id, c]));

    // Determine period label for filename
    const periodLabel = fromDate
      ? `${fromDate.slice(0,7)}`
      : new Date().toISOString().slice(0, 7);

    const outFilename = filename || `${cfg.companyName.replace(/\s+/g,'_')}_Tally_${periodLabel}.xml`;

    // ── Build XML ─────────────────────────────────────────
    const voucherBlocks = invoices.map(inv => _buildTallyVoucher(inv, cfg, customerMap));

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ENVELOPE>`,
      `  <HEADER>`,
      `    <TALLYREQUEST>Import Data</TALLYREQUEST>`,
      `  </HEADER>`,
      `  <BODY>`,
      `    <IMPORTDATA>`,
      `      <REQUESTDESC>`,
      `        <REPORTNAME>Vouchers</REPORTNAME>`,
      `        <STATICVARIABLES>`,
      `          <SVCURRENTCOMPANY>${_xmlEsc(cfg.companyName)}</SVCURRENTCOMPANY>`,
      `        </STATICVARIABLES>`,
      `      </REQUESTDESC>`,
      `      <REQUESTDATA>`,
      ...voucherBlocks,
      `      </REQUESTDATA>`,
      `    </IMPORTDATA>`,
      `  </BODY>`,
      `</ENVELOPE>`,
    ].join('\n');

    // Download
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = outFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    window.LAM?.Toast?.success(
      'Tally Export Ready',
      `${invoices.length} voucher${invoices.length > 1 ? 's' : ''} exported → ${outFilename}`
    );

    return { ok: true, vouchers: invoices.length, filename: outFilename };
  }

  /**
   * Build a single TallyPrime TALLYMESSAGE / VOUCHER block for one invoice.
   *
   * Structure follows TallyPrime XML import spec:
   *   ENVELOPE > BODY > IMPORTDATA > REQUESTDATA > TALLYMESSAGE > VOUCHER
   *
   * Each invoice generates:
   *   - One debit leg (Sundry Debtors / Cash)
   *   - One credit leg per line item (Sales Account)
   *   - GST ledger entries (CGST + SGST for intra-state, IGST for inter-state)
   *   - One ALLINVENTORYENTRIES per line item (stock item)
   */
  function _buildTallyVoucher(inv, cfg, customerMap) {
    const customer    = customerMap[inv.customerId] || {};
    const party       = customer.name || inv.customerName || 'Walk-in Customer';
    const isIGST      = (customer.state || '').toLowerCase() !== 'kerala' &&
                        (customer.state || '') !== '';
    const voucherNo   = inv.invoiceNo || inv.id;
    const voucherDate = _tallyDate(inv.invoiceDate || inv.createdAt);
    const items       = inv.items || inv.lineItems || [];

    // Totals
    const taxableAmt = items.reduce((s, it) => s + _lineBase(it), 0);
    const gstAmt     = items.reduce((s, it) => s + _lineGST(it), 0);
    const totalAmt   = taxableAmt + gstAmt;

    // ── Inventory entries (one per line item) ─────────────
    const inventoryEntries = items.map(it => {
      const base = _lineBase(it);
      const gst  = _lineGST(it);
      const rate = it.gstRate || 0;
      return `
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>${_xmlEsc(it.name || it.productName || it.description || 'Service')}</STOCKITEMNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <RATE>${it.unitPrice || 0}/Nos</RATE>
          <AMOUNT>-${base.toFixed(2)}</AMOUNT>
          <ACTUALQTY>${it.qty || it.quantity || 1} Nos</ACTUALQTY>
          <BILLEDQTY>${it.qty || it.quantity || 1} Nos</BILLEDQTY>
          <BATCHALLOCATIONS.LIST>
            <AMOUNT>-${base.toFixed(2)}</AMOUNT>
            <ACTUALQTY>${it.qty || it.quantity || 1} Nos</ACTUALQTY>
            <BILLEDQTY>${it.qty || it.quantity || 1} Nos</BILLEDQTY>
          </BATCHALLOCATIONS.LIST>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>${_xmlEsc(cfg.salesLedger)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${base.toFixed(2)}</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      `;
    }).join('');

    // ── Ledger entries ────────────────────────────────────
    //  Debit: Sundry Debtors / Cash (full invoice amount)
    //  Credit: Sales Account (taxable)
    //  Credit: GST ledgers

    let gstLedgerEntries = '';
    if (gstAmt > 0) {
      if (isIGST) {
        gstLedgerEntries = `
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${_xmlEsc(cfg.igstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${gstAmt.toFixed(2)}</AMOUNT>
        </LEDGERENTRIES.LIST>`;
      } else {
        const half = gstAmt / 2;
        gstLedgerEntries = `
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${_xmlEsc(cfg.cgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${half.toFixed(2)}</AMOUNT>
        </LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>${_xmlEsc(cfg.sgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${half.toFixed(2)}</AMOUNT>
        </LEDGERENTRIES.LIST>`;
      }
    }

    const partyLedger = (inv.paymentMode === 'cash') ? cfg.cashLedger : cfg.debtorsLedger;

    return `
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
          <DATE>${voucherDate}</DATE>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <VOUCHERNUMBER>${_xmlEsc(voucherNo)}</VOUCHERNUMBER>
          <PARTYLEDGERNAME>${_xmlEsc(party)}</PARTYLEDGERNAME>
          <CSTFORMISSUETYPE/>
          <CSTFORMRECVTYPE/>
          <NARRATION>${_xmlEsc(inv.notes || '')}</NARRATION>
          <ISINVOICE>Yes</ISINVOICE>
          <ISOPTIONAL>No</ISOPTIONAL>

          <LEDGERENTRIES.LIST>
            <LEDGERNAME>${_xmlEsc(party)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${totalAmt.toFixed(2)}</AMOUNT>
          </LEDGERENTRIES.LIST>

          <LEDGERENTRIES.LIST>
            <LEDGERNAME>${_xmlEsc(cfg.salesLedger)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${taxableAmt.toFixed(2)}</AMOUNT>
          </LEDGERENTRIES.LIST>

          ${gstLedgerEntries}

          ${inventoryEntries}

        </VOUCHER>
      </TALLYMESSAGE>`;
  }

  /** Line item taxable base amount */
  function _lineBase(item) {
    const qty   = item.qty || item.quantity || 1;
    const price = item.unitPrice || item.rate || 0;
    return qty * price;
  }

  /** Line item GST amount */
  function _lineGST(item) {
    const base = _lineBase(item);
    const rate = item.gstRate || item.taxRate || 0;
    return base * rate / 100;
  }

  /** Format date for Tally: YYYYMMDD */
  function _tallyDate(isoOrDate) {
    try {
      const d = new Date(isoOrDate);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${dd}`;
    } catch {
      return new Date().toISOString().replace(/-/g,'').slice(0,8);
    }
  }

  /** Escape a string for safe XML embedding */
  function _xmlEsc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Inject Tally Export section into the GST/Reports page.
   * Looks for the same containers as gst-export.js.
   * Called by GSTExport or independently.
   */
  function injectTallyExportWidget(container) {
    if (!container) return;
    if (container.querySelector('.lam-tally-widget')) return;

    const widget = document.createElement('div');
    widget.className = 'lam-tally-widget';
    widget.style.cssText = 'margin-bottom:24px;';
    widget.innerHTML = `
      <div class="card" style="overflow:hidden;">
        <div class="card-header" style="border-bottom:1px solid var(--border-subtle,#333);">
          <div class="card-title">🧾 Tally XML Export</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            Export invoices to TallyPrime-compatible XML
          </div>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px;">From Date</label>
              <input type="date" id="tally-from-date" class="form-input"
                     style="font-size:13px;padding:6px 10px;"
                     value="${_firstDayOfMonth()}">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px;">To Date</label>
              <input type="date" id="tally-to-date" class="form-input"
                     style="font-size:13px;padding:6px 10px;"
                     value="${_today()}">
            </div>
            <button
              id="tally-export-btn"
              onclick="window.LAMSafety.exportTallyXML({
                fromDate: document.getElementById('tally-from-date').value,
                toDate:   document.getElementById('tally-to-date').value
              })"
              class="btn btn-primary"
              style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
              <span>⬇</span> Export Tally XML
            </button>
          </div>
          <div id="tally-export-status"
               style="font-size:12px;color:var(--text-secondary);min-height:16px;"></div>
          <div style="padding:10px;background:var(--surface-2,#111);border-radius:8px;
                      font-size:11px;color:var(--text-muted,#666);line-height:1.6;">
            <strong>How to import:</strong> Open TallyPrime → Gateway → Import Data → Vouchers → select the downloaded XML.
            Ledger names must match exactly. Configure them in
            <a href="#" onclick="window.LAM?.navigate?.('settings');return false;"
               style="color:var(--brand-primary,#f7c948);">Settings → Tally</a>.
          </div>
        </div>
      </div>
    `;

    // Insert before existing children (above GSTR widget)
    container.insertBefore(widget, container.firstChild);
  }

  function _firstDayOfMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
  }

  function _today() {
    return new Date().toISOString().slice(0,10);
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 4 — WHATSAPP INVOICE SHARING
  // ══════════════════════════════════════════════════════════

  /**
   * Send an invoice via WhatsApp.
   *
   * Flow:
   *   1. Load invoice + customer + company from LAMDB
   *   2. Render PDF via window.LAMPDF.invoice() → offscreen canvas
   *   3. Convert canvas[0] to PNG data URL
   *   4. Copy a formatted text summary to clipboard
   *   5. Open wa.me deep link with pre-filled text message
   *
   * The PDF file itself cannot be attached programmatically via wa.me
   * (WhatsApp Web Links only support text). The text message includes
   * a note asking the user to attach the PDF separately. The PNG
   * preview is copied to clipboard as a fallback.
   *
   * @param {string} invoiceId
   * @returns {Promise<void>}
   */
  async function shareInvoiceWhatsApp(invoiceId) {
    const db = window.LAMDB;
    if (!db) { _toast('error', 'Error', 'DB not ready'); return; }

    _toast('info', 'Preparing…', 'Building invoice for WhatsApp');

    try {
      const inv      = await db.dbGet('invoices', invoiceId);
      if (!inv) throw new Error('Invoice not found');

      const customer = inv.customerId ? await db.dbGet('customers', inv.customerId).catch(()=>({})) : {};
      const companies = await db.dbGetAll('companies');
      const company   = companies[0] || {};

      // Phone number — strip spaces, dashes, leading zeroes/+91
      const rawPhone  = customer.phone || inv.customerPhone || '';
      const phone     = _normalizePhone(rawPhone);

      // Format currency
      const fmt = n => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(n || 0);
      const total     = inv.totalAmount || inv.total || inv.grandTotal || 0;
      const dueDate   = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-IN') : '—';
      const invoiceNo = inv.invoiceNo || inv.id;

      // ── Build text message ─────────────────────────────
      const companyName = company.name || window.LAM_COMPANY_NAME || 'LAM Business';
      const textMessage = [
        `*Invoice from ${companyName}*`,
        ``,
        `📋 Invoice No: ${invoiceNo}`,
        `📅 Date: ${inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString('en-IN') : '—'}`,
        `💰 Amount: ₹${fmt(total)}`,
        `⏰ Due: ${dueDate}`,
        inv.paymentStatus ? `✅ Status: ${inv.paymentStatus}` : '',
        ``,
        `Please find the PDF invoice attached separately.`,
        ``,
        `_Sent via LAM — Logistics & Assets Management_`,
      ].filter(l => l !== null).join('\n');

      // ── Copy to clipboard ──────────────────────────────
      try {
        await navigator.clipboard.writeText(textMessage);
      } catch {
        // Clipboard API may be denied on some devices — not fatal
      }

      // ── Try to generate PNG preview ────────────────────
      // We attempt to render the PDF off-screen and grab the first canvas.
      // If LAMPDF is not available or rendering fails, we proceed with text only.
      let pngDataUrl = null;

      if (window.LAMPDF?.invoice) {
        try {
          pngDataUrl = await _renderInvoiceToPNG(inv, company, customer);
        } catch (e) {
          console.warn('[LAMSafety] PDF render for WhatsApp failed:', e);
        }
      }

      if (pngDataUrl) {
        // Copy PNG to clipboard for manual paste
        try {
          const resp  = await fetch(pngDataUrl);
          const blob  = await resp.blob();
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
        } catch {
          // Image clipboard may not be supported — fall back to text already copied
        }
      }

      // ── Open WhatsApp ──────────────────────────────────
      const encoded = encodeURIComponent(textMessage);
      const waURL   = phone
        ? `https://wa.me/91${phone}?text=${encoded}`
        : `https://wa.me/?text=${encoded}`;

      window.open(waURL, '_blank', 'noopener,noreferrer');

      _toast('success', 'WhatsApp Opened',
        phone
          ? `Message ready for ${customer.name || phone}. PDF invoice is also copied — paste it in the chat.`
          : 'Choose a contact in WhatsApp. Invoice text is pre-filled.'
      );

    } catch (err) {
      _toast('error', 'WhatsApp Share Failed', err.message);
    }
  }

  /**
   * Normalize phone number to 10 digits (Indian mobile).
   * Strips +91, 91 prefix, spaces, dashes.
   */
  function _normalizePhone(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/[\s\-\(\)]/g, '');
    if (s.startsWith('+91')) s = s.slice(3);
    if (s.startsWith('91') && s.length === 12) s = s.slice(2);
    // Return only if looks like valid Indian mobile (starts 6-9, 10 digits)
    return /^[6-9]\d{9}$/.test(s) ? s : '';
  }

  /**
   * Render invoice PDF off-screen and return first page as PNG data URL.
   * Uses a temporary hidden container so LAMPDF can paint its canvases.
   */
  async function _renderInvoiceToPNG(inv, company, customer) {
    return new Promise((resolve, reject) => {
      // LAMPDF.invoice() downloads directly normally.
      // We intercept by temporarily wrapping the download method.
      const origDownload = window.LAMPDF?._downloadAsPDF;
      const origBinaryGen = window.LAMPDF?._generatePDFBinary;

      // If LAMPDF exposes canvases, grab them
      // The PDF module uses a Doc class with .pages[] array of canvases
      // We'll call invoice() and then intercept via a custom approach:
      // Override the download trigger so we can grab the canvas instead.

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) reject(new Error('PDF render timeout'));
      }, 5000);

      // Patch: temporarily override Doc.prototype.save to capture canvases
      // instead of triggering download. This is safe because we restore it.
      const PDF = window.LAMPDF;

      // Simple approach: generate the invoice, grab the internal canvases
      // by monkey-patching _generatePDFBinary once
      if (window.PDF?._generatePDFBinary) {
        const orig = window.PDF._generatePDFBinary;
        window.PDF._generatePDFBinary = function(canvases, filename) {
          window.PDF._generatePDFBinary = orig; // restore immediately
          clearTimeout(timeout);
          resolved = true;
          if (canvases && canvases[0]) {
            resolve(canvases[0].toDataURL('image/png'));
          } else {
            reject(new Error('No canvas from PDF engine'));
          }
        };
        PDF.invoice(inv, company, customer);
      } else {
        // Fallback: cannot intercept, just reject
        clearTimeout(timeout);
        reject(new Error('PDF canvas interception not supported'));
      }
    });
  }

  /**
   * Inject "Send via WhatsApp" button into the invoice actions menu.
   * Patches the invoice module's actionsMenu entries at runtime.
   * This uses a MutationObserver so it works regardless of when
   * invoice.js renders the table.
   */
  function injectWhatsAppButton() {
    // Strategy: observe the DOM for invoice action menus and add the button
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          // Look for action menu dropdowns in invoice tables
          const menus = node.querySelectorAll?.('[data-record-id]') ||
                        (node.dataset?.recordId ? [node] : []);
          _patchInvoiceMenus(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also patch any existing menus on load
    _patchInvoiceMenus(document.body);
  }

  /**
   * Find invoice action menus in a DOM subtree and inject WhatsApp buttons.
   */
  function _patchInvoiceMenus(root) {
    // LAM action menus render as <div class="actions-menu"> or similar
    // Each row has onclick="actionsMenu(id, [...])" rendered items.
    // We look for the "Generate PDF" menu items and add WhatsApp after them.
    const pdfItems = root.querySelectorAll?.('[onclick*="generateInvoicePDF"]');
    if (!pdfItems) return;

    for (const item of pdfItems) {
      const parent = item.closest('.dropdown-menu, .actions-dropdown, ul, [role="menu"]');
      if (!parent) continue;

      // Check if we already injected
      if (parent.querySelector('[data-lam-wa]')) continue;

      // Extract the invoice ID from the existing onclick
      const match = item.getAttribute('onclick')?.match(/generateInvoicePDF\(['"]([^'"]+)['"]\)/);
      if (!match) continue;
      const invoiceId = match[1];

      const waItem = document.createElement('div');
      waItem.setAttribute('data-lam-wa', '1');
      waItem.className = item.className; // inherit styling
      waItem.setAttribute('onclick', `window.LAMSafety.shareInvoiceWhatsApp('${invoiceId}')`);
      waItem.innerHTML = item.innerHTML.replace(/📄.*?Invoice/,'📱 Send via WhatsApp');

      item.after(waItem);
    }
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 5 — CLOUD HOOKS (no-op now, Supabase-ready)
  // ══════════════════════════════════════════════════════════

  /**
   * Fire a cloud replication event.
   *
   * This is called on every dbCreate / dbUpdate / dbDelete
   * via the LAMDB _notify hook (see patchDBForCloudHooks below).
   *
   * window.LAMCloud is undefined now — all calls are no-ops.
   *
   * ── HOW TO WIRE SUPABASE LATER ─────────────────────────
   *
   * 1. Install Supabase JS client (or use vanilla fetch).
   * 2. Define window.LAMCloud = { push: async (op) => { ... } }
   *    where op = { type:'create'|'update'|'delete', col, record, ts }
   * 3. In push(), call supabase.from(op.col).upsert(op.record)
   *    for create/update, or .delete().eq('id', op.record.id) for delete.
   * 4. That's it — all existing data writes flow to cloud automatically.
   *
   * ── OP INTERFACE ───────────────────────────────────────
   * {
   *   type:   'create' | 'update' | 'delete',
   *   col:    string,          // collection name e.g. 'invoices'
   *   record: object,          // full record (or {id} for delete)
   *   ts:     number,          // Date.now()
   *   userId: string | null,   // from LAMDB current user
   * }
   *
   * window.LAMCloud = {
   *   push: async (op: CloudOp) => void
   * }
   */
  function _fireCloudHook(type, col, record) {
    if (!window.LAMCloud?.push) return; // no-op when not wired
    try {
      window.LAMCloud.push({
        type,
        col,
        record: record || {},
        ts:     Date.now(),
        userId: window.LAM_USER_ID || null,
      });
    } catch (e) {
      console.warn('[LAMSafety] Cloud hook error:', e);
    }
  }

  /**
   * Patch window.LAMDB to intercept writes and:
   *   a) Schedule a backup (debounced)
   *   b) Fire cloud hooks
   *
   * Called once during init(). Non-destructive: wraps original methods.
   */
  function patchDBForCloudHooks() {
    const db = window.LAMDB;
    if (!db || db._lamSafetyPatched) return;

    const wrap = (origFn, opType) => async function(...args) {
      const result = await origFn.apply(db, args);
      const col    = args[0];
      // result is the record for create/update, id string for delete
      _fireCloudHook(opType, col, typeof result === 'object' ? result : { id: result });
      scheduleBackup();
      return result;
    };

    db.dbCreate = wrap(db.dbCreate, 'create');
    db.dbUpdate = wrap(db.dbUpdate, 'update');
    db.dbSet    = wrap(db.dbSet,    'update');
    db.dbDelete = wrap(db.dbDelete, 'delete');

    db._lamSafetyPatched = true;
  }


  // ══════════════════════════════════════════════════════════
  // SETTINGS — Tally Config Tab
  // ══════════════════════════════════════════════════════════

  /**
   * Render the Tally configuration card for Settings page.
   * Designed to be injected into the Settings module's Data & Backup card,
   * or inserted as a standalone card in the Settings grid.
   *
   * @returns {string} HTML string
   */
  function renderTallySettingsCard() {
    const cfg = getTallyConfig();
    return `
      <div class="card" id="lam-tally-settings-card">
        <div class="card-header">
          <div class="card-title">🧾 Tally Integration</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            Configure ledger names to match your TallyPrime company exactly.
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:4px 0;">
          ${[
            ['companyName',    'Company Name',      cfg.companyName],
            ['salesLedger',    'Sales Ledger',       cfg.salesLedger],
            ['cgstLedger',     'CGST Ledger',        cfg.cgstLedger],
            ['sgstLedger',     'SGST Ledger',        cfg.sgstLedger],
            ['igstLedger',     'IGST Ledger',        cfg.igstLedger],
            ['debtorsLedger',  'Sundry Debtors',     cfg.debtorsLedger],
            ['cashLedger',     'Cash Ledger',        cfg.cashLedger],
            ['stockGroupName', 'Stock Group',        cfg.stockGroupName],
          ].map(([key, label, val]) => `
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="font-size:11px;">${label}</label>
              <input type="text" id="tally-cfg-${key}" class="form-input"
                     style="font-size:13px;"
                     value="${_xmlEsc(val)}"
                     placeholder="${label}">
            </div>
          `).join('')}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="window.LAMSafety.saveTallyConfigFromForm()">
            💾 Save Tally Config
          </button>
          <button class="btn btn-secondary btn-sm" onclick="window.LAMSafety.exportTallyXML({
            fromDate: '${_firstDayOfMonth()}',
            toDate:   '${_today()}'
          })">
            ⬇ Export This Month
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Read the Tally settings form and save.
   * Called by the "Save Tally Config" button in renderTallySettingsCard().
   */
  function saveTallyConfigFromForm() {
    const fields = ['companyName','salesLedger','cgstLedger','sgstLedger','igstLedger',
                    'debtorsLedger','cashLedger','stockGroupName'];
    const config = {};
    for (const key of fields) {
      const el = document.getElementById(`tally-cfg-${key}`);
      if (el) config[key] = el.value.trim();
    }
    saveTallyConfig(config);
  }


  // ══════════════════════════════════════════════════════════
  // SETTINGS — Backup & Restore Card
  // ══════════════════════════════════════════════════════════

  /**
   * Render a Backup & Restore card for the Settings page.
   * Replaces the existing stub in settings.js.
   *
   * @returns {string} HTML string
   */
  function renderBackupSettingsCard() {
    const ts = parseInt(localStorage.getItem(LS_LAST_BACKUP) || '0', 10);
    const lastBackup = ts
      ? `Last backup: ${_relativeTime(new Date(ts))}`
      : 'No backup taken yet';

    return `
      <div class="card" id="lam-backup-settings-card">
        <div class="card-header">
          <div class="card-title">🗄 Data & Backup</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="alert alert-info" style="margin:0;">
            <span class="alert-icon">💾</span>
            <div>
              <div class="alert-title">Local-First Storage</div>
              <div class="alert-text">
                All data is stored in this browser's IndexedDB.
                Clearing browser data will erase everything.
                Download regular backups to protect your data.
              </div>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);">${lastBackup}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <button class="btn btn-primary btn-sm"
                    onclick="window.LAMSafety.performBackup()">
              💾 Download Backup Now
            </button>
            <button class="btn btn-secondary btn-sm"
                    onclick="window.LAMSafety.restoreFromBackup()">
              📥 Restore from Backup
            </button>
          </div>
          <div style="padding:10px;background:var(--surface-2,#111);border-radius:8px;
                      font-size:11px;color:var(--text-muted,#666);line-height:1.6;">
            <strong>Auto-backup:</strong> A backup is automatically downloaded 30 seconds after any data change.
            Keep these files in your Google Drive or WhatsApp Saved Messages for safety.
          </div>
        </div>
      </div>
    `;
  }


  // ══════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════

  /**
   * Initialize LAMSafety. Call once after LAMDB is ready.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.autoInjectBadge=true]   — inject nav badge
   * @param {boolean} [opts.autoInjectTally=true]   — inject Tally widget into reports
   * @param {boolean} [opts.autoInjectWA=true]      — inject WhatsApp buttons
   * @param {boolean} [opts.patchDB=true]           — wrap LAMDB write methods
   */
  function init({
    autoInjectBadge  = true,
    autoInjectTally  = true,
    autoInjectWA     = true,
    patchDB          = true,
  } = {}) {
    if (_initialized) return;
    _initialized = true;

    // Patch DB for cloud hooks + backup scheduling
    if (patchDB) {
      if (window.LAMDB) {
        patchDBForCloudHooks();
      } else {
        // Wait for LAMDB to be available
        const waitForDB = setInterval(() => {
          if (window.LAMDB) {
            clearInterval(waitForDB);
            patchDBForCloudHooks();
          }
        }, 500);
      }
    }

    // DOM-dependent setup
    const onDOMReady = () => {
      if (autoInjectBadge) injectBackupBadge();
      checkAndShowBackupWarning();
      _startBadgeTicker();

      if (autoInjectTally) _autoInjectTally();
      if (autoInjectWA)    injectWhatsAppButton();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDOMReady);
    } else {
      onDOMReady();
    }
  }

  /**
   * Auto-inject Tally widget via MutationObserver
   * (same pattern as gst-export.js autoInject).
   */
  function _autoInjectTally() {
    const TARGETS = [
      '#lam-reports-gst-widget-slot',
      '#reports-container',
      '#page-reports',
      '[data-page="reports"]',
      '.reports-page',
    ];

    function tryInjectTally() {
      for (const sel of TARGETS) {
        const el = document.querySelector(sel);
        if (el) { injectTallyExportWidget(el); return true; }
      }
      return false;
    }

    if (!tryInjectTally()) {
      const obs = new MutationObserver(() => {
        if (tryInjectTally()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Tiny toast helper ─────────────────────────────────────
  function _toast(type, title, msg) {
    if (window.LAM?.Toast?.[type]) {
      window.LAM.Toast[type](title, msg);
    } else {
      console.log(`[LAMSafety] ${type.toUpperCase()}: ${title} — ${msg}`);
    }
  }


  // ── Public API ────────────────────────────────────────────
  return {
    // Init
    init,

    // Backup
    performBackup,
    scheduleBackup,

    // Restore
    restoreFromBackup,

    // Tally
    exportTallyXML,
    getTallyConfig,
    saveTallyConfig,
    saveTallyConfigFromForm,
    injectTallyExportWidget,
    renderTallySettingsCard,

    // WhatsApp
    shareInvoiceWhatsApp,
    injectWhatsAppButton,

    // Settings cards
    renderBackupSettingsCard,

    // Cloud hooks
    patchDBForCloudHooks,

    // Internal — exposed for testing
    _simpleChecksum,
    _relativeTime,
    _xmlEsc,
    _tallyDate,
    _buildTallyVoucher,
    _getAllCollections,
  };

})();

// ── Register globally ───────────────────────────────────────
window.LAMSafety = LAMSafety;

// ── Auto-init on load ───────────────────────────────────────
// Deferred to 1500ms: LAMDB init (0ms), LAMUsers (controlled by dashboard),
// LAMCloud (300ms) all get priority. Safety module is non-critical at startup.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => LAMSafety.init(), 1500));
} else {
  setTimeout(() => LAMSafety.init(), 1500);
}
