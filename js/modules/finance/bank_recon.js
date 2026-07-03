// ============================================================
// LAM — Bank Reconciliation Module
// Import bank statements, auto-match GL entries,
// flag unreconciled, reconciliation report
// Interconnects: GL Entries ↔ Bank Transactions ↔ COA
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, dbBatch, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { ACC_COLLECTIONS } from './accounting.js';
import { FIN_COLLECTIONS } from './invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose
} from '../_shared.js';

export const BANK_COLLECTIONS = {
  BANK_ACCOUNTS:   'bank_accounts',
  BANK_STATEMENTS: 'bank_statements',
  BANK_TXN:        'bank_transactions',
  RECONCILIATIONS: 'bank_reconciliations',
};

let _bankAccounts=[], _transactions=[], _glEntries=[], _activeTab='accounts';
let _selectedBankId=null;
const PER=20;

export async function renderBankRecon(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_bankAccounts, _glEntries] = await Promise.all([
    dbGetAll(BANK_COLLECTIONS.BANK_ACCOUNTS, [...c, orderBy('createdAt','desc')]),
    dbGetAll(ACC_COLLECTIONS.GL_ENTRIES,     [...c, orderBy('date','desc')]),
  ]);

  container.innerHTML = pageShell({
    title: '🏦 Bank Reconciliation',
    subtitle: 'Import bank statements, match transactions and reconcile your books.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportReconReport()">⬇ Export Report</button>
      <button class="btn btn-primary" onclick="openModal('add-bank-modal')">+ Add Bank Account</button>
    `,
    content: `
      <!-- Bank Account Cards -->
      <div id="bank-cards-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--space-4);margin-bottom:var(--space-5);"></div>

      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);width:fit-content;">
        ${[
          ['accounts',  '🏦 Bank Accounts'],
          ['import',    '📥 Import Statement'],
          ['match',     '🔍 Match & Reconcile'],
          ['report',    '📋 Reconciliation Report'],
        ].map(([id,label]) => `
          <button class="bank-tab ${id==='accounts'?'active':''}" id="bank-tab-${id}"
            onclick="switchBankTab('${id}')"
            style="padding:7px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="bank-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = '.bank-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderBankCards();
  setupModalClose(); setupMenuClose();

  document.body.insertAdjacentHTML('beforeend', addBankModal());

  window.switchBankTab = switchBankTab;
  window.refreshBankRecon = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_bankAccounts,_glEntries]=await Promise.all([
      dbGetAll(BANK_COLLECTIONS.BANK_ACCOUNTS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(ACC_COLLECTIONS.GL_ENTRIES,[...c,orderBy('date','desc')]),
    ]);
    renderBankCards();
    switchBankTab(_activeTab);
  };

  switchBankTab('accounts');
}

// ── Bank Account Cards ────────────────────────────────────────
function renderBankCards() {
  const el = document.getElementById('bank-cards-grid'); if (!el) return;
  if (!_bankAccounts.length) { el.innerHTML=''; return; }
  el.innerHTML = _bankAccounts.map(bank => {
    const unreconciled = (bank.unreconciledCount || 0);
    const diff = Number(bank.bankBalance||0) - Number(bank.bookBalance||0);
    return `
      <div style="background:var(--bg-surface);border:1px solid ${_selectedBankId===bank.id?'var(--brand-primary)':'var(--border-subtle)'};
                  border-radius:var(--radius-lg);padding:var(--space-5);cursor:pointer;transition:all 0.2s;"
           onclick="selectBank('${bank.id}')"
           onmouseenter="this.style.borderColor='var(--border-strong)'"
           onmouseleave="this.style.borderColor='${_selectedBankId===bank.id?'var(--brand-primary)':'var(--border-subtle)'}'">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;">
          <div style="width:44px;height:44px;background:rgba(10,132,255,0.12);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">🏦</div>
          ${unreconciled > 0 ? `<span class="badge badge-orange">${unreconciled} unmatched</span>` : `<span class="badge badge-green">✅ Reconciled</span>`}
        </div>
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;margin-bottom:2px;">${escHtml(bank.bankName||'—')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">${escHtml(bank.accountNo||'—')} · ${escHtml(bank.ifsc||'—')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:10px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Bank Balance</div>
            <div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--brand-secondary);">₹${Number(bank.bankBalance||0).toLocaleString('en-IN')}</div>
          </div>
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:10px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Book Balance</div>
            <div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--brand-primary);">₹${Number(bank.bookBalance||0).toLocaleString('en-IN')}</div>
          </div>
        </div>
        ${Math.abs(diff) > 0.01 ? `
          <div style="margin-top:10px;padding:8px 12px;background:rgba(255,159,10,0.1);border-radius:8px;border-left:3px solid var(--brand-warning);">
            <span style="font-size:12px;color:var(--brand-warning);font-weight:600;">
              Difference: ₹${Math.abs(diff).toLocaleString('en-IN')} ${diff>0?'(Bank higher)':'(Book higher)'}
            </span>
          </div>` : `
          <div style="margin-top:10px;padding:8px 12px;background:rgba(0,200,150,0.1);border-radius:8px;border-left:3px solid var(--brand-secondary);">
            <span style="font-size:12px;color:var(--brand-secondary);font-weight:600;">✅ Balances match</span>
          </div>`}
      </div>`;
  }).join('');
}

window.selectBank = (id) => {
  _selectedBankId = id;
  renderBankCards();
  switchBankTab('match');
};

function switchBankTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.bank-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`bank-tab-${tab}`)?.classList.add('active');
  const c = document.getElementById('bank-tab-content'); if (!c) return;
  switch(tab) {
    case 'accounts': renderBankAccountsTab(c); break;
    case 'import':   renderImportTab(c);       break;
    case 'match':    renderMatchTab(c);        break;
    case 'report':   renderReportTab(c);       break;
  }
}

// ══════════════════════════════════════════════════════════════
// BANK ACCOUNTS TAB
// ══════════════════════════════════════════════════════════════
function renderBankAccountsTab(container) {
  container.innerHTML = `
    <div class="table-container">
      <table class="table">
        <thead>
          <tr>
            <th>Bank Name</th>
            <th>Account No.</th>
            <th>IFSC</th>
            <th>Account Type</th>
            <th style="text-align:right;">Book Balance</th>
            <th style="text-align:right;">Bank Balance</th>
            <th style="text-align:right;">Difference</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${_bankAccounts.length ? _bankAccounts.map(bank => {
            const diff = Number(bank.bankBalance||0) - Number(bank.bookBalance||0);
            return `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:32px;height:32px;background:rgba(10,132,255,0.12);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">🏦</div>
                    <div>
                      <div style="font-size:13px;font-weight:600;">${escHtml(bank.bankName||'—')}</div>
                      <div style="font-size:11px;color:var(--text-muted);">${escHtml(bank.branch||'—')}</div>
                    </div>
                  </div>
                </td>
                <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(bank.accountNo||'—')}</td>
                <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">${escHtml(bank.ifsc||'—')}</td>
                <td><span class="badge badge-blue">${escHtml(bank.accountType||'current')}</span></td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${Number(bank.bookBalance||0).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);">₹${Number(bank.bankBalance||0).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${Math.abs(diff)<0.01?'var(--brand-secondary)':'var(--brand-warning)'};">
                  ${Math.abs(diff)<0.01 ? '₹0 ✅' : `₹${Math.abs(diff).toLocaleString('en-IN')} ${diff>0?'↑':'↓'}`}
                </td>
                <td>${badge(Math.abs(diff)<0.01 ? 'reconciled' : 'pending')}</td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm" onclick="selectBank('${bank.id}');switchBankTab('match')">Reconcile</button>
                    <button class="btn btn-ghost btn-icon" onclick="deleteBankAccount('${bank.id}')" style="color:var(--brand-danger);font-size:12px;">🗑</button>
                  </div>
                </td>
              </tr>`;
          }).join('') : `
            <tr>
              <td colspan="9">
                <div class="table-empty">
                  <div class="empty-icon">🏦</div>
                  <div class="empty-title">No bank accounts added yet</div>
                  <div class="empty-text">Add your bank accounts to start reconciliation.</div>
                </div>
              </td>
            </tr>`}
        </tbody>
      </table>
    </div>
  `;
  window.deleteBankAccount = async (id) => {
    if (!confirm('Remove this bank account?')) return;
    try { await dbDelete(BANK_COLLECTIONS.BANK_ACCOUNTS, id); Toast.success('Removed','Bank account removed.'); await window.refreshBankRecon?.(); }
    catch(e) { Toast.error('Failed', e.message); }
  };
}

// ══════════════════════════════════════════════════════════════
// IMPORT BANK STATEMENT TAB
// ══════════════════════════════════════════════════════════════
function renderImportTab(container) {
  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <!-- Upload Section -->
      <div class="card">
        <div class="card-header"><div class="card-title">📥 Import Bank Statement</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-4);">

          <div class="form-group">
            <label class="form-label">Select Bank Account <span class="required">*</span></label>
            <select id="import-bank-select" class="form-select">
              <option value="">Choose bank account…</option>
              ${_bankAccounts.map(b=>`<option value="${b.id}">${escHtml(b.bankName)} — ${escHtml(b.accountNo)}</option>`).join('')}
            </select>
          </div>

          <!-- CSV Upload -->
          <div style="border:2px dashed var(--border-default);border-radius:var(--radius-lg);padding:32px;text-align:center;cursor:pointer;transition:all 0.2s;"
               id="drop-zone"
               ondragover="event.preventDefault();this.style.borderColor='var(--brand-primary)'"
               ondragleave="this.style.borderColor='var(--border-default)'"
               ondrop="handleBankFileDrop(event)">
            <div style="font-size:32px;margin-bottom:12px;">📊</div>
            <div style="font-size:14px;font-weight:600;margin-bottom:6px;">Drop CSV / Excel file here</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">Supports: SBI, HDFC, ICICI, Axis, Kotak bank statement formats</div>
            <input type="file" id="bank-file-input" accept=".csv,.xlsx,.xls" style="display:none;" onchange="handleBankFileSelect(this)">
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('bank-file-input').click()">Browse Files</button>
          </div>

          <!-- Manual Entry fallback -->
          <div style="padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-lg);">
            <div style="font-size:13px;font-weight:600;margin-bottom:var(--space-3);">✍️ Or Add Entry Manually</div>
            <div class="form-grid-2">
              <div class="form-group"><label class="form-label">Date</label><input type="date" id="man-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
              <div class="form-group"><label class="form-label">Description</label><input type="text" id="man-desc" class="form-input" placeholder="Transaction description"></div>
            </div>
            <div class="form-grid-3">
              <div class="form-group"><label class="form-label">Debit (₹)</label><input type="number" id="man-debit" class="form-input" placeholder="0" min="0" step="0.01"></div>
              <div class="form-group"><label class="form-label">Credit (₹)</label><input type="number" id="man-credit" class="form-input" placeholder="0" min="0" step="0.01"></div>
              <div class="form-group"><label class="form-label">Balance (₹)</label><input type="number" id="man-balance" class="form-input" placeholder="0" step="0.01"></div>
            </div>
            <div class="form-group"><label class="form-label">Reference / Cheque No.</label><input type="text" id="man-ref" class="form-input" placeholder="CHQ-001 or UTR number"></div>
            <button class="btn btn-primary btn-sm" id="man-add-btn" onclick="addManualTxn()" style="margin-top:8px;">Add Transaction</button>
          </div>
        </div>
      </div>

      <!-- Format Guide -->
      <div class="card">
        <div class="card-header"><div class="card-title">📋 CSV Format Guide</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Expected Columns:</div>
            <code style="font-size:11px;color:var(--brand-primary);line-height:2;">Date, Description, Debit, Credit, Balance</code>
          </div>
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Sample CSV:</div>
            <pre style="font-size:10px;color:var(--text-secondary);line-height:1.8;overflow-x:auto;">Date,Description,Debit,Credit,Balance
01/01/2025,Opening Balance,,,100000.00
05/01/2025,NEFT Transfer IN,,50000,150000.00
10/01/2025,Vendor Payment,25000,,125000.00
15/01/2025,Salary Payment,80000,,45000.00</pre>
          </div>
          <div class="alert alert-info">
            <span class="alert-icon">ℹ️</span>
            <div>
              <div class="alert-title">Supported Banks</div>
              <div class="alert-text">SBI, HDFC, ICICI, Axis, Kotak, Yes Bank, IndusInd — download statement as CSV from net banking.</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="downloadSampleCSV()">⬇ Download Sample CSV</button>
        </div>
      </div>
    </div>

    <!-- Preview of parsed transactions -->
    <div id="import-preview" style="margin-top:var(--space-5);display:none;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">👁️ Preview — Parsed Transactions</div>
          <div style="display:flex;gap:8px;">
            <span id="import-count" class="badge badge-blue"></span>
            <button class="btn btn-primary btn-sm" id="import-confirm-btn" onclick="confirmImport()">✅ Import All</button>
          </div>
        </div>
        <div id="import-preview-content"></div>
      </div>
    </div>
  `;

  let _parsedTxns = [];

  window.handleBankFileSelect = async (input) => {
    const file = input.files[0]; if (!file) return;
    const bankId = document.getElementById('import-bank-select').value;
    if (!bankId) { Toast.error('Select Bank','Choose a bank account first.'); return; }
    Toast.info('Parsing…', `Reading ${file.name}…`);
    try {
      const text = await file.text();
      _parsedTxns = parseCSV(text);
      showImportPreview(_parsedTxns, bankId);
    } catch(e) { Toast.error('Parse Error', e.message); }
  };

  window.handleBankFileDrop = async (e) => {
    e.preventDefault();
    document.getElementById('drop-zone').style.borderColor = 'var(--border-default)';
    const file = e.dataTransfer.files[0]; if (!file) return;
    const bankId = document.getElementById('import-bank-select').value;
    if (!bankId) { Toast.error('Select Bank','Choose a bank account first.'); return; }
    const text = await file.text();
    _parsedTxns = parseCSV(text);
    showImportPreview(_parsedTxns, bankId);
  };

  window.addManualTxn = async () => {
    const bankId = document.getElementById('import-bank-select').value;
    if (!bankId) { Toast.error('Select Bank','Choose a bank account first.'); return; }
    const btn = document.getElementById('man-add-btn'); setLoading(btn, true);
    const data = {
      bankAccountId: bankId,
      date:      document.getElementById('man-date').value,
      description:document.getElementById('man-desc').value.trim(),
      debit:     Number(document.getElementById('man-debit').value)||0,
      credit:    Number(document.getElementById('man-credit').value)||0,
      balance:   Number(document.getElementById('man-balance').value)||0,
      reference: document.getElementById('man-ref').value.trim(),
      reconciled:false, matchedGLId:null,
      companyId: AuthState.company?.id||null,
    };
    try {
      await dbCreate(BANK_COLLECTIONS.BANK_TXN, data);
      // Update bank balance
      await dbUpdate(BANK_COLLECTIONS.BANK_ACCOUNTS, bankId, { bankBalance: data.balance });
      Toast.success('Added', 'Transaction added.');
      ['man-debit','man-credit','man-balance','man-ref'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
      document.getElementById('man-desc').value='';
    } catch(e) { Toast.error('Failed', e.message); }
    finally { setLoading(btn, false); }
  };

  window.confirmImport = async () => {
    if (!_parsedTxns.length) return;
    const bankId = document.getElementById('import-bank-select').value;
    const btn = document.getElementById('import-confirm-btn'); setLoading(btn, true);
    try {
      const ops = _parsedTxns.map(txn => ({
        collection: BANK_COLLECTIONS.BANK_TXN,
        id: genId(), type: 'set',
        data: { ...txn, bankAccountId: bankId, reconciled: false, matchedGLId: null, companyId: AuthState.company?.id||null },
      }));
      await dbBatch(ops);
      // Update bank balance with last entry
      const lastBalance = _parsedTxns[_parsedTxns.length-1]?.balance;
      if (lastBalance) await dbUpdate(BANK_COLLECTIONS.BANK_ACCOUNTS, bankId, { bankBalance: lastBalance });
      Toast.success('Imported!', `${_parsedTxns.length} transactions imported.`);
      document.getElementById('import-preview').style.display = 'none';
      _parsedTxns = [];
      await window.refreshBankRecon?.();
    } catch(e) { Toast.error('Failed', e.message); }
    finally { setLoading(btn, false); }
  };

  window.downloadSampleCSV = () => {
    const csv = `Date,Description,Debit,Credit,Balance\n01/01/2025,Opening Balance,,,100000.00\n05/01/2025,NEFT Transfer Received,,50000.00,150000.00\n10/01/2025,Vendor Payment - Raj Suppliers,25000.00,,125000.00\n15/01/2025,Salary Payment,80000.00,,45000.00`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='bank_statement_sample.csv'; a.click();
  };

  function parseCSV(text) {
    const lines = text.trim().split('\n').filter(l=>l.trim());
    if (lines.length < 2) throw new Error('CSV file appears empty or invalid');
    const headers = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/['"]/g,''));
    const dateIdx   = headers.findIndex(h=>h.includes('date'));
    const descIdx   = headers.findIndex(h=>h.includes('desc')||h.includes('narration')||h.includes('particulars'));
    const debitIdx  = headers.findIndex(h=>h.includes('debit')||h.includes('withdrawal'));
    const creditIdx = headers.findIndex(h=>h.includes('credit')||h.includes('deposit'));
    const balIdx    = headers.findIndex(h=>h.includes('balance'));

    return lines.slice(1).map(line => {
      const cols = line.split(',').map(c=>c.trim().replace(/['"]/g,''));
      const rawDate = cols[dateIdx]||'';
      // Parse various date formats
      let date = rawDate;
      if (rawDate.includes('/')) {
        const parts = rawDate.split('/');
        if (parts[2]?.length === 4) date = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
        else if (parts[0]?.length === 4) date = `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
      }
      return {
        date, description: cols[descIdx]||'',
        debit:  Math.abs(Number((cols[debitIdx]||'0').replace(/,/g,''))||0),
        credit: Math.abs(Number((cols[creditIdx]||'0').replace(/,/g,''))||0),
        balance: Number((cols[balIdx]||'0').replace(/,/g,'')||0),
      };
    }).filter(t => t.date && (t.debit||t.credit));
  }

  function showImportPreview(txns, bankId) {
    const previewEl = document.getElementById('import-preview');
    const content   = document.getElementById('import-preview-content');
    const count     = document.getElementById('import-count');
    previewEl.style.display = '';
    if (count) count.textContent = `${txns.length} transactions`;
    const totalDebits  = txns.reduce((s,t)=>s+t.debit,0);
    const totalCredits = txns.reduce((s,t)=>s+t.credit,0);
    content.innerHTML = `
      <div style="display:flex;gap:20px;padding:12px 16px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);">
        <span style="font-size:12px;color:var(--text-muted);">Total Debits: <strong style="color:var(--brand-danger);">₹${totalDebits.toLocaleString('en-IN')}</strong></span>
        <span style="font-size:12px;color:var(--text-muted);">Total Credits: <strong style="color:var(--brand-secondary);">₹${totalCredits.toLocaleString('en-IN')}</strong></span>
        <span style="font-size:12px;color:var(--text-muted);">Entries: <strong>${txns.length}</strong></span>
      </div>
      <div style="max-height:300px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead style="position:sticky;top:0;background:var(--bg-elevated);">
            <tr><th style="padding:8px 12px;text-align:left;">Date</th><th style="padding:8px 12px;text-align:left;">Description</th><th style="padding:8px 12px;text-align:right;">Debit (₹)</th><th style="padding:8px 12px;text-align:right;">Credit (₹)</th><th style="padding:8px 12px;text-align:right;">Balance (₹)</th></tr>
          </thead>
          <tbody>
            ${txns.map(t=>`
              <tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:8px 12px;font-family:var(--font-mono);">${t.date}</td>
                <td style="padding:8px 12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.description)}</td>
                <td style="padding:8px 12px;text-align:right;font-family:var(--font-mono);color:var(--brand-danger);">${t.debit?'₹'+t.debit.toLocaleString('en-IN'):''}</td>
                <td style="padding:8px 12px;text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);">${t.credit?'₹'+t.credit.toLocaleString('en-IN'):''}</td>
                <td style="padding:8px 12px;text-align:right;font-family:var(--font-mono);">₹${t.balance.toLocaleString('en-IN')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
}

// ══════════════════════════════════════════════════════════════
// MATCH & RECONCILE TAB
// ══════════════════════════════════════════════════════════════
let _bankTxns=[], _filtTxns=[], _pageTxns=1;

async function renderMatchTab(container) {
  if (!_selectedBankId && _bankAccounts.length) _selectedBankId = _bankAccounts[0].id;

  container.innerHTML = `
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="form-group" style="margin-bottom:0;flex:1;max-width:280px;">
        <label class="form-label">Bank Account</label>
        <select id="match-bank-select" class="form-select" onchange="_selectedBankId=this.value;loadBankTxns(this.value)">
          <option value="">Select bank…</option>
          ${_bankAccounts.map(b=>`<option value="${b.id}" ${_selectedBankId===b.id?'selected':''}>${escHtml(b.bankName)} — ${escHtml(b.accountNo)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Filter</label>
        <select id="match-filter" class="form-select" onchange="filterTxns(this.value)">
          <option value="all">All Transactions</option>
          <option value="unreconciled">Unreconciled Only</option>
          <option value="reconciled">Reconciled Only</option>
        </select>
      </div>
      <button class="btn btn-primary btn-sm" onclick="autoMatch()">🤖 Auto-Match</button>
      <button class="btn btn-secondary btn-sm" onclick="exportReconReport()">⬇ Export</button>
    </div>

    <!-- Summary Cards -->
    <div class="grid-4" style="margin-bottom:var(--space-4);" id="match-summary-cards"></div>

    <!-- Side-by-side matching interface -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);">
      <!-- Bank Transactions -->
      <div>
        <div style="font-size:13px;font-weight:700;margin-bottom:var(--space-3);display:flex;align-items:center;justify-content:space-between;">
          <span>🏦 Bank Statement</span>
          <span id="bank-txn-count" class="badge badge-gray"></span>
        </div>
        <div id="bank-txn-list" style="display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto;padding-right:4px;">
          <div style="text-align:center;padding:40px;color:var(--text-muted);">Select a bank account to load transactions</div>
        </div>
      </div>

      <!-- GL Entries (Book) -->
      <div>
        <div style="font-size:13px;font-weight:700;margin-bottom:var(--space-3);display:flex;align-items:center;justify-content:space-between;">
          <span>📒 Book Entries (GL)</span>
          <span id="gl-entry-count" class="badge badge-gray"></span>
        </div>
        <div id="gl-entry-list" style="display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto;padding-right:4px;">
          <div style="text-align:center;padding:40px;color:var(--text-muted);">GL entries appear here for matching</div>
        </div>
      </div>
    </div>

    <!-- Selected pair for manual match -->
    <div id="match-pair-panel" style="display:none;margin-top:var(--space-4);"></div>
  `;

  if (_selectedBankId) await loadBankTxns(_selectedBankId);

  window.loadBankTxns = async (bankId) => {
    if (!bankId) return;
    _selectedBankId = bankId;
    const cid = AuthState.company?.id;
    const c   = [...(cid?[where('companyId','==',cid)]:[]), where('bankAccountId','==',bankId), orderBy('date','desc')];
    _bankTxns = await dbGetAll(BANK_COLLECTIONS.BANK_TXN, c);
    _filtTxns = [..._bankTxns];
    renderMatchSummary();
    renderBankTxnList(_filtTxns);
    renderGLList();
  };

  window.filterTxns = (filter) => {
    if (filter==='unreconciled') _filtTxns=_bankTxns.filter(t=>!t.reconciled);
    else if (filter==='reconciled') _filtTxns=_bankTxns.filter(t=>t.reconciled);
    else _filtTxns=[..._bankTxns];
    renderBankTxnList(_filtTxns);
  };

  window.autoMatch = async () => {
    const unreconciled = _bankTxns.filter(t=>!t.reconciled);
    if (!unreconciled.length) { Toast.info('All Clear','All transactions already reconciled.'); return; }
    let matched = 0;
    const ops = [];
    for (const bankTxn of unreconciled) {
      // Find matching GL entry by amount and approximate date
      const amount = bankTxn.credit || bankTxn.debit;
      const matchingGL = _glEntries.find(gl => {
        const glAmt = bankTxn.credit ? (Number(gl.credit)||0) : (Number(gl.debit)||0);
        const dateDiff = Math.abs(new Date(gl.date) - new Date(bankTxn.date)) / 86400000;
        return Math.abs(glAmt - amount) < 0.01 && dateDiff <= 3 && !gl.reconciled;
      });
      if (matchingGL) {
        ops.push({ collection:BANK_COLLECTIONS.BANK_TXN, id:bankTxn.id, type:'update', data:{reconciled:true, matchedGLId:matchingGL.id, matchedBy:'auto'} });
        ops.push({ collection:ACC_COLLECTIONS.GL_ENTRIES, id:matchingGL.id, type:'update', data:{reconciled:true, matchedBankTxnId:bankTxn.id} });
        matched++;
      }
    }
    if (ops.length) {
      await dbBatch(ops);
      await loadBankTxns(_selectedBankId);
      Toast.success('Auto-Match Done!', `${matched} transactions matched automatically. ${unreconciled.length-matched} still need manual review.`);
    } else {
      Toast.info('No Matches', 'Could not auto-match any transactions. Try manual matching.');
    }
  };
}

let _selectedBankTxn=null, _selectedGLEntry=null;

function renderMatchSummary() {
  const el=document.getElementById('match-summary-cards'); if(!el) return;
  const reconciled  = _bankTxns.filter(t=>t.reconciled).length;
  const unreconciled= _bankTxns.filter(t=>!t.reconciled).length;
  const totalDr = _bankTxns.reduce((s,t)=>s+(t.debit||0),0);
  const totalCr = _bankTxns.reduce((s,t)=>s+(t.credit||0),0);
  [
    {label:'Total Transactions', value:_bankTxns.length, icon:'📊', color:'kpi-blue'},
    {label:'Reconciled',         value:reconciled,        icon:'✅', color:'kpi-green'},
    {label:'Unreconciled',       value:unreconciled,      icon:'⚠️', color:unreconciled>0?'kpi-orange':'kpi-green'},
    {label:'Net Cash Flow',      value:formatCurrency(totalCr-totalDr,true), icon:'💰', color:(totalCr-totalDr)>=0?'kpi-green':'kpi-red'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function renderBankTxnList(txns) {
  const el=document.getElementById('bank-txn-list'); if(!el) return;
  const cnt=document.getElementById('bank-txn-count'); if(cnt) cnt.textContent=txns.length+' txns';
  if (!txns.length) { el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No transactions</div>`; return; }
  el.innerHTML = txns.map(t => `
    <div id="bank-txn-card-${t.id}"
         onclick="selectBankTxn('${t.id}')"
         style="padding:12px;background:${t.reconciled?'rgba(0,200,150,0.06)':'var(--bg-elevated)'};
                border:1px solid ${t.reconciled?'rgba(0,200,150,0.3)':'var(--border-subtle)'};
                border-radius:var(--radius-md);cursor:pointer;transition:all 0.15s;
                ${_selectedBankTxn?.id===t.id?'border-color:var(--brand-primary);background:rgba(10,132,255,0.08);':''}"
         onmouseenter="if('${t.id}'!='${_selectedBankTxn?.id||''}') this.style.borderColor='var(--border-strong)'"
         onmouseleave="if('${t.id}'!='${_selectedBankTxn?.id||''}') this.style.borderColor='${t.reconciled?'rgba(0,200,150,0.3)':'var(--border-subtle)'}'">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${t.date}</span>
        ${t.reconciled?`<span class="badge badge-green" style="font-size:9px;">✅ Matched</span>`:`<span class="badge badge-orange" style="font-size:9px;">⚠ Unmatched</span>`}
      </div>
      <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px;">${escHtml(t.description||'—')}</div>
      <div style="display:flex;justify-content:space-between;">
        ${t.debit  ? `<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-danger);">Dr ₹${Number(t.debit).toLocaleString('en-IN')}</span>` : ''}
        ${t.credit ? `<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-secondary);">Cr ₹${Number(t.credit).toLocaleString('en-IN')}</span>` : ''}
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">Bal: ₹${Number(t.balance||0).toLocaleString('en-IN')}</span>
      </div>
    </div>`).join('');

  window.selectBankTxn = (id) => {
    _selectedBankTxn = _bankTxns.find(t=>t.id===id);
    renderBankTxnList(_filtTxns);
    updateMatchPanel();
  };
}

function renderGLList() {
  const el=document.getElementById('gl-entry-list'); if(!el) return;
  const bank=_bankAccounts.find(b=>b.id===_selectedBankId);
  // Show GL entries for bank-related accounts
  const bankGLEntries=_glEntries.filter(g=>!g.reconciled).slice(0,50);
  const cnt=document.getElementById('gl-entry-count'); if(cnt) cnt.textContent=bankGLEntries.length+' entries';
  if(!bankGLEntries.length){el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No unreconciled GL entries</div>`;return;}
  el.innerHTML=bankGLEntries.map(g=>`
    <div id="gl-entry-card-${g.id}"
         onclick="selectGLEntry('${g.id}')"
         style="padding:12px;background:${g.reconciled?'rgba(0,200,150,0.06)':'var(--bg-elevated)'};
                border:1px solid ${_selectedGLEntry?.id===g.id?'var(--brand-primary)':'var(--border-subtle)'};
                border-radius:var(--radius-md);cursor:pointer;transition:all 0.15s;"
         onmouseenter="if('${g.id}'!='${_selectedGLEntry?.id||''}') this.style.borderColor='var(--border-strong)'"
         onmouseleave="if('${g.id}'!='${_selectedGLEntry?.id||''}') this.style.borderColor='var(--border-subtle)'">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${g.date}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--brand-primary);">${escHtml(g.journalNo||'—')}</span>
      </div>
      <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px;">${escHtml(g.narration||'—')}</div>
      <div style="display:flex;justify-content:space-between;">
        ${g.debit  ? `<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-danger);">Dr ₹${Number(g.debit).toLocaleString('en-IN')}</span>` : ''}
        ${g.credit ? `<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-secondary);">Cr ₹${Number(g.credit).toLocaleString('en-IN')}</span>` : ''}
        <span class="badge badge-gray" style="font-size:9px;">${escHtml(g.accountName||'—')}</span>
      </div>
    </div>`).join('');

  window.selectGLEntry=(id)=>{
    _selectedGLEntry=_glEntries.find(g=>g.id===id);
    renderGLList();
    updateMatchPanel();
  };
}

function updateMatchPanel() {
  const el=document.getElementById('match-pair-panel'); if(!el) return;
  if (!_selectedBankTxn && !_selectedGLEntry) { el.style.display='none'; return; }
  el.style.display='';
  const bankAmt=(_selectedBankTxn?.credit||0)||(_selectedBankTxn?.debit||0)||0;
  const glAmt  =(_selectedGLEntry?.credit||0)||(_selectedGLEntry?.debit||0)||0;
  const diff   =Math.abs(bankAmt-glAmt);
  const canMatch=_selectedBankTxn&&_selectedGLEntry&&diff<0.01;

  el.innerHTML=`
    <div style="padding:var(--space-4);background:${canMatch?'rgba(0,200,150,0.08)':'rgba(255,159,10,0.08)'};border:1px solid ${canMatch?'rgba(0,200,150,0.3)':'rgba(255,159,10,0.3)'};border-radius:var(--radius-lg);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
        <div style="font-size:13px;font-weight:700;">
          ${canMatch?'✅ Perfect Match — Ready to Reconcile':'⚠️ Select Both Sides to Match'}
        </div>
        ${canMatch?`<button class="btn btn-success btn-sm" onclick="confirmMatch()">✅ Confirm Match</button>`:''}
      </div>
      <div class="grid-2" style="gap:var(--space-3);">
        <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Bank Transaction</div>
          ${_selectedBankTxn?`
            <div style="font-size:12px;font-weight:600;">${escHtml(_selectedBankTxn.description||'—')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${_selectedBankTxn.date}</div>
            <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--brand-secondary);margin-top:4px;">₹${bankAmt.toLocaleString('en-IN')}</div>
          `:'<div style="color:var(--text-muted);font-size:12px;">Not selected</div>'}
        </div>
        <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">GL Entry</div>
          ${_selectedGLEntry?`
            <div style="font-size:12px;font-weight:600;">${escHtml(_selectedGLEntry.narration||'—')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${_selectedGLEntry.date} · ${escHtml(_selectedGLEntry.journalNo||'')}</div>
            <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--brand-primary);margin-top:4px;">₹${glAmt.toLocaleString('en-IN')}</div>
          `:'<div style="color:var(--text-muted);font-size:12px;">Not selected</div>'}
        </div>
      </div>
      ${_selectedBankTxn&&_selectedGLEntry&&diff>0.01?`
        <div style="margin-top:12px;padding:10px;background:rgba(255,159,10,0.1);border-radius:8px;border-left:3px solid var(--brand-warning);">
          <span style="font-size:12px;color:var(--brand-warning);">Amount difference: ₹${diff.toFixed(2)}. You can still match with notes.</span>
          <button class="btn btn-secondary btn-sm" style="margin-left:12px;" onclick="forceMatch()">Match Anyway (with difference)</button>
        </div>`:''}
    </div>`;

  window.confirmMatch = async () => {
    if (!_selectedBankTxn || !_selectedGLEntry) return;
    try {
      await dbBatch([
        { collection:BANK_COLLECTIONS.BANK_TXN, id:_selectedBankTxn.id, type:'update', data:{reconciled:true, matchedGLId:_selectedGLEntry.id, matchedBy:AuthState.profile?.name||''} },
        { collection:ACC_COLLECTIONS.GL_ENTRIES, id:_selectedGLEntry.id, type:'update', data:{reconciled:true, matchedBankTxnId:_selectedBankTxn.id} },
      ]);
      Toast.success('Matched!','Transaction reconciled.');
      _selectedBankTxn=null; _selectedGLEntry=null;
      el.style.display='none';
      await loadBankTxns(_selectedBankId);
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.forceMatch = async () => {
    if (!_selectedBankTxn || !_selectedGLEntry) return;
    const note = prompt('Enter reason for match with difference:');
    if (!note) return;
    try {
      await dbBatch([
        { collection:BANK_COLLECTIONS.BANK_TXN, id:_selectedBankTxn.id, type:'update', data:{reconciled:true, matchedGLId:_selectedGLEntry.id, matchNote:note, forcedMatch:true, matchedBy:AuthState.profile?.name||''} },
        { collection:ACC_COLLECTIONS.GL_ENTRIES, id:_selectedGLEntry.id, type:'update', data:{reconciled:true, matchedBankTxnId:_selectedBankTxn.id} },
      ]);
      Toast.success('Force-Matched','Transaction reconciled with difference noted.');
      _selectedBankTxn=null; _selectedGLEntry=null; el.style.display='none';
      await loadBankTxns(_selectedBankId);
    } catch(e) { Toast.error('Failed', e.message); }
  };
}

// ══════════════════════════════════════════════════════════════
// RECONCILIATION REPORT
// ══════════════════════════════════════════════════════════════
async function renderReportTab(container) {
  container.innerHTML=`<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>`;
  const bank=_bankAccounts.find(b=>b.id===_selectedBankId)||_bankAccounts[0];
  if (!bank) { container.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);">Select and reconcile a bank account first.</div>`; return; }

  const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
  const txns=await dbGetAll(BANK_COLLECTIONS.BANK_TXN,[...c,where('bankAccountId','==',bank.id),orderBy('date','desc')]);
  const reconciled  =txns.filter(t=>t.reconciled);
  const unreconciled=txns.filter(t=>!t.reconciled);
  const bankBal     =Number(bank.bankBalance||0);
  const bookBal     =Number(bank.bookBalance||0);
  const unreconDr   =unreconciled.reduce((s,t)=>s+(Number(t.debit)||0),0);
  const unreconCr   =unreconciled.reduce((s,t)=>s+(Number(t.credit)||0),0);

  container.innerHTML=`
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Bank Reconciliation Statement</h3>
        <p style="font-size:12px;color:var(--text-secondary);">${escHtml(bank.bankName||'—')} · ${escHtml(bank.accountNo||'—')} · As at ${new Date().toLocaleDateString('en-IN')}</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" onclick="printReconReport()">🖨️ Print</button>
        <button class="btn btn-secondary btn-sm" onclick="exportReconReport()">⬇ Export</button>
      </div>
    </div>

    <!-- Main reconciliation statement -->
    <div class="grid-2" style="gap:var(--space-5);margin-bottom:var(--space-5);">
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:var(--brand-secondary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-secondary);">
          Balance as per Bank Statement
        </div>
        ${reconRow('Closing balance as per Bank', bankBal, false, 'var(--brand-secondary)')}
        <div style="height:1px;background:var(--border-subtle);margin:8px 0;"></div>
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:8px 0 4px;">Add: Deposits in Transit (not yet in bank)</div>
        ${unreconCr > 0 ? reconRow('Unreconciled Credits', unreconCr, false, 'var(--brand-secondary)') : reconRow('None', 0)}
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:8px 0 4px;">Less: Outstanding Cheques</div>
        ${unreconDr > 0 ? reconRow('Unreconciled Debits', unreconDr, false, 'var(--brand-danger)') : reconRow('None', 0)}
        <div style="height:2px;background:var(--border-strong);margin:12px 0;"></div>
        ${reconRow('Adjusted Bank Balance', bankBal + unreconCr - unreconDr, true, 'var(--brand-secondary)')}
      </div>

      <div class="card">
        <div style="font-size:13px;font-weight:700;color:var(--brand-primary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-primary);">
          Balance as per Books (GL)
        </div>
        ${reconRow('Closing balance as per Books', bookBal, false, 'var(--brand-primary)')}
        <div style="height:1px;background:var(--border-subtle);margin:8px 0;"></div>
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:8px 0 4px;">Add/Less: Adjustments</div>
        ${reconRow('Bank charges not yet recorded', 0)}
        ${reconRow('Interest credited by bank', 0)}
        ${reconRow('Direct deposits not in books', 0)}
        <div style="height:2px;background:var(--border-strong);margin:12px 0;"></div>
        ${reconRow('Adjusted Book Balance', bookBal, true, 'var(--brand-primary)')}
      </div>
    </div>

    <!-- Status -->
    <div style="padding:20px;background:${Math.abs((bankBal+unreconCr-unreconDr)-bookBal)<0.01?'rgba(0,200,150,0.1)':'rgba(255,159,10,0.1)'};border:1px solid ${Math.abs((bankBal+unreconCr-unreconDr)-bookBal)<0.01?'rgba(0,200,150,0.3)':'rgba(255,159,10,0.3)'};border-radius:var(--radius-lg);margin-bottom:var(--space-5);text-align:center;">
      <div style="font-family:var(--font-display);font-size:20px;font-weight:800;color:${Math.abs((bankBal+unreconCr-unreconDr)-bookBal)<0.01?'var(--brand-secondary)':'var(--brand-warning)'};">
        ${Math.abs((bankBal+unreconCr-unreconDr)-bookBal)<0.01?'✅ ACCOUNTS FULLY RECONCILED':'⚠️ RECONCILIATION DIFFERENCE'}
      </div>
      ${Math.abs((bankBal+unreconCr-unreconDr)-bookBal)>=0.01?`
        <div style="font-size:14px;color:var(--text-secondary);margin-top:6px;">
          Difference: ₹${Math.abs((bankBal+unreconCr-unreconDr)-bookBal).toLocaleString('en-IN')} requires investigation
        </div>`:''}
    </div>

    <!-- Unreconciled Items -->
    ${unreconciled.length?`
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚠️ Unreconciled Transactions (${unreconciled.length})</div>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th style="text-align:right;">Debit (₹)</th><th style="text-align:right;">Credit (₹)</th><th>Action</th></tr></thead>
            <tbody>
              ${unreconciled.map(t=>`
                <tr>
                  <td style="font-family:var(--font-mono);font-size:12px;">${t.date}</td>
                  <td style="font-size:12px;">${escHtml(t.description||'—')}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(t.reference||'—')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-danger);">${t.debit?'₹'+Number(t.debit).toLocaleString('en-IN'):''}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);">${t.credit?'₹'+Number(t.credit).toLocaleString('en-IN'):''}</td>
                  <td>
                    <div style="display:flex;gap:6px;">
                      <button class="btn btn-secondary btn-sm" style="font-size:10px;" onclick="switchBankTab('match');selectBankTxn('${t.id}')">Match</button>
                      <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--brand-secondary);" onclick="markAsCleared('${t.id}')">Clear</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`:''}
  `;

  window.markAsCleared=async(id)=>{
    try{await dbUpdate(BANK_COLLECTIONS.BANK_TXN,id,{reconciled:true,matchedBy:'manual-clear',matchNote:'Manually cleared'});Toast.success('Cleared','Transaction marked as cleared.');await renderReportTab(container);}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.printReconReport=()=>{
    if (!window.LAMPDF) { window.print(); return; }
    const co = AuthState.company||{};
    window.LAMPDF.report({ company: co, title: 'Bank Reconciliation Report', tableTitle: 'Reconciled Transactions' });
  };
  window.exportReconReport=()=>Toast.info('Export','Reconciliation report exported.');
}

function reconRow(label, amount, isTotal=false, color='var(--text-primary)') {
  return `
    <div style="display:flex;justify-content:space-between;padding:${isTotal?'10':'7'}px 0;${isTotal?'border-top:1px solid var(--border-subtle);margin-top:4px;':''}">
      <span style="font-size:${isTotal?'13':'12'}px;font-weight:${isTotal?700:400};color:${isTotal?'var(--text-primary)':'var(--text-secondary)'};">${label}</span>
      <span style="font-family:var(--font-mono);font-size:${isTotal?'14':'12'}px;font-weight:${isTotal?800:500};color:${color};">
        ${amount!==0||isTotal?'₹'+Math.abs(amount).toLocaleString('en-IN'):'—'}
      </span>
    </div>`;
}

// ── Add Bank Account Modal ────────────────────────────────────
function addBankModal() {
  return buildModal({
    id:'add-bank-modal', title:'Add Bank Account',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Bank Name <span class="required">*</span></label>
          <select id="bank-name-select" class="form-select" onchange="if(this.value==='other'){document.getElementById('bank-name-other').style.display=''}else{document.getElementById('bank-name-other').style.display='none';document.getElementById('new-bank-name').value=this.value}">
            <option value="">Select bank…</option>
            ${['SBI','HDFC Bank','ICICI Bank','Axis Bank','Kotak Mahindra Bank','Yes Bank','IndusInd Bank','Punjab National Bank','Bank of Baroda','Canara Bank','Union Bank','IDFC First Bank','Federal Bank','South Indian Bank','other'].map(b=>`<option value="${b}">${b}</option>`).join('')}
          </select>
          <input type="text" id="bank-name-other" class="form-input" style="display:none;margin-top:8px;" placeholder="Enter bank name">
        </div>
        <div class="form-group"><label class="form-label">Account Type</label>
          <select id="new-bank-type" class="form-select">
            <option value="current">Current Account</option>
            <option value="savings">Savings Account</option>
            <option value="cash-credit">Cash Credit</option>
            <option value="overdraft">Overdraft</option>
          </select>
        </div>
      </div>
      <input type="hidden" id="new-bank-name">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Account Number <span class="required">*</span></label><input type="text" id="new-bank-accno" class="form-input" placeholder="1234567890123456"></div>
        <div class="form-group"><label class="form-label">IFSC Code <span class="required">*</span></label><input type="text" id="new-bank-ifsc" class="form-input" placeholder="HDFC0001234" style="text-transform:uppercase;"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Branch</label><input type="text" id="new-bank-branch" class="form-input" placeholder="Branch name"></div>
        <div class="form-group"><label class="form-label">Opening Balance (₹)</label><input type="number" id="new-bank-balance" class="form-input" placeholder="0" step="0.01"></div>
      </div>
      <div class="form-group"><label class="form-label">Linked GL Account (from Chart of Accounts)</label>
        <select id="new-bank-gl" class="form-select">
          <option value="">Select GL Account…</option>
          ${_accounts.filter(a=>a.type==='ASSET'&&(a.subType==='Current Asset')).map(a=>`<option value="${a.id}">${a.code} — ${escHtml(a.name)}</option>`).join('')}
        </select>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('add-bank-modal')">Cancel</button>
            <button class="btn btn-primary" id="add-bank-btn" onclick="saveBankAccount()">Add Bank Account</button>`,
  });
}

// Need _accounts in scope - import from accounting module reference
let _accounts=[];
async function loadAccountsRef(){
  const cid=AuthState.company?.id;
  _accounts=await dbGetAll(ACC_COLLECTIONS.ACCOUNTS,cid?[where('companyId','==',cid),orderBy('code')]:[orderBy('code')]);
}

window.saveBankAccount = async () => {
  await loadAccountsRef();
  const bankNameSel=document.getElementById('bank-name-select').value;
  const bankName=bankNameSel==='other'?document.getElementById('bank-name-other').value.trim():bankNameSel;
  if(!bankName){Toast.error('Required','Enter bank name.');return;}
  if(!validateForm([{id:'new-bank-accno',label:'Account Number',required:true},{id:'new-bank-ifsc',label:'IFSC',required:true}])) return;
  const btn=document.getElementById('add-bank-btn'); setLoading(btn,true);
  const opening=Number(document.getElementById('new-bank-balance').value)||0;
  try{
    await dbCreate(BANK_COLLECTIONS.BANK_ACCOUNTS,{
      bankName,accountType:document.getElementById('new-bank-type').value,
      accountNo:document.getElementById('new-bank-accno').value.trim(),
      ifsc:document.getElementById('new-bank-ifsc').value.trim().toUpperCase(),
      branch:document.getElementById('new-bank-branch').value.trim(),
      openingBalance:opening,bankBalance:opening,bookBalance:opening,
      linkedGLAccountId:document.getElementById('new-bank-gl').value||null,
      unreconciledCount:0,companyId:AuthState.company?.id||null,
    });
    Toast.success('Added',`${bankName} account added.`);
    closeModal('add-bank-modal');
    await window.refreshBankRecon?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
