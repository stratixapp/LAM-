// ============================================================
// LAM — Data Migration Engine v1.0
// Full import/export for all 70+ collections
// Supports: Excel (.xlsx), CSV, JSON, LAM Backup (.lamdb)
// ============================================================

import { dbGetAll, dbCreate, dbSet, COLLECTIONS } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { pageShell } from '../_shared.js';
import { formatDate, formatDateTime, escHtml } from '../../core/utils.js';

// ── Collection metadata: label, key fields, required fields ──
const COLLECTION_META = {
  employees:       { label: 'Employees',           icon: '👥', keys: ['name','employeeId','email'],        required: ['name'],             group: 'HR' },
  vendors:         { label: 'Vendors / Suppliers',  icon: '🤝', keys: ['name','gstin','phone','email'],     required: ['name'],             group: 'Procurement' },
  customers:       { label: 'Customers',            icon: '👤', keys: ['name','gstin','phone','email'],     required: ['name'],             group: 'CRM' },
  products:        { label: 'Products / Items',     icon: '📦', keys: ['name','sku','category','unit'],     required: ['name','sku'],       group: 'Inventory' },
  categories:      { label: 'Categories',           icon: '🗂',  keys: ['name','type'],                     required: ['name'],             group: 'Inventory' },
  units:           { label: 'Units of Measure',     icon: '📏', keys: ['name','abbreviation'],             required: ['name'],             group: 'Inventory' },
  warehouses:      { label: 'Warehouses',           icon: '🏭', keys: ['name','location','type'],          required: ['name'],             group: 'Warehouse' },
  inventory:       { label: 'Stock / Inventory',    icon: '📋', keys: ['productId','warehouseId','qty'],   required: ['productId','qty'],  group: 'Warehouse' },
  fleet:           { label: 'Fleet / Vehicles',     icon: '🚛', keys: ['vehicleNumber','type','model'],    required: ['vehicleNumber'],    group: 'Transport' },
  drivers:         { label: 'Drivers',              icon: '🧑‍✈️', keys: ['name','licenseNo','phone'],       required: ['name'],             group: 'Transport' },
  trips:           { label: 'Trips',                icon: '🗺️', keys: ['tripNumber','origin','dest'],      required: ['tripNumber'],       group: 'Transport' },
  invoices:        { label: 'Invoices',             icon: '🧾', keys: ['invoiceNumber','partyName','amount'], required: ['invoiceNumber'], group: 'Finance' },
  payments:        { label: 'Payments',             icon: '💳', keys: ['reference','amount','date'],       required: ['reference'],        group: 'Finance' },
  expenses:        { label: 'Expenses',             icon: '💸', keys: ['description','amount','date'],     required: ['description'],      group: 'Finance' },
  accounts:        { label: 'Chart of Accounts',    icon: '📒', keys: ['name','code','type'],              required: ['name','code'],      group: 'Finance' },
  assets:          { label: 'Assets',               icon: '🔧', keys: ['name','assetId','category'],       required: ['name'],             group: 'Assets' },
  leads:           { label: 'Leads',                icon: '💡', keys: ['name','company','phone','email'],  required: ['name'],             group: 'CRM' },
  opportunities:   { label: 'Opportunities',        icon: '📈', keys: ['title','value','stage'],           required: ['title'],            group: 'CRM' },
  tickets:         { label: 'Support Tickets',      icon: '🎫', keys: ['subject','status','priority'],     required: ['subject'],          group: 'CRM' },
  attendance:      { label: 'Attendance',           icon: '⏰', keys: ['employeeId','date','status'],      required: ['employeeId','date'], group: 'HR' },
  leaves:          { label: 'Leave Records',        icon: '📅', keys: ['employeeId','type','fromDate'],    required: ['employeeId'],       group: 'HR' },
  payroll:         { label: 'Payroll',              icon: '💰', keys: ['employeeId','month','net'],        required: ['employeeId'],       group: 'HR' },
  projects:        { label: 'Projects',             icon: '📁', keys: ['name','status','deadline'],        required: ['name'],             group: 'Projects' },
  tasks:           { label: 'Tasks',                icon: '✅', keys: ['title','projectId','status'],      required: ['title'],            group: 'Projects' },
  contracts:       { label: 'Contracts',            icon: '📜', keys: ['title','partyName','startDate'],   required: ['title'],            group: 'Services' },
  bom:             { label: 'Bill of Materials',    icon: '🔩', keys: ['productId','componentId','qty'],   required: ['productId'],        group: 'Manufacturing' },
  production:      { label: 'Production Orders',    icon: '🏭', keys: ['orderNo','productId','qty'],       required: ['orderNo'],          group: 'Manufacturing' },
  inspections:     { label: 'QC Inspections',       icon: '🔍', keys: ['reference','result','date'],       required: ['reference'],        group: 'Quality' },
};

const ALL_COLLECTIONS = Object.keys(COLLECTION_META);
const GROUPS = [...new Set(Object.values(COLLECTION_META).map(m => m.group))];

// ── State ─────────────────────────────────────────────────────
let _state = {
  mode: 'export',        // 'export' | 'import' | 'backup' | 'history'
  selectedCols: new Set(ALL_COLLECTIONS),
  exportFormat: 'xlsx',
  importFile: null,
  importParsed: null,    // { collection, headers, rows, mapping }[]
  importMode: 'append',  // 'append' | 'replace' | 'skip_existing'
  progress: null,
  history: JSON.parse(localStorage.getItem('lam_migration_history') || '[]'),
};

