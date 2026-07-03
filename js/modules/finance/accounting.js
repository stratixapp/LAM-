// ============================================================
// LAM — Full Accounting Engine (Indian GAAP + IFRS)
// Chart of Accounts, Double-Entry GL, Journal Entries,
// Trial Balance, Balance Sheet, P&L, Day Book, Ledger
// Interconnects: Invoices → GL, Payments → GL, Expenses → GL
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, dbBatch, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from './invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatDateTime, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

export const ACC_COLLECTIONS = {
  ACCOUNTS:       'acc_chart_of_accounts',
  JOURNAL_ENTRIES:'acc_journal_entries',
  GL_ENTRIES:     'acc_gl_entries',
  PERIODS:        'acc_periods',
};

// ── Account Types (Indian GAAP) ───────────────────────────────
export const ACCOUNT_TYPES = {
  ASSET:      { label: 'Asset',     code: 'A', normalBal: 'debit',  bsSection: 'Assets' },
  LIABILITY:  { label: 'Liability', code: 'L', normalBal: 'credit', bsSection: 'Liabilities' },
  EQUITY:     { label: 'Equity',    code: 'E', normalBal: 'credit', bsSection: 'Equity' },
  REVENUE:    { label: 'Revenue',   code: 'R', normalBal: 'credit', bsSection: 'P&L' },
  EXPENSE:    { label: 'Expense',   code: 'X', normalBal: 'debit',  bsSection: 'P&L' },
};

