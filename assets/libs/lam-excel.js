// ============================================================
// LAM Excel Engine v1 — Pure JS, zero dependency
// Generates real .xlsx files via OOXML spec.
// One-click download from any table in the app.
// ============================================================

const EXCEL = (() => {

  // ── OOXML helpers ─────────────────────────────────────────
  const ESC = s => String(s??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');

  // Convert column index to letter (0=A, 25=Z, 26=AA...)
  function colLetter(n) {
    let s = '';
    n++;
    while (n > 0) { s = String.fromCharCode(65 + (n-1)%26) + s; n = Math.floor((n-1)/26); }
    return s;
  }

  // Cell address
  const addr = (col, row) => `${colLetter(col)}${row}`;

  // ── Shared strings table ─────────────────────────────────
  function buildSharedStrings(sheets) {
    const table = [];
    const index = new Map();
    const intern = val => {
      const s = String(val ?? '');
      if (!index.has(s)) { index.set(s, table.length); table.push(s); }
      return index.get(s);
    };
    sheets.forEach(sheet => {
      sheet.rows.forEach(row => row.forEach(cell => {
        if (cell?.type === 's' || typeof cell?.value === 'string') intern(cell?.value ?? cell ?? '');
      }));
    });
    return { table, intern };
  }

  // ── Style definitions ─────────────────────────────────────
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><name val="Arial"/></font>
    <font><b/><sz val="10"/><name val="Arial"/></font>
    <font><b/><sz val="12"/><name val="Arial"/><color rgb="FFFFFFFF"/></font>
    <font><sz val="9"/><name val="Arial"/><color rgb="FF64748B"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF064E3B"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
    <border><bottom style="medium"><color rgb="FF0A84FF"/></bottom><left/><right/><top/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0"  fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0"  fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0"  fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0"  fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="4"  fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="0"  fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
    <xf numFmtId="0"  fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

  // Style IDs
  const S = { DEFAULT: 0, HEADER_TITLE: 1, COL_HEADER: 2, DATA: 3, CURRENCY: 4, DATE: 5, TOTAL: 6, MUTED: 7 };

  // ── Sheet builder ─────────────────────────────────────────
  class Sheet {
    constructor(name) {
      this.name  = name;
      this.rows  = [];        // raw row data
      this._cols = [];        // column widths
    }

    // Add a title row (big dark header)
    title(text, colSpan = 8) {
      this.rows.push([{ value: text, type: 's', style: S.HEADER_TITLE, colSpan }]);
      return this;
    }

    // Add subtitle row
    subtitle(text) {
      this.rows.push([{ value: text, type: 's', style: S.MUTED }]);
      this.rows.push([]);
      return this;
    }

    // Add column headers row
    headers(labels) {
      this.rows.push(labels.map(l => ({ value: l, type: 's', style: S.COL_HEADER })));
      return this;
    }

    // Add data row - auto-detect type from value
    row(cells, style) {
      this.rows.push(cells.map(c => {
        if (c === null || c === undefined) return { value: '', type: 's', style: S.DATA };
        if (typeof c === 'number') {
          // Currency heuristic: if it looks like a money value
          const s = style || (Math.abs(c) > 1 && String(c).includes('.') ? S.CURRENCY : S.DATA);
          return { value: c, type: 'n', style: s };
        }
        if (c instanceof Date) return { value: c, type: 'd', style: S.DATE };
        return { value: String(c), type: 's', style: style || S.DATA };
      }));
      return this;
    }

    // Add total row
    total(label, values) {
      const row = [{ value: label, type: 's', style: S.TOTAL }];
      values.forEach(v => row.push({ value: v, type: typeof v === 'number' ? 'n' : 's', style: S.TOTAL }));
      this.rows.push(row);
      return this;
    }

    // Empty row spacer
    space() { this.rows.push([]); return this; }

    // Set column widths
    widths(arr) { this._cols = arr; return this; }
  }

  // ── Workbook ───────────────────────────────────────────────
  class Workbook {
    constructor() { this.sheets = []; }
    addSheet(name) { const s = new Sheet(name); this.sheets.push(s); return s; }
    download(filename = 'export.xlsx') { _buildAndDownload(this.sheets, filename); }
  }

  // ── XLSX binary builder ───────────────────────────────────
  function _buildAndDownload(sheets, filename) {
    const { table: ss, intern } = buildSharedStrings(sheets);

    // Build shared strings XML
    const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">
${ss.map(s => `<si><t xml:space="preserve">${ESC(s)}</t></si>`).join('\n')}
</sst>`;

    // Build each sheet XML
    const sheetXmls = sheets.map((sheet, si) => {
      const rows = sheet.rows.map((row, ri) => {
        if (!row.length) return `<row r="${ri+1}"/>`;
        const cells = row.map((cell, ci) => {
          if (!cell) return '';
          const a = addr(ci, ri+1);
          const s = cell.style ?? S.DEFAULT;
          if (cell.type === 'n') return `<c r="${a}" s="${s}" t="n"><v>${cell.value}</v></c>`;
          if (cell.type === 'd') {
            // Excel date serial
            const serial = Math.floor((cell.value - new Date(1899,11,30)) / 86400000);
            return `<c r="${a}" s="${s}" t="n"><v>${serial}</v></c>`;
          }
          // String
          const idx = intern(cell.value ?? '');
          return `<c r="${a}" s="${s}" t="s"><v>${idx}</v></c>`;
        }).filter(Boolean).join('');
        return `<row r="${ri+1}">${cells}</row>`;
      }).join('\n');

      const cols = sheet._cols.length
        ? `<cols>${sheet._cols.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
        : '';

      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${cols}
  <sheetData>${rows}</sheetData>
</worksheet>`;
    });

    // Build workbook.xml
    const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((s,i)=>`<sheet name="${ESC(s.name)}" sheetId="${i+1}" r:id="rId${i+2}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

    // Build [Content_Types].xml
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"             ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml"        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml"               ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`;

    // Build _rels/.rels
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    // Build xl/_rels/workbook.xml.rels
    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${sheets.map((_,i)=>`<Relationship Id="rId${i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('\n  ')}
</Relationships>`;

    // Zip it all together using a minimal Zip builder
    const zip = new _MiniZip();
    zip.add('[Content_Types].xml', contentTypes);
    zip.add('_rels/.rels', rootRels);
    zip.add('xl/workbook.xml', wbXml);
    zip.add('xl/_rels/workbook.xml.rels', wbRels);
    zip.add('xl/sharedStrings.xml', ssXml);
    zip.add('xl/styles.xml', STYLES_XML);
    sheetXmls.forEach((xml, i) => zip.add(`xl/worksheets/sheet${i+1}.xml`, xml));

    const blob = zip.build();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  // ── Minimal Zip builder (Store only — no compression needed for xlsx) ─
  class _MiniZip {
    constructor() { this._files = []; }

    add(name, content) {
      const enc  = new TextEncoder();
      const data = enc.encode(content);
      this._files.push({ name, data });
    }

    build() {
      const enc = new TextEncoder();
      const parts = [];
      const centralDir = [];
      let offset = 0;

      this._files.forEach(({ name, data }) => {
        const nameBuf = enc.encode(name);
        const crc = _crc32(data);
        const now  = new Date();
        const dosDate = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
        const dosTime = (now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);

        // Local file header
        const lh = new Uint8Array(30 + nameBuf.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0,  0x04034B50, true); // signature
        lv.setUint16(4,  20, true);          // version
        lv.setUint16(6,  0, true);           // flags
        lv.setUint16(8,  0, true);           // method: store
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBuf.length, true);
        lv.setUint16(28, 0, true);
        lh.set(nameBuf, 30);

        parts.push(lh, data);

        // Central dir entry
        const cd = new Uint8Array(46 + nameBuf.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0,  0x02014B50, true);
        cv.setUint16(4,  20, true);
        cv.setUint16(6,  20, true);
        cv.setUint16(8,  0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBuf.length, true);
        cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cd.set(nameBuf, 46);
        centralDir.push(cd);

        offset += lh.length + data.length;
      });

      const cdBuf = _concat(centralDir);
      const eocd  = new Uint8Array(22);
      const ev    = new DataView(eocd.buffer);
      ev.setUint32(0,  0x06054B50, true);
      ev.setUint16(4,  0, true); ev.setUint16(6, 0, true);
      ev.setUint16(8,  this._files.length, true);
      ev.setUint16(10, this._files.length, true);
      ev.setUint32(12, cdBuf.length, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);

      return new Blob([...(parts), cdBuf, eocd], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
  }

  function _concat(arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out   = new Uint8Array(total);
    let pos = 0;
    arrays.forEach(a => { out.set(a, pos); pos += a.length; });
    return out;
  }

  // CRC-32 implementation
  const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1;
      t[i] = c;
    }
    return t;
  })();

  function _crc32(u8) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) crc = _crcTable[(crc^u8[i])&0xFF] ^ (crc>>>8);
    return (crc^0xFFFFFFFF) >>> 0;
  }

  // ── Ready-made exporters ──────────────────────────────────

  /** Export any array of objects as Excel. Auto-detects headers. */
  function exportTable(data, opts = {}) {
    if (!data?.length) return;
    const wb   = new Workbook();
    const sh   = wb.addSheet(opts.sheet || 'Export');
    const keys = opts.keys || Object.keys(data[0]);
    const hdrs = opts.headers || keys;
    const company = opts.company;

    sh.title(opts.title || 'LAM Export', hdrs.length)
      .subtitle(`Generated: ${new Date().toLocaleDateString('en-IN')} ${company ? '• ' + company.name : ''}`)
      .headers(hdrs)
      .widths(hdrs.map(() => 18));

    data.forEach(item => sh.row(keys.map(k => item[k] ?? '')));

    if (opts.totals) {
      sh.space();
      sh.total('TOTAL', opts.totals);
    }

    wb.download(opts.filename || `${opts.title || 'Export'}_${Date.now()}.xlsx`);
  }

  /** Export invoices list */
  function invoices(data, company) {
    const fmt = n => Number(n||0);
    const wb  = new Workbook();
    const sh  = wb.addSheet('Invoices');

    sh.title('Invoices', 8)
      .subtitle(`${company?.name || 'LAM'} • ${new Date().toLocaleDateString('en-IN')}`)
      .headers(['Invoice No.', 'Date', 'Customer', 'Due Date', 'Status', 'Subtotal', 'GST', 'Total'])
      .widths([16, 14, 28, 14, 12, 14, 14, 16]);

    let totSub=0, totGst=0, totAmt=0;
    data.forEach(i => {
      sh.row([i.invoiceNumber||'—', i.invoiceDate ? new Date(i.invoiceDate).toLocaleDateString('en-IN') : '—',
              i.customerName||i.customerId||'—', i.dueDate ? new Date(i.dueDate).toLocaleDateString('en-IN') : '—',
              i.paymentStatus?.toUpperCase()||'UNPAID', fmt(i.subtotal), fmt(i.gstAmount), fmt(i.totalAmount)]);
      totSub += fmt(i.subtotal); totGst += fmt(i.gstAmount); totAmt += fmt(i.totalAmount);
    });

    sh.space().total('TOTAL', ['','','','', totSub, totGst, totAmt]);
    wb.download(`Invoices_${Date.now()}.xlsx`);
  }

  /** Export employee list */
  function employees(data, company) {
    const wb = new Workbook();
    const sh = wb.addSheet('Employees');
    sh.title('Employee Directory', 9)
      .subtitle(`${company?.name || 'LAM'} • ${new Date().toLocaleDateString('en-IN')}`)
      .headers(['Emp ID', 'Name', 'Email', 'Phone', 'Department', 'Role', 'Joining Date', 'Status', 'CTC'])
      .widths([10, 22, 28, 14, 16, 14, 14, 10, 14]);
    data.forEach(e => sh.row([
      e.employeeId||e.id?.slice(0,8)||'—', e.name||'—', e.email||'—', e.phone||'—',
      e.department||'—', e.role||'—', e.joiningDate ? new Date(e.joiningDate).toLocaleDateString('en-IN') : '—',
      e.status||'—', Number(e.ctc||0)
    ]));
    wb.download(`Employees_${Date.now()}.xlsx`);
  }

  /** Export inventory */
  function inventory(data, company) {
    const wb = new Workbook();
    const sh = wb.addSheet('Inventory');
    sh.title('Inventory Report', 8)
      .subtitle(`${company?.name || 'LAM'} • ${new Date().toLocaleDateString('en-IN')}`)
      .headers(['SKU', 'Product Name', 'Category', 'Unit', 'In Stock', 'Reorder Qty', 'Unit Cost', 'Stock Value', 'Status'])
      .widths([12, 28, 16, 10, 10, 10, 12, 14, 10]);
    data.forEach(p => {
      const val = (Number(p.qty)||0) * (Number(p.costPrice||p.price)||0);
      const status = (Number(p.qty)||0) <= (Number(p.reorderQty)||0) ? 'LOW STOCK' : 'OK';
      sh.row([p.sku||'—', p.name||'—', p.category||'—', p.unit||'Nos',
              Number(p.qty||0), Number(p.reorderQty||0), Number(p.costPrice||p.price||0), val, status]);
    });
    wb.download(`Inventory_${Date.now()}.xlsx`);
  }

  /** Export trip/fleet report */
  function trips(data, company) {
    const wb = new Workbook();
    const sh = wb.addSheet('Trips');
    sh.title('Trip Report', 9)
      .subtitle(`${company?.name || 'LAM'} • ${new Date().toLocaleDateString('en-IN')}`)
      .headers(['Trip ID', 'Date', 'Driver', 'Vehicle', 'Origin', 'Destination', 'Distance (km)', 'Status', 'Revenue'])
      .widths([12, 14, 20, 14, 20, 20, 14, 12, 14]);
    data.forEach(t => sh.row([
      t.tripId||t.id?.slice(0,8)||'—',
      t.date ? new Date(t.date).toLocaleDateString('en-IN') : '—',
      t.driverName||t.driverId||'—', t.vehicleNumber||'—',
      t.origin||'—', t.destination||'—',
      Number(t.distance||0), t.status||'—', Number(t.revenue||0)
    ]));
    wb.download(`Trips_${Date.now()}.xlsx`);
  }

  return { Workbook, Sheet, exportTable, invoices, employees, inventory, trips };

})();

window.LAMEXCEL = EXCEL;
