// ============================================================
// LAM — Finance Advanced Module (Tools 43, 46, 50)
// Credit Limit Management, Multi-Currency, Budget Planning
// Interconnects: Customers → Orders → Invoices → Payments
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from './invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose, avatarCell } from '../_shared.js';

export const FIN_ADV_COLLECTIONS = { BUDGETS: 'fin_budgets', CURRENCY_RATES: 'fin_currency_rates' };

let _customers=[], _invoices=[], _payments=[], _orders=[];
let _activeTab='credit';
let _unsubs = [];
function _cleanupListeners(){ _unsubs.forEach(fn=>fn&&fn()); _unsubs=[]; }
const PER=15;

export async function renderFinanceAdvanced(container){
  _cleanupListeners();
  [_customers, _invoices, _payments, _orders] = await Promise.all([
    dbGetAll(COLLECTIONS.CUSTOMERS,   AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
    dbGetAll(FIN_COLLECTIONS.INVOICES, AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
    dbGetAll(FIN_COLLECTIONS.PAYMENTS, AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
    dbGetAll('sales_orders',          AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
  ]);

  container.innerHTML=pageShell({
    title:'💳 Finance Advanced',
    subtitle:'Credit limits, multi-currency support and budget planning.',
    actions:`<button class="btn btn-secondary btn-sm" onclick="refreshFinAdv()">↻ Refresh</button>`,
    content:`
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);width:fit-content;">
        ${[['credit','💳 Credit Limits'],['currency','🌍 Multi-Currency'],['budget','📊 Budget Planning']].map(([id,label])=>`
          <button class="finadv-tab ${id==='credit'?'active':''}" id="finadv-tab-${id}"
            onclick="switchFinAdvTab('${id}')"
            style="padding:8px 16px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="finadv-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.finadv-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);
  setupModalClose(); setupMenuClose();
  window.switchFinAdvTab=switchFinAdvTab;
  window.refreshFinAdv=async()=>{
    _customers=await dbGetAll(COLLECTIONS.CUSTOMERS,AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    _invoices =await dbGetAll(FIN_COLLECTIONS.INVOICES,AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    _payments =await dbGetAll(FIN_COLLECTIONS.PAYMENTS,AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    switchFinAdvTab(_activeTab);
  };
  switchFinAdvTab('credit');
}

function switchFinAdvTab(tab){
  _activeTab=tab;
  document.querySelectorAll('.finadv-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`finadv-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('finadv-tab-content'); if(!c) return;
  switch(tab){
    case 'credit':   renderCreditTab(c);   break;
    case 'currency': renderCurrencyTab(c); break;
    case 'budget':   renderBudgetTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 43: CREDIT LIMIT MANAGEMENT
// ══════════════════════════════════════════════════════════════
function renderCreditTab(container){
  // Compute credit utilization per customer
  const creditData=_customers.filter(c=>Number(c.creditLimit)>0).map(c=>{
    const outstanding=_invoices.filter(i=>i.customerId===c.id&&i.paymentStatus!=='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
    const limit=Number(c.creditLimit)||0;
    const utilization=limit?Math.round((outstanding/limit)*100):0;
    const overLimit=outstanding>limit;
    return {...c,outstanding,utilization,overLimit,available:Math.max(0,limit-outstanding)};
  });

  const overLimitCount=creditData.filter(c=>c.overLimit).length;
  const highUtilCount =creditData.filter(c=>c.utilization>=80&&!c.overLimit).length;
  const totalExposure =creditData.reduce((s,c)=>s+c.outstanding,0);

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Customers with Credit', value:creditData.length,           icon:'👥', color:'kpi-blue'},
        {label:'Over Limit',            value:overLimitCount,              icon:'🚨', color:overLimitCount>0?'kpi-red':'kpi-green'},
        {label:'High Utilization (≥80%)',value:highUtilCount,              icon:'⚠️', color:highUtilCount>0?'kpi-yellow':'kpi-green'},
        {label:'Total Exposure',        value:formatCurrency(totalExposure,true),icon:'💰',color:'kpi-orange'},
      ].map((k,i)=>`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <!-- Credit utilization table -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header">
        <div class="card-title">📊 Credit Utilization by Customer</div>
        <button class="btn btn-secondary btn-sm" onclick="openModal('credit-limit-modal')">⚙️ Edit Limits</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Customer</th><th>Credit Limit</th><th>Outstanding</th><th>Available</th><th>Utilization</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${creditData.length?creditData.sort((a,b)=>b.utilization-a.utilization).map(c=>`
              <tr>
                <td>${avatarCell(c.name,c.email,'var(--brand-secondary)','rgba(0,200,150,0.12)')}</td>
                <td style="font-family:var(--font-mono);">₹${Number(c.creditLimit).toLocaleString('en-IN')}</td>
                <td style="font-family:var(--font-mono);color:${c.overLimit?'var(--brand-danger)':'var(--text-primary)'};">₹${c.outstanding.toLocaleString('en-IN')}</td>
                <td style="font-family:var(--font-mono);color:${c.available===0?'var(--brand-danger)':'var(--brand-secondary)'};">₹${c.available.toLocaleString('en-IN')}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <div style="background:var(--bg-overlay);border-radius:4px;height:8px;width:100px;overflow:hidden;">
                      <div style="height:100%;width:${Math.min(c.utilization,100)}%;background:${c.overLimit?'var(--brand-danger)':c.utilization>=80?'var(--brand-warning)':'var(--brand-secondary)'};border-radius:4px;"></div>
                    </div>
                    <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:${c.overLimit?'var(--brand-danger)':c.utilization>=80?'var(--brand-warning)':'var(--text-secondary)'};">${c.utilization}%</span>
                  </div>
                </td>
                <td>${c.overLimit?`<span class="badge badge-red badge-dot">Over Limit</span>`:c.utilization>=80?`<span class="badge badge-yellow badge-dot">High</span>`:`<span class="badge badge-green badge-dot">OK</span>`}</td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-secondary btn-sm" onclick="editCreditLimit('${c.id}',${c.creditLimit})">Edit</button>
                    ${c.overLimit?`<button class="btn btn-danger btn-sm" onclick="holdCustomer('${c.id}')">Hold</button>`:''}
                  </div>
                </td>
              </tr>`).join(''):`<tr><td colspan="7"><div class="table-empty"><div class="empty-icon">💳</div><div class="empty-title">No customers with credit limits</div><div class="empty-text">Set credit limits on customers to track here.</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Customers with no credit limit -->
    <div class="card">
      <div class="card-header"><div class="card-title">👥 Customers Without Credit Limit</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${_customers.filter(c=>!Number(c.creditLimit)).map(c=>`
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
            <div style="width:28px;height:28px;border-radius:6px;background:rgba(0,200,150,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-secondary);">${(c.name||'?').slice(0,2).toUpperCase()}</div>
            <span style="font-size:12px;">${escHtml(c.name||'—')}</span>
            <button class="btn btn-primary btn-sm" style="font-size:10px;padding:3px 8px;" onclick="editCreditLimit('${c.id}',0)">Set Limit</button>
          </div>`).join('')||`<div style="color:var(--text-muted);font-size:12px;padding:8px;">All customers have credit limits set</div>`}
      </div>
    </div>
  `;

  // Credit limit edit modal
  document.getElementById('credit-limit-modal')?.remove();
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')} (current: ₹${Number(c.creditLimit||0).toLocaleString('en-IN')})</option>`).join('');
  document.body.insertAdjacentHTML('beforeend',buildModal({
    id:'credit-limit-modal',title:'Edit Credit Limits',
    body:`
      <div class="form-group"><label class="form-label">Select Customer</label>
        <select id="cl-customer" class="form-select" onchange="prefillCreditLimit(this.value)"><option value="">Select…</option>${custOpts}</select>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">New Credit Limit (₹)</label><input type="number" id="cl-limit" class="form-input" placeholder="100000" min="0"></div>
        <div class="form-group"><label class="form-label">Payment Terms</label>
          <select id="cl-terms" class="form-select"><option value="immediate">Immediate</option><option value="net15">Net 15</option><option value="net30">Net 30</option><option value="net45">Net 45</option><option value="net60">Net 60</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="cl-notes" class="form-textarea" rows="2" placeholder="Reason for limit change…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('credit-limit-modal')">Cancel</button>
            <button class="btn btn-primary" id="cl-save-btn" onclick="saveCreditLimit()">Save Limit</button>`,
  }));

  window.prefillCreditLimit=(id)=>{
    const c=_customers.find(x=>x.id===id); if(!c) return;
    const el=document.getElementById('cl-limit'); if(el) el.value=c.creditLimit||0;
    const te=document.getElementById('cl-terms'); if(te) te.value=c.paymentTerms||'net30';
  };
  window.editCreditLimit=(id,limit)=>{
    const custEl=document.getElementById('cl-customer'); if(custEl) custEl.value=id;
    const limitEl=document.getElementById('cl-limit');   if(limitEl) limitEl.value=limit;
    openModal('credit-limit-modal');
  };
  window.saveCreditLimit=async()=>{
    const id=document.getElementById('cl-customer').value;
    const limit=Number(document.getElementById('cl-limit').value)||0;
    const terms=document.getElementById('cl-terms').value;
    if(!id){Toast.error('Required','Select a customer.');return;}
    const btn=document.getElementById('cl-save-btn'); setLoading(btn,true);
    try{
      await dbUpdate(COLLECTIONS.CUSTOMERS,id,{creditLimit:limit,paymentTerms:terms});
      Toast.success('Updated',`Credit limit set to ₹${limit.toLocaleString('en-IN')}.`);
      closeModal('credit-limit-modal');
      window.refreshFinAdv?.();
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };
  window.holdCustomer=async(id)=>{
    if(!confirm('Place this customer account on hold? New orders will be blocked.')) return;
    try{await dbUpdate(COLLECTIONS.CUSTOMERS,id,{status:'inactive',heldAt:new Date().toISOString()});Toast.warning('On Hold','Customer account held.');}
    catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// TOOL 46: MULTI-CURRENCY SUPPORT
// ══════════════════════════════════════════════════════════════
const CURRENCIES={
  INR:{symbol:'₹',name:'Indian Rupee',   rate:1},
  USD:{symbol:'$',name:'US Dollar',      rate:0.012},
  EUR:{symbol:'€',name:'Euro',           rate:0.011},
  GBP:{symbol:'£',name:'British Pound',  rate:0.0095},
  AED:{symbol:'د.إ',name:'UAE Dirham',   rate:0.044},
  SGD:{symbol:'S$',name:'Singapore Dollar',rate:0.016},
  MYR:{symbol:'RM',name:'Malaysian Ringgit',rate:0.056},
  JPY:{symbol:'¥',name:'Japanese Yen',   rate:1.82},
  CNY:{symbol:'¥',name:'Chinese Yuan',   rate:0.087},
  SAR:{symbol:'﷼',name:'Saudi Riyal',    rate:0.045},
};

function renderCurrencyTab(container){
  container.innerHTML=`
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <!-- Currency Converter -->
      <div class="card">
        <div class="card-header"><div class="card-title">💱 Currency Converter</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-4);">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Amount</label>
              <input type="number" id="conv-amount" class="form-input" value="1000" min="0" oninput="convertCurrency()">
            </div>
            <div class="form-group">
              <label class="form-label">From</label>
              <select id="conv-from" class="form-select" onchange="convertCurrency()">
                ${Object.entries(CURRENCIES).map(([code,c])=>`<option value="${code}" ${code==='INR'?'selected':''}>${c.symbol} ${code} — ${c.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:center;">
            <button onclick="swapCurrencies()" style="background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:all 0.2s;" onmouseenter="this.style.background='var(--bg-overlay)'" onmouseleave="this.style.background='var(--bg-elevated)'">⇄</button>
          </div>
          <div class="form-group">
            <label class="form-label">To</label>
            <select id="conv-to" class="form-select" onchange="convertCurrency()">
              ${Object.entries(CURRENCIES).map(([code,c])=>`<option value="${code}" ${code==='USD'?'selected':''}>${c.symbol} ${code} — ${c.name}</option>`).join('')}
            </select>
          </div>
          <!-- Result -->
          <div id="conv-result" style="background:var(--bg-elevated);border-radius:var(--radius-lg);padding:var(--space-5);text-align:center;">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Converted Amount</div>
            <div style="font-family:var(--font-display);font-size:32px;font-weight:800;color:var(--brand-primary);" id="conv-output">—</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px;" id="conv-rate-display">Rate: —</div>
          </div>
        </div>
      </div>

      <!-- Exchange Rates Table -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📈 Exchange Rates vs INR</div>
          <span style="font-size:10px;color:var(--text-muted);">Base rates (update as needed)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${Object.entries(CURRENCIES).filter(([c])=>c!=='INR').map(([code,cur])=>`
            <div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
              <div style="width:40px;height:28px;background:var(--bg-overlay);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--text-secondary);flex-shrink:0;">${code}</div>
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:500;">${cur.name}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:var(--text-muted);">1 ${code} =</span>
                <input type="number" id="rate-${code}" class="form-input" style="width:80px;text-align:right;" value="${(1/cur.rate).toFixed(2)}" step="0.01" onchange="updateRate('${code}',this.value)">
                <span style="font-size:11px;color:var(--text-muted);">INR</span>
              </div>
            </div>`).join('')}
          <button class="btn btn-primary btn-sm" style="margin-top:6px;" onclick="saveRates()">💾 Save Rates</button>
        </div>
      </div>
    </div>

    <!-- Invoice currency summary -->
    <div class="card" style="margin-top:var(--space-5);">
      <div class="card-header"><div class="card-title">📋 Outstanding Invoices by Currency</div></div>
      ${renderInvoiceByCurrency()}
    </div>
  `;

  window.convertCurrency=()=>{
    const amount=Number(document.getElementById('conv-amount')?.value)||0;
    const from  =document.getElementById('conv-from')?.value||'INR';
    const to    =document.getElementById('conv-to')?.value||'USD';
    const fromRate=CURRENCIES[from]?.rate||1;
    const toRate  =CURRENCIES[to]?.rate||1;
    const result  =amount*(toRate/fromRate);
    const rateVal =(toRate/fromRate);
    const outEl=document.getElementById('conv-output');
    const rateEl=document.getElementById('conv-rate-display');
    if(outEl) outEl.textContent=`${CURRENCIES[to]?.symbol||''}${result.toLocaleString('en-IN',{maximumFractionDigits:4})}`;
    if(rateEl) rateEl.textContent=`1 ${from} = ${rateVal.toFixed(6)} ${to}`;
  };
  window.swapCurrencies=()=>{
    const f=document.getElementById('conv-from');
    const t=document.getElementById('conv-to');
    if(!f||!t) return;
    const tmp=f.value; f.value=t.value; t.value=tmp;
    convertCurrency();
  };
  window.updateRate=(code,val)=>{
    const inrVal=Number(val)||1;
    if(CURRENCIES[code]) CURRENCIES[code].rate=1/inrVal;
  };
  window.saveRates=async()=>{
    try{
      const rates={};
      Object.keys(CURRENCIES).filter(c=>c!=='INR').forEach(code=>{
        const el=document.getElementById(`rate-${code}`);
        if(el) rates[code]=Number(el.value)||0;
      });
      await dbCreate(FIN_ADV_COLLECTIONS.CURRENCY_RATES,{rates,updatedAt:new Date().toISOString(),updatedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
      Toast.success('Saved','Exchange rates saved.');
    }catch(e){Toast.error('Failed',e.message);}
  };
  convertCurrency();
}

function renderInvoiceByCurrency(){
  const byCurrency={};
  _invoices.filter(i=>i.paymentStatus!=='paid').forEach(inv=>{
    const cur=inv.currency||'INR';
    if(!byCurrency[cur]) byCurrency[cur]={total:0,count:0};
    byCurrency[cur].total+=Number(inv.totalAmount)||0;
    byCurrency[cur].count++;
  });
  if(!Object.keys(byCurrency).length) return `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No outstanding invoices</div>`;
  return `
    <div style="display:flex;flex-wrap:wrap;gap:12px;">
      ${Object.entries(byCurrency).map(([cur,data])=>`
        <div style="padding:16px;background:var(--bg-elevated);border-radius:var(--radius-lg);min-width:160px;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:var(--brand-primary);">${CURRENCIES[cur]?.symbol||cur}</div>
          <div style="font-family:var(--font-display);font-size:20px;font-weight:700;margin:4px 0;">${data.total.toLocaleString('en-IN',{maximumFractionDigits:0})}</div>
          <div style="font-size:11px;color:var(--text-muted);">${data.count} invoice${data.count!==1?'s':''}</div>
          <div style="font-size:10px;color:var(--text-muted);">≈ ₹${(data.total*(1/(CURRENCIES[cur]?.rate||1))).toLocaleString('en-IN',{maximumFractionDigits:0})} INR</div>
        </div>`).join('')}
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// TOOL 50: BUDGET PLANNING
// ══════════════════════════════════════════════════════════════
let _budgets=[], _expenses=[];

function renderBudgetTab(container){
  container.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);">
      <div>
        <h3 style="font-family:var(--font-display);font-size:18px;font-weight:700;">Budget Planning</h3>
        <p style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Plan monthly/quarterly budgets and track actual spend</p>
      </div>
      <button class="btn btn-primary" onclick="openModal('budget-modal')">+ Add Budget</button>
    </div>

    <div id="budget-content">
      <div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>
    </div>
  `;

  document.getElementById('budget-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildBudgetModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(FIN_ADV_COLLECTIONS.BUDGETS,cid?[where('companyId','==',cid),orderBy('year','desc'),orderBy('month','desc')]:[orderBy('year','desc')],async(data)=>{
    _budgets=data;
    _expenses=await dbGetAll(FIN_COLLECTIONS.EXPENSES,cid?[where('companyId','==',cid)]:[]);
    renderBudgetContent();
  }));
}

function buildBudgetModal(){
  const currentYear=new Date().getFullYear();
  return buildModal({
    id:'budget-modal',title:'Add Budget',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Year</label>
          <select id="bud-year" class="form-select">
            ${[currentYear-1,currentYear,currentYear+1].map(y=>`<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Month / Quarter</label>
          <select id="bud-period" class="form-select">
            <option value="annual">Full Year</option>
            <option value="Q1">Q1 (Jan-Mar)</option><option value="Q2">Q2 (Apr-Jun)</option>
            <option value="Q3">Q3 (Jul-Sep)</option><option value="Q4">Q4 (Oct-Dec)</option>
            ${['January','February','March','April','May','June','July','August','September','October','November','December'].map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Department / Category</label>
          <select id="bud-category" class="form-select">
            <option value="total">Total Company</option>
            <option value="procurement">Procurement</option><option value="operations">Operations</option>
            <option value="transport">Transport</option><option value="hr">HR & Payroll</option>
            <option value="marketing">Marketing</option><option value="it">IT & Tech</option>
            <option value="admin">Admin & Overhead</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Budget Amount (₹) <span class="required">*</span></label>
          <input type="number" id="bud-amount" class="form-input" placeholder="500000" min="0">
        </div>
        <div class="form-group"><label class="form-label">Alert at (% of budget)</label>
          <select id="bud-alert" class="form-select">
            <option value="70">70% used</option><option value="80" selected>80% used</option>
            <option value="90">90% used</option><option value="100">100% used</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea id="bud-notes" class="form-textarea" rows="2" placeholder="Budget description…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('budget-modal')">Cancel</button>
            <button class="btn btn-primary" id="bud-save-btn" onclick="saveBudget()">Save Budget</button>`,
  });
}

function renderBudgetContent(){
  const el=document.getElementById('budget-content'); if(!el) return;
  const currentYear=new Date().getFullYear();
  const currentMonth=String(new Date().getMonth()+1).padStart(2,'0');

  if(!_budgets.length){
    el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:12px;opacity:0.3;">📊</div><div style="font-size:14px;font-weight:500;margin-bottom:8px;">No budgets defined yet</div><div style="font-size:12px;">Create your first budget to start tracking spend vs plan.</div></div>`;
    return;
  }

  el.innerHTML=_budgets.map(bud=>{
    // Calculate actual spend from expenses
    const expFilter=_expenses.filter(e=>{
      if(!e.date) return false;
      const d=new Date(e.date);
      if(String(d.getFullYear())!==String(bud.year)) return false;
      if(bud.period==='annual') return true;
      if(bud.period.startsWith('Q')){
        const q=Math.ceil((d.getMonth()+1)/3);
        return `Q${q}`===bud.period;
      }
      return String(d.getMonth()+1).padStart(2,'0')===bud.period;
    });
    const actual=expFilter.reduce((s,e)=>s+(Number(e.amount)||0),0);
    const budgetAmt=Number(bud.amount)||0;
    const pct=budgetAmt?Math.round((actual/budgetAmt)*100):0;
    const isOver=actual>budgetAmt;
    const isAlert=pct>=Number(bud.alertAt||80);
    const color=isOver?'var(--brand-danger)':isAlert?'var(--brand-warning)':'var(--brand-secondary)';
    const remaining=budgetAmt-actual;

    return `
      <div class="card" style="margin-bottom:var(--space-4);border-left:4px solid ${color};">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:var(--space-4);">
          <div>
            <div style="font-family:var(--font-display);font-size:16px;font-weight:700;text-transform:capitalize;">${escHtml(bud.category||'Total')} Budget</div>
            <div style="font-size:12px;color:var(--text-muted);">${bud.year} · ${bud.period==='annual'?'Full Year':bud.period}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            ${isOver?`<span class="badge badge-red">Over Budget</span>`:isAlert?`<span class="badge badge-yellow">Near Limit</span>`:`<span class="badge badge-green">On Track</span>`}
            <button class="btn btn-ghost btn-icon" onclick="deleteBudget('${bud.id}')">🗑</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-4);margin-bottom:var(--space-4);">
          ${[
            ['Budget',   '₹'+budgetAmt.toLocaleString('en-IN'), 'var(--text-primary)'],
            ['Actual',   '₹'+actual.toLocaleString('en-IN'),    actual>budgetAmt?'var(--brand-danger)':'var(--text-primary)'],
            ['Remaining','₹'+Math.abs(remaining).toLocaleString('en-IN')+(remaining<0?' (over)':''), remaining<0?'var(--brand-danger)':'var(--brand-secondary)'],
          ].map(([l,v,c])=>`
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">${l}</div>
              <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:${c};">${v}</div>
            </div>`).join('')}
        </div>

        <div>
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;color:var(--text-secondary);">Budget Consumed</span>
            <span style="font-size:12px;font-weight:700;color:${color};">${pct}%</span>
          </div>
          <div style="background:var(--bg-overlay);border-radius:6px;height:12px;overflow:hidden;">
            <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};border-radius:6px;transition:width 1s ease;position:relative;">
              ${pct>10?`<div style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:9px;color:#fff;font-weight:700;">${pct}%</div>`:''}
            </div>
          </div>
        </div>

        ${bud.notes?`<div style="margin-top:var(--space-3);font-size:11px;color:var(--text-muted);">${escHtml(bud.notes)}</div>`:''}
      </div>`;
  }).join('');
}

window.saveBudget=async()=>{
  if(!validateForm([{id:'bud-amount',label:'Budget Amount',required:true}])) return;
  const btn=document.getElementById('bud-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(FIN_ADV_COLLECTIONS.BUDGETS,{
      year:document.getElementById('bud-year').value,
      period:document.getElementById('bud-period').value,
      category:document.getElementById('bud-category').value,
      amount:Number(document.getElementById('bud-amount').value)||0,
      alertAt:Number(document.getElementById('bud-alert').value)||80,
      notes:document.getElementById('bud-notes').value.trim(),
      companyId:AuthState.company?.id||null,
    });
    Toast.success('Budget Created','Budget saved successfully.');
    closeModal('budget-modal');
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.deleteBudget=async(id)=>{if(!confirm('Delete budget?'))return;try{await dbDelete(FIN_ADV_COLLECTIONS.BUDGETS,id);Toast.success('Deleted','Budget removed.');}catch(e){Toast.error('Failed',e.message);}};