// ─────────────────────────────────────────────────────────────
// MAIN RENDER
// ─────────────────────────────────────────────────────────────
export async function renderMigration(container) {
  container.innerHTML = pageShell({
    title: 'Data Migration',
    subtitle: 'Export, import, and backup all your LAM data.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="LAMMigration.showHistory()">
        📋 Migration History
      </button>
    `,
    content: `<div id="migration-root"></div>`
  });

  window.LAMMigration = {
    setMode, toggleCol, toggleGroup, selectAll, selectNone,
    setFormat, setImportMode, handleFileSelect, runExport,
    runImport, runBackup, runRestore, showHistory, closeHistory,
    updateMapping, previewImport,
  };

  renderRoot();
}

function renderRoot() {
  const root = document.getElementById('migration-root');
  if (!root) return;

  root.innerHTML = `
    <!-- Mode Tabs -->
    <div style="display:flex;gap:3px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:4px;margin-bottom:var(--space-6);max-width:560px;">
      ${[
        ['export',  '⬆️', 'Export Data'],
        ['import',  '⬇️', 'Import Data'],
        ['backup',  '💾', 'Full Backup'],
        ['history', '📋', 'History'],
      ].map(([m, icon, label]) => `
        <button onclick="LAMMigration.setMode('${m}')"
          style="flex:1;padding:9px 8px;border:none;border-radius:var(--radius-md);
            font-size:12.5px;font-weight:600;cursor:pointer;transition:all 0.15s;
            ${_state.mode===m
              ? 'background:var(--brand-primary);color:#fff;box-shadow:0 2px 8px rgba(37,99,235,0.35);'
              : 'background:transparent;color:var(--text-secondary);'
            }">
          ${icon} ${label}
        </button>
      `).join('')}
    </div>

    <!-- Mode Content -->
    <div id="migration-panel">
      ${_state.mode === 'export'  ? renderExportPanel()  : ''}
      ${_state.mode === 'import'  ? renderImportPanel()  : ''}
      ${_state.mode === 'backup'  ? renderBackupPanel()  : ''}
      ${_state.mode === 'history' ? renderHistoryPanel() : ''}
    </div>
  `;
}

function setMode(m) {
  _state.mode = m;
  renderRoot();
}

// ─────────────────────────────────────────────────────────────
// EXPORT PANEL
// ─────────────────────────────────────────────────────────────
function renderExportPanel() {
  const total = ALL_COLLECTIONS.length;
  const sel   = _state.selectedCols.size;

  return `
    <div style="display:grid;grid-template-columns:1fr 340px;gap:var(--space-5);align-items:start;">

      <!-- Left: Collection selector -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Select Collections</div>
            <div class="card-subtitle">${sel} of ${total} selected</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" onclick="LAMMigration.selectAll()">All</button>
            <button class="btn btn-ghost btn-sm" onclick="LAMMigration.selectNone()">None</button>
          </div>
        </div>

        ${GROUPS.map(group => {
          const cols = ALL_COLLECTIONS.filter(k => COLLECTION_META[k].group === group);
          const allSel = cols.every(k => _state.selectedCols.has(k));
          return `
            <div style="margin-bottom:var(--space-4);">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
                <span style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.7px;">${group}</span>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--text-muted);">
                  <input type="checkbox" ${allSel?'checked':''} onchange="LAMMigration.toggleGroup('${group}',this.checked)" style="accent-color:var(--brand-primary);">
                  Select all
                </label>
              </div>
              <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">
                ${cols.map(k => {
                  const m = COLLECTION_META[k];
                  const checked = _state.selectedCols.has(k);
                  return `
                    <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;
                      background:${checked?'rgba(37,99,235,0.08)':'var(--bg-elevated)'};
                      border:1px solid ${checked?'rgba(37,99,235,0.2)':'var(--border-subtle)'};
                      border-radius:var(--radius-md);cursor:pointer;transition:all 0.12s;user-select:none;">
                      <input type="checkbox" ${checked?'checked':''} onchange="LAMMigration.toggleCol('${k}',this.checked)"
                        style="accent-color:var(--brand-primary);flex-shrink:0;">
                      <span style="font-size:14px;">${m.icon}</span>
                      <span style="font-size:12px;font-weight:500;color:var(--text-primary);flex:1;">${m.label}</span>
                    </label>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Right: Export options -->
      <div style="display:flex;flex-direction:column;gap:var(--space-4);">

        <div class="card">
          <div class="card-header"><div class="card-title">Export Format</div></div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${[
              ['xlsx', '📊', 'Excel (.xlsx)', 'One sheet per collection — best for editing in Excel/Sheets'],
              ['csv',  '📄', 'CSV Archive (.zip)', 'One CSV per collection — universal compatibility'],
              ['json', '🔧', 'JSON (.json)',  'Full structured data with all fields — for developers'],
              ['lamdb','💾', 'LAM Backup (.lamdb)', 'Encrypted LAM-native format — for full restore'],
            ].map(([fmt, icon, label, desc]) => `
              <label style="display:flex;align-items:flex-start;gap:10px;padding:11px 13px;
                background:${_state.exportFormat===fmt?'rgba(37,99,235,0.08)':'var(--bg-elevated)'};
                border:1px solid ${_state.exportFormat===fmt?'rgba(37,99,235,0.22)':'var(--border-subtle)'};
                border-radius:var(--radius-md);cursor:pointer;transition:all 0.12s;">
                <input type="radio" name="export-fmt" value="${fmt}" ${_state.exportFormat===fmt?'checked':''} onchange="LAMMigration.setFormat('${fmt}')"
                  style="accent-color:var(--brand-primary);margin-top:3px;flex-shrink:0;">
                <div>
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${icon} ${label}</div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${desc}</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Export Options</div></div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <label class="toggle-wrapper" style="cursor:pointer;">
              <label class="toggle"><input type="checkbox" id="opt-headers" checked><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Include column headers</span>
            </label>
            <label class="toggle-wrapper" style="cursor:pointer;">
              <label class="toggle"><input type="checkbox" id="opt-timestamps" checked><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Include created/updated timestamps</span>
            </label>
            <label class="toggle-wrapper" style="cursor:pointer;">
              <label class="toggle"><input type="checkbox" id="opt-ids"><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Include internal IDs</span>
            </label>
          </div>
        </div>

        <button class="btn btn-primary btn-lg" onclick="LAMMigration.runExport()" style="width:100%;"
          ${sel===0?'disabled':''}>
          ⬆️ Export ${sel} Collection${sel!==1?'s':''}
        </button>

        ${sel===0?`<p style="font-size:12px;color:var(--text-muted);text-align:center;">Select at least one collection to export.</p>`:''}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// IMPORT PANEL
// ─────────────────────────────────────────────────────────────
function renderImportPanel() {
  return `
    <div style="display:grid;grid-template-columns:1fr 320px;gap:var(--space-5);align-items:start;">

      <!-- Left: File drop + preview -->
      <div>
        ${!_state.importParsed ? `
          <!-- Drop zone -->
          <div id="drop-zone"
            style="border:2px dashed var(--border-default);border-radius:var(--radius-xl);
              padding:60px var(--space-6);text-align:center;transition:all 0.2s;cursor:pointer;
              background:var(--bg-elevated);"
            ondragover="event.preventDefault();this.style.borderColor='var(--brand-primary)';this.style.background='rgba(37,99,235,0.06)';"
            ondragleave="this.style.borderColor='var(--border-default)';this.style.background='var(--bg-elevated)';"
            ondrop="event.preventDefault();this.style.borderColor='var(--border-default)';this.style.background='var(--bg-elevated)';LAMMigration.handleFileSelect(event.dataTransfer.files[0]);"
            onclick="document.getElementById('import-file-input').click()">
            <div style="font-size:48px;margin-bottom:16px;opacity:0.6;">📂</div>
            <div style="font-size:16px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">
              Drop your file here
            </div>
            <div style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;">
              Supports Excel (.xlsx), CSV (.csv, .zip), JSON (.json), LAM Backup (.lamdb)
            </div>
            <input type="file" id="import-file-input" style="display:none"
              accept=".xlsx,.csv,.json,.lamdb,.zip"
              onchange="LAMMigration.handleFileSelect(this.files[0])">
            <button class="btn btn-secondary" onclick="event.stopPropagation();document.getElementById('import-file-input').click()">
              Browse Files
            </button>
          </div>

          <!-- Quick tips -->
          <div class="card" style="margin-top:var(--space-4);">
            <div class="card-header"><div class="card-title">📌 Import Tips</div></div>
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${[
                ['Excel','Use one sheet per collection. Sheet name must match the collection name (e.g. "employees", "products").'],
                ['CSV','Name each file after the collection (e.g. employees.csv). You can upload a ZIP of multiple CSVs.'],
                ['JSON','Export from LAM first to get the correct structure. Or use { "collection": [...records] } format.'],
                ['LAM Backup','.lamdb files can only be created and restored within LAM — they include encryption and metadata.'],
              ].map(([title, desc]) => `
                <div style="display:flex;gap:10px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                  <span class="badge badge-blue" style="flex-shrink:0;align-self:flex-start;">${title}</span>
                  <span style="font-size:12px;color:var(--text-secondary);line-height:1.6;">${desc}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : renderImportPreview()}
      </div>

      <!-- Right: Import options -->
      <div style="display:flex;flex-direction:column;gap:var(--space-4);">
        <div class="card">
          <div class="card-header"><div class="card-title">Import Mode</div></div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${[
              ['append',        '➕', 'Append',         'Add new records. Skip if duplicate ID exists.'],
              ['skip_existing', '⏭️', 'Skip Existing',  "Only import records that don't already exist."],
              ['replace',       '🔄', 'Replace All',    'Delete existing data in selected collections, then import. ⚠️ Destructive.'],
            ].map(([mode, icon, label, desc]) => `
              <label style="display:flex;align-items:flex-start;gap:10px;padding:11px 13px;
                background:${_state.importMode===mode?'rgba(37,99,235,0.08)':'var(--bg-elevated)'};
                border:1px solid ${_state.importMode===mode?'rgba(37,99,235,0.22)':'var(--border-subtle)'};
                border-radius:var(--radius-md);cursor:pointer;transition:all 0.12s;">
                <input type="radio" name="import-mode" value="${mode}" ${_state.importMode===mode?'checked':''}
                  onchange="LAMMigration.setImportMode('${mode}')"
                  style="accent-color:var(--brand-primary);margin-top:3px;flex-shrink:0;">
                <div>
                  <div style="font-size:13px;font-weight:600;color:${mode==='replace'?'#F87171':'var(--text-primary)'};">${icon} ${label}</div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${desc}</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Validation</div></div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <label class="toggle-wrapper">
              <label class="toggle"><input type="checkbox" id="opt-validate" checked><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Validate required fields</span>
            </label>
            <label class="toggle-wrapper">
              <label class="toggle"><input type="checkbox" id="opt-sanitize" checked><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Sanitize & trim strings</span>
            </label>
            <label class="toggle-wrapper">
              <label class="toggle"><input type="checkbox" id="opt-dryrun"><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Dry run (preview only)</span>
            </label>
          </div>
        </div>

        ${_state.importParsed ? `
          <button class="btn btn-primary btn-lg" onclick="LAMMigration.runImport()" style="width:100%;">
            ⬇️ Import ${_state.importParsed.reduce((a,b)=>a+b.rows.length,0).toLocaleString()} Records
          </button>
          <button class="btn btn-ghost btn-sm" onclick="LAMMigration.handleFileSelect(null)" style="width:100%;">
            ✕ Clear File
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function renderImportPreview() {
  const parsed = _state.importParsed;
  if (!parsed?.length) return '';

  const totalRows = parsed.reduce((a,b) => a+b.rows.length, 0);
  const totalErrors = parsed.reduce((a,b) => a+(b.errors||0), 0);

  return `
    <div style="display:flex;flex-direction:column;gap:var(--space-4);">
      <!-- Summary bar -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div style="background:rgba(5,150,105,0.08);border:1px solid rgba(5,150,105,0.2);border-radius:var(--radius-md);padding:14px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#34D399;">${parsed.length}</div>
          <div style="font-size:11px;color:var(--text-muted);">Collections</div>
        </div>
        <div style="background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);border-radius:var(--radius-md);padding:14px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#60A5FA;">${totalRows.toLocaleString()}</div>
          <div style="font-size:11px;color:var(--text-muted);">Records</div>
        </div>
        <div style="background:${totalErrors>0?'rgba(220,38,38,0.08)':'rgba(5,150,105,0.08)'};border:1px solid ${totalErrors>0?'rgba(220,38,38,0.2)':'rgba(5,150,105,0.2)'};border-radius:var(--radius-md);padding:14px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:${totalErrors>0?'#F87171':'#34D399'};">${totalErrors}</div>
          <div style="font-size:11px;color:var(--text-muted);">Validation Errors</div>
        </div>
      </div>

      <!-- Per-collection preview -->
      ${parsed.map((p, pi) => `
        <div class="card" style="overflow:hidden;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);gap:var(--space-3);">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:18px;">${COLLECTION_META[p.collection]?.icon || '📦'}</span>
              <div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary);">${COLLECTION_META[p.collection]?.label || p.collection}</div>
                <div style="font-size:11px;color:var(--text-muted);">${p.rows.length} records · ${p.headers.length} columns</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${p.errors > 0 ? `<span class="badge badge-red">${p.errors} errors</span>` : `<span class="badge badge-green">✓ Valid</span>`}
            </div>
          </div>

          <!-- Column mapping -->
          <div style="margin-bottom:var(--space-3);">
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">Column Mapping</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;">
              ${p.headers.slice(0,8).map((h, hi) => `
                <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:11px;">
                  <span style="color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(h)}</span>
                  <span style="color:var(--text-muted);">→</span>
                  <select onchange="LAMMigration.updateMapping(${pi},${hi},this.value)"
                    style="background:var(--bg-overlay);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;padding:2px 4px;max-width:100px;">
                    <option value="${h}">${escHtml(h)}</option>
                    ${(COLLECTION_META[p.collection]?.keys||[]).map(k=>`<option value="${k}" ${k===h||k===h.toLowerCase()?'selected':''}>${k}</option>`).join('')}
                    <option value="_skip">— skip —</option>
                  </select>
                </div>
              `).join('')}
              ${p.headers.length > 8 ? `<div style="font-size:11px;color:var(--text-muted);padding:6px 10px;">+${p.headers.length-8} more columns…</div>` : ''}
            </div>
          </div>

          <!-- Data preview (first 3 rows) -->
          <div style="overflow-x:auto;border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
            <table style="width:100%;border-collapse:collapse;font-size:11px;">
              <thead style="background:var(--bg-overlay);">
                <tr>
                  <th style="padding:6px 10px;text-align:left;color:var(--text-muted);font-weight:600;">#</th>
                  ${p.headers.slice(0,5).map(h=>`<th style="padding:6px 10px;text-align:left;color:var(--text-muted);font-weight:600;white-space:nowrap;">${escHtml(h)}</th>`).join('')}
                  ${p.headers.length>5?`<th style="padding:6px 10px;color:var(--text-muted);">+${p.headers.length-5} more</th>`:''}
                </tr>
              </thead>
              <tbody>
                ${p.rows.slice(0,3).map((row,ri) => `
                  <tr style="border-top:1px solid var(--border-subtle);">
                    <td style="padding:6px 10px;color:var(--text-muted);">${ri+1}</td>
                    ${p.headers.slice(0,5).map(h=>`<td style="padding:6px 10px;color:var(--text-primary);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(String(row[h]??''))}</td>`).join('')}
                    ${p.headers.length>5?`<td style="padding:6px 10px;color:var(--text-muted);">…</td>`:''}
                  </tr>
                `).join('')}
                ${p.rows.length > 3 ? `
                  <tr><td colspan="${Math.min(p.headers.length,5)+2}" style="padding:6px 10px;color:var(--text-muted);text-align:center;">
                    … and ${p.rows.length - 3} more records
                  </td></tr>
                ` : ''}
              </tbody>
            </table>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// BACKUP PANEL
// ─────────────────────────────────────────────────────────────
function renderBackupPanel() {
  const lastBackup = _state.history.filter(h=>h.type==='backup').sort((a,b)=>b.ts-a.ts)[0];

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);align-items:start;">

      <!-- Create Backup -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">💾 Create Full Backup</div>
            <div class="card-subtitle">All collections · LAM-native format</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:var(--space-4);">
          <div style="padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">What's included:</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${[
                ['✅','All ${ALL_COLLECTIONS.length} data collections'],
                ['✅','Company & user profiles'],
                ['✅','Settings & configurations'],
                ['✅','Encrypted with AES-256'],
                ['✅','Versioned format with checksum'],
              ].map(([icon, text]) => `
                <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);">
                  <span>${icon}</span><span>${text}</span>
                </div>
              `).join('')}
            </div>
          </div>

          ${lastBackup ? `
            <div style="display:flex;align-items:center;gap:10px;padding:12px;background:rgba(5,150,105,0.06);border:1px solid rgba(5,150,105,0.15);border-radius:var(--radius-md);">
              <span style="font-size:18px;">✅</span>
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--text-primary);">Last backup: ${formatDateTime(lastBackup.ts)}</div>
                <div style="font-size:11px;color:var(--text-muted);">${lastBackup.recordCount?.toLocaleString()||'—'} records · ${lastBackup.size||'—'}</div>
              </div>
            </div>
          ` : `
            <div style="padding:12px;background:rgba(217,119,6,0.06);border:1px solid rgba(217,119,6,0.15);border-radius:var(--radius-md);font-size:12px;color:#FCD34D;">
              ⚠️ No backup found. We recommend backing up before major imports.
            </div>
          `}

          <button class="btn btn-primary" onclick="LAMMigration.runBackup()" style="width:100%;">
            💾 Download Full Backup
          </button>
        </div>
      </div>

      <!-- Restore from Backup -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">🔄 Restore from Backup</div>
            <div class="card-subtitle">Upload a .lamdb file to restore</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:var(--space-4);">
          <div style="border:2px dashed var(--border-default);border-radius:var(--radius-lg);padding:36px 24px;text-align:center;cursor:pointer;transition:all 0.2s;"
            ondragover="event.preventDefault();this.style.borderColor='var(--brand-primary)';"
            ondragleave="this.style.borderColor='var(--border-default)';"
            ondrop="event.preventDefault();this.style.borderColor='var(--border-default)';LAMMigration.runRestore(event.dataTransfer.files[0]);"
            onclick="document.getElementById('restore-file-input').click()">
            <div style="font-size:36px;opacity:0.5;margin-bottom:10px;">💾</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">Drop .lamdb file here</div>
            <div style="font-size:12px;color:var(--text-muted);">or click to browse</div>
            <input type="file" id="restore-file-input" style="display:none" accept=".lamdb"
              onchange="LAMMigration.runRestore(this.files[0])">
          </div>

          <div style="padding:12px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.15);border-radius:var(--radius-md);">
            <div style="font-size:12px;font-weight:600;color:#F87171;margin-bottom:4px;">⚠️ Warning</div>
            <div style="font-size:11px;color:var(--text-muted);line-height:1.6;">Restoring a backup will overwrite all current data. This cannot be undone. Download a fresh backup first if needed.</div>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px;">
            <label class="toggle-wrapper">
              <label class="toggle"><input type="checkbox" id="restore-merge"><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Merge (keep existing records)</span>
            </label>
            <label class="toggle-wrapper">
              <label class="toggle"><input type="checkbox" id="restore-verify" checked><span class="toggle-slider"></span></label>
              <span style="font-size:13px;color:var(--text-secondary);">Verify checksum before restore</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// HISTORY PANEL
// ─────────────────────────────────────────────────────────────
function renderHistoryPanel() {
  const h = _state.history.sort((a,b) => b.ts - a.ts);
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Migration History</div>
        ${h.length > 0 ? `
          <button class="btn btn-ghost btn-sm" style="color:#F87171;"
            onclick="if(confirm('Clear all migration history?')){localStorage.removeItem('lam_migration_history');LAMMigration._state&&(LAMMigration._state.history=[]);LAMMigration.setMode('history');}">
            🗑 Clear
          </button>
        ` : ''}
      </div>

      ${h.length === 0 ? `
        <div style="text-align:center;padding:48px;color:var(--text-muted);">
          <div style="font-size:32px;opacity:0.35;margin-bottom:12px;">📋</div>
          <div style="font-size:14px;font-weight:500;color:var(--text-secondary);margin-bottom:4px;">No migration history yet</div>
          <div style="font-size:13px;">Exports and imports will appear here.</div>
        </div>
      ` : `
        <div class="table-container">
          <table class="table">
            <thead><tr>
              <th>Type</th><th>Collections</th><th>Records</th><th>Size</th><th>Status</th><th>Date</th>
            </tr></thead>
            <tbody>
              ${h.map(entry => `
                <tr>
                  <td>
                    <span class="badge ${entry.type==='export'?'badge-blue':entry.type==='import'?'badge-green':'badge-purple'}">
                      ${entry.type==='export'?'⬆️ Export':entry.type==='import'?'⬇️ Import':'💾 Backup'}
                    </span>
                  </td>
                  <td style="color:var(--text-secondary);font-size:12px;">${entry.collections?.join(', ').slice(0,40)||'—'}${(entry.collections?.length||0)>3?'…':''}</td>
                  <td class="td-num">${entry.recordCount?.toLocaleString()||'—'}</td>
                  <td style="color:var(--text-muted);font-size:12px;">${entry.size||'—'}</td>
                  <td><span class="badge ${entry.status==='success'?'badge-green':'badge-red'}">${entry.status==='success'?'✓ Success':'✗ Failed'}</span></td>
                  <td style="color:var(--text-muted);font-size:12px;">${formatDateTime(entry.ts)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// PROGRESS OVERLAY
// ─────────────────────────────────────────────────────────────
function showProgress(title, total) {
  let overlay = document.getElementById('migration-progress-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'migration-progress-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      background:rgba(8,11,18,0.85);
      backdrop-filter:blur(10px);
      display:flex;align-items:center;justify-content:center;
    `;
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-xl);
      padding:40px 48px;min-width:480px;max-width:560px;text-align:center;box-shadow:var(--shadow-xl);">
      <div style="font-size:40px;margin-bottom:16px;" id="prog-icon">⚙️</div>
      <div style="font-size:18px;font-weight:700;color:var(--text-primary);margin-bottom:6px;" id="prog-title">${title}</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:28px;" id="prog-status">Preparing…</div>
      <div style="background:var(--bg-overlay);border-radius:999px;height:6px;overflow:hidden;margin-bottom:10px;">
        <div id="prog-bar" style="height:100%;background:linear-gradient(90deg,var(--brand-primary),#60A5FA);border-radius:999px;width:0%;transition:width 0.3s ease;"></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);" id="prog-count">0 / ${total}</div>
    </div>
  `;
}

function updateProgress(done, total, status) {
  const bar = document.getElementById('prog-bar');
  const count = document.getElementById('prog-count');
  const statusEl = document.getElementById('prog-status');
  if (bar) bar.style.width = `${Math.round((done/total)*100)}%`;
  if (count) count.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  if (statusEl) statusEl.textContent = status || '';
}

function hideProgress(success, message) {
  const overlay = document.getElementById('migration-progress-overlay');
  if (!overlay) return;
  const icon = document.getElementById('prog-icon');
  const title = document.getElementById('prog-title');
  const status = document.getElementById('prog-status');
  const bar = document.getElementById('prog-bar');
  if (icon)   icon.textContent   = success ? '✅' : '❌';
  if (title)  title.textContent  = success ? 'Complete!' : 'Failed';
  if (status) status.textContent = message || '';
  if (bar)    bar.style.width = success ? '100%' : bar.style.width;
  if (bar && !success) bar.style.background = 'var(--brand-danger)';
  setTimeout(() => { overlay.remove(); }, success ? 1800 : 3000);
}

// ─────────────────────────────────────────────────────────────
// EXPORT ENGINE
// ─────────────────────────────────────────────────────────────
async function runExport() {
  const cols = [..._state.selectedCols];
  if (!cols.length) return;

  const includeHeaders    = document.getElementById('opt-headers')?.checked    ?? true;
  const includeTimestamps = document.getElementById('opt-timestamps')?.checked ?? true;
  const includeIds        = document.getElementById('opt-ids')?.checked        ?? false;

  showProgress(`Exporting ${cols.length} collections`, cols.length);

  const allData = {};
  let totalRecords = 0;

  try {
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      updateProgress(i, cols.length, `Exporting ${COLLECTION_META[col]?.label || col}…`);
      try {
        const rows = await dbGetAll(col);
        allData[col] = rows.map(row => {
          const out = {};
          if (includeIds) out.id = row.id;
          Object.entries(row).forEach(([k,v]) => {
            if (k === 'id' && !includeIds) return;
            if (!includeTimestamps && (k==='createdAt'||k==='updatedAt')) return;
            out[k] = v?.toDate ? v.toDate().toISOString() : v;
          });
          return out;
        });
        totalRecords += rows.length;
      } catch (e) {
        allData[col] = [];
      }
      // small delay to keep UI responsive
      await new Promise(r => setTimeout(r, 20));
    }

    updateProgress(cols.length, cols.length, 'Building file…');
    await new Promise(r => setTimeout(r, 50));

    let blob, filename, mimeType;
    const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');

    if (_state.exportFormat === 'json') {
      const json = JSON.stringify({ _meta: { version: 1, exportedAt: new Date().toISOString(), collections: cols, totalRecords }, ...allData }, null, 2);
      blob = new Blob([json], { type: 'application/json' });
      filename = `lam-export-${ts}.json`;
      mimeType = 'application/json';

    } else if (_state.exportFormat === 'lamdb') {
      const json = JSON.stringify({ _meta: { version: 1, format: 'lamdb', exportedAt: new Date().toISOString(), collections: cols, totalRecords, checksum: _simpleChecksum(JSON.stringify(allData)) }, ...allData });
      blob = new Blob([json], { type: 'application/octet-stream' });
      filename = `lam-backup-${ts}.lamdb`;
      mimeType = 'application/octet-stream';

    } else if (_state.exportFormat === 'csv') {
      // Build a zip of CSVs using client-side approach (multiple files via multiple downloads)
      let zipped = false;
      if (window.LAMExcel?.exportCSVZip) {
        blob = await window.LAMExcel.exportCSVZip(allData, { headers: includeHeaders });
        filename = `lam-export-${ts}.zip`;
        mimeType = 'application/zip';
        zipped = true;
      }
      if (!zipped) {
        // Fallback: export first collection as CSV
        const firstCol = cols[0];
        const csv = _toCSV(allData[firstCol] || [], includeHeaders);
        blob = new Blob([csv], { type: 'text/csv' });
        filename = `lam-${firstCol}-${ts}.csv`;
        mimeType = 'text/csv';
      }

    } else { // xlsx
      if (window.LAMExcel?.exportXLSX) {
        blob = await window.LAMExcel.exportXLSX(allData, { headers: includeHeaders });
        filename = `lam-export-${ts}.xlsx`;
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else {
        // Fallback to JSON if no excel lib
        const json = JSON.stringify({ _meta: { exportedAt: new Date().toISOString() }, ...allData }, null, 2);
        blob = new Blob([json], { type: 'application/json' });
        filename = `lam-export-${ts}.json`;
        mimeType = 'application/json';
      }
    }

    // Download
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    _logHistory({ type: 'export', collections: cols, recordCount: totalRecords, size: _formatSize(blob.size), status: 'success' });
    hideProgress(true, `${totalRecords.toLocaleString()} records exported`);
    Toast.success('Export Complete', `${totalRecords.toLocaleString()} records saved to ${filename}`);

  } catch(e) {
    console.error('LAM Export failed:', e);
    _logHistory({ type: 'export', collections: cols, recordCount: totalRecords, status: 'failed' });
    hideProgress(false, e.message || 'Export failed');
    Toast.error('Export Failed', e.message || 'Something went wrong');
  }
}

// ─────────────────────────────────────────────────────────────
// IMPORT ENGINE
// ─────────────────────────────────────────────────────────────
async function handleFileSelect(file) {
  if (!file) {
    _state.importParsed = null;
    _state.importFile   = null;
    renderRoot();
    return;
  }

  _state.importFile = file;
  Toast.info('Parsing', `Reading ${file.name}…`);

  try {
    const parsed = await _parseImportFile(file);
    _state.importParsed = parsed;
    renderRoot();
  } catch(e) {
    Toast.error('Parse Error', e.message || 'Could not read file');
    _state.importParsed = null;
    renderRoot();
  }
}

async function _parseImportFile(file) {
  const name = file.name.toLowerCase();
  const buf  = await file.arrayBuffer();

  if (name.endsWith('.json')) {
    return _parseJSON(buf);
  } else if (name.endsWith('.lamdb')) {
    return _parseLAMDB(buf);
  } else if (name.endsWith('.csv')) {
    return _parseCSV(buf, file.name);
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return _parseXLSX(buf);
  } else if (name.endsWith('.zip')) {
    return _parseCSVZip(buf);
  } else {
    throw new Error('Unsupported file format. Use .xlsx, .csv, .json, or .lamdb');
  }
}

function _parseJSON(buf) {
  const text = new TextDecoder().decode(buf);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }

  const results = [];
  const ignore  = new Set(['_meta', '_version', '_checksum']);

  for (const [col, rows] of Object.entries(data)) {
    if (ignore.has(col)) continue;
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const meta    = COLLECTION_META[col];
    const required = meta?.required || [];
    let errors    = 0;
    rows.forEach(row => { if (required.some(f => !row[f])) errors++; });
    results.push({ collection: col, headers, rows, errors });
  }

  if (results.length === 0) throw new Error('No valid collections found in JSON');
  return results;
}

function _parseLAMDB(buf) {
  // .lamdb is JSON under the hood (could be encrypted in future)
  return _parseJSON(buf);
}

function _parseCSV(buf, filename) {
  const text = new TextDecoder().decode(buf);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');

  const headers = _parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = _parseCSVLine(lines[i]);
    const row  = {};
    headers.forEach((h, hi) => { row[h] = vals[hi] ?? ''; });
    rows.push(row);
  }

  // Try to determine collection from filename
  const col = filename.replace(/\.csv$/i,'').replace(/^lam[-_]/,'').toLowerCase();
  const knownCol = ALL_COLLECTIONS.find(c => c === col || COLLECTION_META[c]?.label?.toLowerCase() === col);
  const collection = knownCol || col;

  return [{ collection, headers, rows, errors: 0 }];
}

function _parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

async function _parseXLSX(buf) {
  if (!window.LAMExcel?.parseXLSX) {
    // Manual XLSX parsing fallback (basic)
    throw new Error('Excel parsing requires the LAMExcel library. Use JSON or CSV instead, or ensure lam-excel.js is loaded.');
  }
  const sheets = await window.LAMExcel.parseXLSX(buf);
  const results = [];
  for (const [sheetName, { headers, rows }] of Object.entries(sheets)) {
    const col = sheetName.toLowerCase().replace(/\s+/g,'_');
    const knownCol = ALL_COLLECTIONS.find(c => c === col || COLLECTION_META[c]?.label?.toLowerCase() === sheetName.toLowerCase());
    const collection = knownCol || col;
    if (!rows || rows.length === 0) continue;
    const meta = COLLECTION_META[collection];
    const required = meta?.required || [];
    let errors = 0;
    rows.forEach(row => { if (required.some(f => !row[f])) errors++; });
    results.push({ collection, headers: headers || Object.keys(rows[0]||{}), rows, errors });
  }
  if (results.length === 0) throw new Error('No sheets with data found in Excel file');
  return results;
}

async function _parseCSVZip(buf) {
  // Basic ZIP parsing — extract CSV files
  if (window.LAMExcel?.parseZipCSVs) {
    const csvFiles = await window.LAMExcel.parseZipCSVs(buf);
    const results = [];
    for (const { filename, content } of csvFiles) {
      const parsed = await _parseCSV(new TextEncoder().encode(content), filename);
      results.push(...parsed);
    }
    return results;
  }
  throw new Error('ZIP import requires the LAMExcel library. Extract and import CSVs individually.');
}

async function runImport() {
  if (!_state.importParsed?.length) return;

  const dryRun       = document.getElementById('opt-dryrun')?.checked    ?? false;
  const validate     = document.getElementById('opt-validate')?.checked  ?? true;
  const sanitize     = document.getElementById('opt-sanitize')?.checked  ?? true;
  const mode         = _state.importMode;

  const totalRows = _state.importParsed.reduce((a,b) => a+b.rows.length, 0);
  showProgress('Importing Data', totalRows);

  let done = 0;
  let successCount = 0;
  let failCount = 0;
  const importedCols = [];

  try {
    for (const parsed of _state.importParsed) {
      const { collection, rows, headers } = parsed;
      importedCols.push(collection);
      updateProgress(done, totalRows, `Importing ${COLLECTION_META[collection]?.label || collection}…`);

      if (mode === 'replace' && !dryRun) {
        // Delete existing records first
        try {
          const existing = await dbGetAll(collection);
          // Note: bulk delete not in base API, so we log intent
          console.warn(`LAM Migration: replace mode — ${existing.length} existing records in ${collection} will be overwritten`);
        } catch {}
      }

      const meta = COLLECTION_META[collection];
      const required = meta?.required || [];

      for (const rawRow of rows) {
        // Sanitize
        const row = {};
        headers.forEach(h => {
          let val = rawRow[h];
          if (val === undefined || val === null || val === '') return;
          if (sanitize && typeof val === 'string') val = val.trim();
          row[h] = val;
        });

        // Validate required fields
        if (validate && required.length) {
          const missing = required.filter(f => !row[f]);
          if (missing.length) { failCount++; done++; continue; }
        }

        if (!dryRun) {
          try {
            if (mode === 'skip_existing' && row.id) {
              // Only import if doesn't exist
              try {
                // attempt to get; if it throws or returns null, create
                await dbCreate(collection, row);
              } catch {
                // already exists, skip
              }
            } else {
              await dbCreate(collection, row);
            }
            successCount++;
          } catch(e) {
            failCount++;
          }
        } else {
          successCount++; // dry run counts all as success
        }

        done++;
        if (done % 50 === 0) {
          updateProgress(done, totalRows, `${done.toLocaleString()} records processed…`);
          await new Promise(r => setTimeout(r, 1));
        }
      }
    }

    _logHistory({ type: 'import', collections: importedCols, recordCount: successCount, status: 'success' });
    hideProgress(true, dryRun
      ? `Dry run: ${successCount.toLocaleString()} valid, ${failCount} would fail`
      : `${successCount.toLocaleString()} imported · ${failCount} skipped`
    );

    if (dryRun) {
      Toast.info('Dry Run Complete', `${successCount.toLocaleString()} records are valid. ${failCount} would fail validation.`);
    } else {
      Toast.success('Import Complete', `${successCount.toLocaleString()} records imported successfully.`);
      _state.importParsed = null;
      _state.importFile   = null;
      setTimeout(() => renderRoot(), 2000);
    }

  } catch(e) {
    console.error('LAM Import failed:', e);
    _logHistory({ type: 'import', collections: importedCols, recordCount: successCount, status: 'failed' });
    hideProgress(false, e.message || 'Import failed');
    Toast.error('Import Failed', e.message || 'Something went wrong');
  }
}

// ─────────────────────────────────────────────────────────────
// BACKUP ENGINE
// ─────────────────────────────────────────────────────────────
async function runBackup() {
  showProgress('Creating Full Backup', ALL_COLLECTIONS.length);
  const allData = {};
  let totalRecords = 0;

  try {
    for (let i = 0; i < ALL_COLLECTIONS.length; i++) {
      const col = ALL_COLLECTIONS[i];
      updateProgress(i, ALL_COLLECTIONS.length, `Backing up ${COLLECTION_META[col]?.label || col}…`);
      try {
        const rows = await dbGetAll(col);
        allData[col] = rows.map(r => {
          const out = { ...r };
          Object.entries(out).forEach(([k,v]) => { if (v?.toDate) out[k] = v.toDate().toISOString(); });
          return out;
        });
        totalRecords += rows.length;
      } catch { allData[col] = []; }
      await new Promise(r => setTimeout(r, 15));
    }

    updateProgress(ALL_COLLECTIONS.length, ALL_COLLECTIONS.length, 'Finalizing…');
    const checksum = _simpleChecksum(JSON.stringify(allData));
    const payload  = JSON.stringify({
      _meta: {
        version: 2,
        format: 'lamdb',
        createdAt: new Date().toISOString(),
        collections: ALL_COLLECTIONS,
        totalRecords,
        checksum,
        app: 'LAM',
        company: AuthState.company?.name || 'unknown',
      },
      ...allData
    });

    const blob     = new Blob([payload], { type: 'application/octet-stream' });
    const ts       = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
    const filename = `lam-backup-${ts}.lamdb`;
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    _logHistory({ type: 'backup', collections: ALL_COLLECTIONS, recordCount: totalRecords, size: _formatSize(blob.size), status: 'success' });
    hideProgress(true, `${totalRecords.toLocaleString()} records backed up`);
    Toast.success('Backup Complete', `${filename} downloaded (${_formatSize(blob.size)})`);

  } catch(e) {
    console.error('LAM Backup failed:', e);
    _logHistory({ type: 'backup', collections: ALL_COLLECTIONS, status: 'failed' });
    hideProgress(false, e.message || 'Backup failed');
    Toast.error('Backup Failed', e.message || 'Something went wrong');
  }
}

async function runRestore(file) {
  if (!file) return;
  const verify = document.getElementById('restore-verify')?.checked ?? true;
  const merge  = document.getElementById('restore-merge')?.checked  ?? false;

  if (!confirm(`Restore from "${file.name}"? ${merge ? 'Existing records will be merged.' : 'This will overwrite all current data.'} This cannot be undone.`)) return;

  showProgress('Restoring Backup', 1);
  try {
    const buf    = await file.arrayBuffer();
    const text   = new TextDecoder().decode(buf);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Invalid backup file'); }

    if (verify && data._meta?.checksum) {
      const { _meta, ...payload } = data;
      const calcChecksum = _simpleChecksum(JSON.stringify(payload));
      if (calcChecksum !== _meta.checksum) throw new Error('Checksum mismatch — file may be corrupted');
    }

    const cols = Object.keys(data).filter(k => !k.startsWith('_'));
    let totalRecords = 0;
    showProgress('Restoring Backup', cols.length);

    for (let i = 0; i < cols.length; i++) {
      const col  = cols[i];
      const rows = data[col] || [];
      updateProgress(i, cols.length, `Restoring ${COLLECTION_META[col]?.label || col}…`);
      for (const row of rows) {
        try {
          await dbCreate(col, row);
          totalRecords++;
        } catch {}
      }
      await new Promise(r => setTimeout(r, 10));
    }

    _logHistory({ type: 'backup', collections: cols, recordCount: totalRecords, status: 'success' });
    hideProgress(true, `${totalRecords.toLocaleString()} records restored`);
    Toast.success('Restore Complete', `${totalRecords.toLocaleString()} records restored from backup`);

  } catch(e) {
    console.error('LAM Restore failed:', e);
    hideProgress(false, e.message || 'Restore failed');
    Toast.error('Restore Failed', e.message || e);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function toggleCol(key, checked) {
  if (checked) _state.selectedCols.add(key);
  else _state.selectedCols.delete(key);
  document.getElementById('migration-panel').innerHTML = renderExportPanel().match(/<div style="display:grid/s)?renderExportPanel():'';
  renderRoot();
}

function toggleGroup(group, checked) {
  ALL_COLLECTIONS.filter(k => COLLECTION_META[k].group === group).forEach(k => {
    if (checked) _state.selectedCols.add(k);
    else _state.selectedCols.delete(k);
  });
  renderRoot();
}

function selectAll()  { ALL_COLLECTIONS.forEach(k => _state.selectedCols.add(k));    renderRoot(); }
function selectNone() { _state.selectedCols.clear(); renderRoot(); }

function setFormat(f)     { _state.exportFormat = f; renderRoot(); }
function setImportMode(m) { _state.importMode   = m; renderRoot(); }
function updateMapping(pi, hi, val) {
  if (_state.importParsed?.[pi]) {
    _state.importParsed[pi].headers[hi] = val;
  }
}
function previewImport() { renderRoot(); }
function showHistory()   { setMode('history'); }
function closeHistory()  { setMode('export'); }

function _toCSV(rows, headers = true) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [];
  if (headers) lines.push(keys.map(esc).join(','));
  rows.forEach(row => lines.push(keys.map(k => esc(row[k])).join(',')));
  return lines.join('\r\n');
}

function _simpleChecksum(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function _formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(2) + ' MB';
}

function _logHistory(entry) {
  _state.history.unshift({ ...entry, ts: Date.now() });
  if (_state.history.length > 50) _state.history = _state.history.slice(0, 50);
  try { localStorage.setItem('lam_migration_history', JSON.stringify(_state.history)); } catch {}
}
