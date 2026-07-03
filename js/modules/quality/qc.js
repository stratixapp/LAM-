// ============================================================
// LAM — Quality Control (QC) Module
// Incoming QC, In-process QC, Final inspection,
// Defect tracking, Supplier quality, Non-conformance reports
// Interconnects: GRN → QC → Inventory → Procurement → MFG
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

export const QC_COLLECTIONS = {
  INSPECTIONS: 'qc_inspections',
  DEFECTS:     'qc_defects',
  CHECKLISTS:  'qc_checklists',
  NCR:         'qc_ncr',       // Non-Conformance Reports
};

let _inspections=[], _defects=[], _products=[], _vendors=[], _inventory=[];
let _activeTab='dashboard';
const PER=15;

export async function renderQualityControl(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_inspections, _defects, _products, _vendors, _inventory] = await Promise.all([
    dbGetAll(QC_COLLECTIONS.INSPECTIONS, [...c, orderBy('createdAt','desc')]),
    dbGetAll(QC_COLLECTIONS.DEFECTS,     [...c, orderBy('createdAt','desc')]),
    dbGetAll(COLLECTIONS.PRODUCTS,       [...c]),
    dbGetAll(COLLECTIONS.VENDORS,        [...c]),
    dbGetAll(COLLECTIONS.INVENTORY,      [...c]),
  ]);

  container.innerHTML = pageShell({
    title: '🔍 Quality Control',
    subtitle: 'Incoming inspection, in-process QC, defect tracking and supplier quality management.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="refreshQC()">↻ Refresh</button>
      <button class="btn btn-primary" onclick="openModal('inspection-modal')">+ New Inspection</button>
    `,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="qc-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['dashboard',  '📊 Dashboard'],
          ['inspections','🔍 Inspections'],
          ['defects',    '⚠️ Defect Tracker'],
          ['ncr',        '📋 NCR'],
          ['supplier',   '🤝 Supplier Quality'],
          ['checklist',  '✅ Checklists'],
        ].map(([id,label]) => `
          <button class="qc-tab ${id==='dashboard'?'active':''}" id="qc-tab-${id}"
            onclick="switchQCTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="qc-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.qc-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderQCKPIs();
  setupModalClose(); setupMenuClose();
  document.body.insertAdjacentHTML('beforeend', inspectionModal());
  document.body.insertAdjacentHTML('beforeend', defectModal());
  document.body.insertAdjacentHTML('beforeend', ncrModal());

  window.switchQCTab = switchQCTab;
  window.refreshQC   = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_inspections,_defects]=await Promise.all([
      dbGetAll(QC_COLLECTIONS.INSPECTIONS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(QC_COLLECTIONS.DEFECTS,[...c,orderBy('createdAt','desc')]),
    ]);
    renderQCKPIs(); switchQCTab(_activeTab);
  };
  switchQCTab('dashboard');
}

