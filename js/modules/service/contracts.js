// ============================================================
// LAM — Service Contracts & Warranties Module
// Contract management, warranty tracking, service calls,
// SLA-linked escalations, renewal alerts
// Interconnects: Customers → Products → Invoices → CRM Tickets
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency, timeAgo
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

export const SVC_COLLECTIONS = {
  CONTRACTS:    'svc_contracts',
  WARRANTIES:   'svc_warranties',
  SERVICE_CALLS:'svc_service_calls',
  RENEWALS:     'svc_renewals',
};

let _contracts=[], _warranties=[], _serviceCalls=[];
let _customers=[], _products=[], _invoices=[];
let _activeTab='contracts';
const PER=15;

export async function renderServiceContracts(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_contracts, _warranties, _serviceCalls, _customers, _products, _invoices] = await Promise.all([
    dbGetAll(SVC_COLLECTIONS.CONTRACTS,    [...c, orderBy('createdAt','desc')]),
    dbGetAll(SVC_COLLECTIONS.WARRANTIES,   [...c, orderBy('createdAt','desc')]),
    dbGetAll(SVC_COLLECTIONS.SERVICE_CALLS,[...c, orderBy('createdAt','desc')]),
    dbGetAll(COLLECTIONS.CUSTOMERS,        [...c]),
    dbGetAll(COLLECTIONS.PRODUCTS,         [...c]),
    dbGetAll(FIN_COLLECTIONS.INVOICES,     [...c, orderBy('createdAt','desc')]),
  ]);

  container.innerHTML = pageShell({
    title: '🔧 Service & Contracts',
    subtitle: 'Service contracts, warranties, claims and SLA-linked service calls.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshSvc()">↻ Refresh</button>`,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="svc-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['contracts',  '📋 Contracts'],
          ['warranties', '🛡️ Warranties'],
          ['calls',      '🔧 Service Calls'],
          ['renewals',   '🔔 Renewals'],
        ].map(([id,label]) => `
          <button class="svc-tab ${id==='contracts'?'active':''}" id="svc-tab-${id}"
            onclick="switchSvcTab('${id}')"
            style="padding:7px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="svc-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.svc-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderSvcKPIs();
  setupModalClose(); setupMenuClose();
  window.switchSvcTab = switchSvcTab;
  window.refreshSvc   = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_contracts,_warranties,_serviceCalls]=await Promise.all([
      dbGetAll(SVC_COLLECTIONS.CONTRACTS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(SVC_COLLECTIONS.WARRANTIES,[...c,orderBy('createdAt','desc')]),
      dbGetAll(SVC_COLLECTIONS.SERVICE_CALLS,[...c,orderBy('createdAt','desc')]),
    ]);
    renderSvcKPIs(); switchSvcTab(_activeTab);
  };
  switchSvcTab('contracts');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderSvcKPIs() {
  const el=document.getElementById('svc-kpis'); if(!el) return; el.innerHTML='';
  const now   = Date.now();
  const active= _contracts.filter(c=>c.status==='active').length;
  const expiring30 = _contracts.filter(c=>{
    if(!c.endDate||c.status!=='active') return false;
    const d=Math.ceil((new Date(c.endDate)-now)/86400000);
    return d>0&&d<=30;
  }).length;
  const openCalls  = _serviceCalls.filter(c=>c.status==='open'||c.status==='in-progress').length;
  const warrantyActive=_warranties.filter(w=>{
    if(!w.expiryDate) return false;
    return new Date(w.expiryDate)>new Date();
  }).length;
  const contractValue=_contracts.filter(c=>c.status==='active').reduce((s,c)=>s+(Number(c.annualValue)||0),0);

  [
    {label:'Active Contracts',  value:active,                        icon:'📋',color:'kpi-blue'},
    {label:'Expiring in 30d',   value:expiring30,                    icon:'⚠️',color:expiring30>0?'kpi-orange':'kpi-green'},
    {label:'Open Service Calls',value:openCalls,                     icon:'🔧',color:openCalls>0?'kpi-yellow':'kpi-green'},
    {label:'Active Warranties', value:warrantyActive,                icon:'🛡️',color:'kpi-green'},
    {label:'Contract ARR',      value:formatCurrency(contractValue,true),icon:'💰',color:'kpi-blue'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchSvcTab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.svc-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`svc-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('svc-tab-content'); if(!c) return;
  switch(tab) {
    case 'contracts':  renderContractsTab(c);  break;
    case 'warranties': renderWarrantiesTab(c); break;
    case 'calls':      renderCallsTab(c);      break;
    case 'renewals':   renderRenewalsTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// SERVICE CONTRACTS
// ══════════════════════════════════════════════════════════════
let _filtContracts=[], _pageContracts=1;

function renderContractsTab(container) {
  _filtContracts=[..._contracts];
  container.innerHTML=`
    ${searchBar({id:'contracts',placeholder:'Search contract no, customer…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'draft',label:'Draft'},{value:'active',label:'Active'},{value:'expired',label:'Expired'},{value:'cancelled',label:'Cancelled'},{value:'renewed',label:'Renewed'}]},
        {key:'type',label:'All Types',options:[{value:'amc',label:'AMC'},{value:'support',label:'Support'},{value:'maintenance',label:'Maintenance'},{value:'subscription',label:'Subscription'},{value:'retainer',label:'Retainer'}]},
      ],onSearch:'contractsSearch',onFilter:'contractsFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('contract-modal')">+ New Contract</button>
    </div>
    <div id="contracts-table-wrap"></div>
    <div id="contracts-pagination"></div>
  `;

  document.getElementById('contract-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', buildContractModal());
  renderContractsTable();

  window.contractsSearch=debounce((q)=>{_filtContracts=searchFilter(_contracts,q,['contractNo','subject','notes']);_pageContracts=1;renderContractsTable();},250);
  window.contractsFilter=(k,v)=>{_filtContracts=v?_contracts.filter(c=>c[k]===v):[..._contracts];_pageContracts=1;renderContractsTable();};
  window.setContractsPage=(p)=>{_pageContracts=p;renderContractsTable();};
}

function renderContractsTable() {
  const wrap=document.getElementById('contracts-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('contracts-count'); if(cnt) cnt.textContent=`${_filtContracts.length} contract${_filtContracts.length!==1?'s':''}`;
  const start=(_pageContracts-1)*PER;
  const now=Date.now();

  wrap.innerHTML=buildTable({id:'contracts-table',
    columns:[
      {key:'contractNo',   label:'Contract #',  render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.contractNo||'—')}</span>`},
      {key:'customerId',   label:'Customer',    render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return avatarCell(c.name||'—',r.type||'','var(--brand-primary)','rgba(10,132,255,0.12)')}},
      {key:'subject',      label:'Subject',     render:r=>`<div style="font-size:12px;font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.subject||'—')}</div>`},
      {key:'type',         label:'Type',        render:r=>`<span class="badge badge-blue">${escHtml(r.type||'—')}</span>`},
      {key:'startDate',    label:'Start',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.startDate||'—'}</span>`},
      {key:'endDate',      label:'End',         render:r=>{
        if(!r.endDate) return '—';
        const d=Math.ceil((new Date(r.endDate)-now)/86400000);
        const isExp=d<=0; const isWarn=d>0&&d<=30;
        return `<span style="font-size:11px;color:${isExp?'var(--brand-danger)':isWarn?'var(--brand-warning)':'var(--text-muted)'};">${r.endDate}${isExp?' EXPIRED':isWarn?` (${d}d)`:''}`;
      }},
      {key:'annualValue',  label:'Annual Value',render:r=>`<span style="font-family:var(--font-mono);">₹${Number(r.annualValue||0).toLocaleString('en-IN')}</span>`},
      {key:'slaResponse',  label:'SLA',         render:r=>r.slaResponseHours?`<span class="badge badge-gray">${r.slaResponseHours}h response</span>`:'—'},
      {key:'status',       label:'Status',      render:r=>{
        const d=r.endDate?Math.ceil((new Date(r.endDate)-now)/86400000):999;
        const s=d<=0&&r.status==='active'?'expired':r.status||'active';
        return badge(s);
      }},
      {key:'actions',      label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View Details',    action:`viewContract('${r.id}')`},
          {icon:'🔧',label:'Raise Service Call',action:`openSvcCallForContract('${r.id}')`},
          {icon:'🔄',label:'Renew',           action:`renewContract('${r.id}')`},
          {icon:'✏️',label:'Edit',            action:`editContract('${r.id}')`},
          {icon:'🗑',label:'Delete',          action:`deleteContract('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtContracts.slice(start,start+PER),emptyMsg:'No service contracts yet',
  });
  document.getElementById('contracts-pagination').innerHTML=buildPagination({id:'contracts',total:_filtContracts.length,page:_pageContracts,perPage:PER,onChange:'setContractsPage'});
}

function buildContractModal() {
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  return buildModal({
    id:'contract-modal',title:'<span id="contract-modal-title">New Service Contract</span>',size:'xl',
    body:`
      <input type="hidden" id="contract-id">
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Contract No.</label>
          <input type="text" id="ct-no" class="form-input" value="SVC-${genId()}" style="text-transform:uppercase;">
        </div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label>
          <select id="ct-customer" class="form-select"><option value="">Select…</option>${custOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Contract Type</label>
          <select id="ct-type" class="form-select">
            <option value="amc">AMC (Annual Maintenance)</option>
            <option value="support">Technical Support</option>
            <option value="maintenance">Preventive Maintenance</option>
            <option value="subscription">Subscription</option>
            <option value="retainer">Retainer</option>
            <option value="warranty-ext">Extended Warranty</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Contract Subject / Title <span class="required">*</span></label>
        <input type="text" id="ct-subject" class="form-input" placeholder="e.g. Annual Maintenance Contract — Fleet Management System">
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Start Date <span class="required">*</span></label>
          <input type="date" id="ct-start" class="form-input" value="${new Date().toISOString().slice(0,10)}" oninput="autoSetEndDate()">
        </div>
        <div class="form-group"><label class="form-label">End Date <span class="required">*</span></label>
          <input type="date" id="ct-end" class="form-input">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Annual Value (₹)</label>
          <input type="number" id="ct-value" class="form-input" placeholder="0" min="0">
        </div>
        <div class="form-group"><label class="form-label">Billing Cycle</label>
          <select id="ct-billing" class="form-select">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="half-yearly">Half-Yearly</option>
            <option value="annual" selected>Annual</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">SLA Response (hours)</label>
          <select id="ct-sla" class="form-select">
            <option value="4">4 hours (Critical)</option>
            <option value="8">8 hours (High)</option>
            <option value="24" selected>24 hours (Standard)</option>
            <option value="48">48 hours (Basic)</option>
            <option value="72">72 hours (Economy)</option>
          </select>
        </div>
      </div>

      <!-- Covered Products / Assets -->
      <div style="margin:var(--space-4) 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Covered Products / Equipment</div>
          <button class="btn btn-secondary btn-sm" onclick="addCoveredProduct()">+ Add</button>
        </div>
        <div id="ct-products-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>

      <!-- Service Scope -->
      <div class="form-group"><label class="form-label">Service Scope & Inclusions</label>
        <textarea id="ct-scope" class="form-textarea" rows="3" placeholder="What is included: preventive maintenance visits, phone support, spare parts, on-site engineers…"></textarea>
      </div>
      <div class="form-group"><label class="form-label">Exclusions</label>
        <textarea id="ct-exclusions" class="form-textarea" rows="2" placeholder="What is NOT covered: physical damage, consumables, third-party software…"></textarea>
      </div>

      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Preventive Maintenance Visits (per year)</label>
          <input type="number" id="ct-pm-visits" class="form-input" value="4" min="0">
        </div>
        <div class="form-group"><label class="form-label">Auto-Renew?</label>
          <select id="ct-auto-renew" class="form-select">
            <option value="yes">Yes — Auto renew 30 days before expiry</option>
            <option value="no">No — Manual renewal only</option>
            <option value="notify">Notify only — Send alert 60 days before</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes / Special Conditions</label>
        <textarea id="ct-notes" class="form-textarea" rows="2"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('contract-modal')">Cancel</button>
            <button class="btn btn-primary" id="ct-save-btn" onclick="saveContract()">Save Contract</button>`,
  });
}

let _ctProducts=[];
window.addCoveredProduct=()=>{
  const idx=_ctProducts.length; _ctProducts.push({productId:'',serialNo:'',model:''});
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  const el=document.getElementById('ct-products-list'); if(!el) return;
  const row=document.createElement('div'); row.id=`ct-prod-${idx}`;
  row.style.cssText='display:grid;grid-template-columns:1fr 150px 150px 36px;gap:8px;align-items:center;';
  row.innerHTML=`
    <select class="form-select" onchange="_ctProducts[${idx}].productId=this.value"><option value="">Select product…</option>${prodOpts}</select>
    <input type="text" class="form-input" placeholder="Serial No." onchange="_ctProducts[${idx}].serialNo=this.value">
    <input type="text" class="form-input" placeholder="Model" onchange="_ctProducts[${idx}].model=this.value">
    <button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="document.getElementById('ct-prod-${idx}')?.remove();_ctProducts[${idx}]=null">✕</button>
  `;
  el.appendChild(row);
};

window.autoSetEndDate=()=>{
  const start=document.getElementById('ct-start')?.value; if(!start) return;
  const end=new Date(start); end.setFullYear(end.getFullYear()+1);
  const endEl=document.getElementById('ct-end'); if(endEl&&!endEl.value) endEl.value=end.toISOString().slice(0,10);
};

window.saveContract=async()=>{
  if(!validateForm([{id:'ct-customer',label:'Customer',required:true},{id:'ct-subject',label:'Subject',required:true},{id:'ct-start',label:'Start Date',required:true},{id:'ct-end',label:'End Date',required:true}])) return;
  const btn=document.getElementById('ct-save-btn'); setLoading(btn,true);
  const id=document.getElementById('contract-id').value;
  const custId=document.getElementById('ct-customer').value;
  const cust=_customers.find(c=>c.id===custId)||{};
  const data={
    contractNo:document.getElementById('ct-no').value.trim(),
    customerId:custId,customerName:cust.name||'',
    type:document.getElementById('ct-type').value,
    subject:document.getElementById('ct-subject').value.trim(),
    startDate:document.getElementById('ct-start').value,
    endDate:document.getElementById('ct-end').value,
    annualValue:Number(document.getElementById('ct-value').value)||0,
    billingCycle:document.getElementById('ct-billing').value,
    slaResponseHours:Number(document.getElementById('ct-sla').value)||24,
    coveredProducts:_ctProducts.filter(Boolean),
    scope:document.getElementById('ct-scope').value.trim(),
    exclusions:document.getElementById('ct-exclusions').value.trim(),
    pmVisitsPerYear:Number(document.getElementById('ct-pm-visits').value)||4,
    autoRenew:document.getElementById('ct-auto-renew').value,
    notes:document.getElementById('ct-notes').value.trim(),
    status:'active',serviceCallCount:0,
    companyId:AuthState.company?.id||null,
  };
  try{
    if(id){await dbUpdate(SVC_COLLECTIONS.CONTRACTS,id,data);Toast.success('Updated',`Contract ${data.contractNo} updated.`);}
    else{await dbCreate(SVC_COLLECTIONS.CONTRACTS,data);Toast.success('Created',`Contract ${data.contractNo} created.`);}
    closeModal('contract-modal'); _ctProducts=[];
    document.getElementById('ct-products-list').innerHTML='';
    document.getElementById('contract-id').value='';
    await window.refreshSvc?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.viewContract=(id)=>{
  const ct=_contracts.find(x=>x.id===id); if(!ct) return;
  const cust=_customers.find(c=>c.id===ct.customerId)||{};
  const calls=_serviceCalls.filter(s=>s.contractId===id);
  const daysLeft=ct.endDate?Math.ceil((new Date(ct.endDate)-Date.now())/86400000):null;

  document.getElementById('contract-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildModal({
    id:'contract-view-modal',title:`Contract — ${ct.contractNo}`,size:'xl',
    body:`
      <div class="grid-3" style="margin-bottom:var(--space-4);gap:var(--space-3);">
        ${[
          ['Customer',    cust.name||'—'],
          ['Type',        ct.type||'—'],
          ['Start Date',  ct.startDate||'—'],
          ['End Date',    ct.endDate||'—'],
          ['Annual Value','₹'+Number(ct.annualValue||0).toLocaleString('en-IN')],
          ['SLA Response',ct.slaResponseHours+'h'],
          ['Auto Renew',  ct.autoRenew||'—'],
          ['PM Visits/yr',ct.pmVisitsPerYear||0],
          ['Status',      ct.status||'active'],
        ].map(([l,v])=>`
          <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700;">${l}</div>
            <div style="font-size:13px;margin-top:3px;font-weight:500;">${escHtml(String(v||'—'))}</div>
          </div>`).join('')}
      </div>

      ${daysLeft!==null?`
        <div style="padding:12px;background:${daysLeft<=0?'rgba(255,59,48,0.1)':daysLeft<=30?'rgba(255,159,10,0.1)':'rgba(0,200,150,0.1)'};border-radius:var(--radius-md);border-left:3px solid ${daysLeft<=0?'var(--brand-danger)':daysLeft<=30?'var(--brand-warning)':'var(--brand-secondary)'};margin-bottom:var(--space-4);">
          <span style="font-size:13px;font-weight:600;color:${daysLeft<=0?'var(--brand-danger)':daysLeft<=30?'var(--brand-warning)':'var(--brand-secondary)'};">
            ${daysLeft<=0?'⚠️ CONTRACT EXPIRED':daysLeft<=30?`⚠️ Expires in ${daysLeft} days`:`✅ ${daysLeft} days remaining`}
          </span>
        </div>`:''}

      <div class="grid-2" style="gap:var(--space-4);">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Scope / Inclusions</div>
          <div style="font-size:13px;white-space:pre-wrap;color:var(--text-secondary);">${escHtml(ct.scope||'Not specified')}</div>
        </div>
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Exclusions</div>
          <div style="font-size:13px;white-space:pre-wrap;color:var(--text-secondary);">${escHtml(ct.exclusions||'Not specified')}</div>
        </div>
      </div>

      ${ct.coveredProducts?.length?`
        <div style="margin-top:var(--space-4);">
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Covered Equipment</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${ct.coveredProducts.map(cp=>{const p=_products.find(x=>x.id===cp.productId)||{};return `<div style="padding:8px 12px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border-subtle);"><div style="font-size:12px;font-weight:600;">${escHtml(p.name||'—')}</div>${cp.serialNo?`<div style="font-size:10px;color:var(--text-muted);">S/N: ${escHtml(cp.serialNo)}</div>`:''}${cp.model?`<div style="font-size:10px;color:var(--text-muted);">Model: ${escHtml(cp.model)}</div>`:''}</div>`;}).join('')}
          </div>
        </div>`:''}

      <div style="margin-top:var(--space-4);">
        <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Service Calls under this Contract (${calls.length})</div>
        ${calls.length?`
          <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;">
            ${calls.map(sc=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:8px;">
              <div><span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(sc.callNo||'—')}</span><span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${sc.date||'—'}</span></div>
              <div style="font-size:12px;color:var(--text-secondary);">${escHtml(sc.issue||'—')}</div>
              ${badge(sc.status||'open')}
            </div>`).join('')}
          </div>`:`<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No service calls yet</div>`}
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('contract-view-modal')">Close</button>
            <button class="btn btn-primary" onclick="closeModal('contract-view-modal');openSvcCallForContract('${ct.id}')">+ Raise Service Call</button>
            <button class="btn btn-secondary" onclick="closeModal('contract-view-modal');renewContract('${ct.id}')">🔄 Renew</button>`,
  }));
  openModal('contract-view-modal');
};

window.editContract=(id)=>{
  const ct=_contracts.find(x=>x.id===id); if(!ct) return;
  document.getElementById('contract-modal-title').textContent='Edit Contract';
  document.getElementById('contract-id').value=ct.id;
  ['ct-no','ct-subject','ct-start','ct-end','ct-scope','ct-exclusions','ct-notes'].forEach(fId=>{
    const key=fId.replace('ct-','').replace('-','').replace('scope','scope').replace('exclusions','exclusions').replace('notes','notes').replace('no','contractNo').replace('subject','subject').replace('start','startDate').replace('end','endDate');
    const fieldMap={no:'contractNo',subject:'subject',start:'startDate',end:'endDate',scope:'scope',exclusions:'exclusions',notes:'notes'};
    const k=fieldMap[fId.replace('ct-','')]||fId.replace('ct-','');
    const el=document.getElementById(fId); if(el) el.value=ct[k]||'';
  });
  document.getElementById('ct-customer').value=ct.customerId||'';
  document.getElementById('ct-type').value=ct.type||'amc';
  document.getElementById('ct-value').value=ct.annualValue||0;
  document.getElementById('ct-billing').value=ct.billingCycle||'annual';
  document.getElementById('ct-sla').value=String(ct.slaResponseHours||24);
  document.getElementById('ct-pm-visits').value=ct.pmVisitsPerYear||4;
  document.getElementById('ct-auto-renew').value=ct.autoRenew||'notify';
  openModal('contract-modal');
};

window.renewContract=async(id)=>{
  const ct=_contracts.find(x=>x.id===id); if(!ct) return;
  if(!confirm(`Renew contract ${ct.contractNo}? A new 1-year contract will be created.`)) return;
  const startDate=ct.endDate||new Date().toISOString().slice(0,10);
  const newEnd=new Date(startDate); newEnd.setFullYear(newEnd.getFullYear()+1);
  const newNo='SVC-'+genId();
  try{
    await dbCreate(SVC_COLLECTIONS.CONTRACTS,{...ct,id:undefined,contractNo:newNo,startDate,endDate:newEnd.toISOString().slice(0,10),status:'active',serviceCallCount:0,renewedFrom:id});
    await dbUpdate(SVC_COLLECTIONS.CONTRACTS,id,{status:'renewed'});
    Toast.success('Renewed!',`New contract ${newNo} created.`);
    await window.refreshSvc?.();
  }catch(e){Toast.error('Failed',e.message);}
};

window.deleteContract=async(id)=>{if(!confirm('Delete contract?'))return;try{await dbDelete(SVC_COLLECTIONS.CONTRACTS,id);Toast.success('Deleted','Contract removed.');await window.refreshSvc?.();}catch(e){Toast.error('Failed',e.message);}};
window.openSvcCallForContract=(contractId)=>{
  const ct=_contracts.find(x=>x.id===contractId); if(!ct) return;
  const custEl=document.getElementById('sc-customer'); if(custEl) custEl.value=ct.customerId||'';
  const ctEl=document.getElementById('sc-contract'); if(ctEl) ctEl.value=contractId;
  const slaEl=document.getElementById('sc-sla'); if(slaEl) slaEl.value=ct.slaResponseHours||24;
  openModal('svc-call-modal');
};

// ══════════════════════════════════════════════════════════════
// WARRANTIES TAB
// ══════════════════════════════════════════════════════════════
let _filtWarranties=[], _pageWarranties=1;

function renderWarrantiesTab(container) {
  _filtWarranties=[..._warranties];
  const now=Date.now();
  container.innerHTML=`
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Active Warranties', value:_warranties.filter(w=>w.expiryDate&&new Date(w.expiryDate)>new Date()).length, icon:'🛡️',color:'kpi-green'},
        {label:'Expiring in 30 Days',value:_warranties.filter(w=>{if(!w.expiryDate) return false;const d=Math.ceil((new Date(w.expiryDate)-now)/86400000);return d>0&&d<=30;}).length,icon:'⚠️',color:'kpi-orange'},
        {label:'Expired',           value:_warranties.filter(w=>w.expiryDate&&new Date(w.expiryDate)<new Date()).length, icon:'❌',color:'kpi-red'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    ${searchBar({id:'warranties',placeholder:'Search product, serial no, customer…',
      filters:[{key:'status',label:'All Status',options:[{value:'active',label:'Active'},{value:'expired',label:'Expired'},{value:'claimed',label:'Claimed'}]}],
      onSearch:'warrantiesSearch',onFilter:'warrantiesFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('warranty-modal')">+ Register Warranty</button>
    </div>
    <div id="warranties-table-wrap"></div>
    <div id="warranties-pagination"></div>
  `;

  document.getElementById('warranty-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildWarrantyModal());
  renderWarrantiesTable();

  window.warrantiesSearch=debounce((q)=>{_filtWarranties=searchFilter(_warranties,q,['serialNo','productName','notes']);_pageWarranties=1;renderWarrantiesTable();},250);
  window.warrantiesFilter=(k,v)=>{_filtWarranties=v?_warranties.filter(w=>w[k]===v):[..._warranties];_pageWarranties=1;renderWarrantiesTable();};
  window.setWarrantiesPage=(p)=>{_pageWarranties=p;renderWarrantiesTable();};
}

function renderWarrantiesTable() {
  const wrap=document.getElementById('warranties-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('warranties-count'); if(cnt) cnt.textContent=`${_filtWarranties.length} warrant${_filtWarranties.length!==1?'ies':'y'}`;
  const start=(_pageWarranties-1)*PER;
  const now=Date.now();
  wrap.innerHTML=buildTable({id:'warranties-table',
    columns:[
      {key:'productId',   label:'Product',     render:r=>{const p=_products.find(x=>x.id===r.productId)||{};return avatarCell(p.name||r.productName||'—',`S/N: ${r.serialNo||'—'}`,'var(--brand-secondary)','rgba(0,200,150,0.12)')}},
      {key:'customerId',  label:'Customer',    render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||'—')}</span>`}},
      {key:'invoiceRef',  label:'Invoice',     render:r=>`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.invoiceRef||'—')}</span>`},
      {key:'purchaseDate',label:'Purchase',    render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.purchaseDate||'—'}</span>`},
      {key:'expiryDate',  label:'Expires',     render:r=>{
        if(!r.expiryDate) return '—';
        const d=Math.ceil((new Date(r.expiryDate)-now)/86400000);
        const isExp=d<=0; const isWarn=d>0&&d<=30;
        return `<span style="font-size:11px;font-weight:${isExp||isWarn?700:400};color:${isExp?'var(--brand-danger)':isWarn?'var(--brand-warning)':'var(--text-muted)'};">${r.expiryDate}${isExp?' EXPIRED':isWarn?` (${d}d)`:''}`;
      }},
      {key:'warrantyMonths',label:'Duration', render:r=>`<span class="badge badge-blue">${r.warrantyMonths||12} months</span>`},
      {key:'status',      label:'Status',      render:r=>{const d=r.expiryDate?Math.ceil((new Date(r.expiryDate)-now)/86400000):1;return badge(d<=0&&r.status!=='claimed'?'expired':r.status||'active')}},
      {key:'actions',     label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'🔧',label:'Raise Claim',     action:`raiseWarrantyClaim('${r.id}')`},
          {icon:'🗑',label:'Delete',          action:`deleteWarranty('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtWarranties.slice(start,start+PER),emptyMsg:'No warranties registered',
  });
  document.getElementById('warranties-pagination').innerHTML=buildPagination({id:'warranties',total:_filtWarranties.length,page:_pageWarranties,perPage:PER,onChange:'setWarrantiesPage'});
}

function buildWarrantyModal() {
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  const invOpts =_invoices.slice(0,50).map(i=>`<option value="${i.invoiceNumber}">${escHtml(i.invoiceNumber||'—')}</option>`).join('');
  return buildModal({
    id:'warranty-modal',title:'Register Warranty',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label>
          <select id="wa-product" class="form-select"><option value="">Select…</option>${prodOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label>
          <select id="wa-customer" class="form-select"><option value="">Select…</option>${custOpts}</select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Serial Number</label>
          <input type="text" id="wa-serial" class="form-input" placeholder="Product serial number">
        </div>
        <div class="form-group"><label class="form-label">Invoice Reference</label>
          <select id="wa-invoice" class="form-select"><option value="">Select invoice…</option>${invOpts}</select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Purchase Date <span class="required">*</span></label>
          <input type="date" id="wa-purchase" class="form-input" value="${new Date().toISOString().slice(0,10)}" oninput="calcWarrantyExpiry()">
        </div>
        <div class="form-group"><label class="form-label">Warranty Period (months)</label>
          <select id="wa-months" class="form-select" oninput="calcWarrantyExpiry()">
            <option value="3">3 months</option><option value="6">6 months</option>
            <option value="12" selected>12 months (1 year)</option><option value="24">24 months (2 years)</option>
            <option value="36">36 months (3 years)</option><option value="60">60 months (5 years)</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Expiry Date</label>
          <input type="date" id="wa-expiry" class="form-input" readonly style="background:var(--bg-overlay);">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Warranty Terms</label>
        <textarea id="wa-terms" class="form-textarea" rows="2" placeholder="What is covered under warranty…"></textarea>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea id="wa-notes" class="form-textarea" rows="2"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('warranty-modal')">Cancel</button>
            <button class="btn btn-primary" id="wa-save-btn" onclick="saveWarranty()">Register Warranty</button>`,
  });
}

window.calcWarrantyExpiry=()=>{
  const purchase=document.getElementById('wa-purchase')?.value; if(!purchase) return;
  const months=Number(document.getElementById('wa-months')?.value)||12;
  const expiry=new Date(purchase); expiry.setMonth(expiry.getMonth()+months);
  const el=document.getElementById('wa-expiry'); if(el) el.value=expiry.toISOString().slice(0,10);
};

window.saveWarranty=async()=>{
  if(!validateForm([{id:'wa-product',label:'Product',required:true},{id:'wa-customer',label:'Customer',required:true},{id:'wa-purchase',label:'Purchase Date',required:true}])) return;
  const btn=document.getElementById('wa-save-btn'); setLoading(btn,true);
  const prodId=document.getElementById('wa-product').value;
  const p=_products.find(x=>x.id===prodId)||{};
  const custId=document.getElementById('wa-customer').value;
  const months=Number(document.getElementById('wa-months').value)||12;
  try{
    await dbCreate(SVC_COLLECTIONS.WARRANTIES,{productId:prodId,productName:p.name||'',customerId:custId,serialNo:document.getElementById('wa-serial').value.trim(),invoiceRef:document.getElementById('wa-invoice').value||null,purchaseDate:document.getElementById('wa-purchase').value,warrantyMonths:months,expiryDate:document.getElementById('wa-expiry').value,terms:document.getElementById('wa-terms').value.trim(),notes:document.getElementById('wa-notes').value.trim(),status:'active',claimsCount:0,companyId:AuthState.company?.id||null});
    Toast.success('Registered',`${p.name} warranty registered.`);
    closeModal('warranty-modal'); await window.refreshSvc?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.raiseWarrantyClaim=(id)=>{
  const w=_warranties.find(x=>x.id===id); if(!w) return;
  const custEl=document.getElementById('sc-customer'); if(custEl) custEl.value=w.customerId||'';
  const issueEl=document.getElementById('sc-issue'); if(issueEl) issueEl.value=`Warranty claim for ${w.productName} (S/N: ${w.serialNo||'N/A'})`;
  const typeEl=document.getElementById('sc-type'); if(typeEl) typeEl.value='warranty-claim';
  openModal('svc-call-modal');
};

window.deleteWarranty=async(id)=>{if(!confirm('Delete warranty record?'))return;try{await dbDelete(SVC_COLLECTIONS.WARRANTIES,id);Toast.success('Deleted','Warranty removed.');await window.refreshSvc?.();}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// SERVICE CALLS TAB
// ══════════════════════════════════════════════════════════════
let _filtCalls=[], _pageCalls=1;

function renderCallsTab(container) {
  _filtCalls=[..._serviceCalls];
  container.innerHTML=`
    ${searchBar({id:'calls',placeholder:'Search call no, issue…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'open',label:'Open'},{value:'in-progress',label:'In Progress'},{value:'resolved',label:'Resolved'},{value:'closed',label:'Closed'}]},
        {key:'type',label:'All Types',options:[{value:'breakdown',label:'Breakdown'},{value:'preventive',label:'Preventive'},{value:'installation',label:'Installation'},{value:'warranty-claim',label:'Warranty Claim'},{value:'consultation',label:'Consultation'}]},
      ],onSearch:'callsSearch',onFilter:'callsFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('svc-call-modal')">+ Raise Service Call</button>
    </div>
    <div id="calls-table-wrap"></div>
    <div id="calls-pagination"></div>
  `;

  document.getElementById('svc-call-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildSvcCallModal());
  renderCallsTable();

  window.callsSearch=debounce((q)=>{_filtCalls=searchFilter(_serviceCalls,q,['callNo','issue','notes']);_pageCalls=1;renderCallsTable();},250);
  window.callsFilter=(k,v)=>{_filtCalls=v?_serviceCalls.filter(c=>c[k]===v):[..._serviceCalls];_pageCalls=1;renderCallsTable();};
  window.setCallsPage=(p)=>{_pageCalls=p;renderCallsTable();};
}

function renderCallsTable() {
  const wrap=document.getElementById('calls-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('calls-count'); if(cnt) cnt.textContent=`${_filtCalls.length} call${_filtCalls.length!==1?'s':''}`;
  const start=(_pageCalls-1)*PER;
  const now=Date.now();
  wrap.innerHTML=buildTable({id:'calls-table',
    columns:[
      {key:'callNo',     label:'Call #',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.callNo||'—')}</span>`},
      {key:'customerId', label:'Customer',  render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||'—')}</span>`}},
      {key:'type',       label:'Type',      render:r=>`<span class="badge badge-blue">${escHtml(r.type||'—')}</span>`},
      {key:'issue',      label:'Issue',     render:r=>`<div style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.issue||'—')}</div>`},
      {key:'priority',   label:'Priority',  render:r=>{const colors={critical:'var(--brand-danger)',high:'var(--brand-warning)',medium:'var(--brand-primary)',low:'var(--text-muted)'};const c=colors[r.priority]||'var(--text-muted)';return `<span style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${c}20;color:${c};text-transform:uppercase;">${r.priority||'medium'}</span>`}},
      {key:'slaHours',   label:'SLA',       render:r=>{
        if(!r.raisedAt||!r.slaResponseHours) return '—';
        const elapsed=Math.ceil((now-new Date(r.raisedAt))/3600000);
        const sla=Number(r.slaResponseHours)||24;
        const breached=elapsed>sla&&r.status==='open';
        return `<span style="font-size:11px;color:${breached?'var(--brand-danger)':'var(--text-muted)'};">${elapsed}h / ${sla}h${breached?' ⚠ SLA BREACH':''}`;
      }},
      {key:'assignedTo', label:'Technician',render:r=>`<span style="font-size:12px;">${escHtml(r.assignedTo||'—')}</span>`},
      {key:'status',     label:'Status',    render:r=>badge(r.status||'open')},
      {key:'actions',    label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'✅',label:'Mark Resolved',  action:`resolveCall('${r.id}')`},
          {icon:'🔒',label:'Close',          action:`closeCall('${r.id}')`},
          {icon:'🗑',label:'Delete',         action:`deleteCall('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtCalls.slice(start,start+PER),emptyMsg:'No service calls',
  });
  document.getElementById('calls-pagination').innerHTML=buildPagination({id:'calls',total:_filtCalls.length,page:_pageCalls,perPage:PER,onChange:'setCallsPage'});
}

function buildSvcCallModal() {
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const contractOpts=_contracts.filter(c=>c.status==='active').map(c=>`<option value="${c.id}">${escHtml(c.contractNo)} — ${escHtml(c.customerName||'')}</option>`).join('');
  return buildModal({
    id:'svc-call-modal',title:'Raise Service Call',size:'lg',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Call Number</label><input type="text" id="sc-no" class="form-input" value="SC-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label><select id="sc-customer" class="form-select"><option value="">Select…</option>${custOpts}</select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Service Call Type</label>
          <select id="sc-type" class="form-select">
            <option value="breakdown">Breakdown / Emergency</option><option value="preventive">Preventive Maintenance</option>
            <option value="installation">Installation</option><option value="warranty-claim">Warranty Claim</option>
            <option value="consultation">Consultation</option><option value="upgrade">Upgrade / Modification</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Priority</label>
          <select id="sc-priority" class="form-select">
            <option value="low">Low</option><option value="medium" selected>Medium</option>
            <option value="high">High</option><option value="critical">Critical</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Issue / Problem Description <span class="required">*</span></label>
        <textarea id="sc-issue" class="form-textarea" rows="3" placeholder="Describe the problem in detail…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Linked Contract</label>
          <select id="sc-contract" class="form-select"><option value="">No contract</option>${contractOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">SLA Response (hours)</label>
          <input type="number" id="sc-sla" class="form-input" value="24" min="1">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Assigned Technician</label>
          <input type="text" id="sc-tech" class="form-input" placeholder="Technician name">
        </div>
        <div class="form-group"><label class="form-label">Scheduled Date</label>
          <input type="date" id="sc-sched" class="form-input">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="sc-notes" class="form-textarea" rows="2"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('svc-call-modal')">Cancel</button>
            <button class="btn btn-primary" id="sc-save-btn" onclick="saveSvcCall()">Raise Call</button>`,
  });
}

window.saveSvcCall=async()=>{
  if(!validateForm([{id:'sc-customer',label:'Customer',required:true},{id:'sc-issue',label:'Issue',required:true}])) return;
  const btn=document.getElementById('sc-save-btn'); setLoading(btn,true);
  const custId=document.getElementById('sc-customer').value;
  const cust=_customers.find(c=>c.id===custId)||{};
  const contractId=document.getElementById('sc-contract').value||null;
  try{
    await dbCreate(SVC_COLLECTIONS.SERVICE_CALLS,{callNo:document.getElementById('sc-no').value.trim(),customerId:custId,customerName:cust.name||'',contractId,type:document.getElementById('sc-type').value,priority:document.getElementById('sc-priority').value,issue:document.getElementById('sc-issue').value.trim(),slaResponseHours:Number(document.getElementById('sc-sla').value)||24,assignedTo:document.getElementById('sc-tech').value.trim(),scheduledDate:document.getElementById('sc-sched').value||null,notes:document.getElementById('sc-notes').value.trim(),status:'open',raisedAt:new Date().toISOString(),raisedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
    if(contractId) await dbUpdate(SVC_COLLECTIONS.CONTRACTS,contractId,{serviceCallCount:((_contracts.find(c=>c.id===contractId)?.serviceCallCount)||0)+1});
    Toast.success('Raised',`Service call raised.`);
    closeModal('svc-call-modal'); await window.refreshSvc?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.resolveCall=async(id)=>{
  const resolution=prompt('Enter resolution details:'); if(!resolution) return;
  try{await dbUpdate(SVC_COLLECTIONS.SERVICE_CALLS,id,{status:'resolved',resolution,resolvedAt:new Date().toISOString(),resolvedBy:AuthState.profile?.name||''});Toast.success('Resolved','Service call resolved.');}
  catch(e){Toast.error('Failed',e.message);}
};
window.closeCall=async(id)=>{try{await dbUpdate(SVC_COLLECTIONS.SERVICE_CALLS,id,{status:'closed',closedAt:new Date().toISOString()});Toast.success('Closed','Service call closed.');}catch(e){Toast.error('Failed',e.message);}};
window.deleteCall=async(id)=>{if(!confirm('Delete service call?'))return;try{await dbDelete(SVC_COLLECTIONS.SERVICE_CALLS,id);await window.refreshSvc?.();Toast.success('Deleted','Call removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// RENEWALS TAB
// ══════════════════════════════════════════════════════════════
function renderRenewalsTab(container) {
  const now=Date.now();
  const expiring30=_contracts.filter(c=>{if(!c.endDate||c.status!=='active')return false;const d=Math.ceil((new Date(c.endDate)-now)/86400000);return d>0&&d<=30;});
  const expiring60=_contracts.filter(c=>{if(!c.endDate||c.status!=='active')return false;const d=Math.ceil((new Date(c.endDate)-now)/86400000);return d>30&&d<=60;});
  const expiring90=_contracts.filter(c=>{if(!c.endDate||c.status!=='active')return false;const d=Math.ceil((new Date(c.endDate)-now)/86400000);return d>60&&d<=90;});
  const expired=_contracts.filter(c=>c.endDate&&new Date(c.endDate)<new Date()&&c.status==='active');

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Expired (action needed)',value:expired.length,      icon:'🚨',color:'kpi-red'},
        {label:'Expiring in 30 days',    value:expiring30.length,   icon:'⚠️',color:'kpi-orange'},
        {label:'Expiring in 60 days',    value:expiring60.length,   icon:'📅',color:'kpi-yellow'},
        {label:'Expiring in 90 days',    value:expiring90.length,   icon:'🔔',color:'kpi-blue'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    ${[
      {label:'🚨 Expired — Immediate Action',list:expired,color:'var(--brand-danger)'},
      {label:'⚠️ Expiring within 30 Days',  list:expiring30,color:'var(--brand-warning)'},
      {label:'📅 Expiring in 31–60 Days',   list:expiring60,color:'var(--brand-primary)'},
      {label:'🔔 Expiring in 61–90 Days',   list:expiring90,color:'var(--text-muted)'},
    ].filter(s=>s.list.length).map(section=>`
      <div class="card" style="margin-bottom:var(--space-4);">
        <div class="card-header">
          <div class="card-title" style="color:${section.color};">${section.label}</div>
          <span class="badge badge-gray">${section.list.length} contracts</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${section.list.map(ct=>{
            const cust=_customers.find(c=>c.id===ct.customerId)||{};
            const daysLeft=ct.endDate?Math.ceil((new Date(ct.endDate)-now)/86400000):0;
            return `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${section.color};">
                <div>
                  <div style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(ct.contractNo)}</div>
                  <div style="font-size:13px;font-weight:500;">${escHtml(cust.name||'—')} — ${escHtml(ct.subject||'—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">₹${Number(ct.annualValue||0).toLocaleString('en-IN')}/year · ${daysLeft<=0?'Expired '+Math.abs(daysLeft)+'d ago':`Expires in ${daysLeft}d`}</div>
                </div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-primary btn-sm" onclick="renewContract('${ct.id}')">🔄 Renew</button>
                  <button class="btn btn-secondary btn-sm" onclick="viewContract('${ct.id}')">View</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`).join('')}

    ${!expired.length&&!expiring30.length&&!expiring60.length&&!expiring90.length?`
      <div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:48px;margin-bottom:16px;opacity:0.3;">✅</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">All Contracts Healthy</div>
        <div style="font-size:13px;">No contracts expiring in the next 90 days.</div>
      </div>`:''}
  `;
}
