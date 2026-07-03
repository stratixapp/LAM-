// ============================================================
// LAM v9 — GST Export Module
// GSTR-1 + GSTR-3B JSON generation in exact GSTN portal format
// Zero external dependencies — pure vanilla JS
// ============================================================
// Reads from IndexedDB via window.LAMDB
// Stores: invoices, customers, companies, fin_expenses, gst_config
//
// Invoice schema (relevant fields):
//   id, invoiceNumber, invoiceDate, customerId, companyId,
//   items[]  { description, qty, unitPrice, gstRate, hsnCode, discount }
//   subtotal, gstAmount, totalAmount, taxableAmount,
//   placeOfSupply, paymentStatus, igst (boolean flag),
//   supplyType ('inter-state' | 'intra-state')
//
// Customer schema (relevant fields):
//   id, name, gstin, stateCode, address
//
// gst_config schema:
//   gstin, legalName, stateCode, tradeName
// ============================================================

const GSTExport = (() => {

  // ── Indian state codes (GSTN standard) ──────────────────
  const STATE_CODES = {
    'Jammu and Kashmir': '01', 'Himachal Pradesh': '02',
    'Punjab': '03', 'Chandigarh': '04', 'Uttarakhand': '05',
    'Haryana': '06', 'Delhi': '07', 'Rajasthan': '08',
    'Uttar Pradesh': '09', 'Bihar': '10', 'Sikkim': '11',
    'Arunachal Pradesh': '12', 'Nagaland': '13', 'Manipur': '14',
    'Mizoram': '15', 'Tripura': '16', 'Meghalaya': '17',
    'Assam': '18', 'West Bengal': '19', 'Jharkhand': '20',
    'Odisha': '21', 'Chhattisgarh': '22', 'Madhya Pradesh': '23',
    'Gujarat': '24', 'Daman and Diu': '25', 'Dadra and Nagar Haveli': '26',
    'Maharashtra': '27', 'Andhra Pradesh': '28', 'Karnataka': '29',
    'Goa': '30', 'Lakshadweep': '31', 'Kerala': '32',
    'Tamil Nadu': '33', 'Puducherry': '34', 'Andaman and Nicobar': '35',
    'Telangana': '36', 'Andhra Pradesh (New)': '37',
    'Ladakh': '38', 'Other Territory': '97',
  };

  // Default: Kerala (32) — primary market
  const DEFAULT_STATE_CODE = '32';

  // ── Round to 2 decimal places (GSTN requires max 2 dp) ──
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // ── Format date YYYY-MM-DD → DD-MM-YYYY (GSTN format) ───
  function fmtDate(d) {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
    return d;
  }

  // ── Format period YYYY-MM → MMYYYY (GSTN fp format) ─────
  function fmtPeriod(period) {
    const [y, m] = period.split('-');
    return `${m}${y}`;
  }

  // ── Determine if invoice is inter-state ─────────────────
  function isInterState(inv, custStateCode, sellerStateCode) {
    if (inv.igst === true) return true;
    if ((inv.supplyType || '').toLowerCase().includes('inter')) return true;
    if (custStateCode && sellerStateCode && custStateCode !== sellerStateCode) return true;
    return false;
  }

  // ── Extract state code from GSTIN (first 2 chars) ────────
  function stateFromGSTIN(gstin) {
    if (gstin && gstin.length >= 2) return gstin.slice(0, 2);
    return DEFAULT_STATE_CODE;
  }

  // ── Compute line-level tax breakdown ────────────────────
  function computeLineItems(items, isIGST) {
    return (items || [])
      .filter(l => l && l.description)
      .map(l => {
        const qty      = Number(l.qty) || 1;
        const price    = Number(l.unitPrice) || 0;
        const disc     = Number(l.discount) || 0;
        const gstRate  = Number(l.gstRate) || 18;
        const taxable  = r2(qty * price * (1 - disc / 100));
        const totalTax = r2(taxable * gstRate / 100);
        const igstAmt  = isIGST ? totalTax : 0;
        const cgstAmt  = isIGST ? 0 : r2(totalTax / 2);
        const sgstAmt  = isIGST ? 0 : r2(totalTax / 2);
        return {
          hsn:      l.hsnCode || l.hsn || '',
          desc:     l.description || '',
          qty,
          unit:     l.unit || 'NOS',
          unitVal:  r2(price),
          txval:    taxable,
          irt:      gstRate,  // integrated tax rate
          iamt:     igstAmt,
          camt:     cgstAmt,
          samt:     sgstAmt,
          csamt:    0,        // cess — none for transport services
        };
      });
  }

  // ── Aggregate invoice-level tax ─────────────────────────
  function invTotals(inv, isIGST) {
    const taxable  = r2(Number(inv.taxableAmount || inv.subtotal) || 0);
    const gst      = r2(Number(inv.gstAmount) || 0);
    return {
      taxable,
      iamt:  isIGST ? gst : 0,
      camt:  isIGST ? 0 : r2(gst / 2),
      samt:  isIGST ? 0 : r2(gst / 2),
      csamt: 0,
    };
  }

  // ═══════════════════════════════════════════════════════
  // READ from IndexedDB
  // ═══════════════════════════════════════════════════════

  async function _loadData(period) {
    const db = window.LAMDB;
    if (!db) throw new Error('LAMDB not available — include lam-db.js before gst-export.js');

    const [invoiceAll, customers, companies, gstConfigs] = await Promise.all([
      db.dbGetAll('invoices'),
      db.dbGetAll('customers'),
      db.dbGetAll('companies'),
      db.dbGetAll('gst_config').catch(() => []),
    ]);

    // Filter invoices for the requested period (YYYY-MM)
    const invoices = invoiceAll.filter(inv => {
      const d = inv.invoiceDate
        || (inv.createdAt?.seconds ? new Date(inv.createdAt.seconds * 1000).toISOString().slice(0, 10) : '');
      return d && d.startsWith(period);
    });

    const gstConfig  = gstConfigs[0] || {};
    const company    = companies[0] || {};
    const sellerGSTIN = gstConfig.gstin || company.gstin || '';
    const sellerStateCode = sellerGSTIN
      ? stateFromGSTIN(sellerGSTIN)
      : (STATE_CODES[gstConfig.state || company.state || ''] || DEFAULT_STATE_CODE);

    return { invoices, customers, gstConfig, company, sellerGSTIN, sellerStateCode };
  }

  // ═══════════════════════════════════════════════════════
  // BUILD GSTR-1 JSON (GSTN portal-accepted format)
  // ═══════════════════════════════════════════════════════
  //
  // Sections generated:
  //   b2b    — 4A  Invoices to registered buyers (with GSTIN)
  //   b2cs   — 7   B2C small (unregistered, intra-state, ≤ ₹2.5L)
  //   b2cl   — 5   B2C large (unregistered, inter-state, > ₹2.5L)
  //   hsn    — 12  HSN-wise summary
  //   doc_issue — 13 Document issued count
  // ═══════════════════════════════════════════════════════

  function buildGSTR1(period, { invoices, customers, gstConfig, sellerGSTIN, sellerStateCode }) {
    const fp = fmtPeriod(period);

    // ── Categorise invoices ──────────────────────────────
    const b2bInvoices  = [];
    const b2cInvoices  = [];

    for (const inv of invoices) {
      const cust = customers.find(c => c.id === inv.customerId) || {};
      if (cust.gstin && cust.gstin.trim().length === 15) {
        b2bInvoices.push({ inv, cust });
      } else {
        b2cInvoices.push({ inv, cust });
      }
    }

    // ── Section 4A — B2B ────────────────────────────────
    // Group by buyer GSTIN (each GSTIN can have multiple invoices)
    const b2bMap = new Map();
    for (const { inv, cust } of b2bInvoices) {
      const gstin     = cust.gstin.trim().toUpperCase();
      const custState = stateFromGSTIN(gstin);
      const isIGST    = isInterState(inv, custState, sellerStateCode);
      const totals    = invTotals(inv, isIGST);
      const lineItems = computeLineItems(inv.items, isIGST);
      const pos       = inv.placeOfSupply || custState || DEFAULT_STATE_CODE;

      const invEntry = {
        inum:    inv.invoiceNumber || inv.id,
        idt:     fmtDate(inv.invoiceDate),
        val:     r2(Number(inv.totalAmount) || 0),
        pos,
        rchrg:   inv.reverseCharge === true ? 'Y' : 'N',
        inv_typ: 'R',   // Regular invoice
        // Item details — one entry per unique GST rate
        itms: _groupLineItemsByRate(lineItems, isIGST),
      };

      if (!b2bMap.has(gstin)) b2bMap.set(gstin, []);
      b2bMap.get(gstin).push(invEntry);
    }

    const b2b = Array.from(b2bMap.entries()).map(([ctin, inv]) => ({ ctin, inv }));

    // ── Section 5 — B2CL (inter-state, > ₹2.5L) ────────
    const B2CL_THRESHOLD = 250000;
    const b2clInvoices = b2cInvoices.filter(({ inv }) => {
      const custStateFallback = DEFAULT_STATE_CODE;
      const isIGST = isInterState(inv, custStateFallback, sellerStateCode);
      return isIGST && (Number(inv.totalAmount) || 0) > B2CL_THRESHOLD;
    });

    // Group b2cl by POS (place of supply state)
    const b2clMap = new Map();
    for (const { inv } of b2clInvoices) {
      const pos    = inv.placeOfSupply || DEFAULT_STATE_CODE;
      const totals = invTotals(inv, true); // inter-state = IGST
      const invEntry = {
        inum: inv.invoiceNumber || inv.id,
        idt:  fmtDate(inv.invoiceDate),
        val:  r2(Number(inv.totalAmount) || 0),
        pos,
        itms: _groupLineItemsByRate(computeLineItems(inv.items, true), true),
      };
      if (!b2clMap.has(pos)) b2clMap.set(pos, []);
      b2clMap.get(pos).push(invEntry);
    }
    const b2cl = Array.from(b2clMap.entries()).map(([pos, inv]) => ({ pos, inv }));

    // ── Section 7 — B2CS (intra-state or inter-state ≤ ₹2.5L) ─
    // Aggregate by rate + state
    const b2csSmall = b2cInvoices.filter(({ inv }) => {
      const isIGST = isInterState(inv, DEFAULT_STATE_CODE, sellerStateCode);
      return !isIGST || (Number(inv.totalAmount) || 0) <= B2CL_THRESHOLD;
    });

    // Aggregate per (rt, pos, type)
    const b2csAgg = new Map();
    for (const { inv } of b2csSmall) {
      const isIGST = isInterState(inv, DEFAULT_STATE_CODE, sellerStateCode);
      const pos = inv.placeOfSupply || sellerStateCode;
      const typ = isIGST ? 'I' : 'OE'; // I=inter, OE=intra

      for (const item of (inv.items || [])) {
        if (!item || !item.description) continue;
        const qty     = Number(item.qty) || 1;
        const price   = Number(item.unitPrice) || 0;
        const disc    = Number(item.discount) || 0;
        const rate    = Number(item.gstRate) || 18;
        const taxable = r2(qty * price * (1 - disc / 100));
        const tax     = r2(taxable * rate / 100);

        const key = `${rate}_${pos}_${typ}`;
        if (!b2csAgg.has(key)) {
          b2csAgg.set(key, { rt: rate, pos, typ, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
        }
        const bucket = b2csAgg.get(key);
        bucket.txval = r2(bucket.txval + taxable);
        if (isIGST) {
          bucket.iamt = r2(bucket.iamt + tax);
        } else {
          bucket.camt = r2(bucket.camt + tax / 2);
          bucket.samt = r2(bucket.samt + tax / 2);
        }
      }

      // Fallback if no items: use invoice-level totals
      if (!inv.items || !inv.items.length) {
        const taxable = r2(Number(inv.taxableAmount || inv.subtotal) || 0);
        const gst     = r2(Number(inv.gstAmount) || 0);
        const rate    = 18;
        const key     = `${rate}_${pos}_${typ}`;
        if (!b2csAgg.has(key)) {
          b2csAgg.set(key, { rt: rate, pos, typ, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
        }
        const bucket = b2csAgg.get(key);
        bucket.txval = r2(bucket.txval + taxable);
        if (isIGST) { bucket.iamt = r2(bucket.iamt + gst); }
        else { bucket.camt = r2(bucket.camt + gst / 2); bucket.samt = r2(bucket.samt + gst / 2); }
      }
    }
    const b2cs = Array.from(b2csAgg.values());

    // ── Section 12 — HSN Summary ─────────────────────────
    const hsnMap = new Map();
    for (const inv of invoices) {
      const cust    = customers.find(c => c.id === inv.customerId) || {};
      const isIGST  = isInterState(inv, stateFromGSTIN(cust.gstin || ''), sellerStateCode);
      for (const item of (inv.items || [])) {
        if (!item || !item.description) continue;
        const hsn     = item.hsnCode || item.hsn || '9965'; // 9965 = freight/transport (default HSN)
        const qty     = Number(item.qty) || 1;
        const price   = Number(item.unitPrice) || 0;
        const disc    = Number(item.discount) || 0;
        const rate    = Number(item.gstRate) || 18;
        const taxable = r2(qty * price * (1 - disc / 100));
        const tax     = r2(taxable * rate / 100);

        const key = `${hsn}_${rate}`;
        if (!hsnMap.has(key)) {
          hsnMap.set(key, {
            hsn_sc: hsn, desc: item.description || '', uqc: item.unit || 'NOS',
            cnt: 0, qty: 0, val: 0, txval: 0,
            iamt: 0, camt: 0, samt: 0, csamt: 0,
          });
        }
        const h = hsnMap.get(key);
        h.cnt  += 1;
        h.qty   = r2(h.qty + qty);
        h.val   = r2(h.val + r2(qty * price));
        h.txval = r2(h.txval + taxable);
        if (isIGST) { h.iamt = r2(h.iamt + tax); }
        else { h.camt = r2(h.camt + tax / 2); h.samt = r2(h.samt + tax / 2); }
      }
    }
    const hsn = { data: Array.from(hsnMap.values()) };

    // ── Section 13 — Document Issued ─────────────────────
    const doc_issue = {
      doc_det: [{
        doc_num:  1,    // 1 = Invoices
        docs: [{
          num:  1,
          from: _docSeriesFrom(invoices),
          to:   _docSeriesTo(invoices),
          totnum:  invoices.length,
          cancel:  0,
          net_issue: invoices.length,
        }],
      }],
    };

    return {
      gstin:     sellerGSTIN,
      fp,
      gt:        r2(invoices.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0)),
      cur_gt:    r2(invoices.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0)),
      b2b:       b2b.length ? b2b : undefined,
      b2cl:      b2cl.length ? b2cl : undefined,
      b2cs:      b2cs.length ? b2cs : undefined,
      hsn,
      doc_issue,
      // Metadata
      _meta: {
        generated:   new Date().toISOString(),
        period,
        totalInvoices: invoices.length,
        b2bCount:    b2bInvoices.length,
        b2cCount:    b2cInvoices.length,
        generator:   'LAM v9 by Stratix Ecosystem',
        note:        'Verify all data before uploading to GSTN portal. This file is generated from LAM IndexedDB records.',
      },
    };
  }

  // ── Group line items by GST rate for GSTN itms[] format ─
  function _groupLineItemsByRate(lineItems, isIGST) {
    const rateMap = new Map();
    for (const l of lineItems) {
      const rate = l.irt;
      if (!rateMap.has(rate)) {
        rateMap.set(rate, { txval: 0, rt: rate, iamt: 0, camt: 0, samt: 0, csamt: 0 });
      }
      const bucket = rateMap.get(rate);
      bucket.txval = r2(bucket.txval + l.txval);
      bucket.iamt  = r2(bucket.iamt  + l.iamt);
      bucket.camt  = r2(bucket.camt  + l.camt);
      bucket.samt  = r2(bucket.samt  + l.samt);
    }
    return Array.from(rateMap.values()).map(d => ({ num: 1, itm_det: d }));
  }

  function _docSeriesFrom(invoices) {
    if (!invoices.length) return '';
    const nums = invoices.map(i => i.invoiceNumber || '').filter(Boolean).sort();
    return nums[0] || '';
  }

  function _docSeriesTo(invoices) {
    if (!invoices.length) return '';
    const nums = invoices.map(i => i.invoiceNumber || '').filter(Boolean).sort();
    return nums[nums.length - 1] || '';
  }

  // ═══════════════════════════════════════════════════════
  // BUILD GSTR-3B JSON (GSTN portal-accepted format)
  // ═══════════════════════════════════════════════════════
  //
  // Key sections:
  //   sup_details.osup_det   — 3.1(a) Outward taxable supplies
  //   sup_details.osup_zero  — 3.1(b) Zero-rated
  //   sup_details.osup_nil_exmp — 3.1(c) Nil/exempt
  //   sup_details.isup_rev   — 3.1(d) Reverse charge
  //   itc_elg.itc_avl        — 4(A)  ITC available
  //   intr_ltfee             — 5.1   Interest/late fee
  // ═══════════════════════════════════════════════════════

  function buildGSTR3B(period, { invoices, sellerGSTIN, sellerStateCode }) {
    const fp     = fmtPeriod(period);
    const retPer = fp; // GSTN uses same MMYYYY for ret_period

    let totalTaxable = 0, totalIGST = 0, totalCGST = 0, totalSGST = 0;

    for (const inv of invoices) {
      const taxable = r2(Number(inv.taxableAmount || inv.subtotal) || 0);
      const gst     = r2(Number(inv.gstAmount) || 0);
      const isIGST  = !!(inv.igst) || (inv.supplyType || '').toLowerCase().includes('inter');

      totalTaxable += taxable;
      if (isIGST) { totalIGST += gst; }
      else { totalCGST += r2(gst / 2); totalSGST += r2(gst / 2); }
    }

    totalTaxable = r2(totalTaxable);
    totalIGST    = r2(totalIGST);
    totalCGST    = r2(totalCGST);
    totalSGST    = r2(totalSGST);
    const totalTax = r2(totalIGST + totalCGST + totalSGST);

    return {
      gstin:      sellerGSTIN,
      ret_period: retPer,
      // 3.1 — Outward supplies
      sup_details: {
        osup_det: {
          // 3.1(a) Taxable outward + zero-rated non-export + deemed export
          txval: totalTaxable,
          iamt:  totalIGST,
          camt:  totalCGST,
          samt:  totalSGST,
          csamt: 0,
        },
        osup_zero: {
          // 3.1(b) Zero-rated (exports / SEZ)
          txval: 0,
          iamt:  0,
          csamt: 0,
        },
        osup_nil_exmp: {
          // 3.1(c) Nil/exempt/non-GST
          txval: 0,
        },
        isup_rev: {
          // 3.1(d) Inward supplies on reverse charge (paid as recipient)
          txval: 0,
          iamt:  0,
          camt:  0,
          samt:  0,
          csamt: 0,
        },
        osup_nongst: {
          // 3.1(e) Non-GST outward
          txval: 0,
        },
      },
      // 3.2 — Supplies to UIN holders (inter-state, auto-flows from GSTR-1)
      inter_sup: {
        unreg_details: [],
        comp_details:  [],
        uin_details:   [],
      },
      // 4(A) — ITC available
      itc_elg: {
        itc_avl: [
          { ty: 'IGST', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'CGST', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'SGST', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'ISD',  iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'OTH',  iamt: 0, camt: 0, samt: 0, csamt: 0 },
        ],
        itc_rev: [
          { ty: 'RUL42', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'RUL43', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'OTH',   iamt: 0, camt: 0, samt: 0, csamt: 0 },
        ],
        itc_net: { iamt: 0, camt: 0, samt: 0, csamt: 0 },
        itc_inelg: [
          { ty: 'RUL38', iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { ty: 'OTH',   iamt: 0, camt: 0, samt: 0, csamt: 0 },
        ],
      },
      // 4(D) — Inward supplies not eligible for ITC
      inward_sup: {
        isup_details: [
          { tpty: 'GSTIN', inter: 0, intra: 0 },
          { tpty: 'OTH',   inter: 0, intra: 0 },
        ],
      },
      // 5.1 — Interest and late fee (fill manually if applicable)
      intr_ltfee: {
        intr_details: {
          iamt:  0,
          camt:  0,
          samt:  0,
          csamt: 0,
        },
        ltfee_details: {
          iamt:  0,
          camt:  0,
          samt:  0,
          csamt: 0,
        },
      },
      // Summary for human validation
      _summary: {
        period,
        totalInvoices: invoices.length,
        totalTaxableValue: totalTaxable,
        totalIGST,
        totalCGST,
        totalSGST,
        totalTaxLiability: totalTax,
        netTaxPayable: totalTax, // ITC offset = 0 by default (fill manually)
        note: 'ITC (input tax credit) from purchases is NOT auto-populated. Fill section 4 manually from your GSTR-2B. Net tax payable = Tax Liability − ITC.',
      },
      _meta: {
        generated:  new Date().toISOString(),
        generator:  'LAM v9 by Stratix Ecosystem',
        gstin:      sellerGSTIN,
        ret_period: retPer,
        warning:    'Review before upload. ITC values default to zero — update from GSTR-2B before filing.',
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // ZIP BUILDER (pure JS — no external libs)
  // Implements enough of the ZIP spec for two JSON files
  // Uses STORE compression (no deflate dependency)
  // ═══════════════════════════════════════════════════════

  function buildZip(files) {
    // files: Array of { name: string, data: Uint8Array }
    const encoder   = new TextEncoder();
    const localHeaders  = [];
    const centralDirEntries = [];
    let   offset    = 0;

    function crc32(buf) {
      let c = 0xFFFFFFFF;
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let x = i;
        for (let j = 0; j < 8; j++) x = (x & 1) ? (0xEDB88320 ^ (x >>> 1)) : (x >>> 1);
        t[i] = x;
      }
      for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function writeU16(v) { return [(v & 0xFF), (v >> 8) & 0xFF]; }
    function writeU32(v) {
      return [(v & 0xFF), (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
    }

    const now = new Date();
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data      = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
      const crc       = crc32(data);
      const size      = data.length;

      // Local file header (sig 0x04034b50)
      const localHeader = [
        0x50, 0x4B, 0x03, 0x04,   // signature
        ...writeU16(20),           // version needed (2.0)
        ...writeU16(0),            // general purpose bit flag
        ...writeU16(0),            // compression: STORE
        ...writeU16(dosTime),
        ...writeU16(dosDate),
        ...writeU32(crc),
        ...writeU32(size),         // compressed size
        ...writeU32(size),         // uncompressed size
        ...writeU16(nameBytes.length),
        ...writeU16(0),            // extra field length
        ...nameBytes,
      ];

      localHeaders.push({ header: new Uint8Array(localHeader), data, nameBytes, crc, size, offset });
      offset += localHeader.length + size;

      // Central directory entry
      const cdEntry = [
        0x50, 0x4B, 0x01, 0x02,   // central dir signature
        ...writeU16(20),           // version made by
        ...writeU16(20),           // version needed
        ...writeU16(0),            // bit flag
        ...writeU16(0),            // compression: STORE
        ...writeU16(dosTime),
        ...writeU16(dosDate),
        ...writeU32(crc),
        ...writeU32(size),
        ...writeU32(size),
        ...writeU16(nameBytes.length),
        ...writeU16(0),            // extra field
        ...writeU16(0),            // file comment
        ...writeU16(0),            // disk start
        ...writeU16(0),            // internal attributes
        ...writeU32(0),            // external attributes
        ...writeU32(localHeaders[localHeaders.length - 1].offset), // relative offset of local header
        ...nameBytes,
      ];
      centralDirEntries.push(new Uint8Array(cdEntry));
    }

    const centralDirOffset = offset;
    const centralDirSize   = centralDirEntries.reduce((s, e) => s + e.length, 0);

    // End of central directory record
    const eocd = new Uint8Array([
      0x50, 0x4B, 0x05, 0x06,    // EOCD signature
      ...writeU16(0),             // disk number
      ...writeU16(0),             // disk with central dir
      ...writeU16(files.length),  // entries on disk
      ...writeU16(files.length),  // total entries
      ...writeU32(centralDirSize),
      ...writeU32(centralDirOffset),
      ...writeU16(0),             // comment length
    ]);

    // Assemble everything
    const parts = [];
    for (const f of localHeaders) { parts.push(f.header); parts.push(f.data); }
    for (const e of centralDirEntries) { parts.push(e); }
    parts.push(eocd);

    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of parts) { buf.set(p, pos); pos += p.length; }
    return buf;
  }

  // ═══════════════════════════════════════════════════════
  // TRIGGER DOWNLOAD
  // ═══════════════════════════════════════════════════════

  function _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href    = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC: exportGSTFilingZIP
  //   period: 'YYYY-MM' string
  //   Shows status via optional onStatus(msg) callback
  // ═══════════════════════════════════════════════════════

  async function exportGSTFilingZIP(period, onStatus) {
    const emit = onStatus || (() => {});
    try {
      emit('Reading invoices from local database…');
      const dataCtx = await _loadData(period);

      if (!dataCtx.invoices.length) {
        const msg = `No invoices found for ${period}. Create invoices first.`;
        emit(msg);
        return { ok: false, message: msg };
      }

      emit(`Found ${dataCtx.invoices.length} invoice(s). Building GSTR-1…`);
      const gstr1 = buildGSTR1(period, dataCtx);

      emit('Building GSTR-3B…');
      const gstr3b = buildGSTR3B(period, dataCtx);

      emit('Compressing files into ZIP…');
      const enc        = new TextEncoder();
      const gstr1Json  = JSON.stringify(gstr1, null, 2);
      const gstr3bJson = JSON.stringify(gstr3b, null, 2);
      const periodFmt  = period.replace('-', '_'); // e.g. 2025_06

      const zipData = buildZip([
        { name: `GSTR1_${periodFmt}.json`,  data: enc.encode(gstr1Json) },
        { name: `GSTR3B_${periodFmt}.json`, data: enc.encode(gstr3bJson) },
        { name: `README_${periodFmt}.txt`,  data: enc.encode(_makeReadme(period, dataCtx)) },
      ]);

      const blob    = new Blob([zipData], { type: 'application/zip' });
      const gstin   = dataCtx.sellerGSTIN || 'GSTIN_NOT_SET';
      _download(blob, `GST_Filing_${gstin}_${periodFmt}.zip`);

      const summary = {
        ok:         true,
        period,
        invoices:   dataCtx.invoices.length,
        b2b:        gstr1.b2b?.length || 0,
        b2c:        (gstr1.b2cs?.length || 0) + (gstr1.b2cl?.length || 0),
        taxLiability: gstr3b._summary.totalTaxLiability,
        message:    `ZIP downloaded. Upload GSTR1_${periodFmt}.json and GSTR3B_${periodFmt}.json to the GSTN portal.`,
      };
      emit(summary.message);
      return summary;

    } catch (err) {
      const msg = `GST export failed: ${err.message}`;
      emit(msg);
      console.error('[GSTExport]', err);
      return { ok: false, message: msg };
    }
  }

  // ── README text bundled inside the ZIP ─────────────────
  function _makeReadme(period, { invoices, gstConfig, sellerGSTIN }) {
    const [y, m] = period.split('-');
    const monthName = new Date(Number(y), Number(m) - 1, 1)
      .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    return [
      `LAM v9 GST Filing Package`,
      `Generated: ${new Date().toLocaleDateString('en-IN', { dateStyle: 'full', timeStyle: 'short' })}`,
      `Period: ${monthName}`,
      `GSTIN: ${sellerGSTIN || 'NOT CONFIGURED — set in GST Settings'}`,
      `Total Invoices: ${invoices.length}`,
      ``,
      `FILES IN THIS ZIP`,
      `─────────────────────────────────────────`,
      `GSTR1_${period.replace('-','_')}.json`,
      `  → Upload to GSTN portal → GSTR-1 → File using JSON`,
      `  → Contains: B2B invoices (4A), B2C supplies (5/7), HSN summary (12)`,
      ``,
      `GSTR3B_${period.replace('-','_')}.json`,
      `  → Upload to GSTN portal → GSTR-3B → File using JSON`,
      `  → ITC (Input Tax Credit) values are set to ZERO by default`,
      `  → Update section 4 with your GSTR-2B data before filing`,
      ``,
      `FILING STEPS`,
      `─────────────────────────────────────────`,
      `1. Log in to  https://gst.gov.in`,
      `2. Go to: Returns → File Returns → Select period`,
      `3. GSTR-1: Click "Prepare Offline" → Upload JSON → Review → Submit`,
      `4. GSTR-3B: File online (JSON upload available on portal)`,
      `5. Verify all figures before submitting`,
      ``,
      `IMPORTANT`,
      `─────────────────────────────────────────`,
      `• This file is generated from data recorded in LAM v9.`,
      `• Always cross-verify totals with your CA / accountant.`,
      `• ITC (Input Tax Credit) is NOT auto-populated in GSTR-3B.`,
      `  You must fill section 4 from your GSTR-2B auto-draft.`,
      `• HSN codes default to 9965 (Freight) if not set on line items.`,
      `  Review and correct HSN codes in your invoice line items.`,
      ``,
      `SUPPORT`,
      `stratixapp@gmail.com | Stratix Ecosystem`,
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // UI INJECTION
  // Adds "Export for GST Filing" button on the Reports page
  // Call injectReportsButton() after reports page renders
  // ═══════════════════════════════════════════════════════

  function injectReportsButton(containerSelector) {
    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;

    if (!container) return;

    // Avoid double-injection
    if (container.querySelector('#lam-gst-export-widget')) return;

    const currentMonth = new Date().toISOString().slice(0, 7);

    // Build 6 months of period options
    const periodOptions = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const val   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      return `<option value="${val}" ${i === 0 ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const widget = document.createElement('div');
    widget.id = 'lam-gst-export-widget';
    widget.style.cssText = `
      background: var(--bg-elevated, #1c1c1e);
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
      border-radius: var(--radius-lg, 12px);
      padding: 20px 24px;
      margin-bottom: var(--space-5, 20px);
      position: relative;
      overflow: hidden;
    `;

    widget.innerHTML = `
      <div style="
        position:absolute;inset:0;
        background:linear-gradient(135deg,rgba(10,132,255,0.07) 0%,rgba(50,215,75,0.04) 100%);
        pointer-events:none;
      "></div>
      <div style="position:relative;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
          <div style="
            width:40px;height:40px;border-radius:10px;
            background:linear-gradient(135deg,#0a84ff,#30d158);
            display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;
          ">🏛️</div>
          <div>
            <div style="font-family:var(--font-display,sans-serif);font-size:16px;font-weight:700;color:var(--text-primary,#fff);">
              Export for GST Filing
            </div>
            <div style="font-size:12px;color:var(--text-muted,#999);margin-top:2px;">
              Download GSTR-1 + GSTR-3B JSON files ready for GSTN portal upload
            </div>
          </div>
        </div>

        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <div style="display:flex;flex-direction:column;gap:6px;">
            <label style="font-size:11px;font-weight:600;color:var(--text-secondary,#aaa);text-transform:uppercase;letter-spacing:0.05em;">
              Filing Period
            </label>
            <select id="gst-export-period" style="
              background:var(--bg-overlay,rgba(255,255,255,0.06));
              border:1px solid var(--border-subtle,rgba(255,255,255,0.12));
              border-radius:var(--radius-sm,8px);
              color:var(--text-primary,#fff);
              padding:8px 12px;
              font-size:14px;
              outline:none;
              cursor:pointer;
              min-width:200px;
            ">
              ${periodOptions}
            </select>
          </div>

          <button id="gst-export-btn" onclick="window.GSTExport.triggerExport()" style="
            background:linear-gradient(135deg,#0a84ff,#0060cc);
            color:#fff;
            border:none;
            border-radius:var(--radius-sm,8px);
            padding:9px 20px;
            font-size:14px;
            font-weight:600;
            cursor:pointer;
            display:flex;
            align-items:center;
            gap:8px;
            white-space:nowrap;
            transition:opacity 0.15s;
          ">
            <span style="font-size:16px;">⬇</span>
            Download ZIP
          </button>
        </div>

        <div id="gst-export-status" style="
          margin-top:12px;
          font-size:12px;
          color:var(--text-muted,#999);
          min-height:16px;
          transition:color 0.2s;
        "></div>

        <div style="
          margin-top:14px;
          padding-top:14px;
          border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
          gap:8px;
        ">
          ${[
            ['GSTR-1 JSON', 'B2B, B2C, HSN Summary', '🧾', '#0a84ff'],
            ['GSTR-3B JSON', 'Monthly tax summary', '📊', '#30d158'],
            ['README.txt', 'Filing instructions', '📋', '#ff9f0a'],
          ].map(([title, sub, icon, color]) => `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-card,rgba(255,255,255,0.03));border-radius:8px;">
              <span style="font-size:18px;">${icon}</span>
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--text-primary,#fff);">${title}</div>
                <div style="font-size:10px;color:var(--text-muted,#999);">${sub}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    container.insertBefore(widget, container.firstChild);
  }

  // ── Button trigger (called by onclick) ──────────────────
  async function triggerExport() {
    const periodEl = document.getElementById('gst-export-period');
    const period   = periodEl ? periodEl.value : new Date().toISOString().slice(0, 7);
    const btn      = document.getElementById('gst-export-btn');
    const status   = document.getElementById('gst-export-status');

    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = '<span>⏳</span> Preparing…'; }

    const result = await exportGSTFilingZIP(period, (msg) => {
      if (status) {
        status.textContent = msg;
        status.style.color = msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error')
          ? 'var(--color-error, #ff453a)'
          : 'var(--text-secondary, #aaa)';
      }
    });

    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      if (result.ok) {
        btn.innerHTML = '<span>✅</span> Downloaded';
        btn.style.background = 'linear-gradient(135deg,#30d158,#248a3d)';
        if (status) {
          status.style.color = 'var(--color-success, #30d158)';
          status.textContent = `✓ ${result.invoices} invoice(s) · ₹${(result.taxLiability || 0).toLocaleString('en-IN')} tax liability`;
        }
        setTimeout(() => {
          btn.innerHTML = '<span style="font-size:16px;">⬇</span> Download ZIP';
          btn.style.background = 'linear-gradient(135deg,#0a84ff,#0060cc)';
        }, 4000);
      } else {
        btn.innerHTML = '<span>❌</span> Failed — Retry';
        btn.style.background = 'linear-gradient(135deg,#ff453a,#c0392b)';
        setTimeout(() => {
          btn.innerHTML = '<span style="font-size:16px;">⬇</span> Download ZIP';
          btn.style.background = 'linear-gradient(135deg,#0a84ff,#0060cc)';
        }, 5000);
      }
    }

    return result;
  }

  // ── Auto-inject when DOM is ready ───────────────────────
  // Watches for a Reports page container via MutationObserver
  // Looks for common LAM reports container IDs/selectors
  function autoInject() {
    const TARGETS = [
      '#lam-reports-gst-widget-slot',
      '#reports-container',
      '#page-reports',
      '[data-page="reports"]',
      '.reports-page',
    ];

    function tryInject() {
      for (const sel of TARGETS) {
        const el = document.querySelector(sel);
        if (el) {
          injectReportsButton(el);
          // Also inject Tally XML export widget from lam-safety.js
          window.LAMSafety?.injectTallyExportWidget(el);
          return true;
        }
      }
      return false;
    }

    if (!tryInject()) {
      const observer = new MutationObserver(() => {
        if (tryInject()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ─── Expose public API ───────────────────────────────────
  return {
    exportGSTFilingZIP,
    buildGSTR1,
    buildGSTR3B,
    injectReportsButton,
    autoInject,
    triggerExport,
    // Expose for GST Suite integration (gst.js can call these directly)
    _loadData,
    // Tally XML export — delegates to lam-safety.js
    exportTallyXML: (opts) => window.LAMSafety?.exportTallyXML(opts),
  };

})();

window.GSTExport = GSTExport;

// Auto-inject the reports button when the module loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => GSTExport.autoInject());
} else {
  GSTExport.autoInject();
}