// ── Default Chart of Accounts (Indian GAAP) ──────────────────
export const DEFAULT_COA = [
  // ASSETS
  { code:'1000', name:'Cash in Hand',            type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1010', name:'Bank Account — Primary',  type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1020', name:'Bank Account — Secondary',type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1100', name:'Accounts Receivable',     type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1200', name:'Inventory / Stock',       type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1210', name:'Raw Materials',           type:'ASSET',   subType:'Current Asset',    level:2 },
  { code:'1220', name:'Work In Progress',        type:'ASSET',   subType:'Current Asset',    level:2 },
  { code:'1230', name:'Finished Goods',          type:'ASSET',   subType:'Current Asset',    level:2 },
  { code:'1300', name:'Prepaid Expenses',        type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1400', name:'GST Input Credit (CGST)', type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1410', name:'GST Input Credit (SGST)', type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1420', name:'GST Input Credit (IGST)', type:'ASSET',   subType:'Current Asset',    level:1 },
  { code:'1500', name:'Fixed Assets — Plant & Machinery', type:'ASSET', subType:'Fixed Asset', level:1 },
  { code:'1510', name:'Fixed Assets — Vehicles', type:'ASSET',  subType:'Fixed Asset',      level:1 },
  { code:'1520', name:'Fixed Assets — Computers & IT',type:'ASSET',subType:'Fixed Asset',   level:1 },
  { code:'1590', name:'Accumulated Depreciation',type:'ASSET',   subType:'Fixed Asset',      level:1, contraAccount:true },
  { code:'1600', name:'Security Deposits',       type:'ASSET',   subType:'Other Asset',      level:1 },
  // LIABILITIES
  { code:'2000', name:'Accounts Payable',        type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2100', name:'GST Payable (CGST)',       type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2110', name:'GST Payable (SGST)',       type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2120', name:'GST Payable (IGST)',       type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2200', name:'TDS Payable',             type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2210', name:'PF Payable',              type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2220', name:'ESI Payable',             type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2300', name:'Salary Payable',          type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2400', name:'Advance from Customers',  type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2500', name:'Short-term Loans',        type:'LIABILITY',subType:'Current Liability',level:1 },
  { code:'2600', name:'Long-term Loans',         type:'LIABILITY',subType:'Long-term Liability',level:1 },
  // EQUITY
  { code:'3000', name:'Share Capital',           type:'EQUITY',  subType:'Equity',           level:1 },
  { code:'3100', name:'Retained Earnings',       type:'EQUITY',  subType:'Equity',           level:1 },
  { code:'3200', name:'Current Year Profit/Loss',type:'EQUITY',  subType:'Equity',           level:1 },
  { code:'3300', name:"Owner's Drawing",        type:'EQUITY',  subType:'Equity',           level:1, contraAccount:true },
  // REVENUE
  { code:'4000', name:'Sales Revenue',           type:'REVENUE', subType:'Operating Revenue',level:1 },
  { code:'4010', name:'Service Revenue',         type:'REVENUE', subType:'Operating Revenue',level:1 },
  { code:'4020', name:'Freight Revenue',         type:'REVENUE', subType:'Operating Revenue',level:1 },
  { code:'4100', name:'Other Income',            type:'REVENUE', subType:'Non-operating Revenue',level:1 },
  { code:'4110', name:'Interest Income',         type:'REVENUE', subType:'Non-operating Revenue',level:1 },
  // EXPENSES
  { code:'5000', name:'Cost of Goods Sold',      type:'EXPENSE', subType:'Cost of Sales',    level:1 },
  { code:'5100', name:'Salaries & Wages',        type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5110', name:'PF Contribution (Employer)',type:'EXPENSE',subType:'Operating Expense',level:1 },
  { code:'5200', name:'Rent Expense',            type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5210', name:'Utilities Expense',       type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5300', name:'Fuel Expense',            type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5310', name:'Vehicle Maintenance',     type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5400', name:'Depreciation Expense',    type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5500', name:'Advertising & Marketing', type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5600', name:'Office Supplies',         type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5700', name:'Professional Fees',       type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5800', name:'Bank Charges',            type:'EXPENSE', subType:'Operating Expense',level:1 },
  { code:'5900', name:'Interest Expense',        type:'EXPENSE', subType:'Non-operating Expense',level:1 },
  { code:'5990', name:'Miscellaneous Expense',   type:'EXPENSE', subType:'Operating Expense',level:1 },
];

let _accounts=[], _journals=[], _activeTab='coa';
const PER=20;

export async function renderAccounting(container) {
  container.innerHTML = pageShell({
    title: '📒 Accounting Engine',
    subtitle: 'Chart of Accounts, double-entry bookkeeping, trial balance, P&L and balance sheet.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="initDefaultCOA()">⚡ Setup Default COA</button>
      <button class="btn btn-primary" onclick="switchAccTab('journal')">+ Journal Entry</button>
    `,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="acc-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['coa',      '📋 Chart of Accounts'],
          ['journal',  '📝 Journal Entries'],
          ['ledger',   '📖 Ledger'],
          ['daybook',  '📅 Day Book'],
          ['trial',    '⚖️ Trial Balance'],
          ['pnl',      '📊 P&L Statement'],
          ['balsheet', '🏦 Balance Sheet'],
        ].map(([id,label])=>`
          <button class="acc-tab ${id==='coa'?'active':''}" id="acc-tab-${id}"
            onclick="switchAccTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="acc-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.acc-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  setupModalClose(); setupMenuClose();

  // Load data
  const cid=AuthState.company?.id;
  const c=cid?[where('companyId','==',cid)]:[]; 
  [_accounts, _journals] = await Promise.all([
    dbGetAll(ACC_COLLECTIONS.ACCOUNTS,   [...c, orderBy('code')]),
    dbGetAll(ACC_COLLECTIONS.JOURNAL_ENTRIES, [...c, orderBy('date','desc')]),
  ]);

  renderAccKPIs();
  window.switchAccTab=switchAccTab;
  window.refreshAccounting=async()=>{
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_accounts,_journals]=await Promise.all([dbGetAll(ACC_COLLECTIONS.ACCOUNTS,[...c,orderBy('code')]),dbGetAll(ACC_COLLECTIONS.JOURNAL_ENTRIES,[...c,orderBy('date','desc')])]);
    renderAccKPIs(); switchAccTab(_activeTab);
  };

  switchAccTab('coa');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderAccKPIs(){
  const el=document.getElementById('acc-kpis'); if(!el) return; el.innerHTML='';
  const totalAssets    = calcAccountBalance('ASSET');
  const totalLiab      = calcAccountBalance('LIABILITY');
  const totalRevenue   = calcAccountBalance('REVENUE');
  const totalExpense   = calcAccountBalance('EXPENSE');
  const netProfit      = totalRevenue - totalExpense;
  [
    {label:'Total Assets',    value:formatCurrency(totalAssets,true),  icon:'🏦',color:'kpi-blue'},
    {label:'Total Liabilities',value:formatCurrency(totalLiab,true),   icon:'💳',color:'kpi-orange'},
    {label:'Revenue (YTD)',   value:formatCurrency(totalRevenue,true),  icon:'💰',color:'kpi-green'},
    {label:'Expenses (YTD)',  value:formatCurrency(totalExpense,true),  icon:'💸',color:'kpi-yellow'},
    {label:'Net Profit',      value:formatCurrency(netProfit,true),    icon:'📊',color:netProfit>=0?'kpi-green':'kpi-red'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function calcAccountBalance(type){
  return _accounts.filter(a=>a.type===type).reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
}

function switchAccTab(tab){
  _activeTab=tab;
  document.querySelectorAll('.acc-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`acc-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('acc-tab-content'); if(!c) return;
  switch(tab){
    case 'coa':      renderCOATab(c);      break;
    case 'journal':  renderJournalTab(c);  break;
    case 'ledger':   renderLedgerTab(c);   break;
    case 'daybook':  renderDayBookTab(c);  break;
    case 'trial':    renderTrialBalance(c);break;
    case 'pnl':      renderPnLStatement(c);break;
    case 'balsheet': renderBalanceSheet(c);break;
  }
}

// ══════════════════════════════════════════════════════════════
// CHART OF ACCOUNTS
// ══════════════════════════════════════════════════════════════
function renderCOATab(container){
  const byType={ASSET:[],LIABILITY:[],EQUITY:[],REVENUE:[],EXPENSE:[]};
  _accounts.forEach(a=>{ if(byType[a.type]) byType[a.type].push(a); });

  container.innerHTML=`
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:var(--space-4);">
      <button class="btn btn-secondary btn-sm" onclick="exportCOA()">⬇ Export</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('add-account-modal')">+ Add Account</button>
    </div>

    ${Object.entries(byType).map(([type,accounts])=>{
      if(!accounts.length) return '';
      const typeInfo=ACCOUNT_TYPES[type];
      const totalBal=accounts.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
      const color={ASSET:'var(--brand-primary)',LIABILITY:'var(--brand-danger)',EQUITY:'var(--brand-secondary)',REVENUE:'var(--brand-secondary)',EXPENSE:'var(--brand-warning)'}[type];
      return `
        <div class="card" style="margin-bottom:var(--space-4);border-left:4px solid ${color};">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--border-subtle);cursor:pointer;"
               onclick="toggleCOASection('${type}')">
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-family:var(--font-display);font-size:16px;font-weight:700;color:${color};">${typeInfo.label}s</span>
              <span class="badge badge-gray">${accounts.length} accounts</span>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-family:var(--font-display);font-size:16px;font-weight:700;color:${color};">
                ₹${Math.abs(totalBal).toLocaleString('en-IN')}
              </span>
              <span id="coa-arrow-${type}" style="color:var(--text-muted);">▼</span>
            </div>
          </div>
          <div id="coa-section-${type}">
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:var(--bg-elevated);">
                <th style="padding:8px 16px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Code</th>
                <th style="padding:8px 16px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Account Name</th>
                <th style="padding:8px 16px;text-align:left;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Sub-Type</th>
                <th style="padding:8px 16px;text-align:right;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Debit</th>
                <th style="padding:8px 16px;text-align:right;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Credit</th>
                <th style="padding:8px 16px;text-align:right;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Balance</th>
                <th style="padding:8px 16px;text-align:center;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Action</th>
              </tr></thead>
              <tbody>
                ${accounts.map(acc=>{
                  const debit=Number(acc.totalDebit)||0;
                  const credit=Number(acc.totalCredit)||0;
                  const bal=Number(acc.currentBalance)||0;
                  const isNormal=(ACCOUNT_TYPES[type].normalBal==='debit'&&bal>=0)||(ACCOUNT_TYPES[type].normalBal==='credit'&&bal>=0);
                  return `<tr style="border-bottom:1px solid var(--border-subtle);${acc.level===2?'background:var(--bg-surface);':''}" onmouseenter="this.style.background='var(--bg-elevated)'" onmouseleave="this.style.background='${acc.level===2?'var(--bg-surface)':'transparent'}'">
                    <td style="padding:10px 16px;font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(acc.code)}</td>
                    <td style="padding:10px 16px;font-size:13px;${acc.level===2?'padding-left:32px;':''}">${acc.level===2?'└ ':''}${escHtml(acc.name)}</td>
                    <td style="padding:10px 16px;"><span class="badge badge-gray" style="font-size:10px;">${escHtml(acc.subType||'—')}</span></td>
                    <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:12px;">₹${debit.toLocaleString('en-IN')}</td>
                    <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:12px;">₹${credit.toLocaleString('en-IN')}</td>
                    <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:12px;font-weight:700;color:${bal>=0?color:'var(--brand-danger)'};">
                      ₹${Math.abs(bal).toLocaleString('en-IN')} ${bal<0?'(Cr)':''}
                    </td>
                    <td style="padding:10px 16px;text-align:center;">
                      <div style="display:flex;gap:4px;justify-content:center;">
                        <button class="btn btn-ghost btn-sm" style="font-size:10px;" onclick="viewLedger('${acc.id}')">📖 Ledger</button>
                        <button class="btn btn-ghost btn-icon" onclick="deleteAccount('${acc.id}')" style="color:var(--brand-danger);font-size:12px;">🗑</button>
                      </div>
                    </td>
                  </tr>`;
                }).join('')}
                <tr style="background:rgba(0,0,0,0.1);border-top:2px solid ${color};">
                  <td colspan="3" style="padding:10px 16px;font-weight:700;font-size:13px;">Total ${typeInfo.label}s</td>
                  <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-weight:700;">₹${accounts.reduce((s,a)=>s+(Number(a.totalDebit)||0),0).toLocaleString('en-IN')}</td>
                  <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-weight:700;">₹${accounts.reduce((s,a)=>s+(Number(a.totalCredit)||0),0).toLocaleString('en-IN')}</td>
                  <td style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-weight:700;color:${color};">₹${Math.abs(totalBal).toLocaleString('en-IN')}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('')}

    ${!_accounts.length?`
      <div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:48px;margin-bottom:16px;opacity:0.3;">📒</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">No Chart of Accounts Yet</div>
        <div style="font-size:13px;margin-bottom:24px;">Set up the default Indian GAAP chart with one click.</div>
        <button class="btn btn-primary btn-lg" onclick="initDefaultCOA()">⚡ Initialize Default COA (Indian GAAP)</button>
      </div>`:''}
  `;

  // Add account modal
  document.getElementById('add-account-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildAddAccountModal());

  window.toggleCOASection=(type)=>{
    const el=document.getElementById(`coa-section-${type}`);
    const arrow=document.getElementById(`coa-arrow-${type}`);
    if(!el) return;
    const hidden=el.style.display==='none';
    el.style.display=hidden?'':'none';
    if(arrow) arrow.textContent=hidden?'▼':'▶';
  };
  window.viewLedger=(accId)=>{ switchAccTab('ledger'); setTimeout(()=>{ const sel=document.getElementById('ledger-account-select'); if(sel){sel.value=accId;loadLedger(accId);} },300); };
  window.exportCOA=()=>{
    const csv=[['Code','Name','Type','Sub-Type','Debit','Credit','Balance'],
      ..._accounts.map(a=>[a.code,a.name,a.type,a.subType,a.totalDebit||0,a.totalCredit||0,a.currentBalance||0])
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const el=document.createElement('a'); el.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); el.download='chart_of_accounts.csv'; el.click();
    Toast.success('Exported','Chart of Accounts exported.');
  };
  window.deleteAccount=async(id)=>{
    if(!confirm('Delete this account? All associated entries will remain.')) return;
    try{await dbDelete(ACC_COLLECTIONS.ACCOUNTS,id); await window.refreshAccounting?.(); Toast.success('Deleted','Account removed.');}
    catch(e){Toast.error('Failed',e.message);}
  };
}

function buildAddAccountModal(){
  const typeOpts=Object.entries(ACCOUNT_TYPES).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join('');
  return buildModal({
    id:'add-account-modal',title:'Add Account',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Account Code <span class="required">*</span></label><input type="text" id="acc-code" class="form-input" placeholder="e.g. 1015"></div>
        <div class="form-group"><label class="form-label">Account Name <span class="required">*</span></label><input type="text" id="acc-name" class="form-input" placeholder="e.g. Petty Cash"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Account Type <span class="required">*</span></label><select id="acc-type" class="form-select">${typeOpts}</select></div>
        <div class="form-group"><label class="form-label">Sub-Type</label><input type="text" id="acc-subtype" class="form-input" placeholder="e.g. Current Asset"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Opening Balance (₹)</label><input type="number" id="acc-opening" class="form-input" placeholder="0" step="0.01"></div>
        <div class="form-group"><label class="form-label">Parent Account</label>
          <select id="acc-parent" class="form-select">
            <option value="">None (Top Level)</option>
            ${_accounts.filter(a=>a.level===1).map(a=>`<option value="${a.id}">${a.code} — ${escHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description</label><textarea id="acc-desc" class="form-textarea" rows="2" placeholder="Account description…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('add-account-modal')">Cancel</button>
            <button class="btn btn-primary" id="add-acc-btn" onclick="saveAccount()">Add Account</button>`,
  });
}

window.saveAccount=async()=>{
  if(!validateForm([{id:'acc-code',label:'Code',required:true},{id:'acc-name',label:'Name',required:true},{id:'acc-type',label:'Type',required:true}])) return;
  const btn=document.getElementById('add-acc-btn'); setLoading(btn,true);
  const opening=Number(document.getElementById('acc-opening').value)||0;
  const type=document.getElementById('acc-type').value;
  const normalBal=ACCOUNT_TYPES[type]?.normalBal||'debit';
  const data={
    code:document.getElementById('acc-code').value.trim(),
    name:document.getElementById('acc-name').value.trim(),
    type,subType:document.getElementById('acc-subtype').value.trim(),
    parentId:document.getElementById('acc-parent').value||null,
    level:document.getElementById('acc-parent').value?2:1,
    openingBalance:opening,currentBalance:opening,
    totalDebit:normalBal==='debit'?opening:0,
    totalCredit:normalBal==='credit'?opening:0,
    description:document.getElementById('acc-desc').value.trim(),
    isActive:true,companyId:AuthState.company?.id||null,
  };
  try{
    await dbCreate(ACC_COLLECTIONS.ACCOUNTS,data);
    Toast.success('Added',`Account ${data.code} — ${data.name} created.`);
    closeModal('add-account-modal');
    await window.refreshAccounting?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

// ══════════════════════════════════════════════════════════════
// JOURNAL ENTRIES (Double-Entry)
// ══════════════════════════════════════════════════════════════
let _filtJournals=[], _pageJournals=1;

function renderJournalTab(container){
  _filtJournals=[..._journals];
  container.innerHTML=`
    ${searchBar({id:'jnl',placeholder:'Search journal no, narration…',
      filters:[{key:'type',label:'All Types',options:[{value:'general',label:'General'},{value:'sales',label:'Sales'},{value:'purchase',label:'Purchase'},{value:'payment',label:'Payment'},{value:'receipt',label:'Receipt'},{value:'contra',label:'Contra'},{value:'depreciation',label:'Depreciation'}]}],
      onSearch:'jnlSearch',onFilter:'jnlFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('journal-modal')">+ New Journal Entry</button>
    </div>
    <div id="jnl-table-wrap"></div>
    <div id="jnl-pagination"></div>
  `;

  document.getElementById('journal-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildJournalModal());

  window.jnlSearch=debounce((q)=>{_filtJournals=searchFilter(_journals,q,['journalNo','narration','reference']);_pageJournals=1;renderJournalTable();},250);
  window.jnlFilter=(k,v)=>{_filtJournals=v?_journals.filter(j=>j[k]===v):[..._journals];_pageJournals=1;renderJournalTable();};
  window.setJnlPage=(p)=>{_pageJournals=p;renderJournalTable();};
  renderJournalTable();
}

function renderJournalTable(){
  const wrap=document.getElementById('jnl-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('jnl-count'); if(cnt) cnt.textContent=`${_filtJournals.length} entr${_filtJournals.length!==1?'ies':'y'}`;
  const start=(_pageJournals-1)*PER;
  wrap.innerHTML=buildTable({id:'jnl-table',columns:[
    {key:'journalNo', label:'JV No.',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.journalNo||'—')}</span>`},
    {key:'date',      label:'Date',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.date||'—'}</span>`},
    {key:'type',      label:'Type',      render:r=>`<span class="badge badge-blue">${escHtml(r.type||'general')}</span>`},
    {key:'narration', label:'Narration', render:r=>`<div style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.narration||'—')}</div>`},
    {key:'lines',     label:'Lines',     render:r=>`<span class="badge badge-gray">${r.lines?.length||0}</span>`},
    {key:'totalDebit',label:'Dr Amount', render:r=>`<span style="font-family:var(--font-mono);color:var(--brand-primary);">₹${Number(r.totalDebit||0).toLocaleString('en-IN')}</span>`},
    {key:'totalCredit',label:'Cr Amount',render:r=>`<span style="font-family:var(--font-mono);color:var(--brand-secondary);">₹${Number(r.totalCredit||0).toLocaleString('en-IN')}</span>`},
    {key:'balanced',  label:'Balanced',  render:r=>{const bal=Math.abs(Number(r.totalDebit||0)-Number(r.totalCredit||0))<0.01;return bal?`<span class="badge badge-green">✅ Yes</span>`:`<span class="badge badge-red">❌ No</span>`}},
    {key:'reference', label:'Ref',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml(r.reference||'—')}</span>`},
    {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
      {icon:'👁',label:'View',    action:`viewJournal('${r.id}')`},
      {icon:'🔄',label:'Reverse', action:`reverseJournal('${r.id}')`},
      {icon:'🗑',label:'Delete',  action:`deleteJournal('${r.id}')`,danger:true},
    ])},
  ],rows:_filtJournals.slice(start,start+PER),emptyMsg:'No journal entries yet'});
  document.getElementById('jnl-pagination').innerHTML=buildPagination({id:'jnl',total:_filtJournals.length,page:_pageJournals,perPage:PER,onChange:'setJnlPage'});
}

function buildJournalModal(){
  const accOpts=_accounts.map(a=>`<option value="${a.id}" data-code="${a.code}" data-type="${a.type}">${a.code} — ${escHtml(a.name)}</option>`).join('');
  return buildModal({
    id:'journal-modal',title:'New Journal Entry',size:'xl',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Journal No.</label><input type="text" id="jv-no" class="form-input" value="JV-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" id="jv-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Entry Type</label>
          <select id="jv-type" class="form-select">
            <option value="general">General Journal</option><option value="sales">Sales Entry</option>
            <option value="purchase">Purchase Entry</option><option value="payment">Payment</option>
            <option value="receipt">Receipt</option><option value="contra">Contra Entry</option>
            <option value="depreciation">Depreciation</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Narration <span class="required">*</span></label>
        <input type="text" id="jv-narration" class="form-input" placeholder="Being — describe what this entry is for…">
      </div>
      <div class="form-group"><label class="form-label">Reference (Invoice/Bill No.)</label>
        <input type="text" id="jv-ref" class="form-input" placeholder="INV-XXXX or PO-XXXX">
      </div>

      <!-- Journal Lines -->
      <div style="margin:var(--space-4) 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Journal Lines (Debit = Dr, Credit = Cr)</div>
          <button class="btn btn-secondary btn-sm" onclick="addJournalLine()">+ Add Line</button>
        </div>
        <div class="table-container">
          <table class="table" id="jv-lines-table">
            <thead>
              <tr>
                <th style="min-width:240px;">Account</th>
                <th style="width:180px;">Description</th>
                <th style="width:130px;">Debit (₹)</th>
                <th style="width:130px;">Credit (₹)</th>
                <th style="width:36px;"></th>
              </tr>
            </thead>
            <tbody id="jv-lines-body"></tbody>
          </table>
        </div>

        <!-- Balance Check -->
        <div style="display:flex;justify-content:flex-end;gap:24px;margin-top:12px;padding:12px 16px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="font-size:13px;color:var(--text-secondary);">Total Debit: <strong id="jv-total-dr" style="font-family:var(--font-mono);color:var(--brand-primary);">₹0.00</strong></div>
          <div style="font-size:13px;color:var(--text-secondary);">Total Credit: <strong id="jv-total-cr" style="font-family:var(--font-mono);color:var(--brand-secondary);">₹0.00</strong></div>
          <div style="font-size:13px;" id="jv-balance-status"><span class="badge badge-gray">Not balanced</span></div>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('journal-modal')">Cancel</button>
            <button class="btn btn-primary" id="jv-save-btn" onclick="saveJournal()" disabled>Post Journal Entry</button>`,
  });
}

// Journal line management
let _jvLines=[];
window.addJournalLine=()=>{
  const idx=_jvLines.length; _jvLines.push({accountId:'',description:'',debit:0,credit:0});
  const accOpts=_accounts.map(a=>`<option value="${a.id}">${a.code} — ${escHtml(a.name)}</option>`).join('');
  const row=document.createElement('tr'); row.id=`jv-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:220px;" onchange="updateJVLine(${idx},'accountId',this.value)"><option value="">Select account…</option>${accOpts}</select></td>
    <td><input type="text" class="form-input" placeholder="Line description…" onchange="updateJVLine(${idx},'description',this.value)"></td>
    <td><input type="number" id="jv-dr-${idx}" class="form-input" value="0" min="0" step="0.01" oninput="updateJVLine(${idx},'debit',this.value);if(Number(this.value)>0){document.getElementById('jv-cr-${idx}').value=0;updateJVLine(${idx},'credit',0);}calcJVTotals()"></td>
    <td><input type="number" id="jv-cr-${idx}" class="form-input" value="0" min="0" step="0.01" oninput="updateJVLine(${idx},'credit',this.value);if(Number(this.value)>0){document.getElementById('jv-dr-${idx}').value=0;updateJVLine(${idx},'debit',0);}calcJVTotals()"></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeJVLine(${idx})">✕</button></td>
  `;
  document.getElementById('jv-lines-body').appendChild(row);
  calcJVTotals();
};

window.updateJVLine=(idx,key,val)=>{ if(_jvLines[idx]) _jvLines[idx][key]=val; };
window.removeJVLine=(idx)=>{ document.getElementById(`jv-line-${idx}`)?.remove(); _jvLines[idx]=null; calcJVTotals(); };
window.calcJVTotals=()=>{
  const active=_jvLines.filter(Boolean);
  const totalDr=active.reduce((s,l)=>s+(Number(l.debit)||0),0);
  const totalCr=active.reduce((s,l)=>s+(Number(l.credit)||0),0);
  const balanced=Math.abs(totalDr-totalCr)<0.01&&totalDr>0;
  const drEl=document.getElementById('jv-total-dr'); if(drEl) drEl.textContent='₹'+totalDr.toLocaleString('en-IN',{minimumFractionDigits:2});
  const crEl=document.getElementById('jv-total-cr'); if(crEl) crEl.textContent='₹'+totalCr.toLocaleString('en-IN',{minimumFractionDigits:2});
  const statusEl=document.getElementById('jv-balance-status');
  if(statusEl) statusEl.innerHTML=balanced?`<span class="badge badge-green">✅ Balanced</span>`:`<span class="badge badge-red">❌ Diff: ₹${Math.abs(totalDr-totalCr).toFixed(2)}</span>`;
  const saveBtn=document.getElementById('jv-save-btn'); if(saveBtn) saveBtn.disabled=!balanced;
};

window.saveJournal=async()=>{
  if(!validateForm([{id:'jv-date',label:'Date',required:true},{id:'jv-narration',label:'Narration',required:true}])) return;
  const valid=_jvLines.filter(l=>l&&l.accountId&&(Number(l.debit)||Number(l.credit)));
  if(valid.length<2){Toast.error('Invalid','A journal entry needs at least 2 lines.');return;}
  const totalDr=valid.reduce((s,l)=>s+(Number(l.debit)||0),0);
  const totalCr=valid.reduce((s,l)=>s+(Number(l.credit)||0),0);
  if(Math.abs(totalDr-totalCr)>0.01){Toast.error('Not Balanced',`Debit ₹${totalDr.toFixed(2)} ≠ Credit ₹${totalCr.toFixed(2)}`);return;}
  const btn=document.getElementById('jv-save-btn'); setLoading(btn,true);
  try{
    const journalData={
      journalNo:document.getElementById('jv-no').value.trim(),
      date:document.getElementById('jv-date').value,
      type:document.getElementById('jv-type').value,
      narration:document.getElementById('jv-narration').value.trim(),
      reference:document.getElementById('jv-ref').value.trim(),
      lines:valid,totalDebit:totalDr,totalCredit:totalCr,
      postedBy:AuthState.profile?.name||'',
      companyId:AuthState.company?.id||null,
    };
    const journalDoc=await dbCreate(ACC_COLLECTIONS.JOURNAL_ENTRIES,journalData);
    // Update account balances
    const balanceOps=[];
    for(const line of valid){
      const acc=_accounts.find(a=>a.id===line.accountId); if(!acc) continue;
      const dr=Number(line.debit)||0; const cr=Number(line.credit)||0;
      const accType=ACCOUNT_TYPES[acc.type]; if(!accType) continue;
      let balChange=0;
      if(accType.normalBal==='debit') balChange=dr-cr;
      else balChange=cr-dr;
      const newBal=(Number(acc.currentBalance)||0)+balChange;
      const newTotalDr=(Number(acc.totalDebit)||0)+dr;
      const newTotalCr=(Number(acc.totalCredit)||0)+cr;
      balanceOps.push({collection:ACC_COLLECTIONS.ACCOUNTS,id:acc.id,type:'update',data:{currentBalance:newBal,totalDebit:newTotalDr,totalCredit:newTotalCr}});
      // Also create individual GL entry
      balanceOps.push({collection:ACC_COLLECTIONS.GL_ENTRIES,id:genId(),type:'set',data:{journalId:journalDoc.id,journalNo:journalData.journalNo,accountId:acc.id,accountCode:acc.code,accountName:acc.name,date:journalData.date,narration:journalData.narration,debit:dr,credit:cr,balance:newBal,companyId:AuthState.company?.id||null}});
    }
    await dbBatch(balanceOps);
    Toast.success('Posted!',`${journalData.journalNo} posted. ${valid.length} GL entries created.`);
    closeModal('journal-modal');
    _jvLines=[]; document.getElementById('jv-lines-body').innerHTML='';
    document.getElementById('jv-no').value='JV-'+genId();
    await window.refreshAccounting?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.viewJournal=async(id)=>{
  const j=_journals.find(x=>x.id===id); if(!j) return;
  document.getElementById('jv-view-modal')?.remove();
  const html=buildModal({
    id:'jv-view-modal',title:`Journal Entry — ${j.journalNo}`,size:'lg',
    body:`
      <div class="grid-3" style="margin-bottom:16px;gap:10px;">
        ${[['JV No.',j.journalNo],['Date',j.date],['Type',j.type],['Reference',j.reference||'—'],['Posted By',j.postedBy||'—'],['Posted On',formatDate(j.createdAt)]].map(([l,v])=>`
          <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;">
            <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">${l}</div>
            <div style="font-size:13px;margin-top:2px;">${escHtml(String(v||'—'))}</div>
          </div>`).join('')}
      </div>
      <div style="padding:12px;background:var(--bg-elevated);border-radius:8px;margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Narration</div>
        <div style="font-size:13px;">${escHtml(j.narration||'—')}</div>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Account Code</th><th>Account Name</th><th>Description</th><th style="text-align:right;">Debit (₹)</th><th style="text-align:right;">Credit (₹)</th></tr></thead>
          <tbody>
            ${(j.lines||[]).map(line=>{
              const acc=_accounts.find(a=>a.id===line.accountId)||{};
              return `<tr>
                <td style="font-family:var(--font-mono);color:var(--brand-primary);">${escHtml(acc.code||'—')}</td>
                <td style="font-size:12px;">${escHtml(acc.name||line.accountId||'—')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${escHtml(line.description||'—')}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-primary);">${Number(line.debit||0)?'₹'+Number(line.debit).toLocaleString('en-IN',{minimumFractionDigits:2}):'—'}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);">${Number(line.credit||0)?'₹'+Number(line.credit).toLocaleString('en-IN',{minimumFractionDigits:2}):'—'}</td>
              </tr>`;
            }).join('')}
            <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
              <td colspan="3" style="font-weight:700;padding:10px 16px;">TOTAL</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-primary);padding:10px 16px;">₹${Number(j.totalDebit||0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);padding:10px 16px;">₹${Number(j.totalCredit||0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
            </tr>
          </tbody>
        </table>
      </div>`,
    footer:`<button class="btn btn-secondary" onclick="closeModal('jv-view-modal')">Close</button>
            <button class="btn btn-danger btn-sm" onclick="closeModal('jv-view-modal');reverseJournal('${j.id}')">🔄 Reverse Entry</button>`,
  });
  document.body.insertAdjacentHTML('beforeend',html); openModal('jv-view-modal');
};

window.reverseJournal=async(id)=>{
  const j=_journals.find(x=>x.id===id); if(!j) return;
  if(!confirm(`Reverse journal entry ${j.journalNo}? This creates an equal and opposite entry.`)) return;
  const reversedLines=(j.lines||[]).map(l=>({...l,debit:l.credit||0,credit:l.debit||0}));
  const data={
    journalNo:'REV-'+j.journalNo,date:new Date().toISOString().slice(0,10),type:j.type,
    narration:`REVERSAL of ${j.journalNo} — ${j.narration}`,
    reference:j.journalNo,lines:reversedLines,
    totalDebit:j.totalCredit,totalCredit:j.totalDebit,
    reversalOf:j.id,postedBy:AuthState.profile?.name||'',
    companyId:AuthState.company?.id||null,
  };
  try{
    await dbCreate(ACC_COLLECTIONS.JOURNAL_ENTRIES,data);
    Toast.success('Reversed',`Reversal entry created: ${data.journalNo}`);
    await window.refreshAccounting?.();
  }catch(e){Toast.error('Failed',e.message);}
};

window.deleteJournal=async(id)=>{
  if(!confirm('Delete this journal entry? Account balances will be reversed.')) return;
  const j=_journals.find(x=>x.id===id); if(!j) return;
  try{
    // Reverse balance changes
    const ops=[];
    for(const line of (j.lines||[])){
      const acc=_accounts.find(a=>a.id===line.accountId); if(!acc) continue;
      const accType=ACCOUNT_TYPES[acc.type]; if(!accType) continue;
      const dr=Number(line.debit)||0; const cr=Number(line.credit)||0;
      let balChange=accType.normalBal==='debit'?-(dr-cr):-(cr-dr);
      ops.push({collection:ACC_COLLECTIONS.ACCOUNTS,id:acc.id,type:'update',data:{currentBalance:(Number(acc.currentBalance)||0)+balChange,totalDebit:Math.max(0,(Number(acc.totalDebit)||0)-dr),totalCredit:Math.max(0,(Number(acc.totalCredit)||0)-cr)}});
    }
    if(ops.length) await dbBatch(ops);
    await dbDelete(ACC_COLLECTIONS.JOURNAL_ENTRIES,id);
    Toast.success('Deleted','Journal entry deleted and balances reversed.');
    await window.refreshAccounting?.();
  }catch(e){Toast.error('Failed',e.message);}
};

// ══════════════════════════════════════════════════════════════
// LEDGER VIEW
// ══════════════════════════════════════════════════════════════
async function renderLedgerTab(container){
  container.innerHTML=`
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;flex-wrap:wrap;margin-bottom:var(--space-4);">
      <div class="form-group" style="flex:1;max-width:360px;margin-bottom:0;">
        <label class="form-label">Select Account</label>
        <select id="ledger-account-select" class="form-select" onchange="loadLedger(this.value)">
          <option value="">Choose account…</option>
          ${_accounts.map(a=>`<option value="${a.id}">${a.code} — ${escHtml(a.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">From</label>
        <input type="date" id="ledger-from" class="form-input" value="${new Date().getFullYear()}-04-01">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">To</label>
        <input type="date" id="ledger-to" class="form-input" value="${new Date().toISOString().slice(0,10)}">
      </div>
      <button class="btn btn-secondary btn-sm" onclick="printLedger()">🖨️ Print</button>
    </div>
    <div id="ledger-content">
      <div style="text-align:center;padding:60px;color:var(--text-muted);font-size:13px;">Select an account to view its ledger</div>
    </div>
  `;
}

window.loadLedger=async(accId)=>{
  if(!accId) return;
  const el=document.getElementById('ledger-content'); if(!el) return;
  const acc=_accounts.find(a=>a.id===accId); if(!acc) return;
  const from=document.getElementById('ledger-from')?.value;
  const to  =document.getElementById('ledger-to')?.value;
  el.innerHTML=`<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>`;

  try{
    const cid=AuthState.company?.id;
    const constraints=[...(cid?[where('companyId','==',cid)]:[]),where('accountId','==',accId),orderBy('date','asc')];
    let entries=await dbGetAll(ACC_COLLECTIONS.GL_ENTRIES,constraints);
    if(from) entries=entries.filter(e=>e.date>=from);
    if(to)   entries=entries.filter(e=>e.date<=to);

    const accType=ACCOUNT_TYPES[acc.type];
    const normalBal=accType?.normalBal||'debit';
    let runningBal=Number(acc.openingBalance)||0;

    el.innerHTML=`
      <!-- Account Header -->
      <div style="background:linear-gradient(135deg,rgba(10,132,255,0.1),rgba(0,200,150,0.05));border:1px solid rgba(10,132,255,0.2);border-radius:var(--radius-lg);padding:20px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Account Ledger</div>
            <div style="font-family:var(--font-display);font-size:22px;font-weight:700;">${escHtml(acc.code)} — ${escHtml(acc.name)}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${escHtml(acc.type)} · ${escHtml(acc.subType||'—')}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px;color:var(--text-muted);">Current Balance</div>
            <div style="font-family:var(--font-display);font-size:28px;font-weight:800;color:var(--brand-primary);">₹${Math.abs(Number(acc.currentBalance)||0).toLocaleString('en-IN')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${normalBal==='debit'?'Debit Balance':'Credit Balance'}</div>
          </div>
        </div>
      </div>

      <!-- Ledger Table -->
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th style="width:100px;">Date</th>
              <th>Particulars / Narration</th>
              <th style="width:100px;">JV No.</th>
              <th style="width:130px;text-align:right;">Debit (₹)</th>
              <th style="width:130px;text-align:right;">Credit (₹)</th>
              <th style="width:150px;text-align:right;">Balance (₹)</th>
            </tr>
          </thead>
          <tbody>
            <!-- Opening Balance -->
            <tr style="background:rgba(10,132,255,0.06);border-bottom:2px solid var(--border-subtle);">
              <td style="font-size:12px;padding:10px 16px;">${from||'Opening'}</td>
              <td style="font-size:13px;font-weight:600;padding:10px 16px;">Opening Balance</td>
              <td style="padding:10px 16px;"></td>
              <td style="text-align:right;font-family:var(--font-mono);padding:10px 16px;">${normalBal==='debit'&&runningBal>0?'₹'+runningBal.toLocaleString('en-IN'):''}</td>
              <td style="text-align:right;font-family:var(--font-mono);padding:10px 16px;">${normalBal==='credit'&&runningBal>0?'₹'+runningBal.toLocaleString('en-IN'):''}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:10px 16px;">₹${runningBal.toLocaleString('en-IN')} ${normalBal==='debit'?'Dr':'Cr'}</td>
            </tr>
            ${entries.map(e=>{
              const dr=Number(e.debit)||0; const cr=Number(e.credit)||0;
              if(normalBal==='debit') runningBal+=dr-cr;
              else runningBal+=cr-dr;
              const balColor=runningBal<0?'var(--brand-danger)':'var(--text-primary)';
              return `<tr>
                <td style="font-family:var(--font-mono);font-size:12px;padding:10px 16px;">${e.date||'—'}</td>
                <td style="font-size:12px;padding:10px 16px;">${escHtml(e.narration||'—')}</td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--brand-primary);padding:10px 16px;">${escHtml(e.journalNo||'—')}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-primary);padding:10px 16px;">${dr?'₹'+dr.toLocaleString('en-IN',{minimumFractionDigits:2}):''}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);padding:10px 16px;">${cr?'₹'+cr.toLocaleString('en-IN',{minimumFractionDigits:2}):''}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:600;color:${balColor};padding:10px 16px;">₹${Math.abs(runningBal).toLocaleString('en-IN',{minimumFractionDigits:2})} ${runningBal<0?'Cr':'Dr'}</td>
              </tr>`;
            }).join('')}
            ${!entries.length?`<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted);">No transactions in selected period</td></tr>`:''}
            <!-- Closing Balance -->
            <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
              <td colspan="3" style="font-weight:700;font-size:13px;padding:12px 16px;">CLOSING BALANCE</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-primary);padding:12px 16px;">₹${entries.reduce((s,e)=>s+(Number(e.debit)||0),0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);padding:12px 16px;">₹${entries.reduce((s,e)=>s+(Number(e.credit)||0),0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:800;font-size:14px;color:${runningBal<0?'var(--brand-danger)':'var(--brand-primary)'};padding:12px 16px;">₹${Math.abs(runningBal).toLocaleString('en-IN',{minimumFractionDigits:2})} ${runningBal<0?'Cr':'Dr'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }catch(e){el.innerHTML=`<div class="alert alert-danger"><span>❌</span><div>${e.message}</div></div>`;}
};

window.printLedger=()=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'General Ledger Report' }); else window.print(); };

// ══════════════════════════════════════════════════════════════
// DAY BOOK
// ══════════════════════════════════════════════════════════════
function renderDayBookTab(container){
  const today=new Date().toISOString().slice(0,10);
  container.innerHTML=`
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Date</label>
        <input type="date" id="daybook-date" class="form-input" value="${today}" onchange="loadDayBook(this.value)">
      </div>
      <button class="btn btn-secondary btn-sm" onclick="loadDayBook(document.getElementById('daybook-date').value)">Load</button>
      <button class="btn btn-secondary btn-sm" onclick="printDayBook()">🖨️ Print Day Book</button>
    </div>
    <div id="daybook-content"><div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div></div>
  `;
  loadDayBook(today);
}

window.loadDayBook=async(date)=>{
  const el=document.getElementById('daybook-content'); if(!el) return;
  el.innerHTML=`<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>`;
  try{
    const dayJournals=_journals.filter(j=>j.date===date);
    if(!dayJournals.length){el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);"><div style="font-size:36px;margin-bottom:12px;opacity:0.3;">📅</div><div style="font-size:14px;">No transactions on ${date}</div></div>`;return;}
    const totalDr=dayJournals.reduce((s,j)=>s+(Number(j.totalDebit)||0),0);
    const totalCr=dayJournals.reduce((s,j)=>s+(Number(j.totalCredit)||0),0);
    el.innerHTML=`
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;">Day Book</div>
        <div style="font-size:13px;color:var(--text-secondary);">${new Date(date).toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${dayJournals.length} entries · Total Dr: ₹${totalDr.toLocaleString('en-IN')} · Total Cr: ₹${totalCr.toLocaleString('en-IN')}</div>
      </div>
      ${dayJournals.map(j=>`
        <div style="margin-bottom:20px;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);overflow:hidden;">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg-elevated);">
            <div>
              <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(j.journalNo)}</span>
              <span class="badge badge-blue" style="margin-left:8px;">${j.type}</span>
            </div>
            <span style="font-size:11px;color:var(--text-muted);">₹${Number(j.totalDebit||0).toLocaleString('en-IN')}</span>
          </div>
          <div style="padding:10px 16px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);">
            <div style="font-size:13px;font-style:italic;color:var(--text-secondary);">Being: ${escHtml(j.narration||'—')}</div>
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <tbody>
              ${(j.lines||[]).map((line,i)=>{
                const acc=_accounts.find(a=>a.id===line.accountId)||{};
                const isDr=Number(line.debit)>0;
                return `<tr style="border-bottom:1px solid var(--border-subtle);">
                  <td style="padding:8px 16px ${isDr?'':' padding-left:48px'};font-size:12px;">
                    ${!isDr?'To ':''}<strong>${escHtml(acc.name||'—')}</strong> A/c ${isDr?'Dr':''}
                  </td>
                  <td style="padding:8px 16px;text-align:right;font-family:var(--font-mono);font-size:12px;color:${isDr?'var(--brand-primary)':'var(--brand-secondary)'};">
                    ₹${isDr?Number(line.debit||0).toLocaleString('en-IN',{minimumFractionDigits:2}):Number(line.credit||0).toLocaleString('en-IN',{minimumFractionDigits:2})}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`).join('')}
    `;
  }catch(e){el.innerHTML=`<div class="alert alert-danger"><span>❌</span><div>${e.message}</div></div>`;}
};
window.printDayBook=()=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'Day Book Report' }); else window.print(); };

// ══════════════════════════════════════════════════════════════
// TRIAL BALANCE
// ══════════════════════════════════════════════════════════════
function renderTrialBalance(container){
  const totalDr=_accounts.reduce((s,a)=>s+(Number(a.totalDebit)||0),0);
  const totalCr=_accounts.reduce((s,a)=>s+(Number(a.totalCredit)||0),0);
  const isBalanced=Math.abs(totalDr-totalCr)<0.01;

  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Trial Balance</h3>
        <p style="font-size:12px;color:var(--text-secondary);">As of ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p>
      </div>
      <div style="display:flex;gap:8px;">
        ${isBalanced?`<span class="badge badge-green badge-dot" style="padding:6px 14px;font-size:12px;">✅ Accounts Balanced</span>`:
          `<span class="badge badge-red badge-dot" style="padding:6px 14px;font-size:12px;">❌ Out of Balance by ₹${Math.abs(totalDr-totalCr).toFixed(2)}</span>`}
        <button class="btn btn-secondary btn-sm" onclick="exportTrialBalance()">⬇ Export</button>
        <button class="btn btn-secondary btn-sm" onclick="printTrialBalance()">🖨️ Print</button>
      </div>
    </div>

    <div class="table-container">
      <table class="table">
        <thead>
          <tr>
            <th style="width:80px;">Code</th>
            <th>Account Name</th>
            <th style="width:100px;">Type</th>
            <th style="width:160px;text-align:right;">Debit Balance (₹)</th>
            <th style="width:160px;text-align:right;">Credit Balance (₹)</th>
          </tr>
        </thead>
        <tbody>
          ${['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'].map(type=>{
            const accs=_accounts.filter(a=>a.type===type&&(Number(a.totalDebit)||Number(a.totalCredit)));
            if(!accs.length) return '';
            const typeInfo=ACCOUNT_TYPES[type];
            return `
              <tr style="background:rgba(10,132,255,0.06);">
                <td colspan="5" style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
                  ${typeInfo.label}s
                </td>
              </tr>
              ${accs.map(acc=>{
                const bal=Number(acc.currentBalance)||0;
                const isDrBal=typeInfo.normalBal==='debit';
                return `<tr>
                  <td style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);padding:10px 16px;">${escHtml(acc.code)}</td>
                  <td style="font-size:13px;padding:10px 16px;">${escHtml(acc.name)}</td>
                  <td style="padding:10px 16px;"><span class="badge badge-gray" style="font-size:10px;">${escHtml(acc.subType||type)}</span></td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-primary);padding:10px 16px;">${isDrBal&&bal>0?'₹'+bal.toLocaleString('en-IN',{minimumFractionDigits:2}):isDrBal&&bal<0?`(₹${Math.abs(bal).toLocaleString('en-IN')})`:''}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);padding:10px 16px;">${!isDrBal&&bal>0?'₹'+bal.toLocaleString('en-IN',{minimumFractionDigits:2}):!isDrBal&&bal<0?`(₹${Math.abs(bal).toLocaleString('en-IN')})`:''}</td>
                </tr>`;
              }).join('')}`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr style="background:var(--bg-elevated);border-top:3px double var(--border-strong);">
            <td colspan="3" style="font-weight:800;font-size:14px;padding:14px 16px;font-family:var(--font-display);">GRAND TOTAL</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:800;font-size:14px;color:var(--brand-primary);padding:14px 16px;">₹${totalDr.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:800;font-size:14px;color:var(--brand-secondary);padding:14px 16px;">₹${totalCr.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  window.exportTrialBalance=()=>{
    const csv=[['Code','Account','Type','Debit Balance','Credit Balance'],
      ..._accounts.map(a=>{
        const bal=Number(a.currentBalance)||0; const isDr=ACCOUNT_TYPES[a.type]?.normalBal==='debit';
        return [a.code,a.name,a.type,isDr&&bal>0?bal:0,!isDr&&bal>0?bal:0];
      })
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const el=document.createElement('a'); el.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); el.download='trial_balance.csv'; el.click();
  };
  window.printTrialBalance=()=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'Trial Balance' }); else window.print(); };
}

// ══════════════════════════════════════════════════════════════
// P&L STATEMENT (Income Statement)
// ══════════════════════════════════════════════════════════════
function renderPnLStatement(container){
  const revenue   =_accounts.filter(a=>a.type==='REVENUE');
  const expenses  =_accounts.filter(a=>a.type==='EXPENSE');
  const totalRev  =revenue.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const cogs      =expenses.filter(a=>a.subType==='Cost of Sales').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const grossProfit=totalRev-cogs;
  const opex      =expenses.filter(a=>a.subType==='Operating Expense').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const nonOpEx   =expenses.filter(a=>a.subType==='Non-operating Expense').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const nonOpRev  =revenue.filter(a=>a.subType==='Non-operating Revenue').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const ebitda    =grossProfit-opex;
  const netProfit =totalRev-expenses.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const grossMargin=totalRev?Math.round((grossProfit/totalRev)*100):0;
  const netMargin  =totalRev?Math.round((netProfit/totalRev)*100):0;

  const pnlRow=(label,value,indent=0,isBold=false,isTotal=false,color='')=>`
    <tr style="${isTotal?'background:var(--bg-elevated);border-top:2px solid var(--border-strong);':'border-bottom:1px solid var(--border-subtle);'}">
      <td style="padding:${isTotal?'12':'9'}px 16px ${isTotal?'12':'9'}px ${16+indent*24}px;font-size:${isTotal?'14':'13'}px;font-weight:${isBold||isTotal?700:400};">${label}</td>
      <td style="text-align:right;padding:${isTotal?'12':'9'}px 16px;font-family:var(--font-mono);font-size:${isTotal?'15':'13'}px;font-weight:${isBold||isTotal?800:500};color:${color||(value>=0?'var(--text-primary)':'var(--brand-danger)')};white-space:nowrap;">
        ${value!==null?`₹${Math.abs(value).toLocaleString('en-IN')}${value<0?' (Loss)':''}`:' '}
      </td>
    </tr>`;

  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Profit & Loss Statement</h3>
        <p style="font-size:12px;color:var(--text-secondary);">For the period ending ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary btn-sm" onclick="exportPnL()">⬇ Export</button>
        <button class="btn btn-secondary btn-sm" onclick="printPnL()">🖨️ Print</button>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {l:'Total Revenue', v:formatCurrency(totalRev,true),   c:'var(--brand-secondary)'},
        {l:'Gross Profit',  v:formatCurrency(grossProfit,true), c:grossProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'},
        {l:'Gross Margin',  v:grossMargin+'%',                  c:grossMargin>=30?'var(--brand-secondary)':grossMargin>=15?'var(--brand-warning)':'var(--brand-danger)'},
        {l:'Net Profit',    v:formatCurrency(netProfit,true),   c:netProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'},
      ].map(k=>`
        <div class="card" style="text-align:center;">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${k.l}</div>
          <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:${k.c};">${k.v}</div>
        </div>`).join('')}
    </div>

    <div class="table-container">
      <table class="table">
        <thead><tr><th>Description</th><th style="text-align:right;">Amount (₹)</th></tr></thead>
        <tbody>
          <!-- Revenue Section -->
          <tr style="background:rgba(0,200,150,0.08);"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;text-transform:uppercase;color:var(--brand-secondary);letter-spacing:0.5px;">I. Revenue from Operations</td></tr>
          ${revenue.filter(a=>a.subType==='Operating Revenue').map(a=>pnlRow(a.name,Number(a.currentBalance)||0,1)).join('')}
          ${pnlRow('Total Operating Revenue',totalRev-nonOpRev,0,true,false,'var(--brand-secondary)')}

          <tr style="background:rgba(0,200,150,0.04);"><td colspan="2" style="padding:8px 16px;font-weight:600;font-size:12px;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Other Income</td></tr>
          ${revenue.filter(a=>a.subType==='Non-operating Revenue').map(a=>pnlRow(a.name,Number(a.currentBalance)||0,1)).join('')}
          ${pnlRow('TOTAL REVENUE',totalRev,0,true,true,'var(--brand-secondary)')}

          <!-- Cost of Sales -->
          <tr style="background:rgba(255,59,48,0.06);"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;text-transform:uppercase;color:var(--brand-danger);letter-spacing:0.5px;">II. Cost of Goods Sold</td></tr>
          ${expenses.filter(a=>a.subType==='Cost of Sales').map(a=>pnlRow(a.name,Number(a.currentBalance)||0,1)).join('')}
          ${pnlRow('GROSS PROFIT',grossProfit,0,true,true,grossProfit>=0?'var(--brand-secondary)':'var(--brand-danger)')}
          ${pnlRow('Gross Margin %',null,0,false,false)}

          <!-- Operating Expenses -->
          <tr style="background:rgba(255,59,48,0.04);"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;text-transform:uppercase;color:var(--brand-warning);letter-spacing:0.5px;">III. Operating Expenses</td></tr>
          ${expenses.filter(a=>a.subType==='Operating Expense').map(a=>pnlRow(a.name,Number(a.currentBalance)||0,1)).join('')}
          ${pnlRow('EBITDA',ebitda,0,true,true,ebitda>=0?'var(--brand-secondary)':'var(--brand-danger)')}

          <!-- Non-operating -->
          ${nonOpEx?`
            <tr style="background:rgba(255,59,48,0.04);"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">IV. Non-Operating Expenses</td></tr>
            ${expenses.filter(a=>a.subType==='Non-operating Expense').map(a=>pnlRow(a.name,Number(a.currentBalance)||0,1)).join('')}`:''}

          <!-- Net Profit -->
          ${pnlRow('NET PROFIT / (LOSS)',netProfit,0,true,true,netProfit>=0?'var(--brand-secondary)':'var(--brand-danger)')}
          ${pnlRow('Net Profit Margin %',null,0,false,false)}
        </tbody>
      </table>
    </div>
  `;
  window.exportPnL=()=>Toast.info('Export','P&L exported.');
  window.printPnL=()=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'Profit & Loss Statement' }); else window.print(); };
}

// ══════════════════════════════════════════════════════════════
// BALANCE SHEET
// ══════════════════════════════════════════════════════════════
function renderBalanceSheet(container){
  const assets     =_accounts.filter(a=>a.type==='ASSET');
  const liabilities=_accounts.filter(a=>a.type==='LIABILITY');
  const equity     =_accounts.filter(a=>a.type==='EQUITY');
  const revenue    =_accounts.filter(a=>a.type==='REVENUE');
  const expenses   =_accounts.filter(a=>a.type==='EXPENSE');

  const totalAssets=assets.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const totalLiab  =liabilities.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const totalEquity=equity.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const netProfit  =revenue.reduce((s,a)=>s+(Number(a.currentBalance)||0),0)-expenses.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const totalLiabEquity=totalLiab+totalEquity+netProfit;
  const isBalanced=Math.abs(totalAssets-totalLiabEquity)<1;

  const bsSection=(title,accounts,total,color)=>`
    <div style="margin-bottom:var(--space-4);">
      <div style="padding:10px 16px;background:rgba(10,132,255,0.06);border-left:4px solid ${color};margin-bottom:2px;">
        <div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${color};">${title}</div>
      </div>
      ${accounts.map(a=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:1px solid var(--border-subtle);">
          <div style="font-size:13px;">${escHtml(a.name)} <span style="font-size:10px;color:var(--text-muted);">(${a.code})</span></div>
          <div style="font-family:var(--font-mono);font-size:13px;">₹${Math.abs(Number(a.currentBalance)||0).toLocaleString('en-IN')}</div>
        </div>`).join('')}
      <div style="display:flex;justify-content:space-between;padding:12px 16px;background:var(--bg-elevated);border-top:2px solid ${color};">
        <div style="font-weight:700;font-size:13px;">Total</div>
        <div style="font-family:var(--font-mono);font-weight:800;font-size:14px;color:${color};">₹${Math.abs(total).toLocaleString('en-IN')}</div>
      </div>
    </div>`;

  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Balance Sheet</h3>
        <p style="font-size:12px;color:var(--text-secondary);">As at ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p>
      </div>
      <div style="display:flex;gap:8px;">
        ${isBalanced?`<span class="badge badge-green badge-dot" style="padding:6px 14px;">✅ Balanced</span>`:
          `<span class="badge badge-red badge-dot" style="padding:6px 14px;">❌ Difference: ₹${Math.abs(totalAssets-totalLiabEquity).toFixed(2)}</span>`}
        <button class="btn btn-secondary btn-sm" onclick="printBalanceSheet()">🖨️ Print</button>
      </div>
    </div>

    <div class="grid-2" style="gap:var(--space-5);align-items:start;">
      <!-- Assets Side -->
      <div>
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--brand-primary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-primary);">ASSETS</div>
        ${bsSection('Fixed Assets',assets.filter(a=>a.subType==='Fixed Asset'),assets.filter(a=>a.subType==='Fixed Asset').reduce((s,a)=>s+(Number(a.currentBalance)||0),0),'var(--brand-primary)')}
        ${bsSection('Current Assets',assets.filter(a=>a.subType==='Current Asset'),assets.filter(a=>a.subType==='Current Asset').reduce((s,a)=>s+(Number(a.currentBalance)||0),0),'var(--brand-primary)')}
        ${bsSection('Other Assets',assets.filter(a=>a.subType==='Other Asset'),assets.filter(a=>a.subType==='Other Asset').reduce((s,a)=>s+(Number(a.currentBalance)||0),0),'var(--brand-primary)')}
        <div style="display:flex;justify-content:space-between;padding:14px 16px;background:var(--brand-primary);border-radius:var(--radius-md);margin-top:var(--space-3);">
          <div style="font-weight:800;font-size:15px;color:#fff;">TOTAL ASSETS</div>
          <div style="font-family:var(--font-display);font-weight:800;font-size:18px;color:#fff;">₹${totalAssets.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <!-- Liabilities + Equity Side -->
      <div>
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--brand-secondary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-secondary);">LIABILITIES & EQUITY</div>
        ${bsSection('Equity & Reserves',equity,totalEquity,'var(--brand-secondary)')}
        <div style="padding:10px 16px;background:rgba(0,200,150,0.06);border-left:4px solid var(--brand-secondary);margin-bottom:2px;">
          <div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--brand-secondary);">Current Year Profit / (Loss)</div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:1px solid var(--border-subtle);">
          <div style="font-size:13px;">Net Profit / (Loss)</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:${netProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'};">₹${Math.abs(netProfit).toLocaleString('en-IN')} ${netProfit<0?'(Loss)':''}</div>
        </div>
        ${bsSection('Long-term Liabilities',liabilities.filter(a=>a.subType==='Long-term Liability'),liabilities.filter(a=>a.subType==='Long-term Liability').reduce((s,a)=>s+(Number(a.currentBalance)||0),0),'var(--brand-warning)')}
        ${bsSection('Current Liabilities',liabilities.filter(a=>a.subType==='Current Liability'),liabilities.filter(a=>a.subType==='Current Liability').reduce((s,a)=>s+(Number(a.currentBalance)||0),0),'var(--brand-warning)')}
        <div style="display:flex;justify-content:space-between;padding:14px 16px;background:var(--brand-secondary);border-radius:var(--radius-md);margin-top:var(--space-3);">
          <div style="font-weight:800;font-size:15px;color:#fff;">TOTAL LIABILITIES + EQUITY</div>
          <div style="font-family:var(--font-display);font-weight:800;font-size:18px;color:#fff;">₹${totalLiabEquity.toLocaleString('en-IN')}</div>
        </div>
      </div>
    </div>
  `;
  window.printBalanceSheet=()=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'Balance Sheet' }); else window.print(); };
}

// ══════════════════════════════════════════════════════════════
// INIT DEFAULT COA
// ══════════════════════════════════════════════════════════════
window.initDefaultCOA=async()=>{
  if(_accounts.length&&!confirm(`COA already has ${_accounts.length} accounts. Add default accounts on top?`)) return;
  try{
    Toast.info('Setting up…','Creating default Chart of Accounts for Indian GAAP…');
    const existing=new Set(_accounts.map(a=>a.code));
    const toCreate=DEFAULT_COA.filter(a=>!existing.has(a.code));
    if(!toCreate.length){Toast.info('Already exists','All default accounts already present.');return;}
    const ops=toCreate.map(acc=>({
      collection:ACC_COLLECTIONS.ACCOUNTS,
      id:genId(),type:'set',
      data:{...acc,openingBalance:0,currentBalance:0,totalDebit:0,totalCredit:0,isActive:true,companyId:AuthState.company?.id||null},
    }));
    await dbBatch(ops);
    Toast.success('Done!',`${toCreate.length} accounts created. Your Chart of Accounts is ready.`);
    await window.refreshAccounting?.();
  }catch(e){Toast.error('Failed',e.message);}
};
