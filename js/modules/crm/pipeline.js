// ============================================================
// LAM — Sales Pipeline / CRM Opportunities Module
// Lead → Qualified → Proposal → Negotiation → Won/Lost
// Interconnects: Customers → Quotations → Sales Orders → Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
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

export const PIPELINE_COLLECTIONS = {
  LEADS:        'crm_leads',
  OPPORTUNITIES:'crm_opportunities',
  QUOTATIONS:   'crm_quotations',
  ACTIVITIES:   'crm_activities',
};

// Stage config
const STAGES = [
  { id:'lead',        label:'Lead',        color:'var(--text-muted)',          pct:10,  icon:'👋' },
  { id:'qualified',   label:'Qualified',   color:'var(--brand-info)',           pct:25,  icon:'🎯' },
  { id:'proposal',    label:'Proposal',    color:'var(--brand-primary)',        pct:50,  icon:'📄' },
  { id:'negotiation', label:'Negotiation', color:'var(--brand-warning)',        pct:75,  icon:'🤝' },
  { id:'won',         label:'Won',         color:'var(--brand-secondary)',      pct:100, icon:'🏆' },
  { id:'lost',        label:'Lost',        color:'var(--brand-danger)',         pct:0,   icon:'❌' },
];

let _opps=[], _leads=[], _activities=[], _customers=[], _products=[];
let _activeTab='pipeline';
const PER=20;

