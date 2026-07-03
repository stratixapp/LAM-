// ============================================================
// LAM — Excel / CSV / ZIP Engine (LAMExcel)
// Client-side XLSX read/write, CSV zip, column detection
// Depends on: SheetJS (xlsx) loaded via CDN or bundled
// ============================================================

const LAMExcel = (() => {

  // ── XLSX Export ──────────────────────────────────────────
  async function exportXLSX(allData, { headers = true } = {}) {
    const XLSX = await _getXLSX();
    const wb   = XLSX.utils.book_new();

    for (const [col, rows] of Object.entries(allData)) {
      if (!rows?.length) continue;
      const label = col.replace(/_/g,' ').replace(/\b\w/g, l => l.toUpperCase()).slice(0, 31);
      const ws = headers
        ? XLSX.utils.json_to_sheet(rows)
        : XLSX.utils.json_to_sheet(rows, { skipHeader: true });

      // Style header row
      if (headers) {
        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
        for (let C = range.s.c; C <= range.e.c; C++) {
          const addr = XLSX.utils.encode_cell({ r: 0, c: C });
          if (!ws[addr]) continue;
          ws[addr].s = {
            font: { bold: true, color: { rgb: '1E2535' } },
            fill: { fgColor: { rgb: '2563EB' } },
            alignment: { horizontal: 'left' },
          };
        }
        // Auto column widths
        const colWidths = [];
        const keys = Object.keys(rows[0] || {});
        keys.forEach((k, i) => {
          const maxLen = Math.max(
            k.length,
            ...rows.slice(0, 50).map(r => String(r[k] ?? '').length)
          );
          colWidths.push({ wch: Math.min(maxLen + 2, 40) });
        });
        ws['!cols'] = colWidths;
      }

      XLSX.utils.book_append_sheet(wb, ws, label);
    }

    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
    return new Blob([wbOut], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  // ── XLSX Parse ───────────────────────────────────────────
  async function parseXLSX(buf) {
    const XLSX = await _getXLSX();
    const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
    const result = {};

    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: '',
        blankrows: false,
        dateNF: 'YYYY-MM-DD',
      });

      if (rows.length < 2) continue;

      const rawHeaders = rows[0].map(h => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_'));
      const dataRows   = rows.slice(1).map(row => {
        const obj = {};
        rawHeaders.forEach((h, i) => {
          const val = row[i];
          if (val !== '' && val !== undefined && val !== null) obj[h] = val;
        });
        return obj;
      }).filter(row => Object.keys(row).length > 0);

      result[sheetName] = { headers: rawHeaders, rows: dataRows };
    }

    return result;
  }

  // ── CSV Export (single) ──────────────────────────────────
  function exportCSV(rows, { headers = true } = {}) {
    if (!rows?.length) return '';
    const keys = Object.keys(rows[0]);
    const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [];
    if (headers) lines.push(keys.map(esc).join(','));
    rows.forEach(row => lines.push(keys.map(k => esc(row[k])).join(',')));
    return lines.join('\r\n');
  }

  // ── CSV ZIP Export ───────────────────────────────────────
  async function exportCSVZip(allData, { headers = true } = {}) {
    // Build a simple ZIP manually (no dependency needed for small files)
    const files = [];

    for (const [col, rows] of Object.entries(allData)) {
      if (!rows?.length) continue;
      const csv  = exportCSV(rows, { headers });
      const data = new TextEncoder().encode(csv);
      files.push({ name: `${col}.csv`, data });
    }

    return _buildZip(files);
  }

  // ── CSV ZIP Parse ────────────────────────────────────────
  async function parseZipCSVs(buf) {
    const files = _parseZip(buf);
    const csvFiles = [];

    for (const { name, data } of files) {
      if (!name.toLowerCase().endsWith('.csv')) continue;
      const content = new TextDecoder().decode(data);
      csvFiles.push({ filename: name, content });
    }

    return csvFiles;
  }

  // ── Template Download ────────────────────────────────────
  // Generates an empty Excel template with correct headers for a collection
  async function downloadTemplate(collectionKey, meta) {
    const XLSX = await _getXLSX();
    const wb   = XLSX.utils.book_new();
    const keys = meta?.keys || ['name'];

    // Header row with sample data row
    const sample = {};
    keys.forEach(k => {
      const examples = {
        name: 'Example Name', email: 'example@company.com',
        phone: '9876543210', gstin: '27AABCU9603R1ZX',
        sku: 'PROD-001', qty: '100', amount: '50000',
        date: new Date().toISOString().slice(0,10),
        vehicleNumber: 'KL-01-AB-1234',
      };
      sample[k] = examples[k] || `sample_${k}`;
    });

    const ws = XLSX.utils.json_to_sheet([sample]);
    // Style header
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c: C });
      if (ws[addr]) ws[addr].s = { font: { bold: true } };
    }
    ws['!cols'] = keys.map(() => ({ wch: 20 }));

    XLSX.utils.book_append_sheet(wb, ws, collectionKey);
    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob  = new Blob([wbOut], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `lam-template-${collectionKey}.xlsx`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Auto-detect column mappings ──────────────────────────
  function detectMappings(headers, targetKeys) {
    const mappings = {};
    const normalize = s => s.toLowerCase().replace(/[\s_\-\.]/g, '');

    headers.forEach(h => {
      const nh = normalize(h);
      // Exact match
      const exact = targetKeys.find(k => normalize(k) === nh);
      if (exact) { mappings[h] = exact; return; }
      // Partial match
      const partial = targetKeys.find(k =>
        nh.includes(normalize(k)) || normalize(k).includes(nh)
      );
      if (partial) mappings[h] = partial;
      else mappings[h] = h; // keep original
    });

    return mappings;
  }

  // ── Internal: SheetJS lazy loader ───────────────────────
  async function _getXLSX() {
    if (window.XLSX) return window.XLSX;
    // Try to load from CDN
    await new Promise((resolve, reject) => {
      if (document.querySelector('script[data-lam-xlsx]')) {
        // Already loading, wait
        const check = setInterval(() => { if (window.XLSX) { clearInterval(check); resolve(); } }, 50);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.dataset.lamXlsx = '1';
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Could not load XLSX library. Check your internet connection.'));
      document.head.appendChild(s);
    });
    if (!window.XLSX) throw new Error('XLSX library failed to load');
    return window.XLSX;
  }

  // ── Internal: Minimal ZIP builder (PKZIP local file headers) ──
  function _buildZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const { name, data } of files) {
      const nameBytes = enc.encode(name);
      const crc = _crc32(data);
      const size = data.length;

      // Local file header
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lfhView = new DataView(lfh.buffer);
      lfhView.setUint32(0, 0x04034b50, true); // signature
      lfhView.setUint16(4, 20, true);          // version needed
      lfhView.setUint16(6, 0, true);           // flags
      lfhView.setUint16(8, 0, true);           // compression (stored)
      lfhView.setUint16(10, 0, true);          // mod time
      lfhView.setUint16(12, 0, true);          // mod date
      lfhView.setUint32(14, crc, true);        // crc32
      lfhView.setUint32(18, size, true);       // compressed size
      lfhView.setUint32(22, size, true);       // uncompressed size
      lfhView.setUint16(26, nameBytes.length, true); // filename length
      lfhView.setUint16(28, 0, true);          // extra length
      lfh.set(nameBytes, 30);

      // Central directory entry
      const cde = new Uint8Array(46 + nameBytes.length);
      const cdeView = new DataView(cde.buffer);
      cdeView.setUint32(0, 0x02014b50, true); // signature
      cdeView.setUint16(4, 20, true);          // version made by
      cdeView.setUint16(6, 20, true);          // version needed
      cdeView.setUint16(8, 0, true);
      cdeView.setUint16(10, 0, true);
      cdeView.setUint16(12, 0, true);
      cdeView.setUint16(14, 0, true);
      cdeView.setUint32(16, crc, true);
      cdeView.setUint32(20, size, true);
      cdeView.setUint32(24, size, true);
      cdeView.setUint16(28, nameBytes.length, true);
      cdeView.setUint16(30, 0, true);
      cdeView.setUint16(32, 0, true);
      cdeView.setUint16(34, 0, true);
      cdeView.setUint16(36, 0, true);
      cdeView.setUint32(38, 0, true);
      cdeView.setUint32(42, offset, true);
      cde.set(nameBytes, 46);

      parts.push(lfh, data);
      centralDir.push(cde);
      offset += lfh.length + data.length;
    }

    const cdSize   = centralDir.reduce((a,b) => a+b.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, files.length, true);
    eocdView.setUint16(10, files.length, true);
    eocdView.setUint32(12, cdSize, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);

    const allParts = [...parts, ...centralDir, eocd];
    const total    = allParts.reduce((a,b) => a+b.length, 0);
    const out      = new Uint8Array(total);
    let pos = 0;
    allParts.forEach(p => { out.set(p, pos); pos += p.length; });

    return new Blob([out], { type: 'application/zip' });
  }

  // ── Internal: Simple ZIP parser ──────────────────────────
  function _parseZip(buf) {
    const view  = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const files = [];
    let i = 0;

    while (i < bytes.length - 4) {
      if (view.getUint32(i, true) !== 0x04034b50) { i++; continue; }
      const nameLen  = view.getUint16(i + 26, true);
      const extraLen = view.getUint16(i + 28, true);
      const dataSize = view.getUint32(i + 18, true);
      const nameStart = i + 30;
      const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLen));
      const dataStart = nameStart + nameLen + extraLen;
      const data = bytes.slice(dataStart, dataStart + dataSize);
      files.push({ name, data });
      i = dataStart + dataSize;
    }

    return files;
  }

  // ── Internal: CRC32 ─────────────────────────────────────
  function _crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = _crc32Table();
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  let _crc32TableCache = null;
  function _crc32Table() {
    if (_crc32TableCache) return _crc32TableCache;
    _crc32TableCache = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32TableCache[i] = c;
    }
    return _crc32TableCache;
  }

  // ── Public API ───────────────────────────────────────────
  return {
    exportXLSX,
    parseXLSX,
    exportCSV,
    exportCSVZip,
    parseZipCSVs,
    downloadTemplate,
    detectMappings,
  };
})();

// Register globally
window.LAMExcel = LAMExcel;
export default LAMExcel;
