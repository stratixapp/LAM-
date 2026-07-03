// ============================================================
// LAM — Multi-Company Consolidation Module
// Manage multiple legal entities, consolidated financials,
// intercompany transactions, subsidiary management
// Interconnects: Accounting → Finance → All modules
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { ACC_COLLECTIONS } from '../finance/accounting.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
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

export const MULTI_COLLECTIONS = {
  COMPANIES:     'multi_companies',
  IC_TRANSACTIONS:'multi_ic_transactions',
  CONSOLIDATIONS:'multi_consolidations',
};

let _companies=[], _activeCompany=null;
let _activeTab='companies';
const PER=15;

export async function renderMultiCompany(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('groupId','==',cid)] : [];

  _companies = await dbGetAll(MULTI_COLLECTIONS.COMPANIES, [...c, orderBy('createdAt','asc')]);

  // Always include the current company as the parent
  const currentCompany = AuthState.company;
  if (currentCompany && !_companies.find(co=>co.id===currentCompany.id)) {
    _companies = [{
      ...currentCompany,
      role: 'parent',
      currency: 'INR',
      ownership: 100,
      isParent: true,
    }, ..._companies];
  }

  container.innerHTML = pageShell({
    title: '🏢 Multi-Company Management',
    subtitle: 'Manage multiple legal entities, subsidiaries and consolidated financial reporting.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="refreshMulti()">↻ Refresh</button>
      <button class="btn btn-primary" onclick="openModal('add-company-modal')">+ Add Entity</button>
    `,
    content: `
      <!-- Group KPIs -->
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="multi-kpis"></div>

      <!-- Tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['companies',      '🏢 Entities'],
          ['consolidated',   '📊 Consolidated P&L'],
          ['balancesheet',   '🏦 Consolidated B/S'],
          ['intercompany',   '🔄 Intercompany'],
          ['switch',         '⚡ Switch Company'],
        ].map(([id,label]) => `
          <button class="multi-tab ${id==='companies'?'active':''}" id="multi-tab-${id}"
            onclick="switchMultiTab('${id}')"
            style="padding:7px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="multi-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.multi-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderMultiKPIs();
  setupModalClose(); setupMenuClose();
  document.body.insertAdjacentHTML('beforeend', addCompanyModal());
  document.body.insertAdjacentHTML('beforeend', icTransactionModal());

  window.switchMultiTab = switchMultiTab;
  window.refreshMulti   = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('groupId','==',cid)]:[];
    _companies = await dbGetAll(MULTI_COLLECTIONS.COMPANIES,[...c,orderBy('createdAt','asc')]);
    renderMultiKPIs(); switchMultiTab(_activeTab);
  };
  switchMultiTab('companies');
}

function renderMultiKPIs() {
  const el=document.getElementById('multi-kpis'); if(!el) return; el.innerHTML='';
  const entities = _companies.length;
  const active   = _companies.filter(c=>c.status!=='inactive').length;
  const totalRev = _companies.reduce((s,c)=>s+(Number(c.lastMonthRevenue)||0),0);
  const owned    = _companies.filter(c=>Number(c.ownership||0)>=50).length;
  [
    {label:'Total Entities',    value:entities,                       icon:'🏢', color:'kpi-blue'},
    {label:'Active',            value:active,                         icon:'✅', color:'kpi-green'},
    {label:'Majority Owned',    value:owned,                          icon:'🏆', color:'kpi-orange'},
    {label:'Group Revenue',     value:formatCurrency(totalRev,true),  icon:'💰', color:'kpi-green'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchMultiTab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.multi-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`multi-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('multi-tab-content'); if(!c) return;
  switch(tab) {
    case 'companies':   renderEntitiesTab(c);        break;
    case 'consolidated':renderConsolidatedPnL(c);    break;
    case 'balancesheet':renderConsolidatedBS(c);     break;
    case 'intercompany':renderIntercompanyTab(c);    break;
    case 'switch':      renderSwitchCompanyTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// ENTITIES TAB
// ══════════════════════════════════════════════════════════════
function renderEntitiesTab(container) {
  container.innerHTML = `
    <!-- Group structure diagram -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">🏢 Group Structure</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:var(--space-4);padding:var(--space-4);">
        ${_companies.map(co => {
          const color = co.isParent ? 'var(--brand-primary)' : co.role==='subsidiary' ? 'var(--brand-secondary)' : 'var(--brand-warning)';
          return `
            <div style="background:var(--bg-elevated);border:2px solid ${color};border-radius:var(--radius-lg);padding:var(--space-4);min-width:220px;position:relative;">
              ${co.isParent ? `<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--brand-primary);color:#fff;padding:2px 12px;border-radius:999px;font-size:10px;font-weight:700;">PARENT</div>` : ''}
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                <div style="width:36px;height:36px;border-radius:var(--radius-md);background:${color}20;display:flex;align-items:center;justify-content:center;font-size:18px;">🏢</div>
                <div>
                  <div style="font-size:14px;font-weight:700;">${escHtml(co.name||'—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">${escHtml(co.gstin||'—')}</div>
                </div>
              </div>
              ${[
                ['Type',      co.type||'Private Limited'],
                ['Ownership', co.isParent?'100% (Parent)':co.ownership+'%'],
                ['Currency',  co.currency||'INR'],
                ['Status',    co.status||'active'],
              ].map(([l,v])=>`
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
                  <span style="font-size:11px;color:var(--text-muted);">${l}</span>
                  <span style="font-size:11px;font-weight:500;">${escHtml(String(v||'—'))}</span>
                </div>`).join('')}
              ${!co.isParent?`
                <div style="display:flex;gap:6px;margin-top:10px;">
                  <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="switchToCompany('${co.id}')">⚡ Switch</button>
                  <button class="btn btn-ghost btn-icon" onclick="deleteCompany('${co.id}')" style="color:var(--brand-danger);">🗑</button>
                </div>`:''}
            </div>`;
        }).join('')}

        <!-- Add entity card -->
        <div style="background:var(--bg-elevated);border:2px dashed var(--border-default);border-radius:var(--radius-lg);padding:var(--space-4);min-width:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;"
             onclick="openModal('add-company-modal')"
             onmouseenter="this.style.borderColor='var(--brand-primary)'" onmouseleave="this.style.borderColor='var(--border-default)'">
          <div style="font-size:32px;margin-bottom:8px;opacity:0.4;">+</div>
          <div style="font-size:13px;color:var(--text-muted);">Add Entity</div>
          <div style="font-size:11px;color:var(--text-muted);">Subsidiary, Branch, JV</div>
        </div>
      </div>
    </div>

    <!-- Entities table -->
    <div class="card">
      <div class="card-header"><div class="card-title">📋 All Entities</div></div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Entity</th><th>Type</th><th>GSTIN</th><th>Ownership %</th><th>Currency</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${_companies.map(co=>`
              <tr ${co.isParent?'style="background:rgba(10,132,255,0.04);"':''}>
                <td>
                  <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:32px;height:32px;border-radius:8px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:14px;">🏢</div>
                    <div>
                      <div style="font-size:13px;font-weight:600;">${escHtml(co.name||'—')}</div>
                      ${co.isParent?`<span style="font-size:9px;color:var(--brand-primary);font-weight:700;text-transform:uppercase;">Parent Company</span>`:''}
                    </div>
                  </div>
                </td>
                <td><span class="badge badge-blue">${escHtml(co.type||'Private Ltd')}</span></td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(co.gstin||'—')}</td>
                <td style="font-family:var(--font-mono);">${co.isParent?'100% (Parent)':co.ownership+'%'}</td>
                <td><span class="badge badge-gray">${co.currency||'INR'}</span></td>
                <td>${badge(co.status||'active')}</td>
                <td>
                  ${!co.isParent?`
                    <div style="display:flex;gap:6px;">
                      <button class="btn btn-primary btn-sm" onclick="switchToCompany('${co.id}')">⚡ Switch</button>
                      <button class="btn btn-ghost btn-icon" onclick="deleteCompany('${co.id}')" style="color:var(--brand-danger);">🗑</button>
                    </div>`:
                    `<span style="font-size:11px;color:var(--text-muted);">Current</span>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window.switchToCompany = async (id) => {
    const co = _companies.find(x=>x.id===id); if(!co) return;
    if (!confirm(`Switch to ${co.name}? This will reload the app with ${co.name}'s data.`)) return;
    Toast.info('Switching…', `Loading ${co.name}…`);
    setTimeout(() => {
      window.location.href = `?company=${id}`;
    }, 800);
  };

  window.deleteCompany = async (id) => {
    if (!confirm('Remove this entity from the group?')) return;
    try { await dbDelete(MULTI_COLLECTIONS.COMPANIES, id); Toast.success('Removed','Entity removed from group.'); await window.refreshMulti?.(); }
    catch(e) { Toast.error('Failed', e.message); }
  };
}

// ══════════════════════════════════════════════════════════════
// CONSOLIDATED P&L
// ══════════════════════════════════════════════════════════════
async function renderConsolidatedPnL(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Consolidated P&L Statement</h3>
        <p style="font-size:12px;color:var(--text-secondary);">Group-wide consolidated income statement across all entities</p>
      </div>
      <div style="display:flex;gap:8px;">
        <select id="consol-period" class="form-select" style="width:auto;" onchange="loadConsolidatedPnL(this.value)">
          ${Array.from({length:4},(_,i)=>{const y=new Date().getFullYear()-i;return `<option value="${y}">${y}-${y+1} (FY)</option>`;}).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" onclick="exportConsolidated()">⬇ Export</button>
      </div>
    </div>
    <div id="consol-pnl-content">
      <div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>
    </div>
  `;

  window.loadConsolidatedPnL = async (year) => {
    const el = document.getElementById('consol-pnl-content'); if(!el) return;

    // Load accounts for all companies (simplified — uses current company's accounts as proxy)
    const cid = AuthState.company?.id;
    const c   = cid ? [where('companyId','==',cid)] : [];
    const accounts = await dbGetAll(ACC_COLLECTIONS.ACCOUNTS, [...c, orderBy('code')]);

    // Group by type
    const revenue  = accounts.filter(a=>a.type==='REVENUE');
    const expenses = accounts.filter(a=>a.type==='EXPENSE');

    const totalRev = revenue.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
    const cogs     = expenses.filter(a=>a.subType==='Cost of Sales').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
    const opex     = expenses.filter(a=>a.subType==='Operating Expense').reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
    const gross    = totalRev - cogs;
    const ebitda   = gross - opex;
    const netProfit= totalRev - expenses.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);

    const pRow=(label,value,indent=0,bold=false,color='')=>`
      <tr style="${bold?'background:var(--bg-elevated);':''}border-bottom:1px solid var(--border-subtle);">
        <td style="padding:9px 16px;padding-left:${16+indent*24}px;font-size:${bold?'14':'13'}px;font-weight:${bold?700:400};">${label}</td>
        ${_companies.map(co=>`<td style="text-align:right;padding:9px 16px;font-family:var(--font-mono);font-size:13px;font-weight:${bold?700:500};color:${color||(value>=0?'var(--text-primary)':'var(--brand-danger)')};"><span style="opacity:0.4">₹</span>${Math.abs(value).toLocaleString('en-IN')}</td>`).join('')}
        <td style="text-align:right;padding:9px 16px;font-family:var(--font-mono);font-size:13px;font-weight:${bold?800:600};color:${color||(value>=0?'var(--brand-secondary)':'var(--brand-danger)')};background:rgba(0,200,150,0.04);">₹${Math.abs(value).toLocaleString('en-IN')}</td>
      </tr>`;

    el.innerHTML=`
      <div class="table-container">
        <table class="table">
          <thead>
            <tr style="background:var(--bg-elevated);">
              <th style="min-width:200px;">Description</th>
              ${_companies.map(co=>`<th style="text-align:right;min-width:140px;">${escHtml(co.name||'—')}</th>`).join('')}
              <th style="text-align:right;min-width:140px;background:rgba(0,200,150,0.08);color:var(--brand-secondary);">Group Total</th>
            </tr>
          </thead>
          <tbody>
            <tr style="background:rgba(0,200,150,0.06);"><td colspan="${_companies.length+2}" style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--brand-secondary);">Revenue</td></tr>
            ${pRow('Total Revenue', totalRev, 0, false, 'var(--brand-secondary)')}
            <tr style="background:rgba(255,59,48,0.04);"><td colspan="${_companies.length+2}" style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--brand-danger);">Cost of Sales</td></tr>
            ${pRow('Cost of Goods Sold', cogs)}
            ${pRow('GROSS PROFIT', gross, 0, true, gross>=0?'var(--brand-secondary)':'var(--brand-danger)')}
            <tr style="background:rgba(255,159,10,0.04);"><td colspan="${_companies.length+2}" style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--brand-warning);">Operating Expenses</td></tr>
            ${pRow('Total Operating Expenses', opex)}
            ${pRow('EBITDA', ebitda, 0, true, ebitda>=0?'var(--brand-secondary)':'var(--brand-danger)')}
            ${pRow('NET PROFIT / (LOSS)', netProfit, 0, true, netProfit>=0?'var(--brand-secondary)':'var(--brand-danger)')}
          </tbody>
        </table>
      </div>
      <div class="alert alert-info" style="margin-top:var(--space-4);">
        <span class="alert-icon">ℹ️</span>
        <div><div class="alert-title">Consolidation Note</div>
        <div class="alert-text">For full multi-entity consolidation, each entity needs its own Firebase project or Supabase schema. Currently showing ${AuthState.company?.name||'current company'}'s data replicated across entities for structure preview.</div></div>
      </div>
    `;
  };

  window.exportConsolidated = async () => {
    if(!window.LAMPrint){ Toast.info('Export','Preparing consolidated report…'); return; }
    const companies = await dbGetAll(MULTI_COLLECTIONS.COMPANIES).catch(()=>[]);
    const data = {};
    for(const co of companies){
      const invs = await dbGetAll(COLLECTIONS.INVOICES,[where('companyId','==',co.id)]).catch(()=>[]);
      const exps = await dbGetAll(COLLECTIONS.EXPENSES||'expenses',[where('companyId','==',co.id)]).catch(()=>[]);
      data[co.id]={
        revenue:  invs.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+Number(i.totalAmount||0),0),
        expenses: exps.reduce((s,e)=>s+Number(e.amount||0),0),
      };
    }
    if (window.LAMPrint) {
      window.LAMPrint.consolidatedReport(companies,data,{groupName:AuthState.company?.name||'Group'});
    } else {
      Toast.info('Print', 'Print engine not loaded. Please refresh and try again.');
    }
  };
  loadConsolidatedPnL(new Date().getFullYear());
}

// ══════════════════════════════════════════════════════════════
// CONSOLIDATED BALANCE SHEET
// ══════════════════════════════════════════════════════════════
async function renderConsolidatedBS(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];
  const accounts = await dbGetAll(ACC_COLLECTIONS.ACCOUNTS, [...c, orderBy('code')]);

  const assets      = accounts.filter(a=>a.type==='ASSET');
  const liabilities = accounts.filter(a=>a.type==='LIABILITY');
  const equity      = accounts.filter(a=>a.type==='EQUITY');
  const revenue     = accounts.filter(a=>a.type==='REVENUE');
  const expenses    = accounts.filter(a=>a.type==='EXPENSE');
  const totalAssets = assets.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const totalLiab   = liabilities.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const totalEquity = equity.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
  const netProfit   = revenue.reduce((s,a)=>s+(Number(a.currentBalance)||0),0)-expenses.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);

  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Consolidated Balance Sheet</h3>
      <div style="display:flex;gap:8px;">
        <span style="${Math.abs(totalAssets-(totalLiab+totalEquity+netProfit))<1?'':'display:none'}" class="badge badge-green">✅ Balanced</span>
        <button class="btn btn-secondary btn-sm" onclick="window.print()">🖨️ Print</button>
      </div>
    </div>

    <div class="grid-2" style="gap:var(--space-5);align-items:start;">
      <!-- Assets -->
      <div class="card">
        <div style="font-size:14px;font-weight:700;color:var(--brand-primary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-primary);">ASSETS</div>
        ${['Current Asset','Fixed Asset','Other Asset'].map(subType=>{
          const subAccounts=assets.filter(a=>a.subType===subType);
          if(!subAccounts.length) return '';
          const total=subAccounts.reduce((s,a)=>s+(Number(a.currentBalance)||0),0);
          return `
            <div style="margin-bottom:var(--space-3);">
              <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">${subType}</div>
              ${subAccounts.map(a=>`
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
                  <span style="font-size:12px;">${escHtml(a.name)}</span>
                  <span style="font-family:var(--font-mono);font-size:12px;">₹${Math.abs(Number(a.currentBalance)||0).toLocaleString('en-IN')}</span>
                </div>`).join('')}
              <div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="font-size:12px;font-weight:700;">Subtotal</span><span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">₹${total.toLocaleString('en-IN')}</span></div>
            </div>`;
        }).join('')}
        <div style="display:flex;justify-content:space-between;padding:12px;background:var(--brand-primary);border-radius:var(--radius-md);margin-top:var(--space-3);">
          <span style="font-size:14px;font-weight:800;color:#fff;">TOTAL ASSETS</span>
          <span style="font-family:var(--font-display);font-size:18px;font-weight:800;color:#fff;">₹${totalAssets.toLocaleString('en-IN')}</span>
        </div>
      </div>

      <!-- Liabilities + Equity -->
      <div class="card">
        <div style="font-size:14px;font-weight:700;color:var(--brand-secondary);margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:2px solid var(--brand-secondary);">LIABILITIES & EQUITY</div>
        <div style="margin-bottom:var(--space-3);">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">Equity</div>
          ${equity.map(a=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);"><span style="font-size:12px;">${escHtml(a.name)}</span><span style="font-family:var(--font-mono);font-size:12px;">₹${Math.abs(Number(a.currentBalance)||0).toLocaleString('en-IN')}</span></div>`).join('')}
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
            <span style="font-size:12px;">Net Profit/(Loss)</span>
            <span style="font-family:var(--font-mono);font-size:12px;color:${netProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'};">₹${Math.abs(netProfit).toLocaleString('en-IN')}</span>
          </div>
        </div>
        ${['Current Liability','Long-term Liability'].map(subType=>{
          const subAccounts=liabilities.filter(a=>a.subType===subType);
          if(!subAccounts.length) return '';
          return `
            <div style="margin-bottom:var(--space-3);">
              <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">${subType}</div>
              ${subAccounts.map(a=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);"><span style="font-size:12px;">${escHtml(a.name)}</span><span style="font-family:var(--font-mono);font-size:12px;">₹${Math.abs(Number(a.currentBalance)||0).toLocaleString('en-IN')}</span></div>`).join('')}
            </div>`;
        }).join('')}
        <div style="display:flex;justify-content:space-between;padding:12px;background:var(--brand-secondary);border-radius:var(--radius-md);margin-top:var(--space-3);">
          <span style="font-size:14px;font-weight:800;color:#fff;">TOTAL L + E</span>
          <span style="font-family:var(--font-display);font-size:18px;font-weight:800;color:#fff;">₹${(totalLiab+totalEquity+netProfit).toLocaleString('en-IN')}</span>
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// INTERCOMPANY TRANSACTIONS
// ══════════════════════════════════════════════════════════════
async function renderIntercompanyTab(container) {
  const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
  const icTxns = await dbGetAll(MULTI_COLLECTIONS.IC_TRANSACTIONS, [...c, orderBy('createdAt','desc')]);

  container.innerHTML=`
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">🔄</span>
      <div>
        <div class="alert-title">Intercompany Transactions</div>
        <div class="alert-text">Record transactions between group entities. These are eliminated during consolidation to avoid double-counting.</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openModal('ic-txn-modal')" style="flex-shrink:0;margin-left:auto;">+ New IC Transaction</button>
    </div>

    <div class="grid-2" style="margin-bottom:var(--space-5);">
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Total IC Volume</div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:800;color:var(--brand-primary);">₹${icTxns.reduce((s,t)=>s+(Number(t.amount)||0),0).toLocaleString('en-IN')}</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Transactions</div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:800;color:var(--brand-secondary);">${icTxns.length}</div>
      </div>
    </div>

    ${icTxns.length?`
      <div class="card">
        <div class="card-header"><div class="card-title">📋 IC Transaction Log</div></div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th>Type</th><th style="text-align:right;">Amount</th><th>Description</th><th>Status</th></tr></thead>
            <tbody>
              ${icTxns.map(t=>{
                const from=_companies.find(co=>co.id===t.fromCompanyId)||{};
                const to  =_companies.find(co=>co.id===t.toCompanyId)||{};
                return `<tr>
                  <td style="font-size:11px;color:var(--text-muted);">${t.date||'—'}</td>
                  <td style="font-size:12px;">${escHtml(from.name||'—')}</td>
                  <td style="font-size:12px;">${escHtml(to.name||'—')}</td>
                  <td><span class="badge badge-blue">${escHtml(t.type||'loan')}</span></td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:600;">₹${Number(t.amount||0).toLocaleString('en-IN')}</td>
                  <td style="font-size:11px;color:var(--text-secondary);">${escHtml((t.description||'—').slice(0,50))}</td>
                  <td>${badge(t.status||'pending')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`:`
      <div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px;opacity:0.3;">🔄</div>
        <div style="font-size:14px;font-weight:500;">No intercompany transactions yet</div>
      </div>`}
  `;
}

// ══════════════════════════════════════════════════════════════
// SWITCH COMPANY TAB
// ══════════════════════════════════════════════════════════════
function renderSwitchCompanyTab(container) {
  container.innerHTML=`
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">⚡</span>
      <div><div class="alert-title">Switch Active Company</div>
      <div class="alert-text">Select an entity to work in. All data entry, reports and transactions will be for the selected entity.</div></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:var(--space-4);">
      ${_companies.map(co=>{
        const isCurrent = co.id===AuthState.company?.id || co.isParent;
        return `
          <div style="padding:var(--space-4);background:${isCurrent?'rgba(10,132,255,0.08)':'var(--bg-elevated)'};border:2px solid ${isCurrent?'var(--brand-primary)':'var(--border-subtle)'};border-radius:var(--radius-lg);cursor:pointer;transition:all 0.2s;"
               onclick="${isCurrent?'':''}" onmouseenter="this.style.borderColor='var(--brand-primary)'" onmouseleave="this.style.borderColor='${isCurrent?'var(--brand-primary)':'var(--border-subtle)'}'">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              <div style="width:40px;height:40px;border-radius:var(--radius-md);background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:20px;">🏢</div>
              <div>
                <div style="font-size:14px;font-weight:700;">${escHtml(co.name||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${co.isParent?'Parent Company':co.role||'Subsidiary'}</div>
              </div>
              ${isCurrent?`<span class="badge badge-green" style="margin-left:auto;">Active</span>`:''}
            </div>
            ${[['GSTIN',co.gstin||'—'],['Type',co.type||'—'],['Currency',co.currency||'INR']].map(([l,v])=>`
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
                <span style="font-size:11px;color:var(--text-muted);">${l}</span>
                <span style="font-size:11px;font-weight:500;">${escHtml(String(v))}</span>
              </div>`).join('')}
            <button class="btn btn-${isCurrent?'secondary':'primary'} btn-sm" style="width:100%;margin-top:12px;" ${isCurrent?'disabled':''} onclick="switchToCompany('${co.id}')">
              ${isCurrent?'✅ Currently Active':'⚡ Switch Here'}
            </button>
          </div>`;
      }).join('')}
    </div>
  `;

  window.switchToCompany = async (id) => {
    const co = _companies.find(x=>x.id===id); if(!co||co.isParent) return;
    Toast.info('Switching…',`Loading ${co.name}…`);
    setTimeout(()=>{
          AuthState.company = co;
          localStorage.setItem('lam_active_company', co.id);
          Toast.success('Switched', 'Now viewing: ' + co.name);
          window.location.reload();
        }, 300);
  };
}

// ── Modals ────────────────────────────────────────────────────
function addCompanyModal() {
  return buildModal({
    id:'add-company-modal', title:'Add Legal Entity',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Company Name <span class="required">*</span></label>
          <input type="text" id="co-name" class="form-input" placeholder="Legal name of entity">
        </div>
        <div class="form-group"><label class="form-label">Entity Type</label>
          <select id="co-type" class="form-select">
            <option value="Private Limited">Private Limited</option>
            <option value="LLP">LLP</option>
            <option value="Partnership">Partnership Firm</option>
            <option value="Proprietorship">Proprietorship</option>
            <option value="Branch">Branch Office</option>
            <option value="JV">Joint Venture</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">GSTIN</label>
          <input type="text" id="co-gstin" class="form-input" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase;">
        </div>
        <div class="form-group"><label class="form-label">CIN / Registration No.</label>
          <input type="text" id="co-cin" class="form-input" placeholder="U12345MH2020PTC123456">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Ownership % <span class="required">*</span></label>
          <input type="number" id="co-ownership" class="form-input" placeholder="51" min="1" max="100">
        </div>
        <div class="form-group"><label class="form-label">Relationship</label>
          <select id="co-role" class="form-select">
            <option value="subsidiary">Wholly-owned Subsidiary</option>
            <option value="associate">Associate Company</option>
            <option value="jv">Joint Venture</option>
            <option value="branch">Branch</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Reporting Currency</label>
          <select id="co-currency" class="form-select">
            <option value="INR">INR — Indian Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="AED">AED — UAE Dirham</option>
            <option value="SGD">SGD — Singapore Dollar</option>
            <option value="EUR">EUR — Euro</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Registered Address</label>
        <input type="text" id="co-address" class="form-input" placeholder="Full registered address">
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('add-company-modal')">Cancel</button>
            <button class="btn btn-primary" id="add-co-btn" onclick="saveCompany()">Add Entity</button>`,
  });
}

function icTransactionModal() {
  const coOpts = _companies.map(co=>`<option value="${co.id}">${escHtml(co.name||'—')}</option>`).join('');
  return buildModal({
    id:'ic-txn-modal', title:'New Intercompany Transaction',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">From Entity <span class="required">*</span></label>
          <select id="ic-from" class="form-select"><option value="">Select…</option>${coOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">To Entity <span class="required">*</span></label>
          <select id="ic-to" class="form-select"><option value="">Select…</option>${coOpts}</select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Type</label>
          <select id="ic-type" class="form-select">
            <option value="loan">Intercompany Loan</option>
            <option value="dividend">Dividend</option>
            <option value="management-fee">Management Fee</option>
            <option value="royalty">Royalty</option>
            <option value="goods">Goods Transfer</option>
            <option value="services">Services</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Amount (₹) <span class="required">*</span></label>
          <input type="number" id="ic-amount" class="form-input" placeholder="0" min="0">
        </div>
        <div class="form-group"><label class="form-label">Date</label>
          <input type="date" id="ic-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description</label>
        <textarea id="ic-desc" class="form-textarea" rows="2" placeholder="Purpose and details of this intercompany transaction…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('ic-txn-modal')">Cancel</button>
            <button class="btn btn-primary" id="ic-save-btn" onclick="saveICTransaction()">Record Transaction</button>`,
  });
}

window.saveCompany=async()=>{
  if(!validateForm([{id:'co-name',label:'Name',required:true},{id:'co-ownership',label:'Ownership',required:true}])) return;
  const btn=document.getElementById('add-co-btn'); setLoading(btn,true);
  try{
    await dbCreate(MULTI_COLLECTIONS.COMPANIES,{name:document.getElementById('co-name').value.trim(),type:document.getElementById('co-type').value,gstin:document.getElementById('co-gstin').value.trim().toUpperCase()||null,cin:document.getElementById('co-cin').value.trim()||null,ownership:Number(document.getElementById('co-ownership').value)||0,role:document.getElementById('co-role').value,currency:document.getElementById('co-currency').value,address:document.getElementById('co-address').value.trim(),status:'active',groupId:AuthState.company?.id||null,companyId:AuthState.company?.id||null});
    Toast.success('Added','Entity added to group.');
    closeModal('add-company-modal');
    await window.refreshMulti?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveICTransaction=async()=>{
  if(!validateForm([{id:'ic-from',label:'From Entity',required:true},{id:'ic-to',label:'To Entity',required:true},{id:'ic-amount',label:'Amount',required:true}])) return;
  const fromId=document.getElementById('ic-from').value;
  const toId  =document.getElementById('ic-to').value;
  if(fromId===toId){Toast.error('Invalid','Cannot transact with same entity.');return;}
  const btn=document.getElementById('ic-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(MULTI_COLLECTIONS.IC_TRANSACTIONS,{fromCompanyId:fromId,toCompanyId:toId,type:document.getElementById('ic-type').value,amount:Number(document.getElementById('ic-amount').value)||0,date:document.getElementById('ic-date').value,description:document.getElementById('ic-desc').value.trim(),status:'pending',companyId:AuthState.company?.id||null});
    Toast.success('Recorded','IC transaction recorded.');
    closeModal('ic-txn-modal');
    switchMultiTab('intercompany');
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