export async function renderSalesPipeline(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_opps, _leads, _activities, _customers, _products] = await Promise.all([
    dbGetAll(PIPELINE_COLLECTIONS.OPPORTUNITIES, [...c, orderBy('createdAt','desc')]),
    dbGetAll(PIPELINE_COLLECTIONS.LEADS,         [...c, orderBy('createdAt','desc')]),
    dbGetAll(PIPELINE_COLLECTIONS.ACTIVITIES,    [...c, orderBy('date','desc')]),
    dbGetAll(COLLECTIONS.CUSTOMERS,              [...c]),
    dbGetAll(COLLECTIONS.PRODUCTS,               [...c]),
  ]);

  container.innerHTML = pageShell({
    title: '📈 Sales Pipeline',
    subtitle: 'Lead to order funnel — track opportunities, proposals, negotiations and closures.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportPipeline()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openModal('opp-modal')">+ New Opportunity</button>
    `,
    content: `
      <!-- Pipeline KPIs -->
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="pipeline-kpis"></div>

      <!-- Sub-tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['pipeline',    '📊 Kanban Pipeline'],
          ['list',        '📋 List View'],
          ['leads',       '👋 Leads'],
          ['quotations',  '📄 Quotations'],
          ['activities',  '📅 Activities'],
          ['forecast',    '🔮 Forecast'],
        ].map(([id,label]) => `
          <button class="pipe-tab ${id==='pipeline'?'active':''}" id="pipe-tab-${id}"
            onclick="switchPipeTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="pipe-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.pipe-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderPipelineKPIs();
  setupModalClose(); setupMenuClose();

  document.body.insertAdjacentHTML('beforeend', oppModal());
  document.body.insertAdjacentHTML('beforeend', activityModal());
  document.body.insertAdjacentHTML('beforeend', quotationModal());

  window.switchPipeTab = switchPipeTab;
  window.refreshPipeline = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_opps,_leads,_activities]=await Promise.all([
      dbGetAll(PIPELINE_COLLECTIONS.OPPORTUNITIES,[...c,orderBy('createdAt','desc')]),
      dbGetAll(PIPELINE_COLLECTIONS.LEADS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(PIPELINE_COLLECTIONS.ACTIVITIES,[...c,orderBy('date','desc')]),
    ]);
    renderPipelineKPIs(); switchPipeTab(_activeTab);
  };

  switchPipeTab('pipeline');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderPipelineKPIs() {
  const el=document.getElementById('pipeline-kpis'); if(!el) return; el.innerHTML='';
  const active  =_opps.filter(o=>!['won','lost'].includes(o.stage));
  const won     =_opps.filter(o=>o.stage==='won');
  const lost    =_opps.filter(o=>o.stage==='lost');
  const pipeline =active.reduce((s,o)=>s+(Number(o.value)||0),0);
  const wonValue =won.reduce((s,o)=>s+(Number(o.value)||0),0);
  const winRate  =_opps.length?Math.round((won.length/_opps.length)*100):0;
  [
    {label:'Pipeline Value',  value:formatCurrency(pipeline,true),  icon:'💰',color:'kpi-blue'},
    {label:'Active Opps',     value:active.length,                  icon:'📊',color:'kpi-orange'},
    {label:'Won (MTD)',        value:formatCurrency(wonValue,true),  icon:'🏆',color:'kpi-green'},
    {label:'Win Rate',         value:winRate+'%',                   icon:'🎯',color:winRate>=50?'kpi-green':'kpi-yellow'},
    {label:'Leads',            value:_leads.length,                 icon:'👋',color:'kpi-blue'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchPipeTab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.pipe-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`pipe-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('pipe-tab-content'); if(!c) return;
  switch(tab) {
    case 'pipeline':   renderKanban(c);     break;
    case 'list':       renderListView(c);   break;
    case 'leads':      renderLeadsTab(c);   break;
    case 'quotations': renderQuoteTab(c);   break;
    case 'activities': renderActivityTab(c);break;
    case 'forecast':   renderForecastTab(c);break;
  }
}

// ══════════════════════════════════════════════════════════════
// KANBAN PIPELINE VIEW
// ══════════════════════════════════════════════════════════════
function renderKanban(container) {
  const activeStages = STAGES.filter(s=>!['won','lost'].includes(s.id));

  container.innerHTML = `
    <div style="overflow-x:auto;padding-bottom:var(--space-4);">
      <div style="display:grid;grid-template-columns:repeat(${activeStages.length},minmax(240px,1fr));gap:var(--space-3);min-width:${activeStages.length*250}px;">
        ${activeStages.map(stage => {
          const stageOpps = _opps.filter(o=>o.stage===stage.id);
          const stageValue= stageOpps.reduce((s,o)=>s+(Number(o.value)||0),0);
          return `
            <div style="background:var(--bg-elevated);border-radius:var(--radius-lg);overflow:hidden;border:1px solid var(--border-subtle);">
              <!-- Column Header -->
              <div style="padding:12px 14px;border-bottom:1px solid var(--border-subtle);background:var(--bg-overlay);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:16px;">${stage.icon}</span>
                    <span style="font-size:13px;font-weight:700;color:${stage.color};">${stage.label}</span>
                  </div>
                  <span style="background:${stage.color}20;color:${stage.color};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">${stageOpps.length}</span>
                </div>
                <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">₹${stageValue.toLocaleString('en-IN')}</div>
                <!-- Stage progress bar -->
                <div style="background:var(--bg-surface);border-radius:2px;height:3px;margin-top:8px;overflow:hidden;">
                  <div style="height:100%;width:${stage.pct}%;background:${stage.color};transition:width 0.8s;"></div>
                </div>
              </div>

              <!-- Cards -->
              <div style="padding:10px;display:flex;flex-direction:column;gap:8px;min-height:200px;max-height:520px;overflow-y:auto;"
                   id="kanban-col-${stage.id}"
                   ondragover="event.preventDefault()" ondrop="dropOpp(event,'${stage.id}')">
                ${stageOpps.length ? stageOpps.map(opp => kanbanCard(opp)).join('') :
                  `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:11px;opacity:0.5;">Drop here</div>`}
              </div>

              <!-- Add button -->
              <div style="padding:8px 10px;border-top:1px solid var(--border-subtle);">
                <button class="btn btn-ghost btn-sm" style="width:100%;font-size:11px;" onclick="openOppInStage('${stage.id}')">+ Add Opportunity</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Won/Lost summary row -->
    <div class="grid-2" style="margin-top:var(--space-4);">
      ${['won','lost'].map(s => {
        const stage=STAGES.find(x=>x.id===s);
        const stageOpps=_opps.filter(o=>o.stage===s);
        const val=stageOpps.reduce((sum,o)=>sum+(Number(o.value)||0),0);
        return `
          <div style="padding:16px;background:${s==='won'?'rgba(0,200,150,0.08)':'rgba(255,59,48,0.08)'};border:1px solid ${s==='won'?'rgba(0,200,150,0.25)':'rgba(255,59,48,0.25)'};border-radius:var(--radius-lg);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <div style="font-size:15px;font-weight:700;color:${stage.color};">${stage.icon} ${stage.label}</div>
              <div style="font-family:var(--font-display);font-size:18px;font-weight:800;color:${stage.color};">₹${val.toLocaleString('en-IN')}</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${stageOpps.slice(0,5).map(o=>`
                <div style="padding:4px 10px;background:${s==='won'?'rgba(0,200,150,0.1)':'rgba(255,59,48,0.1)'};border-radius:999px;font-size:11px;color:${stage.color};">
                  ${escHtml(o.title||o.customerName||'—')} · ₹${Number(o.value||0).toLocaleString('en-IN')}
                </div>`).join('')}
              ${stageOpps.length>5?`<div style="font-size:11px;color:var(--text-muted);padding:4px;">+${stageOpps.length-5} more</div>`:''}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

  window.dropOpp = async (e, newStage) => {
    e.preventDefault();
    const oppId = e.dataTransfer.getData('oppId'); if (!oppId) return;
    const opp = _opps.find(o=>o.id===oppId); if (!opp) return;
    const stage = STAGES.find(s=>s.id===newStage);
    try {
      const update = { stage: newStage, [`${newStage}At`]: new Date().toISOString() };
      if (newStage==='won') update.closedAt = new Date().toISOString();
      await dbUpdate(PIPELINE_COLLECTIONS.OPPORTUNITIES, oppId, update);
      Toast.success(`Moved to ${stage.label}`, `${opp.title} → ${stage.icon} ${stage.label}`);
      await window.refreshPipeline?.();
    } catch(e) { Toast.error('Failed', e.message); }
  };
  window.openOppInStage = (stage) => {
    const stageEl = document.getElementById('opp-stage'); if (stageEl) stageEl.value = stage;
    openModal('opp-modal');
  };
}

function kanbanCard(opp) {
  const cust = _customers.find(c=>c.id===opp.customerId);
  const stage = STAGES.find(s=>s.id===opp.stage);
  const isOverdue = opp.expectedClose && new Date(opp.expectedClose)<new Date() && !['won','lost'].includes(opp.stage);
  return `
    <div draggable="true"
         ondragstart="event.dataTransfer.setData('oppId','${opp.id}')"
         onclick="viewOpp('${opp.id}')"
         style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);
                padding:12px;cursor:grab;transition:all 0.15s;user-select:none;
                ${isOverdue?'border-left:3px solid var(--brand-danger);':''}"
         onmouseenter="this.style.borderColor='var(--border-strong)';this.style.boxShadow='var(--shadow-md)'"
         onmouseleave="this.style.borderColor='${isOverdue?'var(--brand-danger)':'var(--border-subtle)'}'
;this.style.boxShadow='none'">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;">${escHtml(opp.title||'—')}</div>
        <span style="font-family:var(--font-display);font-size:13px;font-weight:800;color:var(--brand-secondary);flex-shrink:0;">₹${Number(opp.value||0).toLocaleString('en-IN')}</span>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;">
        ${cust ? `👤 ${escHtml(cust.name)}` : `🏢 ${escHtml(opp.companyName||'—')}`}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:10px;color:var(--text-muted);">Close: ${opp.expectedClose||'—'}</span>
        <span style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${stage?.color||'var(--text-muted)'}20;color:${stage?.color||'var(--text-muted)'};">${opp.probability||0}%</span>
      </div>
      <!-- Probability bar -->
      <div style="background:var(--bg-overlay);border-radius:2px;height:4px;overflow:hidden;">
        <div style="height:100%;width:${opp.probability||0}%;background:${stage?.color||'var(--text-muted)'};border-radius:2px;"></div>
      </div>
      ${opp.assignedTo?`<div style="font-size:10px;color:var(--text-muted);margin-top:6px;">👤 ${escHtml(opp.assignedTo)}</div>`:''}
      ${isOverdue?`<div style="font-size:10px;color:var(--brand-danger);margin-top:4px;font-weight:600;">⚠ OVERDUE</div>`:''}
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// LIST VIEW
// ══════════════════════════════════════════════════════════════
let _filtOpps=[], _pageOpps=1;

function renderListView(container) {
  _filtOpps=[..._opps];
  container.innerHTML=`
    ${searchBar({id:'opps',placeholder:'Search opportunity, customer…',
      filters:[
        {key:'stage',label:'All Stages',options:STAGES.map(s=>({value:s.id,label:s.label}))},
        {key:'assignedTo',label:'All Owners',options:[...new Set(_opps.map(o=>o.assignedTo).filter(Boolean))].map(v=>({value:v,label:v}))},
      ],onSearch:'oppsSearch',onFilter:'oppsFilter'})}
    <div id="opps-table-wrap"></div>
    <div id="opps-pagination"></div>
  `;
  renderOppsTable();
  window.oppsSearch=debounce((q)=>{_filtOpps=searchFilter(_opps,q,['title','companyName','notes']);_pageOpps=1;renderOppsTable();},250);
  window.oppsFilter=(k,v)=>{_filtOpps=v?_opps.filter(o=>o[k]===v):[..._opps];_pageOpps=1;renderOppsTable();};
  window.setOppsPage=(p)=>{_pageOpps=p;renderOppsTable();};
}

function renderOppsTable(){
  const wrap=document.getElementById('opps-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('opps-count'); if(cnt) cnt.textContent=`${_filtOpps.length} opportunit${_filtOpps.length!==1?'ies':'y'}`;
  const start=(_pageOpps-1)*PER;
  wrap.innerHTML=buildTable({id:'opps-table',
    columns:[
      {key:'title',        label:'Opportunity',  render:r=>`<div style="font-size:13px;font-weight:600;">${escHtml(r.title||'—')}</div>`},
      {key:'customerId',   label:'Customer',     render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return avatarCell(c.name||r.companyName||'—',r.contactPerson||'','var(--brand-secondary)','rgba(0,200,150,0.12)')}},
      {key:'value',        label:'Value',        render:r=>`<span style="font-family:var(--font-display);font-size:13px;font-weight:700;color:var(--brand-secondary);">₹${Number(r.value||0).toLocaleString('en-IN')}</span>`},
      {key:'stage',        label:'Stage',        render:r=>{const s=STAGES.find(x=>x.id===r.stage)||{};return `<span style="padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${s.color||'var(--text-muted)'}20;color:${s.color||'var(--text-muted)'};">${s.icon||''} ${s.label||r.stage}</span>`}},
      {key:'probability',  label:'Prob %',       render:r=>{const pct=Number(r.probability||0);return `<div style="display:flex;align-items:center;gap:8px;"><div style="background:var(--bg-overlay);border-radius:4px;height:6px;width:60px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--brand-primary);border-radius:4px;"></div></div><span style="font-size:11px;font-family:var(--font-mono);">${pct}%</span></div>`}},
      {key:'weightedValue',label:'Weighted',     render:r=>{const w=Number(r.value||0)*(Number(r.probability||0)/100);return `<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">₹${w.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>`}},
      {key:'expectedClose',label:'Expected Close',render:r=>{if(!r.expectedClose)return'—';const overdue=new Date(r.expectedClose)<new Date()&&!['won','lost'].includes(r.stage);return `<span style="font-size:11px;color:${overdue?'var(--brand-danger)':'var(--text-muted)'};">${r.expectedClose}${overdue?' ⚠':''}</span>`}},
      {key:'assignedTo',   label:'Owner',        render:r=>`<span style="font-size:12px;">${escHtml(r.assignedTo||'—')}</span>`},
      {key:'actions',      label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View',       action:`viewOpp('${r.id}')`},
          {icon:'📄',label:'Quotation',  action:`createQuote('${r.id}')`},
          {icon:'🏆',label:'Mark Won',   action:`moveStage('${r.id}','won')`},
          {icon:'❌',label:'Mark Lost',  action:`moveStage('${r.id}','lost')`},
          {icon:'🗑',label:'Delete',     action:`deleteOpp('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtOpps.slice(start,start+PER),emptyMsg:'No opportunities yet',
  });
  document.getElementById('opps-pagination').innerHTML=buildPagination({id:'opps',total:_filtOpps.length,page:_pageOpps,perPage:PER,onChange:'setOppsPage'});
}

// ══════════════════════════════════════════════════════════════
// LEADS TAB
// ══════════════════════════════════════════════════════════════
let _filtLeads=[], _pageLeads=1;

function renderLeadsTab(container) {
  _filtLeads=[..._leads];
  container.innerHTML=`
    ${searchBar({id:'leads',placeholder:'Search lead, company, source…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'new',label:'New'},{value:'contacted',label:'Contacted'},{value:'qualified',label:'Qualified'},{value:'disqualified',label:'Disqualified'}]},
        {key:'source',label:'All Sources',options:[{value:'website',label:'Website'},{value:'referral',label:'Referral'},{value:'cold-call',label:'Cold Call'},{value:'social',label:'Social Media'},{value:'trade-show',label:'Trade Show'},{value:'other',label:'Other'}]},
      ],onSearch:'leadsSearch',onFilter:'leadsFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('lead-modal')">+ Add Lead</button>
    </div>
    <div id="leads-table-wrap"></div>
    <div id="leads-pagination"></div>
  `;

  document.getElementById('lead-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildLeadModal());
  renderLeadsTable();

  window.leadsSearch=debounce((q)=>{_filtLeads=searchFilter(_leads,q,['name','company','email','phone']);_pageLeads=1;renderLeadsTable();},250);
  window.leadsFilter=(k,v)=>{_filtLeads=v?_leads.filter(l=>l[k]===v):[..._leads];_pageLeads=1;renderLeadsTable();};
  window.setLeadsPage=(p)=>{_pageLeads=p;renderLeadsTable();};
}

function renderLeadsTable(){
  const wrap=document.getElementById('leads-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('leads-count'); if(cnt) cnt.textContent=`${_filtLeads.length} lead${_filtLeads.length!==1?'s':''}`;
  const start=(_pageLeads-1)*PER;
  wrap.innerHTML=buildTable({id:'leads-table',
    columns:[
      {key:'name',      label:'Lead',     render:r=>avatarCell(r.name||'—',r.company||'','var(--brand-primary)','rgba(10,132,255,0.12)')},
      {key:'email',     label:'Email',    render:r=>`<span style="font-size:11px;">${escHtml(r.email||'—')}</span>`},
      {key:'phone',     label:'Phone',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.phone||'—')}</span>`},
      {key:'source',    label:'Source',   render:r=>`<span class="badge badge-blue">${escHtml(r.source||'other')}</span>`},
      {key:'interest',  label:'Interest', render:r=>`<span style="font-size:12px;color:var(--text-secondary);">${escHtml((r.interest||'').slice(0,40))}${(r.interest||'').length>40?'…':''}</span>`},
      {key:'status',    label:'Status',   render:r=>badge(r.status||'new')},
      {key:'createdAt', label:'Added',    render:r=>`<span style="font-size:11px;color:var(--text-muted);">${timeAgo(r.createdAt)}</span>`},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'🎯',label:'Convert to Opp',action:`convertLead('${r.id}')`},
          {icon:'📅',label:'Log Activity',  action:`openActivityForLead('${r.id}')`},
          {icon:'✅',label:'Qualify',       action:`qualifyLead('${r.id}')`},
          {icon:'❌',label:'Disqualify',    action:`disqualifyLead('${r.id}')`},
          {icon:'🗑',label:'Delete',        action:`deleteLead('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtLeads.slice(start,start+PER),emptyMsg:'No leads yet',
  });
  document.getElementById('leads-pagination').innerHTML=buildPagination({id:'leads',total:_filtLeads.length,page:_pageLeads,perPage:PER,onChange:'setLeadsPage'});
}

function buildLeadModal(){
  return buildModal({
    id:'lead-modal',title:'Add Lead',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Contact Name <span class="required">*</span></label><input type="text" id="ld-name" class="form-input" placeholder="Full name"></div>
        <div class="form-group"><label class="form-label">Company</label><input type="text" id="ld-company" class="form-input" placeholder="Company name"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Email</label><input type="email" id="ld-email" class="form-input" placeholder="lead@company.com"></div>
        <div class="form-group"><label class="form-label">Phone</label><input type="tel" id="ld-phone" class="form-input" placeholder="9876543210" maxlength="10"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Lead Source</label>
          <select id="ld-source" class="form-select">
            <option value="website">Website</option><option value="referral">Referral</option>
            <option value="cold-call">Cold Call</option><option value="social">Social Media</option>
            <option value="trade-show">Trade Show / Exhibition</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Estimated Value (₹)</label><input type="number" id="ld-value" class="form-input" placeholder="0" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Interest / Product Inquiry</label>
        <textarea id="ld-interest" class="form-textarea" rows="2" placeholder="What product/service are they interested in?"></textarea>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea id="ld-notes" class="form-textarea" rows="2" placeholder="Additional context…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('lead-modal')">Cancel</button>
            <button class="btn btn-primary" id="lead-save-btn" onclick="saveLead()">Save Lead</button>`,
  });
}

// ══════════════════════════════════════════════════════════════
// QUOTATIONS TAB
// ══════════════════════════════════════════════════════════════
let _quotes=[], _filtQuotes=[], _pageQuotes=1;

async function renderQuoteTab(container){
  const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
  _quotes=await dbGetAll(PIPELINE_COLLECTIONS.QUOTATIONS,[...c,orderBy('createdAt','desc')]);
  _filtQuotes=[..._quotes];

  container.innerHTML=`
    ${searchBar({id:'quotes',placeholder:'Search quote number, customer…',
      filters:[{key:'status',label:'All Status',options:[{value:'draft',label:'Draft'},{value:'sent',label:'Sent'},{value:'accepted',label:'Accepted'},{value:'rejected',label:'Rejected'},{value:'expired',label:'Expired'}]}],
      onSearch:'quotesSearch',onFilter:'quotesFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('quote-modal')">+ New Quotation</button>
    </div>
    <div id="quotes-table-wrap"></div>
    <div id="quotes-pagination"></div>
  `;
  renderQuotesTable();
  window.quotesSearch=debounce((q)=>{_filtQuotes=searchFilter(_quotes,q,['quoteNo','customerName','notes']);_pageQuotes=1;renderQuotesTable();},250);
  window.quotesFilter=(k,v)=>{_filtQuotes=v?_quotes.filter(q=>q[k]===v):[..._quotes];_pageQuotes=1;renderQuotesTable();};
  window.setQuotesPage=(p)=>{_pageQuotes=p;renderQuotesTable();};
}

function renderQuotesTable(){
  const wrap=document.getElementById('quotes-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('quotes-count'); if(cnt) cnt.textContent=`${_filtQuotes.length} quotation${_filtQuotes.length!==1?'s':''}`;
  const start=(_pageQuotes-1)*PER;
  wrap.innerHTML=buildTable({id:'quotes-table',
    columns:[
      {key:'quoteNo',     label:'Quote #',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.quoteNo||'—')}</span>`},
      {key:'customerId',  label:'Customer',   render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||r.customerName||'—')}</span>`}},
      {key:'opportunityId',label:'Opportunity',render:r=>{const o=_opps.find(x=>x.id===r.opportunityId)||{};return o.id?`<span style="font-size:11px;color:var(--text-muted);">${escHtml(o.title||'—')}</span>`:'—'}},
      {key:'totalAmount', label:'Amount',     render:r=>`<span style="font-family:var(--font-display);font-size:13px;font-weight:700;color:var(--brand-secondary);">₹${Number(r.totalAmount||0).toLocaleString('en-IN')}</span>`},
      {key:'validUntil',  label:'Valid Until', render:r=>{if(!r.validUntil)return'—';const expired=new Date(r.validUntil)<new Date();return `<span style="font-size:11px;color:${expired?'var(--brand-danger)':'var(--text-muted)'};">${r.validUntil}${expired?' EXPIRED':''}</span>`}},
      {key:'status',      label:'Status',     render:r=>badge(r.status||'draft')},
      {key:'actions',     label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View Quote',      action:`viewQuote('${r.id}')`},
          {icon:'🖨️',label:'Print PDF',      action:`printQuote('${r.id}')`},
          {icon:'✅',label:'Mark Accepted',  action:`acceptQuote('${r.id}')`},
          {icon:'🛒',label:'Convert to Order',action:`convertQuoteToOrder('${r.id}')`},
          {icon:'🗑',label:'Delete',         action:`deleteQuote('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtQuotes.slice(start,start+PER),emptyMsg:'No quotations yet',
  });
  document.getElementById('quotes-pagination').innerHTML=buildPagination({id:'quotes',total:_filtQuotes.length,page:_pageQuotes,perPage:PER,onChange:'setQuotesPage'});
}

// ══════════════════════════════════════════════════════════════
// ACTIVITIES TAB
// ══════════════════════════════════════════════════════════════
let _filtActs=[], _pageActs=1;

function renderActivityTab(container){
  _filtActs=[..._activities];
  container.innerHTML=`
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="input-wrapper" style="flex:1;max-width:300px;">
        <span class="input-icon-left">🔍</span>
        <input type="text" id="act-search" class="form-input has-icon-left" placeholder="Search activities…" oninput="actSearch(this.value)">
      </div>
      <div id="act-count" style="font-size:12px;color:var(--text-muted);"></div>
      <button class="btn btn-primary btn-sm" onclick="openModal('activity-modal')">+ Log Activity</button>
    </div>

    <!-- Today's activities -->
    <div class="card" style="margin-bottom:var(--space-4);">
      <div class="card-header"><div class="card-title">📅 Today's Schedule</div></div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${_activities.filter(a=>a.date===new Date().toISOString().slice(0,10)).length ?
          _activities.filter(a=>a.date===new Date().toISOString().slice(0,10)).map(a=>activityRow(a)).join('') :
          `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No activities scheduled for today</div>`}
      </div>
    </div>

    <!-- All activities -->
    <div id="acts-list" style="display:flex;flex-direction:column;gap:6px;"></div>
    <div id="acts-pagination" style="margin-top:var(--space-3);"></div>
  `;
  renderActsList();
  window.actSearch=debounce((q)=>{_filtActs=searchFilter(_activities,q,['type','notes','relatedName']);_pageActs=1;renderActsList();},250);
  window.setActsPage=(p)=>{_pageActs=p;renderActsList();};
}

function activityRow(a){
  const typeIcon={call:'📞',email:'✉️',meeting:'🤝',demo:'💻',follow_up:'🔔',task:'✅',visit:'🏢'}[a.type]||'📌';
  const opp=_opps.find(o=>o.id===a.opportunityId)||{};
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);">
      <div style="width:36px;height:36px;border-radius:var(--radius-md);background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${typeIcon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(a.notes||a.type||'—')}</div>
        <div style="font-size:11px;color:var(--text-muted);">${escHtml(opp.title||a.relatedName||'—')} · ${a.date||'—'}</div>
      </div>
      ${a.outcome?`<span class="badge badge-${a.outcome==='positive'?'green':a.outcome==='negative'?'red':'gray'}">${escHtml(a.outcome)}</span>`:''}
      ${a.nextAction?`<div style="font-size:11px;color:var(--brand-warning);">→ ${escHtml(a.nextAction)}</div>`:''}
    </div>`;
}

function renderActsList(){
  const el=document.getElementById('acts-list'); if(!el)return;
  const cnt=document.getElementById('act-count'); if(cnt) cnt.textContent=`${_filtActs.length} activities`;
  const start=(_pageActs-1)*PER;
  el.innerHTML=_filtActs.slice(start,start+PER).map(a=>activityRow(a)).join('')||`<div style="text-align:center;padding:40px;color:var(--text-muted);">No activities logged yet</div>`;
  document.getElementById('acts-pagination').innerHTML=buildPagination({id:'acts',total:_filtActs.length,page:_pageActs,perPage:PER,onChange:'setActsPage'});
}

// ══════════════════════════════════════════════════════════════
// FORECAST TAB
// ══════════════════════════════════════════════════════════════
function renderForecastTab(container){
  const active=_opps.filter(o=>!['won','lost'].includes(o.stage));
  const byStage=STAGES.filter(s=>!['won','lost'].includes(s.id)).map(stage=>{
    const stageOpps=active.filter(o=>o.stage===stage.id);
    const pipeline=stageOpps.reduce((s,o)=>s+(Number(o.value)||0),0);
    const weighted=stageOpps.reduce((s,o)=>s+(Number(o.value)||0)*(Number(o.probability||stage.pct)/100),0);
    return {...stage,opps:stageOpps.length,pipeline,weighted};
  });

  const totalPipeline=byStage.reduce((s,x)=>s+x.pipeline,0);
  const totalWeighted=byStage.reduce((s,x)=>s+x.weighted,0);

  // Monthly forecast
  const monthlyForecast={};
  active.forEach(o=>{
    if(!o.expectedClose) return;
    const month=o.expectedClose.slice(0,7);
    if(!monthlyForecast[month]) monthlyForecast[month]={pipeline:0,weighted:0,count:0};
    monthlyForecast[month].pipeline+=(Number(o.value)||0);
    monthlyForecast[month].weighted+=(Number(o.value)||0)*(Number(o.probability||50)/100);
    monthlyForecast[month].count++;
  });

  container.innerHTML=`
    <div class="grid-2" style="margin-bottom:var(--space-5);">
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Total Pipeline</div>
        <div style="font-family:var(--font-display);font-size:28px;font-weight:800;color:var(--brand-primary);">${formatCurrency(totalPipeline,true)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${active.length} opportunities</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">Weighted Forecast</div>
        <div style="font-family:var(--font-display);font-size:28px;font-weight:800;color:var(--brand-secondary);">${formatCurrency(totalWeighted,true)}</div>
        <div style="font-size:11px;color:var(--text-muted);">Adjusted for probability</div>
      </div>
    </div>

    <!-- By Stage -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">Pipeline by Stage</div></div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${byStage.map(s=>`
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:600;color:${s.color};">${s.icon} ${s.label} (${s.opps} opps)</span>
              <div style="display:flex;gap:16px;">
                <span style="font-size:12px;color:var(--text-muted);">Pipeline: <strong style="font-family:var(--font-mono);">₹${s.pipeline.toLocaleString('en-IN')}</strong></span>
                <span style="font-size:12px;color:var(--text-muted);">Weighted: <strong style="font-family:var(--font-mono);color:${s.color};">₹${s.weighted.toLocaleString('en-IN',{maximumFractionDigits:0})}</strong></span>
              </div>
            </div>
            <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
              <div style="height:100%;width:${totalPipeline?Math.round((s.pipeline/totalPipeline)*100):0}%;background:${s.color};border-radius:4px;"></div>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Monthly Forecast -->
    <div class="card">
      <div class="card-header"><div class="card-title">Monthly Forecast</div></div>
      ${Object.keys(monthlyForecast).length?`
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Month</th><th>Opportunities</th><th style="text-align:right;">Pipeline Value</th><th style="text-align:right;">Weighted Forecast</th></tr></thead>
            <tbody>
              ${Object.entries(monthlyForecast).sort().map(([month,data])=>`
                <tr>
                  <td style="font-family:var(--font-mono);">${month}</td>
                  <td><span class="badge badge-blue">${data.count}</span></td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${data.pipeline.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${data.weighted.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`:`<div style="text-align:center;padding:30px;color:var(--text-muted);">Set expected close dates on opportunities to see monthly forecast</div>`}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════════════
function oppModal(){
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  return buildModal({
    id:'opp-modal',title:'<span id="opp-modal-title">New Opportunity</span>',size:'lg',
    body:`
      <input type="hidden" id="opp-id">
      <div class="form-group"><label class="form-label">Opportunity Title <span class="required">*</span></label>
        <input type="text" id="opp-title" class="form-input" placeholder="e.g. FleetPro — 50 Vehicle Fleet Management">
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Customer</label>
          <select id="opp-customer" class="form-select"><option value="">Select or type company…</option>${custOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Company Name (if not in CRM)</label>
          <input type="text" id="opp-company" class="form-input" placeholder="Company name">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Opportunity Value (₹) <span class="required">*</span></label>
          <input type="number" id="opp-value" class="form-input" placeholder="500000" min="0">
        </div>
        <div class="form-group"><label class="form-label">Stage</label>
          <select id="opp-stage" class="form-select">
            ${STAGES.map(s=>`<option value="${s.id}">${s.icon} ${s.label}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Win Probability (%)</label>
          <input type="number" id="opp-prob" class="form-input" value="25" min="0" max="100">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Expected Close Date</label>
          <input type="date" id="opp-close" class="form-input">
        </div>
        <div class="form-group"><label class="form-label">Assigned To</label>
          <input type="text" id="opp-owner" class="form-input" placeholder="Sales rep name" value="${escHtml(AuthState.profile?.name||'')}">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Contact Person</label>
          <input type="text" id="opp-contact" class="form-input" placeholder="Decision maker name">
        </div>
        <div class="form-group"><label class="form-label">Contact Phone</label>
          <input type="tel" id="opp-phone" class="form-input" placeholder="9876543210">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description / Next Steps</label>
        <textarea id="opp-notes" class="form-textarea" rows="3" placeholder="Describe the opportunity, customer pain points, next actions…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('opp-modal')">Cancel</button>
            <button class="btn btn-primary" id="opp-save-btn" onclick="saveOpp()">Save Opportunity</button>`,
  });
}

function activityModal(){
  const oppOpts=_opps.map(o=>`<option value="${o.id}">${escHtml(o.title||'—')}</option>`).join('');
  return buildModal({
    id:'activity-modal',title:'Log Activity',
    body:`
      <input type="hidden" id="act-opp-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Activity Type <span class="required">*</span></label>
          <select id="act-type" class="form-select">
            <option value="call">📞 Phone Call</option><option value="email">✉️ Email</option>
            <option value="meeting">🤝 Meeting</option><option value="demo">💻 Product Demo</option>
            <option value="follow_up">🔔 Follow-up</option><option value="visit">🏢 Client Visit</option>
            <option value="task">✅ Task</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="act-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Related Opportunity</label>
        <select id="act-opp" class="form-select"><option value="">General / No opportunity</option>${oppOpts}</select>
      </div>
      <div class="form-group"><label class="form-label">Notes / Summary <span class="required">*</span></label>
        <textarea id="act-notes" class="form-textarea" rows="3" placeholder="What was discussed, decided, agreed…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Outcome</label>
          <select id="act-outcome" class="form-select">
            <option value="positive">Positive</option><option value="neutral">Neutral</option>
            <option value="negative">Negative</option><option value="follow-up-needed">Follow-up Needed</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Next Action</label>
          <input type="text" id="act-next" class="form-input" placeholder="e.g. Send proposal by Friday">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Next Action Date</label>
        <input type="date" id="act-next-date" class="form-input">
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('activity-modal')">Cancel</button>
            <button class="btn btn-primary" id="act-save-btn" onclick="saveActivity()">Log Activity</button>`,
  });
}

function quotationModal(){
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const oppOpts=_opps.map(o=>`<option value="${o.id}">${escHtml(o.title||'—')}</option>`).join('');
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-price="${p.sellingPrice||0}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  return buildModal({
    id:'quote-modal',title:'Create Quotation',size:'xl',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Quote Number</label><input type="text" id="qt-no" class="form-input" value="QT-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label><select id="qt-customer" class="form-select"><option value="">Select…</option>${custOpts}</select></div>
        <div class="form-group"><label class="form-label">Linked Opportunity</label><select id="qt-opp" class="form-select"><option value="">None</option>${oppOpts}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Date</label><input type="date" id="qt-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Valid Until <span class="required">*</span></label><input type="date" id="qt-valid" class="form-input"></div>
        <div class="form-group"><label class="form-label">Payment Terms</label><select id="qt-terms" class="form-select"><option value="immediate">Immediate</option><option value="net30">Net 30</option><option value="net45">Net 45</option><option value="net60">Net 60</option></select></div>
      </div>

      <!-- Quote Items -->
      <div style="margin:var(--space-4) 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Quote Items</div>
          <button class="btn btn-secondary btn-sm" onclick="addQuoteLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table"><thead><tr><th>Product/Service</th><th style="width:70px;">Qty</th><th style="width:110px;">Unit Price</th><th style="width:70px;">Discount%</th><th style="width:70px;">GST%</th><th style="width:100px;">Total</th><th style="width:36px;"></th></tr></thead>
          <tbody id="qt-lines-body"></tbody></table>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-top:10px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <div style="font-size:12px;color:var(--text-muted);">Subtotal: <strong id="qt-sub">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">Discount: <strong id="qt-disc" style="color:var(--brand-secondary);">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">GST: <strong id="qt-gst">₹0</strong></div>
          <div style="font-size:15px;font-weight:800;color:var(--brand-secondary);">Total: <span id="qt-total">₹0</span></div>
        </div>
      </div>

      <div class="form-group"><label class="form-label">Terms & Conditions</label>
        <textarea id="qt-terms-text" class="form-textarea" rows="2" placeholder="Delivery terms, warranty, payment conditions…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('quote-modal')">Cancel</button>
            <button class="btn btn-primary" id="qt-save-btn" onclick="saveQuotation()">Save Quotation</button>`,
  });
}

// ── Register all globals ──────────────────────────────────────
let _qtLines=[];

window.addQuoteLine=()=>{
  const idx=_qtLines.length; _qtLines.push({productId:'',qty:1,unitPrice:0,discount:0,gstRate:18});
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-price="${p.sellingPrice||0}" data-gst="${p.gstRate||18}">${escHtml(p.name)}</option>`).join('');
  const row=document.createElement('tr'); row.id=`qt-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:160px;" onchange="qtLineProduct(${idx},this)"><option value="">Select…</option>${prodOpts}</select></td>
    <td><input type="number" class="form-input" style="width:60px;" value="1" min="1" onchange="_qtLines[${idx}].qty=this.value;calcQtTotals()"></td>
    <td><input type="number" id="qt-price-${idx}" class="form-input" style="width:100px;" value="0" min="0" onchange="_qtLines[${idx}].unitPrice=this.value;calcQtTotals()"></td>
    <td><input type="number" class="form-input" style="width:60px;" value="0" min="0" max="100" onchange="_qtLines[${idx}].discount=this.value;calcQtTotals()"></td>
    <td><input type="number" id="qt-gst-${idx}" class="form-input" style="width:60px;" value="18" onchange="_qtLines[${idx}].gstRate=this.value;calcQtTotals()"></td>
    <td><span id="qt-line-total-${idx}" style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹0</span></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="document.getElementById('qt-line-${idx}')?.remove();_qtLines[${idx}]=null;calcQtTotals()">✕</button></td>
  `;
  document.getElementById('qt-lines-body').appendChild(row);
  calcQtTotals();
};

window.qtLineProduct=(idx,select)=>{
  const opt=select.options[select.selectedIndex];
  const price=Number(opt?.dataset?.price)||0; const gst=Number(opt?.dataset?.gst)||18;
  _qtLines[idx]={..._qtLines[idx],productId:opt.value,unitPrice:price,gstRate:gst};
  const pe=document.getElementById(`qt-price-${idx}`); if(pe) pe.value=price;
  const ge=document.getElementById(`qt-gst-${idx}`);   if(ge) ge.value=gst;
  calcQtTotals();
};

window.calcQtTotals=()=>{
  let sub=0,disc=0,gst=0;
  _qtLines.filter(Boolean).forEach((l,idx)=>{
    const base=(Number(l.qty)||0)*(Number(l.unitPrice)||0);
    const d=base*(Number(l.discount)||0)/100;
    const taxable=base-d;
    const g=taxable*(Number(l.gstRate)||0)/100;
    sub+=taxable; disc+=d; gst+=g;
    const te=document.getElementById(`qt-line-total-${idx}`);
    if(te) te.textContent='₹'+(taxable+g).toLocaleString('en-IN',{maximumFractionDigits:0});
  });
  const s=document.getElementById('qt-sub');   if(s) s.textContent='₹'+sub.toLocaleString('en-IN',{maximumFractionDigits:0});
  const d=document.getElementById('qt-disc');  if(d) d.textContent='₹'+disc.toLocaleString('en-IN',{maximumFractionDigits:0});
  const g=document.getElementById('qt-gst');   if(g) g.textContent='₹'+gst.toLocaleString('en-IN',{maximumFractionDigits:0});
  const t=document.getElementById('qt-total'); if(t) t.textContent='₹'+(sub+gst).toLocaleString('en-IN',{maximumFractionDigits:0});
};

// Save functions
window.saveOpp=async()=>{
  if(!validateForm([{id:'opp-title',label:'Title',required:true},{id:'opp-value',label:'Value',required:true}])) return;
  const btn=document.getElementById('opp-save-btn'); setLoading(btn,true);
  const id=document.getElementById('opp-id').value;
  const stage=document.getElementById('opp-stage').value;
  const data={title:document.getElementById('opp-title').value.trim(),customerId:document.getElementById('opp-customer').value||null,companyName:document.getElementById('opp-company').value.trim(),value:Number(document.getElementById('opp-value').value)||0,stage,probability:Number(document.getElementById('opp-prob').value)||25,expectedClose:document.getElementById('opp-close').value||null,assignedTo:document.getElementById('opp-owner').value.trim(),contactPerson:document.getElementById('opp-contact').value.trim(),contactPhone:document.getElementById('opp-phone').value.trim(),notes:document.getElementById('opp-notes').value.trim(),companyId:AuthState.company?.id||null};
  try{
    if(id){await dbUpdate(PIPELINE_COLLECTIONS.OPPORTUNITIES,id,data);Toast.success('Updated',`${data.title} updated.`);}
    else{await dbCreate(PIPELINE_COLLECTIONS.OPPORTUNITIES,data);Toast.success('Created',`${data.title} added to pipeline.`);}
    closeModal('opp-modal');
    ['opp-id','opp-title','opp-company','opp-value','opp-close','opp-contact','opp-phone','opp-notes'].forEach(x=>{const e=document.getElementById(x);if(e)e.value='';});
    await window.refreshPipeline?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveLead=async()=>{
  if(!validateForm([{id:'ld-name',label:'Name',required:true}])) return;
  const btn=document.getElementById('lead-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(PIPELINE_COLLECTIONS.LEADS,{name:document.getElementById('ld-name').value.trim(),company:document.getElementById('ld-company').value.trim(),email:document.getElementById('ld-email').value.trim(),phone:document.getElementById('ld-phone').value.trim(),source:document.getElementById('ld-source').value,estimatedValue:Number(document.getElementById('ld-value').value)||0,interest:document.getElementById('ld-interest').value.trim(),notes:document.getElementById('ld-notes').value.trim(),status:'new',companyId:AuthState.company?.id||null});
    Toast.success('Lead Added','Lead saved to pipeline.');
    closeModal('lead-modal');
    await window.refreshPipeline?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveActivity=async()=>{
  if(!validateForm([{id:'act-notes',label:'Notes',required:true},{id:'act-date',label:'Date',required:true}])) return;
  const btn=document.getElementById('act-save-btn'); setLoading(btn,true);
  try{
    const oppId=document.getElementById('act-opp').value;
    const opp=_opps.find(o=>o.id===oppId)||{};
    await dbCreate(PIPELINE_COLLECTIONS.ACTIVITIES,{type:document.getElementById('act-type').value,date:document.getElementById('act-date').value,opportunityId:oppId||null,relatedName:opp.title||'',notes:document.getElementById('act-notes').value.trim(),outcome:document.getElementById('act-outcome').value,nextAction:document.getElementById('act-next').value.trim(),nextActionDate:document.getElementById('act-next-date').value||null,loggedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
    Toast.success('Logged','Activity recorded.');
    closeModal('activity-modal');
    await window.refreshPipeline?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveQuotation=async()=>{
  if(!validateForm([{id:'qt-customer',label:'Customer',required:true},{id:'qt-valid',label:'Valid Until',required:true}])) return;
  const valid=_qtLines.filter(l=>l&&l.productId);
  if(!valid.length){Toast.error('No items','Add at least one item.');return;}
  const btn=document.getElementById('qt-save-btn'); setLoading(btn,true);
  const sub=valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(1-(Number(l.discount)||0)/100)+s,0);
  const gst=valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitPrice)||0)*(1-(Number(l.discount)||0)/100)*((Number(l.gstRate)||0)/100)+s,0);
  const custId=document.getElementById('qt-customer').value;
  const cust=_customers.find(c=>c.id===custId)||{};
  try{
    await dbCreate(PIPELINE_COLLECTIONS.QUOTATIONS,{quoteNo:document.getElementById('qt-no').value.trim(),customerId:custId,customerName:cust.name||'',opportunityId:document.getElementById('qt-opp').value||null,quoteDate:document.getElementById('qt-date').value,validUntil:document.getElementById('qt-valid').value,paymentTerms:document.getElementById('qt-terms').value,items:valid,subtotal:sub,gstAmount:gst,totalAmount:sub+gst,termsText:document.getElementById('qt-terms-text').value.trim(),status:'draft',companyId:AuthState.company?.id||null});
    Toast.success('Quotation Created','Quotation saved.');
    closeModal('quote-modal'); _qtLines=[]; document.getElementById('qt-lines-body').innerHTML='';
    await window.refreshPipeline?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

// Action helpers
window.viewOpp=(id)=>{
  const o=_opps.find(x=>x.id===id); if(!o)return;
  document.getElementById('opp-modal-title').textContent='Edit Opportunity';
  document.getElementById('opp-id').value=o.id;
  document.getElementById('opp-title').value=o.title||'';
  document.getElementById('opp-customer').value=o.customerId||'';
  document.getElementById('opp-company').value=o.companyName||'';
  document.getElementById('opp-value').value=o.value||'';
  document.getElementById('opp-stage').value=o.stage||'lead';
  document.getElementById('opp-prob').value=o.probability||25;
  document.getElementById('opp-close').value=o.expectedClose||'';
  document.getElementById('opp-owner').value=o.assignedTo||'';
  document.getElementById('opp-contact').value=o.contactPerson||'';
  document.getElementById('opp-phone').value=o.contactPhone||'';
  document.getElementById('opp-notes').value=o.notes||'';
  openModal('opp-modal');
};
window.moveStage=async(id,stage)=>{
  const s=STAGES.find(x=>x.id===stage);
  if(!confirm(`Move to ${s?.label||stage}?`))return;
  try{await dbUpdate(PIPELINE_COLLECTIONS.OPPORTUNITIES,id,{stage,[`${stage}At`]:new Date().toISOString()});Toast.success('Moved',`Opportunity moved to ${s?.label||stage}.`);await window.refreshPipeline?.();}
  catch(e){Toast.error('Failed',e.message);}
};
window.deleteOpp=async(id)=>{if(!confirm('Delete opportunity?'))return;try{await dbDelete(PIPELINE_COLLECTIONS.OPPORTUNITIES,id);await window.refreshPipeline?.();Toast.success('Deleted','Opportunity removed.');}catch(e){Toast.error('Failed',e.message);}};
window.convertLead=async(id)=>{
  const l=_leads.find(x=>x.id===id); if(!l)return;
  document.getElementById('opp-title').value=`${l.company||l.name} — ${l.interest||'New Opportunity'}`;
  document.getElementById('opp-company').value=l.company||'';
  document.getElementById('opp-value').value=l.estimatedValue||0;
  document.getElementById('opp-contact').value=l.name||'';
  document.getElementById('opp-phone').value=l.phone||'';
  document.getElementById('opp-stage').value='qualified';
  document.getElementById('opp-prob').value=25;
  openModal('opp-modal');
  await dbUpdate(PIPELINE_COLLECTIONS.LEADS,id,{status:'qualified'});
};
window.qualifyLead=async(id)=>{try{await dbUpdate(PIPELINE_COLLECTIONS.LEADS,id,{status:'qualified'});Toast.success('Qualified','Lead marked as qualified.');}catch(e){Toast.error('Failed',e.message);}};
window.disqualifyLead=async(id)=>{try{await dbUpdate(PIPELINE_COLLECTIONS.LEADS,id,{status:'disqualified'});Toast.warning('Disqualified','Lead marked as disqualified.');}catch(e){Toast.error('Failed',e.message);}};
window.deleteLead=async(id)=>{if(!confirm('Delete lead?'))return;try{await dbDelete(PIPELINE_COLLECTIONS.LEADS,id);await window.refreshPipeline?.();Toast.success('Deleted','Lead removed.');}catch(e){Toast.error('Failed',e.message);}};
window.openActivityForLead=(leadId)=>{const l=_leads.find(x=>x.id===leadId);if(l){const el=document.getElementById('act-next');if(el)el.value=`Follow up with ${l.name}`;}openModal('activity-modal');};
window.createQuote=(oppId)=>{document.getElementById('qt-opp').value=oppId;const o=_opps.find(x=>x.id===oppId);if(o&&o.customerId)document.getElementById('qt-customer').value=o.customerId;_qtLines=[];document.getElementById('qt-lines-body').innerHTML='';addQuoteLine();openModal('quote-modal');};
window.viewQuote = async (id) => {
  const q = _quotes.find(x => x.id === id);
  if (!q) { Toast.error('Not found','Quotation not found.'); return; }
  const co = AuthState.company || {};
  const validDate = q.validUntil ? new Date(q.validUntil) : null;
  const isExpired = validDate && validDate < new Date();

  // Build print-ready quote window
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { Toast.error('Blocked','Allow popups to view quotation.'); return; }

  const itemRows = (q.items || []).map(it => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;">${escHtml(it.description||it.name||'—')}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;text-align:center;">${it.qty||1}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;text-align:right;">₹${Number(it.rate||it.unitPrice||0).toLocaleString('en-IN')}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;text-align:center;">${it.gst||it.gstRate||18}%</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;text-align:right;font-weight:600;">₹${Number(it.amount||((it.qty||1)*(it.rate||it.unitPrice||0))).toLocaleString('en-IN')}</td>
    </tr>`).join('');

  win.document.write(`<!DOCTYPE html><html><head>
    <title>Quotation ${escHtml(q.quoteNo||'—')} — ${escHtml(q.customerName||'—')}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:Arial,sans-serif;font-size:13px;color:#1e293b;background:#f8fafc;padding:24px;}
      .doc{max-width:800px;margin:0 auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-radius:8px;overflow:hidden;}
      .header{background:linear-gradient(135deg,#1e3a5f,#0a84ff);color:#fff;padding:28px 32px;}
      .header h1{font-size:26px;font-weight:800;letter-spacing:-0.5px;}
      .header .sub{font-size:12px;opacity:0.7;margin-top:4px;}
      .body-pad{padding:28px 32px;}
      .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;}
      .meta-box{background:#f8fafc;border-radius:8px;padding:16px;}
      .meta-box .label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:8px;}
      .meta-row{display:flex;justify-content:space-between;padding:3px 0;font-size:12px;border-bottom:1px solid #f1f5f9;}
      .meta-row:last-child{border:none;}
      .meta-row .k{color:#64748b;}
      .meta-row .v{font-weight:600;color:#1e293b;}
      table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12px;}
      th{background:#1e3a5f;color:#fff;padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;}
      th:not(:first-child){text-align:center;}
      th:last-child,th:nth-child(3){text-align:right;}
      .totals{display:flex;justify-content:flex-end;margin-bottom:24px;}
      .totals-box{width:280px;}
      .tot-row{display:flex;justify-content:space-between;padding:6px 12px;font-size:13px;border-bottom:1px solid #f1f5f9;}
      .tot-row.final{background:#0a84ff;color:#fff;border-radius:6px;font-weight:800;font-size:15px;padding:10px 12px;border:none;}
      .terms{background:#fff8e1;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:0 6px 6px 0;margin-bottom:20px;font-size:12px;}
      .status-badge{display:inline-block;padding:4px 14px;border-radius:99px;font-size:11px;font-weight:700;text-transform:uppercase;}
      .status-draft{background:#e2e8f0;color:#475569;}
      .status-sent{background:#dbeafe;color:#1d4ed8;}
      .status-accepted{background:#dcfce7;color:#166534;}
      .status-rejected{background:#fee2e2;color:#991b1b;}
      .actions{display:flex;gap:12px;padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;}
      .btn-print{background:#0a84ff;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;}
      .btn-close{background:#e2e8f0;color:#475569;border:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;}
      @media print{.actions{display:none;}body{background:#fff;padding:0;}.doc{box-shadow:none;border-radius:0;}print-color-adjust:exact;}
    </style></head><body>
    <div class="doc">
      <div class="header">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <h1>${escHtml(co.name||'Company Name')}</h1>
            <div class="sub">${escHtml(co.address||'')}${co.gstin?'  ·  GSTIN: '+co.gstin:''}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;">QUOTATION</div>
            <div style="font-size:14px;opacity:0.85;margin-top:4px;">${escHtml(q.quoteNo||'—')}</div>
            <span class="status-badge status-${q.status||'draft'}" style="margin-top:8px;display:inline-block;">${(q.status||'draft').toUpperCase()}</span>
          </div>
        </div>
      </div>

      <div class="body-pad">
        <div class="meta-grid">
          <div class="meta-box">
            <div class="label">Bill To</div>
            <div style="font-size:15px;font-weight:700;color:#0a84ff;">${escHtml(q.customerName||'—')}</div>
            ${q.customerAddress?`<div style="font-size:11px;color:#64748b;margin-top:4px;">${escHtml(q.customerAddress)}</div>`:''}
            ${q.customerGst?`<div style="font-size:11px;color:#64748b;">GSTIN: ${escHtml(q.customerGst)}</div>`:''}
          </div>
          <div class="meta-box">
            <div class="label">Quotation Details</div>
            <div class="meta-row"><span class="k">Quote No.</span><span class="v">${escHtml(q.quoteNo||'—')}</span></div>
            <div class="meta-row"><span class="k">Quote Date</span><span class="v">${q.quoteDate||'—'}</span></div>
            <div class="meta-row"><span class="k">Valid Until</span><span class="v" style="color:${isExpired?'#dc2626':'#166534'};">${q.validUntil||'—'}${isExpired?' (EXPIRED)':''}</span></div>
            <div class="meta-row"><span class="k">Payment Terms</span><span class="v">${escHtml(q.paymentTerms||'—')}</span></div>
          </div>
        </div>

        <table>
          <thead><tr>
            <th style="width:40%;">Description</th>
            <th style="width:10%;text-align:center;">Qty</th>
            <th style="width:15%;text-align:right;">Rate (₹)</th>
            <th style="width:10%;text-align:center;">GST %</th>
            <th style="width:15%;text-align:right;">Amount (₹)</th>
          </tr></thead>
          <tbody>${itemRows||'<tr><td colspan="5" style="padding:20px;text-align:center;color:#94a3b8;">No items</td></tr>'}</tbody>
        </table>

        <div class="totals">
          <div class="totals-box">
            <div class="tot-row"><span>Subtotal</span><span>₹${Number(q.subtotal||0).toLocaleString('en-IN')}</span></div>
            <div class="tot-row"><span>GST Amount</span><span>₹${Number(q.gstAmount||0).toLocaleString('en-IN')}</span></div>
            <div class="tot-row final"><span>TOTAL</span><span>₹${Number(q.totalAmount||0).toLocaleString('en-IN')}</span></div>
          </div>
        </div>

        ${q.termsText?`<div class="terms"><strong>Terms & Conditions:</strong><br>${escHtml(q.termsText)}</div>`:''}

        <div style="margin-top:32px;display:flex;justify-content:space-between;">
          <div style="text-align:center;">
            <div style="border-top:1px solid #cbd5e1;padding-top:8px;width:180px;font-size:11px;color:#64748b;">Prepared By</div>
          </div>
          <div style="text-align:center;">
            <div style="border-top:1px solid #cbd5e1;padding-top:8px;width:180px;font-size:11px;color:#64748b;">Authorized Signatory</div>
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="btn-print" onclick="window.print()">🖨️ Print / Save PDF</button>
        <button class="btn-close" onclick="window.close()">✕ Close</button>
      </div>
    </div>
  </body></html>`);
  win.document.close();
};
window.printQuote=(id)=>{ if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'Quotation' }); else window.print(); };
window.acceptQuote=async(id)=>{try{await dbUpdate(PIPELINE_COLLECTIONS.QUOTATIONS,id,{status:'accepted',acceptedAt:new Date().toISOString()});Toast.success('Accepted','Quotation marked as accepted.');}catch(e){Toast.error('Failed',e.message);}};
window.convertQuoteToOrder=(id)=>{const q=_quotes.find(x=>x.id===id);if(q){Toast.info('Converting','Redirecting to Sales Orders…');setTimeout(()=>LAM.Router.navigate('orders'),800);}};
window.deleteQuote=async(id)=>{if(!confirm('Delete quotation?'))return;try{await dbDelete(PIPELINE_COLLECTIONS.QUOTATIONS,id);await renderQuoteTab(document.getElementById('pipe-tab-content'));Toast.success('Deleted','Quotation removed.');}catch(e){Toast.error('Failed',e.message);}};
window.exportPipeline=()=>{
  const csv=[['Title','Company','Value','Stage','Probability','Weighted','Expected Close','Owner'],
    ..._opps.map(o=>{const c=_customers.find(x=>x.id===o.customerId)||{};return[o.title,c.name||o.companyName,o.value,o.stage,o.probability,(Number(o.value)||0)*(Number(o.probability||0)/100),o.expectedClose,o.assignedTo];})
  ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='pipeline_export.csv'; a.click();
  Toast.success('Exported','Pipeline exported.');
};