function renderQCKPIs() {
  const el=document.getElementById('qc-kpis'); if(!el) return; el.innerHTML='';
  const total      = _inspections.length;
  const passed     = _inspections.filter(i=>i.result==='pass').length;
  const failed     = _inspections.filter(i=>i.result==='fail').length;
  const conditional= _inspections.filter(i=>i.result==='conditional').length;
  const passRate   = total ? Math.round((passed/total)*100) : 0;
  const openDefects= _defects.filter(d=>d.status==='open').length;

  [
    {label:'Total Inspections', value:total,        icon:'🔍', color:'kpi-blue'},
    {label:'Passed',            value:passed,        icon:'✅', color:'kpi-green'},
    {label:'Failed',            value:failed,        icon:'❌', color:failed>0?'kpi-red':'kpi-green'},
    {label:'Pass Rate',         value:passRate+'%',  icon:'📊', color:passRate>=90?'kpi-green':'kpi-yellow'},
    {label:'Open Defects',      value:openDefects,   icon:'⚠️', color:openDefects>0?'kpi-orange':'kpi-green'},
  ].forEach((k,i) => {
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchQCTab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.qc-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`qc-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('qc-tab-content'); if(!c) return;
  switch(tab) {
    case 'dashboard':   renderQCDashboard(c);   break;
    case 'inspections': renderInspectionsTab(c); break;
    case 'defects':     renderDefectsTab(c);     break;
    case 'ncr':         renderNCRTab(c);         break;
    case 'supplier':    renderSupplierQCTab(c);  break;
    case 'checklist':   renderChecklistTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// QC DASHBOARD
// ══════════════════════════════════════════════════════════════
function renderQCDashboard(container) {
  const total   = _inspections.length;
  const passed  = _inspections.filter(i=>i.result==='pass').length;
  const failed  = _inspections.filter(i=>i.result==='fail').length;
  const cond    = _inspections.filter(i=>i.result==='conditional').length;

  // Defect by category
  const defectsByCat = {};
  _defects.forEach(d => { defectsByCat[d.category||'Other'] = (defectsByCat[d.category||'Other']||0)+1; });

  // Pass rate by product
  const byProduct = {};
  _inspections.forEach(i => {
    const p = _products.find(x=>x.id===i.productId);
    const name = p?.name || i.productId || 'Unknown';
    if (!byProduct[name]) byProduct[name]={total:0,passed:0};
    byProduct[name].total++;
    if (i.result==='pass') byProduct[name].passed++;
  });

  container.innerHTML = `
    <div class="grid-2" style="gap:var(--space-5);margin-bottom:var(--space-5);">
      <!-- Inspection results donut -->
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Inspection Results</div></div>
        <div style="display:flex;align-items:center;gap:var(--space-5);padding:var(--space-4);">
          <!-- Visual bars -->
          <div style="flex:1;display:flex;flex-direction:column;gap:10px;">
            ${[
              ['Passed',      passed, total, 'var(--brand-secondary)'],
              ['Failed',      failed, total, 'var(--brand-danger)'],
              ['Conditional', cond,   total, 'var(--brand-warning)'],
            ].map(([label,count,tot,color])=>`
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
                  <span style="font-size:12px;font-weight:500;">${label}</span>
                  <span style="font-size:12px;font-weight:700;color:${color};">${count} (${tot?Math.round((count/tot)*100):0}%)</span>
                </div>
                <div style="background:var(--bg-overlay);border-radius:4px;height:10px;overflow:hidden;">
                  <div style="height:100%;width:${tot?Math.round((count/tot)*100):0}%;background:${color};border-radius:4px;transition:width 0.8s;"></div>
                </div>
              </div>`).join('')}
          </div>
          <!-- Big pass rate number -->
          <div style="text-align:center;flex-shrink:0;">
            <div style="font-family:var(--font-display);font-size:52px;font-weight:800;color:${(total?Math.round((passed/total)*100):0)>=90?'var(--brand-secondary)':'var(--brand-warning)'};">${total?Math.round((passed/total)*100):0}%</div>
            <div style="font-size:12px;color:var(--text-muted);">Pass Rate</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${total} total</div>
          </div>
        </div>
      </div>

      <!-- Defects by category -->
      <div class="card">
        <div class="card-header"><div class="card-title">⚠️ Defects by Category</div></div>
        ${Object.keys(defectsByCat).length?`
          <div style="display:flex;flex-direction:column;gap:10px;padding:var(--space-4);">
            ${Object.entries(defectsByCat).sort((a,b)=>b[1]-a[1]).map(([cat,count])=>{
              const total=_defects.length;
              const pct=total?Math.round((count/total)*100):0;
              return `
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:12px;">${escHtml(cat)}</span>
                    <span style="font-size:12px;font-weight:700;color:var(--brand-danger);">${count}</span>
                  </div>
                  <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:var(--brand-danger);border-radius:4px;opacity:0.7;"></div>
                  </div>
                </div>`;
            }).join('')}
          </div>`:`<div style="padding:var(--space-5);text-align:center;color:var(--text-muted);">No defects recorded ✅</div>`}
      </div>
    </div>

    <!-- Product quality table -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">📦 Quality by Product</div></div>
      ${Object.keys(byProduct).length?`
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Product</th><th>Inspections</th><th>Passed</th><th>Failed</th><th>Pass Rate</th><th>Quality</th></tr></thead>
            <tbody>
              ${Object.entries(byProduct).map(([name,data])=>{
                const pct=Math.round((data.passed/data.total)*100);
                return `<tr>
                  <td style="font-size:12px;font-weight:500;">${escHtml(name)}</td>
                  <td style="font-family:var(--font-mono);">${data.total}</td>
                  <td style="font-family:var(--font-mono);color:var(--brand-secondary);">${data.passed}</td>
                  <td style="font-family:var(--font-mono);color:var(--brand-danger);">${data.total-data.passed}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="background:var(--bg-overlay);border-radius:4px;height:6px;width:80px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:${pct>=90?'var(--brand-secondary)':pct>=70?'var(--brand-warning)':'var(--brand-danger)'};border-radius:4px;"></div>
                      </div>
                      <span style="font-size:11px;font-weight:700;">${pct}%</span>
                    </div>
                  </td>
                  <td>${pct>=90?`<span class="badge badge-green">Excellent</span>`:pct>=70?`<span class="badge badge-yellow">Average</span>`:`<span class="badge badge-red">Poor</span>`}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`:`<div style="padding:var(--space-5);text-align:center;color:var(--text-muted);">No inspection data</div>`}
    </div>

    <!-- Recent inspections -->
    <div class="card">
      <div class="card-header"><div class="card-title">🕐 Recent Inspections</div><button class="btn btn-secondary btn-sm" onclick="switchQCTab('inspections')">View All</button></div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${_inspections.slice(0,6).map(insp=>{
          const p=_products.find(x=>x.id===insp.productId)||{};
          return `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${insp.result==='pass'?'var(--brand-secondary)':insp.result==='fail'?'var(--brand-danger)':'var(--brand-warning)'};">
              <span style="font-size:18px;">${insp.result==='pass'?'✅':insp.result==='fail'?'❌':'⚠️'}</span>
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:600;">${escHtml(p.name||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${escHtml(insp.type||'—')} · ${formatDate(insp.createdAt)}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:12px;color:var(--text-muted);">${insp.qty||0} ${escHtml(p.unit||'pcs')}</div>
                <div style="font-size:11px;color:${insp.defects>0?'var(--brand-danger)':'var(--brand-secondary)'};">${insp.defects||0} defects</div>
              </div>
            </div>`;
        }).join('') || `<div style="padding:var(--space-4);text-align:center;color:var(--text-muted);">No inspections yet</div>`}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
// INSPECTIONS TAB
// ══════════════════════════════════════════════════════════════
let _filtInsp=[], _pageInsp=1;

function renderInspectionsTab(container) {
  _filtInsp=[..._inspections];
  container.innerHTML=`
    ${searchBar({id:'insp',placeholder:'Search inspection no, product…',
      filters:[
        {key:'type',label:'All Types',options:[{value:'incoming',label:'Incoming'},{value:'in-process',label:'In-Process'},{value:'final',label:'Final'},{value:'outgoing',label:'Outgoing'}]},
        {key:'result',label:'All Results',options:[{value:'pass',label:'Pass'},{value:'fail',label:'Fail'},{value:'conditional',label:'Conditional'}]},
      ],onSearch:'inspSearch',onFilter:'inspFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('inspection-modal')">+ New Inspection</button>
    </div>
    <div id="insp-table-wrap"></div>
    <div id="insp-pagination"></div>
  `;
  renderInspTable();
  window.inspSearch=debounce((q)=>{_filtInsp=searchFilter(_inspections,q,['inspectionNo','notes']);_pageInsp=1;renderInspTable();},250);
  window.inspFilter=(k,v)=>{_filtInsp=v?_inspections.filter(i=>i[k]===v):[..._inspections];_pageInsp=1;renderInspTable();};
  window.setInspPage=(p)=>{_pageInsp=p;renderInspTable();};
}

function renderInspTable() {
  const wrap=document.getElementById('insp-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('insp-count'); if(cnt) cnt.textContent=`${_filtInsp.length} inspection${_filtInsp.length!==1?'s':''}`;
  const start=(_pageInsp-1)*PER;
  wrap.innerHTML=buildTable({id:'insp-table',
    columns:[
      {key:'inspectionNo',label:'Inspection #', render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.inspectionNo||'—')}</span>`},
      {key:'type',        label:'Type',         render:r=>`<span class="badge badge-blue">${escHtml(r.type||'—')}</span>`},
      {key:'productId',   label:'Product',      render:r=>{const p=_products.find(x=>x.id===r.productId)||{};return `<span style="font-size:12px;">${escHtml(p.name||'—')}</span>`}},
      {key:'qty',         label:'Qty Inspected',render:r=>`<span style="font-family:var(--font-mono);">${r.qty||0}</span>`},
      {key:'defects',     label:'Defects',      render:r=>`<span style="font-family:var(--font-mono);color:${r.defects>0?'var(--brand-danger)':'var(--brand-secondary)'};">${r.defects||0}</span>`},
      {key:'defectRate',  label:'Defect Rate',  render:r=>{const rate=r.qty?Math.round(((r.defects||0)/r.qty)*100):0;return `<span style="font-family:var(--font-mono);color:${rate>5?'var(--brand-danger)':rate>2?'var(--brand-warning)':'var(--brand-secondary)'};">${rate}%</span>`}},
      {key:'inspector',   label:'Inspector',    render:r=>`<span style="font-size:12px;">${escHtml(r.inspector||'—')}</span>`},
      {key:'result',      label:'Result',       render:r=>`<span class="badge badge-${r.result==='pass'?'green':r.result==='fail'?'red':'yellow'}">${r.result==='pass'?'✅ Pass':r.result==='fail'?'❌ Fail':'⚠️ Conditional'}</span>`},
      {key:'date',        label:'Date',         render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
      {key:'actions',     label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View Report',  action:`viewInspection('${r.id}')`},
          {icon:'⚠️',label:'Log Defect',  action:`openDefectForInsp('${r.id}')`},
          {icon:'🗑',label:'Delete',      action:`deleteInspection('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtInsp.slice(start,start+PER),emptyMsg:'No inspections yet',
  });
  document.getElementById('insp-pagination').innerHTML=buildPagination({id:'insp',total:_filtInsp.length,page:_pageInsp,perPage:PER,onChange:'setInspPage'});
}

// ══════════════════════════════════════════════════════════════
// DEFECTS TAB
// ══════════════════════════════════════════════════════════════
let _filtDef=[], _pageDef=1;

function renderDefectsTab(container) {
  _filtDef=[..._defects];
  container.innerHTML=`
    ${searchBar({id:'def',placeholder:'Search defect, product…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'open',label:'Open'},{value:'in-review',label:'In Review'},{value:'resolved',label:'Resolved'},{value:'wontfix',label:"Won't Fix"}]},
        {key:'severity',label:'All Severity',options:[{value:'critical',label:'Critical'},{value:'major',label:'Major'},{value:'minor',label:'Minor'},{value:'cosmetic',label:'Cosmetic'}]},
        {key:'category',label:'All Categories',options:[{value:'dimensional',label:'Dimensional'},{value:'surface',label:'Surface'},{value:'functional',label:'Functional'},{value:'packaging',label:'Packaging'},{value:'labeling',label:'Labeling'},{value:'other',label:'Other'}]},
      ],onSearch:'defSearch',onFilter:'defFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('defect-modal')">+ Log Defect</button>
    </div>
    <div id="def-table-wrap"></div>
    <div id="def-pagination"></div>
  `;
  renderDefTable();
  window.defSearch=debounce((q)=>{_filtDef=searchFilter(_defects,q,['title','notes','rootCause']);_pageDef=1;renderDefTable();},250);
  window.defFilter=(k,v)=>{_filtDef=v?_defects.filter(d=>d[k]===v):[..._defects];_pageDef=1;renderDefTable();};
  window.setDefPage=(p)=>{_pageDef=p;renderDefTable();};
}

function renderDefTable() {
  const wrap=document.getElementById('def-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('def-count'); if(cnt) cnt.textContent=`${_filtDef.length} defect${_filtDef.length!==1?'s':''}`;
  const start=(_pageDef-1)*PER;
  const sevColors={critical:'var(--brand-danger)',major:'var(--brand-warning)',minor:'var(--brand-primary)',cosmetic:'var(--text-muted)'};
  wrap.innerHTML=buildTable({id:'def-table',
    columns:[
      {key:'title',     label:'Defect',    render:r=>`<div style="font-size:12px;font-weight:500;">${escHtml(r.title||'—')}</div>`},
      {key:'productId', label:'Product',   render:r=>{const p=_products.find(x=>x.id===r.productId)||{};return `<span style="font-size:12px;">${escHtml(p.name||'—')}</span>`}},
      {key:'category',  label:'Category',  render:r=>`<span class="badge badge-blue">${escHtml(r.category||'other')}</span>`},
      {key:'severity',  label:'Severity',  render:r=>{const c=sevColors[r.severity]||'var(--text-muted)';return `<span style="padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${c}20;color:${c};text-transform:uppercase;">${r.severity||'minor'}</span>`}},
      {key:'qty',       label:'Defective', render:r=>`<span style="font-family:var(--font-mono);color:var(--brand-danger);">${r.defectiveQty||0}</span>`},
      {key:'rootCause', label:'Root Cause',render:r=>`<span style="font-size:11px;color:var(--text-secondary);">${escHtml((r.rootCause||'—').slice(0,40))}${(r.rootCause||'').length>40?'…':''}</span>`},
      {key:'corrective',label:'Corrective',render:r=>r.correctiveAction?`<span class="badge badge-green">Assigned</span>`:`<span class="badge badge-gray">Pending</span>`},
      {key:'status',    label:'Status',    render:r=>badge(r.status||'open')},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'✅',label:'Resolve',       action:`resolveDefect('${r.id}')`},
          {icon:'📋',label:'Create NCR',    action:`createNCRFromDefect('${r.id}')`},
          {icon:'🗑',label:'Delete',        action:`deleteDefect('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtDef.slice(start,start+PER),emptyMsg:'No defects logged',
  });
  document.getElementById('def-pagination').innerHTML=buildPagination({id:'def',total:_filtDef.length,page:_pageDef,perPage:PER,onChange:'setDefPage'});
}

// ══════════════════════════════════════════════════════════════
// NCR TAB
// ══════════════════════════════════════════════════════════════
async function renderNCRTab(container) {
  const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
  const ncrs=await dbGetAll(QC_COLLECTIONS.NCR,[...c,orderBy('createdAt','desc')]);

  container.innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('ncr-modal')">+ Raise NCR</button>
    </div>
    ${ncrs.length?`
      <div class="table-container">
        <table class="table">
          <thead><tr><th>NCR #</th><th>Product</th><th>Vendor</th><th>Description</th><th>Qty Rejected</th><th>Disposition</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${ncrs.map(ncr=>{
              const p=_products.find(x=>x.id===ncr.productId)||{};
              const v=_vendors.find(x=>x.id===ncr.vendorId)||{};
              return `<tr>
                <td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(ncr.ncrNumber||'—')}</td>
                <td style="font-size:12px;">${escHtml(p.name||'—')}</td>
                <td style="font-size:12px;">${escHtml(v.name||v.companyName||'—')}</td>
                <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(ncr.description||'—')}</td>
                <td style="font-family:var(--font-mono);color:var(--brand-danger);">${ncr.rejectedQty||0}</td>
                <td><span class="badge badge-${ncr.disposition==='return'?'orange':ncr.disposition==='scrap'?'red':'blue'}">${escHtml(ncr.disposition||'pending')}</span></td>
                <td>${badge(ncr.status||'open')}</td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-secondary btn-sm" onclick="closeNCR('${ncr.id}')">Close</button>
                    <button class="btn btn-ghost btn-icon" onclick="deleteNCR('${ncr.id}')" style="color:var(--brand-danger);">🗑</button>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`:`<div style="text-align:center;padding:60px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:12px;opacity:0.3;">📋</div><div style="font-size:14px;font-weight:500;margin-bottom:8px;">No NCRs raised</div></div>`}
  `;

  window.closeNCR=async(id)=>{try{await dbUpdate(QC_COLLECTIONS.NCR,id,{status:'closed',closedAt:new Date().toISOString()});Toast.success('NCR Closed','NCR marked as closed.');await window.refreshQC?.();}catch(e){Toast.error('Failed',e.message);}};
  window.deleteNCR=async(id)=>{if(!confirm('Delete NCR?'))return;try{await dbDelete(QC_COLLECTIONS.NCR,id);await window.refreshQC?.();Toast.success('Deleted','NCR removed.');}catch(e){Toast.error('Failed',e.message);}};
}

// ══════════════════════════════════════════════════════════════
// SUPPLIER QUALITY TAB
// ══════════════════════════════════════════════════════════════
function renderSupplierQCTab(container) {
  // Calculate supplier quality scores
  const supplierScores=_vendors.map(v=>{
    const supplierInsp=_inspections.filter(i=>i.vendorId===v.id);
    const totalInsp=supplierInsp.length;
    const passed=supplierInsp.filter(i=>i.result==='pass').length;
    const totalDefects=supplierInsp.reduce((s,i)=>s+(Number(i.defects)||0),0);
    const totalQty=supplierInsp.reduce((s,i)=>s+(Number(i.qty)||0),0);
    const passRate=totalInsp?Math.round((passed/totalInsp)*100):null;
    const defectRate=totalQty?Math.round((totalDefects/totalQty)*10000)/100:0;
    const score=passRate!==null?Math.min(100,Math.max(0,passRate-(defectRate*5))):null;
    return {...v,totalInsp,passed,totalDefects,passRate,defectRate,score};
  }).filter(v=>v.totalInsp>0).sort((a,b)=>b.score-a.score);

  container.innerHTML=`
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header"><div class="card-title">🏆 Supplier Quality Scorecard</div></div>
      ${supplierScores.length?`
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Supplier</th><th>Inspections</th><th>Pass Rate</th><th>Defect Rate (PPM)</th><th>Quality Score</th><th>Rating</th></tr></thead>
            <tbody>
              ${supplierScores.map(v=>`
                <tr>
                  <td>${avatarCell(v.name||v.companyName||'—','','var(--brand-primary)','rgba(10,132,255,0.12)')}</td>
                  <td style="font-family:var(--font-mono);">${v.totalInsp}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="background:var(--bg-overlay);border-radius:4px;height:6px;width:80px;overflow:hidden;">
                        <div style="height:100%;width:${v.passRate||0}%;background:${v.passRate>=90?'var(--brand-secondary)':v.passRate>=70?'var(--brand-warning)':'var(--brand-danger)'};border-radius:4px;"></div>
                      </div>
                      <span style="font-size:11px;font-weight:700;">${v.passRate??'—'}%</span>
                    </div>
                  </td>
                  <td style="font-family:var(--font-mono);color:${v.defectRate>1?'var(--brand-danger)':v.defectRate>0.5?'var(--brand-warning)':'var(--brand-secondary)'};">${(v.defectRate*100).toFixed(0)} PPM</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="background:var(--bg-overlay);border-radius:4px;height:8px;width:100px;overflow:hidden;">
                        <div style="height:100%;width:${v.score||0}%;background:${(v.score||0)>=80?'var(--brand-secondary)':(v.score||0)>=60?'var(--brand-warning)':'var(--brand-danger)'};border-radius:4px;"></div>
                      </div>
                      <span style="font-family:var(--font-mono);font-size:13px;font-weight:800;color:${(v.score||0)>=80?'var(--brand-secondary)':(v.score||0)>=60?'var(--brand-warning)':'var(--brand-danger)'};">${v.score?.toFixed(0)??'—'}</span>
                    </div>
                  </td>
                  <td>${(v.score||0)>=90?`<span class="badge badge-green">⭐ A+ Preferred</span>`:(v.score||0)>=70?`<span class="badge badge-yellow">👍 B Approved</span>`:`<span class="badge badge-red">⚠️ C Under Review</span>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`:`<div style="padding:var(--space-5);text-align:center;color:var(--text-muted);">No supplier inspection data. Link vendors to inspections to see scores.</div>`}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
// CHECKLISTS TAB
// ══════════════════════════════════════════════════════════════
function renderChecklistTab(container) {
  const defaultChecklists=[
    {id:'incoming',name:'Incoming Material Inspection',items:['Check quantity against PO','Verify packaging integrity','Check expiry dates / batch numbers','Dimensional check (random sample)','Visual surface inspection','Test functionality (if applicable)','Check documentation (invoice, COC)','Update GRN and inventory']},
    {id:'inprocess',name:'In-Process Quality Check',items:['Raw material verified before start','Machine/tool calibration confirmed','First-piece inspection done','Process parameters within spec','Worker skill/training verified','WIP tagged and tracked','Intermediate measurements logged','Defects segregated immediately']},
    {id:'final',name:'Final Product Inspection (FPI)',items:['100% visual inspection','Dimensional verification (AQL 2.5)','Functional/performance test','Weight check (if applicable)','Label and marking verification','Packaging check and seal','Documentation complete','Release for shipment']},
    {id:'outgoing',name:'Pre-Shipment Inspection',items:['Quantity matches delivery note','Packing list verified','Product specification match','Delivery note attached','Vehicle condition check','Temperature/humidity ok (if required)','Seal number recorded','Customer-specific requirements met']},
  ];

  container.innerHTML=`
    <div class="grid-2">
      ${defaultChecklists.map(cl=>`
        <div class="card">
          <div class="card-header">
            <div class="card-title">${escHtml(cl.name)}</div>
            <button class="btn btn-primary btn-sm" onclick="startChecklist('${cl.id}')">▶ Start</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;" id="checklist-items-${cl.id}">
            ${cl.items.map((item,i)=>`
              <label style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;">
                <input type="checkbox" id="cl-${cl.id}-${i}" style="accent-color:var(--brand-primary);flex-shrink:0;" onchange="updateChecklistProgress('${cl.id}',${cl.items.length})">
                <span style="font-size:12px;" id="cl-label-${cl.id}-${i}">${escHtml(item)}</span>
              </label>`).join('')}
          </div>
          <div style="margin-top:12px;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;color:var(--text-muted);">Progress</span>
              <span id="cl-pct-${cl.id}" style="font-size:12px;font-weight:700;color:var(--brand-primary);">0/${cl.items.length}</span>
            </div>
            <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
              <div id="cl-bar-${cl.id}" style="height:100%;width:0%;background:var(--brand-primary);border-radius:4px;transition:width 0.3s;"></div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" style="margin-top:10px;width:100%;" onclick="saveChecklistResult('${cl.id}','${escHtml(cl.name)}',${cl.items.length})">💾 Save Result</button>
        </div>`).join('')}
    </div>
  `;

  window.updateChecklistProgress=(clId,total)=>{
    const checked=document.querySelectorAll(`input[id^="cl-${clId}-"]:checked`).length;
    const pct=Math.round((checked/total)*100);
    const pctEl=document.getElementById(`cl-pct-${clId}`); if(pctEl) pctEl.textContent=`${checked}/${total}`;
    const barEl=document.getElementById(`cl-bar-${clId}`); if(barEl){barEl.style.width=pct+'%';barEl.style.background=pct===100?'var(--brand-secondary)':'var(--brand-primary)';}
  };

  window.saveChecklistResult=async(clId,clName,total)=>{
    const checked=document.querySelectorAll(`input[id^="cl-${clId}-"]:checked`).length;
    if(checked<total&&!confirm(`Only ${checked}/${total} items checked. Save anyway?`)) return;
    try{
      await dbCreate(QC_COLLECTIONS.INSPECTIONS,{inspectionNo:'INS-'+genId(),type:clId,result:checked===total?'pass':'conditional',checklist:clName,checkedItems:checked,totalItems:total,inspector:AuthState.profile?.name||'',date:new Date().toISOString().slice(0,10),qty:1,defects:0,companyId:AuthState.company?.id||null});
      Toast.success('Saved!',`Checklist result saved: ${checked}/${total} items passed.`);
      await window.refreshQC?.();
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.startChecklist=(clId)=>Toast.info('Checklist','Check off each item as you inspect. Save when done.');
}

// ══════════════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════════════
function inspectionModal() {
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  const vendorOpts=_vendors.map(v=>`<option value="${v.id}">${escHtml(v.name||v.companyName||'—')}</option>`).join('');
  return buildModal({
    id:'inspection-modal',title:'New QC Inspection',size:'lg',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Inspection No.</label><input type="text" id="ins-no" class="form-input" value="INS-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
          <select id="ins-type" class="form-select">
            <option value="incoming">Incoming Material</option><option value="in-process">In-Process</option>
            <option value="final">Final Product</option><option value="outgoing">Pre-Shipment</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Date</label><input type="date" id="ins-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label><select id="ins-product" class="form-select"><option value="">Select…</option>${prodOpts}</select></div>
        <div class="form-group"><label class="form-label">Vendor (if incoming)</label><select id="ins-vendor" class="form-select"><option value="">Select…</option>${vendorOpts}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Qty Inspected <span class="required">*</span></label><input type="number" id="ins-qty" class="form-input" placeholder="100" min="1"></div>
        <div class="form-group"><label class="form-label">Defects Found</label><input type="number" id="ins-defects" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Sample Size (AQL)</label>
          <select id="ins-aql" class="form-select"><option value="normal">Normal (AQL 1.5)</option><option value="tightened">Tightened (AQL 1.0)</option><option value="reduced">Reduced (AQL 4.0)</option><option value="100pct">100% Inspection</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Inspection Result <span class="required">*</span></label>
        <div style="display:flex;gap:12px;margin-top:8px;">
          ${[['pass','✅ Pass','var(--brand-secondary)'],['conditional','⚠️ Conditional','var(--brand-warning)'],['fail','❌ Fail','var(--brand-danger)']].map(([val,label,color])=>`
            <label style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;border:2px solid var(--border-subtle);flex:1;justify-content:center;"
                   onmouseenter="this.style.borderColor='${color}'" onmouseleave="this.querySelectorAll('input')[0].checked||(this.style.borderColor='var(--border-subtle)')">
              <input type="radio" name="ins-result" value="${val}" style="accent-color:${color};">
              <span style="font-size:13px;font-weight:600;">${label}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Inspector Name</label><input type="text" id="ins-inspector" class="form-input" value="${escHtml(AuthState.profile?.name||'')}"></div>
        <div class="form-group"><label class="form-label">Batch / Lot No.</label><input type="text" id="ins-batch" class="form-input" placeholder="Batch number"></div>
      </div>
      <div class="form-group"><label class="form-label">Observations / Notes</label><textarea id="ins-notes" class="form-textarea" rows="2" placeholder="Inspection observations…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('inspection-modal')">Cancel</button>
            <button class="btn btn-primary" id="ins-save-btn" onclick="saveInspection()">Save Inspection</button>`,
  });
}

function defectModal() {
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  return buildModal({
    id:'defect-modal',title:'Log Defect',
    body:`
      <input type="hidden" id="def-insp-id">
      <div class="form-group"><label class="form-label">Defect Title <span class="required">*</span></label><input type="text" id="def-title" class="form-input" placeholder="Brief defect description"></div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label><select id="def-product" class="form-select"><option value="">Select…</option>${prodOpts}</select></div>
        <div class="form-group"><label class="form-label">Category</label>
          <select id="def-category" class="form-select">
            <option value="dimensional">Dimensional</option><option value="surface">Surface Finish</option>
            <option value="functional">Functional</option><option value="packaging">Packaging</option>
            <option value="labeling">Labeling</option><option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Severity</label>
          <select id="def-severity" class="form-select">
            <option value="cosmetic">Cosmetic</option><option value="minor">Minor</option>
            <option value="major">Major</option><option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Defective Qty</label><input type="number" id="def-qty" class="form-input" placeholder="0" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Root Cause</label><textarea id="def-root" class="form-textarea" rows="2" placeholder="What caused this defect?"></textarea></div>
      <div class="form-group"><label class="form-label">Corrective Action</label><textarea id="def-action" class="form-textarea" rows="2" placeholder="What action will be taken to fix and prevent recurrence?"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('defect-modal')">Cancel</button>
            <button class="btn btn-primary" id="def-save-btn" onclick="saveDefect()">Log Defect</button>`,
  });
}

function ncrModal() {
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  const vendorOpts=_vendors.map(v=>`<option value="${v.id}">${escHtml(v.name||v.companyName||'—')}</option>`).join('');
  return buildModal({
    id:'ncr-modal',title:'Raise Non-Conformance Report (NCR)',size:'lg',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">NCR Number</label><input type="text" id="ncr-no" class="form-input" value="NCR-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label><select id="ncr-product" class="form-select"><option value="">Select…</option>${prodOpts}</select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Vendor (source)</label><select id="ncr-vendor" class="form-select"><option value="">Select…</option>${vendorOpts}</select></div>
        <div class="form-group"><label class="form-label">Rejected Qty</label><input type="number" id="ncr-qty" class="form-input" placeholder="0" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Non-Conformance Description <span class="required">*</span></label>
        <textarea id="ncr-desc" class="form-textarea" rows="3" placeholder="Describe the non-conformance in detail…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Disposition</label>
          <select id="ncr-disp" class="form-select">
            <option value="return">Return to Vendor</option><option value="rework">Rework/Repair</option>
            <option value="accept-deviation">Accept with Deviation</option><option value="scrap">Scrap / Write-off</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Root Cause Category</label>
          <select id="ncr-root-cat" class="form-select">
            <option value="design">Design Issue</option><option value="material">Material Problem</option>
            <option value="process">Process Error</option><option value="human">Human Error</option>
            <option value="supplier">Supplier Issue</option><option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Corrective Action Required</label>
        <textarea id="ncr-action" class="form-textarea" rows="2" placeholder="CAPA — Corrective and Preventive Action…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('ncr-modal')">Cancel</button>
            <button class="btn btn-primary" id="ncr-save-btn" onclick="saveNCR()">Raise NCR</button>`,
  });
}

// ── Global save functions ─────────────────────────────────────
window.saveInspection=async()=>{
  if(!validateForm([{id:'ins-product',label:'Product',required:true},{id:'ins-qty',label:'Qty',required:true}])) return;
  const resultEl=document.querySelector('input[name="ins-result"]:checked');
  if(!resultEl){Toast.error('Result Required','Select Pass, Conditional or Fail.');return;}
  const btn=document.getElementById('ins-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(QC_COLLECTIONS.INSPECTIONS,{inspectionNo:document.getElementById('ins-no').value.trim(),type:document.getElementById('ins-type').value,date:document.getElementById('ins-date').value,productId:document.getElementById('ins-product').value,vendorId:document.getElementById('ins-vendor').value||null,qty:Number(document.getElementById('ins-qty').value)||0,defects:Number(document.getElementById('ins-defects').value)||0,aql:document.getElementById('ins-aql').value,result:resultEl.value,inspector:document.getElementById('ins-inspector').value.trim(),batch:document.getElementById('ins-batch').value.trim(),notes:document.getElementById('ins-notes').value.trim(),companyId:AuthState.company?.id||null});
    Toast.success('Inspection Saved',`Result: ${resultEl.value}`);
    closeModal('inspection-modal');
    await window.refreshQC?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveDefect=async()=>{
  if(!validateForm([{id:'def-title',label:'Title',required:true},{id:'def-product',label:'Product',required:true}])) return;
  const btn=document.getElementById('def-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(QC_COLLECTIONS.DEFECTS,{title:document.getElementById('def-title').value.trim(),productId:document.getElementById('def-product').value,category:document.getElementById('def-category').value,severity:document.getElementById('def-severity').value,defectiveQty:Number(document.getElementById('def-qty').value)||0,rootCause:document.getElementById('def-root').value.trim(),correctiveAction:document.getElementById('def-action').value.trim(),inspectionId:document.getElementById('def-insp-id').value||null,status:'open',reportedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
    Toast.success('Defect Logged','Defect recorded.');
    closeModal('defect-modal');
    await window.refreshQC?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveNCR=async()=>{
  if(!validateForm([{id:'ncr-product',label:'Product',required:true},{id:'ncr-desc',label:'Description',required:true}])) return;
  const btn=document.getElementById('ncr-save-btn'); setLoading(btn,true);
  const prodId=document.getElementById('ncr-product').value;
  const p=_products.find(x=>x.id===prodId)||{};
  try{
    await dbCreate(QC_COLLECTIONS.NCR,{ncrNumber:document.getElementById('ncr-no').value.trim(),productId:prodId,productName:p.name||'',vendorId:document.getElementById('ncr-vendor').value||null,rejectedQty:Number(document.getElementById('ncr-qty').value)||0,description:document.getElementById('ncr-desc').value.trim(),disposition:document.getElementById('ncr-disp').value,rootCauseCategory:document.getElementById('ncr-root-cat').value,correctiveAction:document.getElementById('ncr-action').value.trim(),status:'open',raisedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
    Toast.success('NCR Raised','Non-Conformance Report created.');
    closeModal('ncr-modal');
    await window.refreshQC?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.viewInspection=(id)=>{
  const i=_inspections.find(x=>x.id===id); if(!i) return;
  const p=_products.find(x=>x.id===i.productId)||{};
  Toast.info(`${i.inspectionNo}`,`${p.name} — ${i.qty} units — ${i.defects} defects — Result: ${i.result}`);
};
window.openDefectForInsp=(id)=>{const el=document.getElementById('def-insp-id');if(el)el.value=id;openModal('defect-modal');};
window.resolveDefect=async(id)=>{try{await dbUpdate(QC_COLLECTIONS.DEFECTS,id,{status:'resolved',resolvedAt:new Date().toISOString()});Toast.success('Resolved','Defect resolved.');await window.refreshQC?.();}catch(e){Toast.error('Failed',e.message);}};
window.createNCRFromDefect=(defectId)=>{const d=_defects.find(x=>x.id===defectId);if(d){const el=document.getElementById('ncr-product');if(el)el.value=d.productId||'';const desc=document.getElementById('ncr-desc');if(desc)desc.value=d.title||'';}openModal('ncr-modal');};
window.deleteInspection=async(id)=>{if(!confirm('Delete inspection?'))return;try{await dbDelete(QC_COLLECTIONS.INSPECTIONS,id);await window.refreshQC?.();Toast.success('Deleted','Inspection removed.');}catch(e){Toast.error('Failed',e.message);}};
window.deleteDefect=async(id)=>{if(!confirm('Delete defect?'))return;try{await dbDelete(QC_COLLECTIONS.DEFECTS,id);await window.refreshQC?.();Toast.success('Deleted','Defect removed.');}catch(e){Toast.error('Failed',e.message);}};
