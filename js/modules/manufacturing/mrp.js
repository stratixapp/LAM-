// ============================================================
// LAM — Manufacturing / MRP / BOM Module
// Bill of Materials, Production Orders, MRP Engine,
// Work-in-Progress tracking, Cost of Production
// Interconnects: Inventory → BOM → Production → GL → Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, dbBatch, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { ACC_COLLECTIONS } from '../finance/accounting.js';
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

export const MFG_COLLECTIONS = {
  BOM:          'mfg_bom',
  PRODUCTION:   'mfg_production_orders',
  WORK_CENTERS: 'mfg_work_centers',
  OPERATIONS:   'mfg_operations',
  MRP_RUNS:     'mfg_mrp_runs',
};

let _products=[], _inventory=[], _boms=[], _productions=[], _workCenters=[];
let _activeTab='bom';
const PER=15;

export async function renderManufacturing(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_products, _inventory, _boms, _productions, _workCenters] = await Promise.all([
    dbGetAll(COLLECTIONS.PRODUCTS,       [...c]),
    dbGetAll(COLLECTIONS.INVENTORY,      [...c]),
    dbGetAll(MFG_COLLECTIONS.BOM,        [...c, orderBy('createdAt','desc')]),
    dbGetAll(MFG_COLLECTIONS.PRODUCTION, [...c, orderBy('createdAt','desc')]),
    dbGetAll(MFG_COLLECTIONS.WORK_CENTERS,[...c]),
  ]);

  container.innerHTML = pageShell({
    title: '🏭 Manufacturing & MRP',
    subtitle: 'Bill of Materials, production orders, MRP planning and work-in-progress tracking.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshMfg()">↻ Refresh</button>`,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="mfg-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['bom',         '📋 Bill of Materials'],
          ['production',  '🏭 Production Orders'],
          ['mrp',         '🤖 MRP Planning'],
          ['wip',         '⚙️ Work-in-Progress'],
          ['workcenters', '🔧 Work Centers'],
          ['costing',     '💰 Production Costing'],
        ].map(([id,label]) => `
          <button class="mfg-tab ${id==='bom'?'active':''}" id="mfg-tab-${id}"
            onclick="switchMfgTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="mfg-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = '.mfg-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderMfgKPIs();
  setupModalClose(); setupMenuClose();
  window.switchMfgTab = switchMfgTab;
  window.refreshMfg   = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_products,_inventory,_boms,_productions,_workCenters]=await Promise.all([
      dbGetAll(COLLECTIONS.PRODUCTS,[...c]),dbGetAll(COLLECTIONS.INVENTORY,[...c]),
      dbGetAll(MFG_COLLECTIONS.BOM,[...c,orderBy('createdAt','desc')]),
      dbGetAll(MFG_COLLECTIONS.PRODUCTION,[...c,orderBy('createdAt','desc')]),
      dbGetAll(MFG_COLLECTIONS.WORK_CENTERS,[...c]),
    ]);
    renderMfgKPIs(); switchMfgTab(_activeTab);
  };
  switchMfgTab('bom');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderMfgKPIs() {
  const el = document.getElementById('mfg-kpis'); if (!el) return; el.innerHTML = '';
  const activeProd  = _productions.filter(p=>p.status==='in-progress').length;
  const planned     = _productions.filter(p=>p.status==='planned').length;
  const completed   = _productions.filter(p=>p.status==='completed').length;
  const totalBOMs   = _boms.length;
  const wipValue    = _productions.filter(p=>p.status==='in-progress').reduce((s,p)=>s+(Number(p.estimatedCost)||0),0);

  [
    {label:'Bill of Materials',   value:totalBOMs,               icon:'📋', color:'kpi-blue'},
    {label:'Active Production',   value:activeProd,              icon:'🏭', color:'kpi-green'},
    {label:'Planned Orders',      value:planned,                 icon:'📅', color:'kpi-yellow'},
    {label:'Completed (MTD)',     value:completed,               icon:'✅', color:'kpi-orange'},
    {label:'WIP Value',           value:formatCurrency(wipValue,true), icon:'💰', color:'kpi-blue'},
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchMfgTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.mfg-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`mfg-tab-${tab}`)?.classList.add('active');
  const c = document.getElementById('mfg-tab-content'); if (!c) return;
  switch(tab) {
    case 'bom':         renderBOMTab(c);        break;
    case 'production':  renderProductionTab(c); break;
    case 'mrp':         renderMRPTab(c);        break;
    case 'wip':         renderWIPTab(c);        break;
    case 'workcenters': renderWorkCentersTab(c);break;
    case 'costing':     renderCostingTab(c);    break;
  }
}

// ══════════════════════════════════════════════════════════════
// BILL OF MATERIALS (BOM)
// ══════════════════════════════════════════════════════════════
let _filtBOMs=[], _pageBOMs=1;

function renderBOMTab(container) {
  _filtBOMs = [..._boms];
  container.innerHTML = `
    ${searchBar({id:'bom', placeholder:'Search product, BOM number…',
      filters:[{key:'status',label:'All Status',options:[{value:'active',label:'Active'},{value:'draft',label:'Draft'},{value:'obsolete',label:'Obsolete'}]}],
      onSearch:'bomSearch', onFilter:'bomFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('bom-modal')">+ Create BOM</button>
    </div>
    <div id="bom-table-wrap"></div>
    <div id="bom-pagination"></div>
    <div id="bom-detail-panel"></div>
  `;

  document.getElementById('bom-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', buildBOMModal());
  renderBOMTable();

  window.bomSearch = debounce((q)=>{_filtBOMs=searchFilter(_boms,q,['bomNumber','productName','description']);_pageBOMs=1;renderBOMTable();},250);
  window.bomFilter = (k,v)=>{_filtBOMs=v?_boms.filter(b=>b[k]===v):[..._boms];_pageBOMs=1;renderBOMTable();};
  window.setBOMPage = (p)=>{_pageBOMs=p;renderBOMTable();};
}

function renderBOMTable() {
  const wrap = document.getElementById('bom-table-wrap'); if (!wrap) return;
  const cnt  = document.getElementById('bom-count'); if(cnt) cnt.textContent=`${_filtBOMs.length} BOM${_filtBOMs.length!==1?'s':''}`;
  const start= (_pageBOMs-1)*PER;
  wrap.innerHTML = buildTable({
    id: 'bom-table',
    columns: [
      {key:'bomNumber',    label:'BOM No.',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.bomNumber||'—')}</span>`},
      {key:'productName',  label:'Finished Product', render:r=>{const p=_products.find(x=>x.id===r.finishedProductId);return avatarCell(p?.name||r.productName||'—',`SKU: ${p?.sku||'—'}`,'var(--brand-accent)','rgba(255,107,53,0.12)')}},
      {key:'version',      label:'Version',      render:r=>`<span class="badge badge-blue">v${r.version||'1.0'}</span>`},
      {key:'outputQty',    label:'Batch Size',   render:r=>`<span style="font-family:var(--font-mono);">${r.outputQty||1} ${escHtml(r.outputUnit||'pcs')}</span>`},
      {key:'components',   label:'Components',   render:r=>`<span class="badge badge-gray">${r.components?.length||0} items</span>`},
      {key:'estimatedCost',label:'Est. Cost',    render:r=>`<span style="font-family:var(--font-mono);">₹${Number(r.estimatedCost||0).toLocaleString('en-IN')}</span>`},
      {key:'status',       label:'Status',       render:r=>badge(r.status||'active')},
      {key:'actions',      label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View BOM',         action:`viewBOM('${r.id}')`},
          {icon:'🏭',label:'Create Production', action:`createProductionFromBOM('${r.id}')`},
          {icon:'📊',label:'Cost Analysis',     action:`bomCostAnalysis('${r.id}')`},
          {icon:'✏️',label:'Edit',             action:`editBOM('${r.id}')`},
          {icon:'🗑',label:'Delete',            action:`deleteBOM('${r.id}')`,danger:true},
        ])},
    ],
    rows: _filtBOMs.slice(start, start+PER),
    emptyMsg: 'No BOMs created yet',
  });
  document.getElementById('bom-pagination').innerHTML = buildPagination({id:'bom',total:_filtBOMs.length,page:_pageBOMs,perPage:PER,onChange:'setBOMPage'});
}

function buildBOMModal() {
  const prodOpts = _products.map(p=>`<option value="${p.id}" data-unit="${p.unit||'pcs'}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  return buildModal({
    id:'bom-modal', title:'<span id="bom-modal-title">Create Bill of Materials</span>', size:'xl',
    body:`
      <input type="hidden" id="bom-id">
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">BOM Number</label>
          <input type="text" id="bom-number" class="form-input" value="BOM-${genId()}" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Finished Product <span class="required">*</span></label>
          <select id="bom-product" class="form-select" onchange="updateBOMUnit(this)">
            <option value="">Select product…</option>${prodOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Version</label>
          <input type="text" id="bom-version" class="form-input" value="1.0" placeholder="1.0">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Batch Output Qty <span class="required">*</span></label>
          <input type="number" id="bom-output-qty" class="form-input" value="1" min="1">
        </div>
        <div class="form-group">
          <label class="form-label">Output Unit</label>
          <input type="text" id="bom-output-unit" class="form-input" placeholder="pcs" value="pcs" readonly style="background:var(--bg-overlay);">
        </div>
        <div class="form-group">
          <label class="form-label">Lead Time (days)</label>
          <input type="number" id="bom-lead-time" class="form-input" value="1" min="0">
        </div>
      </div>

      <!-- BOM Components -->
      <div style="margin:var(--space-4) 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:700;">Raw Materials / Components</div>
          <button class="btn btn-secondary btn-sm" onclick="addBOMLine()">+ Add Component</button>
        </div>
        <div class="table-container">
          <table class="table" id="bom-components-table">
            <thead>
              <tr>
                <th style="min-width:200px;">Component / Raw Material</th>
                <th style="width:100px;">Qty per Batch</th>
                <th style="width:80px;">Unit</th>
                <th style="width:100px;">Cost/Unit (₹)</th>
                <th style="width:100px;">Total Cost</th>
                <th style="width:100px;">Scrap %</th>
                <th style="width:40px;"></th>
              </tr>
            </thead>
            <tbody id="bom-lines-body"></tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:20px;margin-top:10px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
          <span style="font-size:12px;color:var(--text-muted);">Components: <strong id="bom-comp-count" style="color:var(--text-primary);">0</strong></span>
          <span style="font-size:12px;color:var(--text-muted);">Material Cost: <strong id="bom-mat-cost" style="color:var(--brand-primary);">₹0</strong></span>
          <span style="font-size:12px;color:var(--text-muted);">+ Overhead (10%): <strong id="bom-overhead" style="color:var(--text-secondary);">₹0</strong></span>
          <span style="font-size:13px;font-weight:700;color:var(--brand-secondary);">Total Est. Cost: <span id="bom-total-cost">₹0</span></span>
        </div>
      </div>

      <!-- Operations / Routing -->
      <div style="margin-bottom:var(--space-4);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:700;">Manufacturing Operations / Routing</div>
          <button class="btn btn-secondary btn-sm" onclick="addBOMOperation()">+ Add Operation</button>
        </div>
        <div id="bom-operations-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="bom-status" class="form-select">
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="obsolete">Obsolete</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Description / Notes</label>
          <input type="text" id="bom-desc" class="form-input" placeholder="BOM description…">
        </div>
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('bom-modal')">Cancel</button>
      <button class="btn btn-primary" id="bom-save-btn" onclick="saveBOM()">Save BOM</button>
    `,
  });
}

// BOM Line management
let _bomLines=[], _bomOps=[];

window.updateBOMUnit=(select)=>{
  const opt=select.options[select.selectedIndex];
  const unit=opt?.dataset?.unit||'pcs';
  const el=document.getElementById('bom-output-unit'); if(el) el.value=unit;
};

window.addBOMLine=(line={})=>{
  const idx=_bomLines.length;
  _bomLines.push({productId:'',qty:1,unit:'pcs',costPerUnit:0,scrapPct:0,...line});
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-unit="${p.unit||'pcs'}" data-cost="${p.costPrice||0}" ${line.productId===p.id?'selected':''}>${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  const row=document.createElement('tr'); row.id=`bom-line-${idx}`;
  row.innerHTML=`
    <td>
      <select class="form-select" style="min-width:180px;" onchange="updateBOMLineProduct(${idx},this)">
        <option value="">Select component…</option>${prodOpts}
      </select>
    </td>
    <td><input type="number" class="form-input" style="width:90px;" value="${line.qty||1}" min="0.001" step="0.001" onchange="updateBOMLine(${idx},'qty',this.value);calcBOMCost()"></td>
    <td><span id="bom-unit-${idx}" class="badge badge-gray">${line.unit||'pcs'}</span></td>
    <td><input type="number" id="bom-cost-${idx}" class="form-input" style="width:90px;" value="${line.costPerUnit||0}" min="0" step="0.01" onchange="updateBOMLine(${idx},'costPerUnit',this.value);calcBOMCost()"></td>
    <td><span id="bom-line-total-${idx}" style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹0</span></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.scrapPct||0}" min="0" max="100" placeholder="0%" onchange="updateBOMLine(${idx},'scrapPct',this.value);calcBOMCost()"></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removeBOMLine(${idx})">✕</button></td>
  `;
  document.getElementById('bom-lines-body').appendChild(row);
  calcBOMCost();
};

window.updateBOMLineProduct=(idx,select)=>{
  const opt=select.options[select.selectedIndex];
  const unit=opt?.dataset?.unit||'pcs';
  const cost=Number(opt?.dataset?.cost)||0;
  if(_bomLines[idx]){_bomLines[idx].productId=opt.value;_bomLines[idx].unit=unit;_bomLines[idx].costPerUnit=cost;}
  const unitEl=document.getElementById(`bom-unit-${idx}`); if(unitEl) unitEl.textContent=unit;
  const costEl=document.getElementById(`bom-cost-${idx}`); if(costEl&&!Number(costEl.value)) costEl.value=cost;
  if(_bomLines[idx]) _bomLines[idx].costPerUnit=cost;
  calcBOMCost();
};

window.updateBOMLine=(idx,key,val)=>{if(_bomLines[idx])_bomLines[idx][key]=val;};
window.removeBOMLine=(idx)=>{document.getElementById(`bom-line-${idx}`)?.remove();_bomLines[idx]=null;calcBOMCost();};

window.calcBOMCost=()=>{
  const active=_bomLines.filter(Boolean);
  let totalMat=0;
  active.forEach((l,idx)=>{
    const qty=Number(l.qty)||0;
    const cost=Number(l.costPerUnit)||0;
    const scrap=Number(l.scrapPct)||0;
    const totalQtyNeeded=qty*(1+scrap/100);
    const lineCost=totalQtyNeeded*cost;
    totalMat+=lineCost;
    const te=document.getElementById(`bom-line-total-${idx}`);
    if(te) te.textContent='₹'+lineCost.toLocaleString('en-IN',{maximumFractionDigits:2});
  });
  const overhead=totalMat*0.10;
  const total=totalMat+overhead;
  const cc=document.getElementById('bom-comp-count'); if(cc) cc.textContent=active.filter(l=>l.productId).length;
  const mc=document.getElementById('bom-mat-cost');   if(mc) mc.textContent='₹'+totalMat.toLocaleString('en-IN',{maximumFractionDigits:0});
  const oh=document.getElementById('bom-overhead');   if(oh) oh.textContent='₹'+overhead.toLocaleString('en-IN',{maximumFractionDigits:0});
  const tc=document.getElementById('bom-total-cost'); if(tc) tc.textContent='₹'+total.toLocaleString('en-IN',{maximumFractionDigits:0});
};

window.addBOMOperation=(op={})=>{
  const idx=_bomOps.length;
  _bomOps.push({name:'',workCenterId:'',durationMin:0,cost:0,...op});
  const wcOpts=_workCenters.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('');
  const el=document.getElementById('bom-operations-list'); if(!el) return;
  const row=document.createElement('div'); row.id=`bom-op-${idx}`;
  row.style.cssText='display:grid;grid-template-columns:1fr 150px 100px 100px 36px;gap:8px;align-items:center;padding:10px;background:var(--bg-elevated);border-radius:8px;';
  row.innerHTML=`
    <input type="text" class="form-input" placeholder="Operation name (e.g. Cutting, Welding…)" value="${escHtml(op.name||'')}" onchange="_bomOps[${idx}].name=this.value">
    <select class="form-select" onchange="_bomOps[${idx}].workCenterId=this.value"><option value="">Work Center…</option>${wcOpts}</select>
    <input type="number" class="form-input" placeholder="Mins" value="${op.durationMin||0}" min="0" onchange="_bomOps[${idx}].durationMin=this.value" title="Duration in minutes">
    <input type="number" class="form-input" placeholder="₹/hr cost" value="${op.cost||0}" min="0" step="0.01" onchange="_bomOps[${idx}].cost=this.value">
    <button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="document.getElementById('bom-op-${idx}')?.remove();_bomOps[${idx}]=null">✕</button>
  `;
  el.appendChild(row);
};

window.saveBOM=async()=>{
  if(!validateForm([{id:'bom-product',label:'Product',required:true},{id:'bom-output-qty',label:'Output Qty',required:true}])) return;
  const valid=_bomLines.filter(l=>l&&l.productId);
  if(!valid.length){Toast.error('No components','Add at least one raw material component.');return;}
  const btn=document.getElementById('bom-save-btn'); setLoading(btn,true);
  const id=document.getElementById('bom-id').value;
  const prodId=document.getElementById('bom-product').value;
  const prod=_products.find(p=>p.id===prodId);
  const totalMat=valid.reduce((s,l)=>{const qty=Number(l.qty)*(1+(Number(l.scrapPct)||0)/100);return s+qty*(Number(l.costPerUnit)||0);},0);
  const estimatedCost=totalMat*1.10;
  const data={
    bomNumber:document.getElementById('bom-number').value.trim(),
    finishedProductId:prodId,productName:prod?.name||'',
    version:document.getElementById('bom-version').value.trim()||'1.0',
    outputQty:Number(document.getElementById('bom-output-qty').value)||1,
    outputUnit:document.getElementById('bom-output-unit').value,
    leadTimeDays:Number(document.getElementById('bom-lead-time').value)||1,
    components:valid,operations:_bomOps.filter(Boolean),
    estimatedCost,status:document.getElementById('bom-status').value,
    description:document.getElementById('bom-desc').value.trim(),
    companyId:AuthState.company?.id||null,
  };
  try{
    if(id){await dbUpdate(MFG_COLLECTIONS.BOM,id,data);Toast.success('Updated',`BOM ${data.bomNumber} updated.`);}
    else{await dbCreate(MFG_COLLECTIONS.BOM,data);Toast.success('Created',`BOM ${data.bomNumber} created.`);}
    closeModal('bom-modal'); _bomLines=[]; _bomOps=[];
    document.getElementById('bom-lines-body').innerHTML='';
    const opsList=document.getElementById('bom-operations-list'); if(opsList) opsList.innerHTML='';
    await window.refreshMfg?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.viewBOM=async(id)=>{
  const bom=_boms.find(x=>x.id===id); if(!bom) return;
  document.getElementById('bom-detail-panel').innerHTML=`
    <div class="card" style="margin-top:var(--space-5);border:2px solid var(--border-strong);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--border-subtle);">
        <div>
          <div style="font-family:var(--font-display);font-size:18px;font-weight:700;">${escHtml(bom.bomNumber)} — ${escHtml(bom.productName)}</div>
          <div style="font-size:12px;color:var(--text-secondary);">v${bom.version} · Output: ${bom.outputQty} ${bom.outputUnit} · Lead Time: ${bom.leadTimeDays}d</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${badge(bom.status||'active')}
          <span style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--brand-secondary);">₹${Number(bom.estimatedCost||0).toLocaleString('en-IN')}</span>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('bom-detail-panel').innerHTML=''">✕ Close</button>
        </div>
      </div>

      <!-- Components Table -->
      <div style="padding:var(--space-4) var(--space-5);">
        <div style="font-size:13px;font-weight:700;margin-bottom:var(--space-3);">🧩 Components / Raw Materials</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Component</th><th>SKU</th><th>Qty per Batch</th><th>Unit</th><th>Scrap %</th><th>Effective Qty</th><th>Cost/Unit</th><th>Total Cost</th><th>In Stock?</th></tr></thead>
            <tbody>
              ${(bom.components||[]).map(c=>{
                const p=_products.find(x=>x.id===c.productId)||{};
                const totalInv=_inventory.filter(i=>i.productId===c.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
                const effectiveQty=Number(c.qty)*(1+(Number(c.scrapPct)||0)/100);
                const lineCost=effectiveQty*(Number(c.costPerUnit)||0);
                const sufficient=totalInv>=effectiveQty;
                return `<tr>
                  <td style="font-size:13px;font-weight:500;">${escHtml(p.name||c.productId||'—')}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(p.sku||'—')}</td>
                  <td style="font-family:var(--font-mono);">${c.qty}</td>
                  <td><span class="badge badge-gray">${escHtml(c.unit||'pcs')}</span></td>
                  <td style="font-family:var(--font-mono);">${c.scrapPct||0}%</td>
                  <td style="font-family:var(--font-mono);font-weight:600;">${effectiveQty.toFixed(3)}</td>
                  <td style="font-family:var(--font-mono);">₹${Number(c.costPerUnit||0).toLocaleString('en-IN')}</td>
                  <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${lineCost.toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      ${sufficient?`<span class="badge badge-green">✅ ${totalInv} in stock</span>`:`<span class="badge badge-red">❌ Need ${effectiveQty.toFixed(2)}, have ${totalInv}</span>`}
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot>
              <tr style="background:var(--bg-elevated);">
                <td colspan="7" style="font-weight:700;padding:10px 16px;">Total Material Cost</td>
                <td style="font-family:var(--font-mono);font-weight:800;color:var(--brand-secondary);padding:10px 16px;">₹${(bom.estimatedCost/1.10).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        ${(bom.operations||[]).length?`
          <div style="margin-top:var(--space-4);">
            <div style="font-size:13px;font-weight:700;margin-bottom:var(--space-3);">⚙️ Operations / Routing</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${bom.operations.map((op,i)=>`
                <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid var(--brand-primary);">
                  <div style="width:24px;height:24px;border-radius:50%;background:rgba(10,132,255,0.2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-primary);">${i+1}</div>
                  <div style="flex:1;">
                    <div style="font-size:13px;font-weight:500;">${escHtml(op.name||'—')}</div>
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);">${op.durationMin||0} min</div>
                  <div style="font-family:var(--font-mono);font-size:12px;">₹${Number(op.cost||0).toLocaleString('en-IN')}/hr</div>
                </div>`).join('')}
            </div>
          </div>`:''}

        <div style="margin-top:var(--space-4);display:flex;gap:10px;">
          <button class="btn btn-primary" onclick="createProductionFromBOM('${bom.id}');document.getElementById('bom-detail-panel').innerHTML=''">🏭 Create Production Order</button>
          <button class="btn btn-secondary" onclick="editBOM('${bom.id}');document.getElementById('bom-detail-panel').innerHTML=''">✏️ Edit BOM</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('bom-detail-panel').scrollIntoView({behavior:'smooth'});
};

window.editBOM=(id)=>{
  const b=_boms.find(x=>x.id===id); if(!b) return;
  document.getElementById('bom-modal-title').textContent='Edit BOM';
  document.getElementById('bom-id').value=b.id;
  document.getElementById('bom-number').value=b.bomNumber||'';
  document.getElementById('bom-product').value=b.finishedProductId||'';
  document.getElementById('bom-version').value=b.version||'1.0';
  document.getElementById('bom-output-qty').value=b.outputQty||1;
  document.getElementById('bom-output-unit').value=b.outputUnit||'pcs';
  document.getElementById('bom-lead-time').value=b.leadTimeDays||1;
  document.getElementById('bom-status').value=b.status||'active';
  document.getElementById('bom-desc').value=b.description||'';
  _bomLines=[]; document.getElementById('bom-lines-body').innerHTML='';
  (b.components||[]).forEach(c=>addBOMLine(c));
  _bomOps=[]; const opsList=document.getElementById('bom-operations-list'); if(opsList) opsList.innerHTML='';
  (b.operations||[]).forEach(op=>addBOMOperation(op));
  openModal('bom-modal');
};

window.deleteBOM=async(id)=>{
  if(!confirm('Delete this BOM?'))return;
  try{await dbDelete(MFG_COLLECTIONS.BOM,id);Toast.success('Deleted','BOM removed.');await window.refreshMfg?.();}
  catch(e){Toast.error('Failed',e.message);}
};

window.bomCostAnalysis=(id)=>{
  const bom=_boms.find(x=>x.id===id); if(!bom) return;
  switchMfgTab('costing');
};

// ══════════════════════════════════════════════════════════════
// PRODUCTION ORDERS
// ══════════════════════════════════════════════════════════════
let _filtProd=[], _pageProd=1;

function renderProductionTab(container) {
  _filtProd=[..._productions];
  container.innerHTML=`
    ${searchBar({id:'prod',placeholder:'Search production order, product…',
      filters:[{key:'status',label:'All Status',options:[
        {value:'planned',label:'Planned'},{value:'released',label:'Released'},
        {value:'in-progress',label:'In Progress'},{value:'completed',label:'Completed'},
        {value:'cancelled',label:'Cancelled'},
      ]}],onSearch:'prodSearch',onFilter:'prodFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('prod-modal')">+ Create Production Order</button>
    </div>
    <div id="prod-table-wrap"></div>
    <div id="prod-pagination"></div>
  `;

  document.getElementById('prod-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildProdModal());
  renderProdTable();

  window.prodSearch=debounce((q)=>{_filtProd=searchFilter(_productions,q,['productionNo','productName']);_pageProd=1;renderProdTable();},250);
  window.prodFilter=(k,v)=>{_filtProd=v?_productions.filter(p=>p[k]===v):[..._productions];_pageProd=1;renderProdTable();};
  window.setProdPage=(p)=>{_pageProd=p;renderProdTable();};
}

function renderProdTable(){
  const wrap=document.getElementById('prod-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('prod-count'); if(cnt) cnt.textContent=`${_filtProd.length} order${_filtProd.length!==1?'s':''}`;
  const start=(_pageProd-1)*PER;
  wrap.innerHTML=buildTable({id:'prod-table',
    columns:[
      {key:'productionNo', label:'PO #',       render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.productionNo||'—')}</span>`},
      {key:'productName',  label:'Product',     render:r=>avatarCell(r.productName||'—',`BOM: ${r.bomNumber||'—'}`,'var(--brand-accent)','rgba(255,107,53,0.12)')},
      {key:'plannedQty',   label:'Planned Qty', render:r=>`<span style="font-family:var(--font-mono);">${r.plannedQty||0} ${escHtml(r.unit||'pcs')}</span>`},
      {key:'producedQty',  label:'Produced',    render:r=>`<span style="font-family:var(--font-mono);color:${r.producedQty>=r.plannedQty?'var(--brand-secondary)':'var(--text-primary)'};">${r.producedQty||0}</span>`},
      {key:'startDate',    label:'Start',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.startDate||'—'}</span>`},
      {key:'dueDate',      label:'Due',         render:r=>{if(!r.dueDate)return'—';const overdue=r.status!=='completed'&&new Date(r.dueDate)<new Date();return `<span style="font-size:11px;color:${overdue?'var(--brand-danger)':'var(--text-muted)'};">${r.dueDate}${overdue?' ⚠':''}</span>`}},
      {key:'estimatedCost',label:'Est. Cost',   render:r=>`<span style="font-family:var(--font-mono);">₹${Number(r.estimatedCost||0).toLocaleString('en-IN')}</span>`},
      {key:'actualCost',   label:'Actual Cost', render:r=>r.actualCost?`<span style="font-family:var(--font-mono);color:${r.actualCost>r.estimatedCost?'var(--brand-danger)':'var(--brand-secondary)'};">₹${Number(r.actualCost).toLocaleString('en-IN')}</span>`:'—'},
      {key:'status',       label:'Status',      render:r=>badge(r.status||'planned')},
      {key:'actions',      label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'▶', label:'Start Production',  action:`startProduction('${r.id}')`},
          {icon:'✅',label:'Complete',           action:`completeProduction('${r.id}')`},
          {icon:'📊',label:'View Progress',     action:`viewProductionProgress('${r.id}')`},
          {icon:'❌',label:'Cancel',            action:`cancelProduction('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtProd.slice(start,start+PER),emptyMsg:'No production orders yet',
  });
  document.getElementById('prod-pagination').innerHTML=buildPagination({id:'prod',total:_filtProd.length,page:_pageProd,perPage:PER,onChange:'setProdPage'});
}

function buildProdModal(){
  const bomOpts=_boms.filter(b=>b.status==='active').map(b=>`<option value="${b.id}" data-product="${b.finishedProductId}" data-name="${escHtml(b.productName||'')}" data-cost="${b.estimatedCost||0}" data-unit="${b.outputUnit||'pcs'}">${escHtml(b.bomNumber)} — ${escHtml(b.productName)}</option>`).join('');
  return buildModal({
    id:'prod-modal',title:'Create Production Order',size:'lg',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Production Order No.</label><input type="text" id="po-number" class="form-input" value="PRD-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Bill of Materials <span class="required">*</span></label>
          <select id="po-bom" class="form-select" onchange="autoFillProductionFromBOM(this)">
            <option value="">Select BOM…</option>${bomOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Planned Qty <span class="required">*</span></label><input type="number" id="po-qty" class="form-input" value="1" min="1" oninput="updateProductionCost()"></div>
        <div class="form-group"><label class="form-label">Unit</label><input type="text" id="po-unit" class="form-input" value="pcs" readonly style="background:var(--bg-overlay);"></div>
        <div class="form-group"><label class="form-label">Est. Cost</label><input type="text" id="po-cost-display" class="form-input" readonly style="background:var(--bg-overlay);" value="₹0"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Start Date <span class="required">*</span></label><input type="date" id="po-start" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Due Date</label><input type="date" id="po-due" class="form-input"></div>
      </div>

      <!-- Material Requirements Preview -->
      <div id="po-materials-preview" style="margin-top:var(--space-4);display:none;">
        <div style="font-size:13px;font-weight:700;margin-bottom:var(--space-3);">📦 Material Requirements</div>
        <div id="po-materials-list"></div>
      </div>

      <div class="form-group"><label class="form-label">Notes</label><textarea id="po-notes" class="form-textarea" rows="2" placeholder="Production instructions…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('prod-modal')">Cancel</button>
            <button class="btn btn-primary" id="po-save-btn" onclick="saveProductionOrder()">Create Production Order</button>`,
  });
}

window.autoFillProductionFromBOM=(select)=>{
  const opt=select.options[select.selectedIndex];
  if(!opt.value) return;
  const unit=opt.dataset?.unit||'pcs';
  const el=document.getElementById('po-unit'); if(el) el.value=unit;
  updateProductionCost();
  // Show material requirements preview
  const bom=_boms.find(b=>b.id===opt.value);
  if(!bom) return;
  const qty=Number(document.getElementById('po-qty')?.value)||1;
  const preview=document.getElementById('po-materials-preview');
  const list=document.getElementById('po-materials-list');
  if(!preview||!list) return;
  preview.style.display='';
  list.innerHTML=`
    <div class="table-container">
      <table class="table" style="font-size:12px;">
        <thead><tr><th>Component</th><th>Need per Batch</th><th>For ${qty} units</th><th>In Stock</th><th>Status</th></tr></thead>
        <tbody>
          ${(bom.components||[]).map(c=>{
            const p=_products.find(x=>x.id===c.productId)||{};
            const needed=Number(c.qty)*(1+(Number(c.scrapPct)||0)/100)*qty;
            const inStock=_inventory.filter(i=>i.productId===c.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
            const ok=inStock>=needed;
            return `<tr>
              <td>${escHtml(p.name||c.productId||'—')}</td>
              <td style="font-family:var(--font-mono);">${Number(c.qty)*(1+(Number(c.scrapPct)||0)/100)} ${c.unit||'pcs'}</td>
              <td style="font-family:var(--font-mono);font-weight:700;">${needed.toFixed(3)} ${c.unit||'pcs'}</td>
              <td style="font-family:var(--font-mono);">${inStock} ${c.unit||'pcs'}</td>
              <td>${ok?`<span class="badge badge-green">✅ OK</span>`:`<span class="badge badge-red">❌ Short ${(needed-inStock).toFixed(2)}</span>`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
};

window.updateProductionCost=()=>{
  const bomId=document.getElementById('po-bom')?.value;
  const qty=Number(document.getElementById('po-qty')?.value)||1;
  const bom=_boms.find(b=>b.id===bomId);
  if(!bom) return;
  const costPerBatch=Number(bom.estimatedCost)||0;
  const batchSize=Number(bom.outputQty)||1;
  const totalCost=(costPerBatch/batchSize)*qty;
  const el=document.getElementById('po-cost-display'); if(el) el.value='₹'+totalCost.toLocaleString('en-IN',{maximumFractionDigits:0});
};

window.createProductionFromBOM=(bomId)=>{
  const bomEl=document.getElementById('po-bom'); if(bomEl){bomEl.value=bomId;autoFillProductionFromBOM(bomEl);}
  openModal('prod-modal');
};

window.saveProductionOrder=async()=>{
  if(!validateForm([{id:'po-bom',label:'BOM',required:true},{id:'po-qty',label:'Quantity',required:true},{id:'po-start',label:'Start Date',required:true}])) return;
  const btn=document.getElementById('po-save-btn'); setLoading(btn,true);
  const bomId=document.getElementById('po-bom').value;
  const bom=_boms.find(b=>b.id===bomId)||{};
  const qty=Number(document.getElementById('po-qty').value)||1;
  const batchSize=Number(bom.outputQty)||1;
  const totalCost=(Number(bom.estimatedCost)||0)/batchSize*qty;
  const data={
    productionNo:document.getElementById('po-number').value.trim(),
    bomId,bomNumber:bom.bomNumber||'',
    finishedProductId:bom.finishedProductId||'',productName:bom.productName||'',
    plannedQty:qty,unit:bom.outputUnit||'pcs',
    startDate:document.getElementById('po-start').value,
    dueDate:document.getElementById('po-due').value||null,
    estimatedCost:totalCost,actualCost:0,producedQty:0,
    status:'planned',components:bom.components||[],
    notes:document.getElementById('po-notes').value.trim(),
    companyId:AuthState.company?.id||null,
  };
  try{
    await dbCreate(MFG_COLLECTIONS.PRODUCTION,data);
    Toast.success('Created',`${data.productionNo} created.`);
    closeModal('prod-modal');
    await window.refreshMfg?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.startProduction=async(id)=>{
  const prod=_productions.find(x=>x.id===id); if(!prod) return;
  // Check material availability first
  const shortages=[];
  for(const comp of (prod.components||[])){
    const needed=Number(comp.qty)*(1+(Number(comp.scrapPct)||0)/100)*(prod.plannedQty||1);
    const inStock=_inventory.filter(i=>i.productId===comp.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
    if(inStock<needed){const p=_products.find(x=>x.id===comp.productId);shortages.push(`${p?.name||'?'}: need ${needed.toFixed(2)}, have ${inStock}`);}
  }
  if(shortages.length){
    if(!confirm(`Material shortages:\n${shortages.join('\n')}\n\nStart production anyway?`)) return;
  }
  try{
    await dbUpdate(MFG_COLLECTIONS.PRODUCTION,id,{status:'in-progress',actualStartDate:new Date().toISOString().slice(0,10)});
    // Consume materials from inventory
    const ops=[];
    for(const comp of (prod.components||[])){
      const needed=Number(comp.qty)*(1+(Number(comp.scrapPct)||0)/100)*(prod.plannedQty||1);
      const inv=_inventory.find(i=>i.productId===comp.productId);
      if(inv) ops.push({collection:COLLECTIONS.INVENTORY,id:inv.id,type:'update',data:{quantity:Math.max(0,Number(inv.quantity)-needed)}});
    }
    if(ops.length) await dbBatch(ops);
    Toast.success('Started!',`Production ${prod.productionNo} started. Materials consumed from inventory.`);
    await window.refreshMfg?.();
  }catch(e){Toast.error('Failed',e.message);}
};

window.completeProduction=async(id)=>{
  const prod=_productions.find(x=>x.id===id); if(!prod) return;
  const actual=prompt(`How many ${prod.unit} produced? (Planned: ${prod.plannedQty})`);
  if(!actual) return;
  const actualQty=Number(actual)||0;
  const actualCost=prompt(`Actual production cost (₹)? (Estimated: ₹${Number(prod.estimatedCost||0).toLocaleString('en-IN')})`);
  const actualCostNum=Number(actualCost)||Number(prod.estimatedCost)||0;
  try{
    await dbUpdate(MFG_COLLECTIONS.PRODUCTION,id,{status:'completed',producedQty:actualQty,actualCost:actualCostNum,completedAt:new Date().toISOString()});
    // Add finished goods to inventory
    const existingFG=_inventory.find(i=>i.productId===prod.finishedProductId);
    if(existingFG){await dbUpdate(COLLECTIONS.INVENTORY,existingFG.id,{quantity:(Number(existingFG.quantity)||0)+actualQty});}
    else{await dbCreate(COLLECTIONS.INVENTORY,{productId:prod.finishedProductId,quantity:actualQty,companyId:AuthState.company?.id||null});}
    Toast.success('Completed! 🎉',`${actualQty} ${prod.unit} produced. Added to finished goods inventory.`);
    await window.refreshMfg?.();
  }catch(e){Toast.error('Failed',e.message);}
};

window.viewProductionProgress=(id)=>{
  const prod=_productions.find(x=>x.id===id); if(!prod) return;
  const pct=prod.plannedQty?Math.round(((prod.producedQty||0)/prod.plannedQty)*100):0;
  Toast.info(`${prod.productionNo} — ${pct}% Complete`,`Produced ${prod.producedQty||0} of ${prod.plannedQty} ${prod.unit}`);
};

window.cancelProduction=async(id)=>{
  const prod=_productions.find(x=>x.id===id);
  if(!confirm(`Cancel production order "${prod?.productionNo}"?`)) return;
  try{await dbUpdate(MFG_COLLECTIONS.PRODUCTION,id,{status:'cancelled'});Toast.warning('Cancelled','Production order cancelled.');}
  catch(e){Toast.error('Failed',e.message);}
};

// ══════════════════════════════════════════════════════════════
// MRP PLANNING ENGINE
// ══════════════════════════════════════════════════════════════
function renderMRPTab(container){
  container.innerHTML=`
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header">
        <div class="card-title">🤖 Material Requirements Planning (MRP)</div>
        <button class="btn btn-primary" id="run-mrp-btn" onclick="runMRP()">▶ Run MRP</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-3);">
        <div class="grid-3">
          <div class="form-group">
            <label class="form-label">Planning Horizon</label>
            <select id="mrp-horizon" class="form-select">
              <option value="7">1 Week</option><option value="14">2 Weeks</option>
              <option value="30" selected>1 Month</option><option value="90">3 Months</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Safety Stock Buffer (%)</label>
            <input type="number" id="mrp-buffer" class="form-input" value="15" min="0" max="100">
          </div>
          <div class="form-group">
            <label class="form-label">Plan Based On</label>
            <select id="mrp-basis" class="form-select">
              <option value="sales-orders">Open Sales Orders</option>
              <option value="forecast">Demand Forecast</option>
              <option value="both">Both</option>
            </select>
          </div>
        </div>
        <div class="alert alert-info">
          <span class="alert-icon">🤖</span>
          <div>
            <div class="alert-title">How MRP Works</div>
            <div class="alert-text">MRP analyses open sales orders, current inventory levels, BOMs, and lead times to calculate what needs to be purchased or produced — and when.</div>
          </div>
        </div>
      </div>
    </div>
    <div id="mrp-results"></div>
  `;

  window.runMRP=async()=>{
    const btn=document.getElementById('run-mrp-btn'); setLoading(btn,true);
    const horizon=Number(document.getElementById('mrp-horizon').value)||30;
    const buffer=Number(document.getElementById('mrp-buffer').value)||15;
    const el=document.getElementById('mrp-results');
    el.innerHTML=`<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>`;

    try{
      // Load open sales orders
      const cid=AuthState.company?.id;
      const orders=await dbGetAll('sales_orders',cid?[where('companyId','==',cid),where('status','in',['confirmed','processing'])]:[] );

      // Calculate demand
      const demand={};
      orders.forEach(order=>{
        (order.items||[]).forEach(item=>{
          demand[item.productId]=(demand[item.productId]||0)+(Number(item.qty)||0);
        });
      });

      // For each demanded product, check if BOM exists and calculate raw material needs
      const mrpPlan=[];
      for(const [productId,demandQty] of Object.entries(demand)){
        const product=_products.find(p=>p.id===productId);
        const bom=_boms.find(b=>b.finishedProductId===productId&&b.status==='active');
        const currentStock=_inventory.filter(i=>i.productId===productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
        const netDemand=Math.max(0,demandQty*(1+buffer/100)-currentStock);

        if(bom){
          // Manufacturing — calculate raw material requirements
          const productionNeeded=Math.ceil(netDemand/(bom.outputQty||1));
          const matReqs=(bom.components||[]).map(comp=>{
            const rawStock=_inventory.filter(i=>i.productId===comp.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
            const rawNeeded=Number(comp.qty)*(1+(Number(comp.scrapPct)||0)/100)*productionNeeded;
            const rawCompProd=_products.find(p=>p.id===comp.productId);
            return {productId:comp.productId,name:rawCompProd?.name||'—',needed:rawNeeded,inStock:rawStock,toOrder:Math.max(0,rawNeeded-rawStock),unit:comp.unit||'pcs'};
          });
          mrpPlan.push({type:'produce',productId,productName:product?.name||'—',demandQty,currentStock,netDemand,productionQty:productionNeeded*(bom.outputQty||1),bomId:bom.id,bomNumber:bom.bomNumber,leadDays:bom.leadTimeDays||1,materialRequirements:matReqs});
        } else {
          // Purchase — no BOM, direct purchase
          mrpPlan.push({type:'purchase',productId,productName:product?.name||'—',demandQty,currentStock,netDemand,toOrder:netDemand,leadDays:7});
        }
      }

      if(!mrpPlan.length){el.innerHTML=`<div class="alert alert-success"><span class="alert-icon">✅</span><div><div class="alert-title">No action required</div><div class="alert-text">All open orders can be fulfilled from current stock.</div></div></div>`;setLoading(btn,false);return;}

      el.innerHTML=`
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
          <h3 style="font-size:16px;font-weight:700;">MRP Results — ${mrpPlan.length} Action${mrpPlan.length!==1?'s':''} Required</h3>
          <button class="btn btn-primary btn-sm" onclick="createPOsFromMRP()">📋 Create All POs</button>
        </div>

        ${mrpPlan.map(plan=>`
          <div style="margin-bottom:var(--space-4);padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:4px solid ${plan.type==='produce'?'var(--brand-primary)':'var(--brand-warning)'};">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
              <div>
                <div style="font-size:14px;font-weight:700;">${escHtml(plan.productName)}</div>
                <div style="font-size:11px;color:var(--text-muted);">Demand: ${plan.demandQty} · In Stock: ${plan.currentStock} · Net Need: ${plan.netDemand.toFixed(0)} (incl. ${buffer}% buffer)</div>
              </div>
              <span style="padding:4px 14px;border-radius:999px;font-size:12px;font-weight:700;background:${plan.type==='produce'?'rgba(10,132,255,0.15)':'rgba(255,159,10,0.15)'};color:${plan.type==='produce'?'var(--brand-primary)':'var(--brand-warning)'};">
                ${plan.type==='produce'?'🏭 PRODUCE':'🛒 PURCHASE'}
              </span>
            </div>

            ${plan.type==='produce'?`
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:var(--space-3);">
                Create production order for <strong>${plan.productionQty}</strong> units using BOM <strong>${plan.bomNumber}</strong> (Lead time: ${plan.leadDays}d)
              </div>
              ${plan.materialRequirements?.length?`
                <div style="background:var(--bg-overlay);border-radius:var(--radius-md);padding:12px;">
                  <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">Raw Material Requirements</div>
                  ${plan.materialRequirements.map(m=>`
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border-subtle);">
                      <span style="font-size:12px;">${escHtml(m.name)}</span>
                      <div style="display:flex;align-items:center;gap:12px;">
                        <span style="font-size:11px;color:var(--text-muted);">Need: ${m.needed.toFixed(2)} ${m.unit} · Have: ${m.inStock} ${m.unit}</span>
                        ${m.toOrder>0?`<span class="badge badge-red">Order ${m.toOrder.toFixed(2)} ${m.unit}</span>`:`<span class="badge badge-green">✅ Sufficient</span>`}
                      </div>
                    </div>`).join('')}
                </div>`:''}
              <button class="btn btn-primary btn-sm" style="margin-top:10px;" onclick="createProductionFromBOM('${plan.bomId}')">Create Production Order</button>
            `:`
              <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">
                Purchase <strong>${plan.toOrder.toFixed(0)}</strong> units (Lead time: ~${plan.leadDays}d)
              </div>
              <button class="btn btn-secondary btn-sm" onclick="LAM.Router.navigate('procurement')">Create Purchase Order</button>
            `}
          </div>`).join('')}
      `;
    }catch(e){el.innerHTML=`<div class="alert alert-danger"><span>❌</span><div>${e.message}</div></div>`;}
    setLoading(btn,false);
  };

  window.createPOsFromMRP=()=>Toast.info('Creating POs','Redirecting to Procurement to create purchase orders…');
}

// ══════════════════════════════════════════════════════════════
// WIP TRACKING
// ══════════════════════════════════════════════════════════════
function renderWIPTab(container){
  const active=_productions.filter(p=>p.status==='in-progress');
  container.innerHTML=`
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Active Production Orders', value:active.length,                                     icon:'🏭',color:'kpi-blue'},
        {label:'WIP Value',                value:formatCurrency(active.reduce((s,p)=>s+(Number(p.estimatedCost)||0),0),true), icon:'💰',color:'kpi-orange'},
        {label:'Avg Completion',           value:active.length?Math.round(active.reduce((s,p)=>s+(p.plannedQty?((p.producedQty||0)/p.plannedQty)*100:0),0)/active.length)+'%':'—', icon:'📊',color:'kpi-green'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    ${active.length?`
      <div style="display:flex;flex-direction:column;gap:var(--space-4);">
        ${active.map(prod=>{
          const pct=prod.plannedQty?Math.round(((prod.producedQty||0)/prod.plannedQty)*100):0;
          const isOverdue=prod.dueDate&&new Date(prod.dueDate)<new Date();
          return `
            <div class="card" style="border-left:4px solid ${isOverdue?'var(--brand-danger)':'var(--brand-primary)'};">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:var(--space-3);">
                <div>
                  <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--brand-primary);">${escHtml(prod.productionNo)}</div>
                  <div style="font-size:13px;font-weight:600;margin-top:2px;">${escHtml(prod.productName||'—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">Started: ${prod.actualStartDate||prod.startDate||'—'} · Due: <span style="color:${isOverdue?'var(--brand-danger)':'inherit'}">${prod.dueDate||'—'}${isOverdue?' ⚠ OVERDUE':''}</span></div>
                </div>
                <div style="text-align:right;">
                  <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:${pct>=100?'var(--brand-secondary)':pct>=50?'var(--brand-primary)':'var(--brand-warning)'};">${pct}%</div>
                  <div style="font-size:11px;color:var(--text-muted);">${prod.producedQty||0} / ${prod.plannedQty} ${prod.unit}</div>
                </div>
              </div>

              <!-- Progress bar -->
              <div style="background:var(--bg-overlay);border-radius:6px;height:12px;overflow:hidden;margin-bottom:var(--space-3);">
                <div style="height:100%;width:${Math.min(pct,100)}%;background:${pct>=100?'var(--brand-secondary)':pct>=50?'var(--brand-primary)':'var(--brand-warning)'};border-radius:6px;transition:width 1s ease;"></div>
              </div>

              <!-- Update progress -->
              <div style="display:flex;align-items:center;gap:10px;">
                <label style="font-size:12px;color:var(--text-muted);">Update produced qty:</label>
                <input type="number" id="wip-qty-${prod.id}" class="form-input" style="width:100px;" value="${prod.producedQty||0}" min="0" max="${prod.plannedQty}">
                <button class="btn btn-secondary btn-sm" onclick="updateWIPQty('${prod.id}')">Update</button>
                ${pct>=100?`<button class="btn btn-success btn-sm" onclick="completeProduction('${prod.id}')">✅ Complete</button>`:''}
                <div style="margin-left:auto;display:flex;gap:8px;">
                  <span style="font-size:12px;color:var(--text-muted);">Est: ₹${Number(prod.estimatedCost||0).toLocaleString('en-IN')}</span>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>`:`
      <div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:48px;margin-bottom:16px;opacity:0.3;">⚙️</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">No Active Production</div>
        <div style="font-size:13px;">Start a production order to track WIP here.</div>
      </div>`}
  `;

  window.updateWIPQty=async(id)=>{
    const qty=Number(document.getElementById(`wip-qty-${id}`)?.value)||0;
    const prod=_productions.find(p=>p.id===id); if(!prod) return;
    try{
      await dbUpdate(MFG_COLLECTIONS.PRODUCTION,id,{producedQty:qty});
      Toast.success('Updated',`Progress updated: ${qty}/${prod.plannedQty} ${prod.unit}`);
      await window.refreshMfg?.();
    }catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// WORK CENTERS
// ══════════════════════════════════════════════════════════════
function renderWorkCentersTab(container){
  container.innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-4);">
      <button class="btn btn-primary" onclick="openModal('wc-modal')">+ Add Work Center</button>
    </div>

    <div class="grid-3">
      ${_workCenters.length?_workCenters.map(wc=>`
        <div class="card" style="border-left:3px solid var(--brand-primary);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
            <div style="width:40px;height:40px;background:rgba(10,132,255,0.12);border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;font-size:20px;">⚙️</div>
            <div>
              <div style="font-size:14px;font-weight:700;">${escHtml(wc.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(wc.type||'Machine')}</div>
            </div>
          </div>
          ${[['Capacity',wc.capacityPerDay+' units/day'],['Cost Rate','₹'+Number(wc.costPerHour||0).toLocaleString('en-IN')+'/hr'],['Location',wc.location||'—'],['Operator',wc.operator||'—']].map(([l,v])=>`
            <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border-subtle);">
              <span style="font-size:11px;color:var(--text-muted);">${l}</span>
              <span style="font-size:12px;font-weight:500;">${escHtml(String(v||'—'))}</span>
            </div>`).join('')}
          <div style="margin-top:10px;display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" style="font-size:11px;" onclick="editWorkCenter('${wc.id}')">✏️ Edit</button>
            <button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--brand-danger);" onclick="deleteWorkCenter('${wc.id}')">🗑 Delete</button>
          </div>
        </div>`).join(''):`
        <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted);">
          <div style="font-size:36px;margin-bottom:12px;opacity:0.3;">🔧</div>
          <div style="font-size:14px;font-weight:500;margin-bottom:8px;">No Work Centers</div>
          <div style="font-size:12px;">Add manufacturing work centers (machines, assembly lines, etc.)</div>
        </div>`}
    </div>
  `;

  document.getElementById('wc-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildModal({
    id:'wc-modal',title:'<span id="wc-modal-title">Add Work Center</span>',
    body:`
      <input type="hidden" id="wc-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Name <span class="required">*</span></label><input type="text" id="wc-name" class="form-input" placeholder="CNC Machine 1, Assembly Line A…"></div>
        <div class="form-group"><label class="form-label">Type</label>
          <select id="wc-type" class="form-select"><option value="Machine">Machine</option><option value="Assembly">Assembly Line</option><option value="Workstation">Workstation</option><option value="Labour">Labour Station</option></select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Capacity (units/day)</label><input type="number" id="wc-capacity" class="form-input" placeholder="100" min="0"></div>
        <div class="form-group"><label class="form-label">Cost per Hour (₹)</label><input type="number" id="wc-cost" class="form-input" placeholder="500" min="0" step="0.01"></div>
        <div class="form-group"><label class="form-label">Efficiency (%)</label><input type="number" id="wc-eff" class="form-input" placeholder="85" min="1" max="100" value="85"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Location</label><input type="text" id="wc-loc" class="form-input" placeholder="Factory floor A, Section 2…"></div>
        <div class="form-group"><label class="form-label">Operator / In-charge</label><input type="text" id="wc-op" class="form-input" placeholder="Staff name"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="wc-notes" class="form-textarea" rows="2" placeholder="Equipment details, maintenance schedule…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('wc-modal')">Cancel</button>
            <button class="btn btn-primary" id="wc-save-btn" onclick="saveWorkCenter()">Save</button>`,
  }));

  window.saveWorkCenter=async()=>{
    if(!validateForm([{id:'wc-name',label:'Name',required:true}])) return;
    const btn=document.getElementById('wc-save-btn'); setLoading(btn,true);
    const id=document.getElementById('wc-id').value;
    const data={name:document.getElementById('wc-name').value.trim(),type:document.getElementById('wc-type').value,capacityPerDay:Number(document.getElementById('wc-capacity').value)||0,costPerHour:Number(document.getElementById('wc-cost').value)||0,efficiency:Number(document.getElementById('wc-eff').value)||85,location:document.getElementById('wc-loc').value.trim(),operator:document.getElementById('wc-op').value.trim(),notes:document.getElementById('wc-notes').value.trim(),companyId:AuthState.company?.id||null};
    try{
      if(id){await dbUpdate(MFG_COLLECTIONS.WORK_CENTERS,id,data);Toast.success('Updated','Work center updated.');}
      else{await dbCreate(MFG_COLLECTIONS.WORK_CENTERS,data);Toast.success('Added',`${data.name} added.`);}
      closeModal('wc-modal'); await window.refreshMfg?.();
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };
  window.editWorkCenter=(id)=>{
    const wc=_workCenters.find(x=>x.id===id); if(!wc) return;
    document.getElementById('wc-modal-title').textContent='Edit Work Center';
    document.getElementById('wc-id').value=wc.id;
    document.getElementById('wc-name').value=wc.name||'';
    document.getElementById('wc-type').value=wc.type||'Machine';
    document.getElementById('wc-capacity').value=wc.capacityPerDay||'';
    document.getElementById('wc-cost').value=wc.costPerHour||'';
    document.getElementById('wc-eff').value=wc.efficiency||85;
    document.getElementById('wc-loc').value=wc.location||'';
    document.getElementById('wc-op').value=wc.operator||'';
    document.getElementById('wc-notes').value=wc.notes||'';
    openModal('wc-modal');
  };
  window.deleteWorkCenter=async(id)=>{if(!confirm('Delete this work center?'))return;try{await dbDelete(MFG_COLLECTIONS.WORK_CENTERS,id);await window.refreshMfg?.();Toast.success('Deleted','Work center removed.');}catch(e){Toast.error('Failed',e.message);}};
}

// ══════════════════════════════════════════════════════════════
// PRODUCTION COSTING
// ══════════════════════════════════════════════════════════════
function renderCostingTab(container){
  const completed=_productions.filter(p=>p.status==='completed');
  const totalProd=completed.length;
  const totalEstimated=completed.reduce((s,p)=>s+(Number(p.estimatedCost)||0),0);
  const totalActual=completed.reduce((s,p)=>s+(Number(p.actualCost)||0),0);
  const variance=totalActual-totalEstimated;
  const variancePct=totalEstimated?Math.round((variance/totalEstimated)*100):0;

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Completed Orders',  value:totalProd,                         icon:'✅',color:'kpi-green'},
        {label:'Total Estimated',   value:formatCurrency(totalEstimated,true),icon:'📋',color:'kpi-blue'},
        {label:'Total Actual',      value:formatCurrency(totalActual,true),   icon:'💰',color:'kpi-orange'},
        {label:'Variance',          value:(variancePct>=0?'+':'')+variancePct+'%', icon:variancePct>10?'🚨':'📊', color:Math.abs(variancePct)>10?'kpi-red':'kpi-green'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header">
        <div class="card-title">📊 Estimated vs Actual Cost Analysis</div>
        <button class="btn btn-secondary btn-sm" onclick="exportCostingReport()">⬇ Export</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Production Order</th><th>Product</th><th>Qty Produced</th><th style="text-align:right;">Estimated Cost</th><th style="text-align:right;">Actual Cost</th><th style="text-align:right;">Variance</th><th style="text-align:right;">Cost/Unit</th><th>Status</th></tr></thead>
          <tbody>
            ${completed.length?completed.map(p=>{
              const est=Number(p.estimatedCost)||0;
              const actual=Number(p.actualCost)||0;
              const varAmt=actual-est;
              const varPct=est?Math.round((varAmt/est)*100):0;
              const costPerUnit=p.producedQty?actual/p.producedQty:0;
              return `<tr>
                <td style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(p.productionNo||'—')}</td>
                <td style="font-size:12px;font-weight:500;">${escHtml(p.productName||'—')}</td>
                <td style="font-family:var(--font-mono);">${p.producedQty||0} ${escHtml(p.unit||'pcs')}</td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${est.toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:600;">₹${actual.toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${varAmt>0?'var(--brand-danger)':'var(--brand-secondary)'};">
                  ${varAmt>=0?'+':''}₹${Math.abs(varAmt).toLocaleString('en-IN')} (${varPct>=0?'+':''}${varPct}%)
                </td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${costPerUnit.toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
                <td>${varAmt>est*0.1?`<span class="badge badge-red">Over Budget</span>`:varAmt<-est*0.1?`<span class="badge badge-green">Under Budget</span>`:`<span class="badge badge-gray">On Track</span>`}</td>
              </tr>`;
            }).join(''):`<tr><td colspan="8"><div class="table-empty"><div class="empty-icon">💰</div><div class="empty-title">No completed production orders yet</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- BOM Cost Breakdown -->
    <div class="card">
      <div class="card-header"><div class="card-title">🧩 BOM Cost Breakdown</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--space-4);">
        ${_boms.slice(0,6).map(bom=>{
          const matCost=bom.estimatedCost/1.10;
          const overhead=bom.estimatedCost-matCost;
          const totalCost=bom.estimatedCost;
          const costPerUnit=totalCost/(bom.outputQty||1);
          return `
            <div style="padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);border:1px solid var(--border-subtle);">
              <div style="font-size:13px;font-weight:700;margin-bottom:10px;">${escHtml(bom.productName||'—')}</div>
              ${[['Material Cost',matCost,'var(--brand-primary)'],['Overhead (10%)',overhead,'var(--brand-warning)'],['Total Cost',totalCost,'var(--brand-secondary)'],['Cost per Unit',costPerUnit,'var(--text-primary)']].map(([l,v,c])=>`
                <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border-subtle);">
                  <span style="font-size:12px;color:var(--text-muted);">${l}</span>
                  <span style="font-family:var(--font-mono);font-size:12px;font-weight:${l.includes('Total')||l.includes('per')?700:500};color:${c};">₹${Number(v||0).toLocaleString('en-IN',{maximumFractionDigits:2})}</span>
                </div>`).join('')}
            </div>`;
        }).join('')||`<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">Create BOMs to see cost breakdowns</div>`}
      </div>
    </div>
  `;

  window.exportCostingReport=()=>{
    const csv=[['Production No','Product','Qty','Estimated','Actual','Variance','Cost/Unit'],
      ...completed.map(p=>{const est=Number(p.estimatedCost)||0;const act=Number(p.actualCost)||0;const cpu=p.producedQty?act/p.producedQty:0;return[p.productionNo,p.productName,p.producedQty,est,act,act-est,cpu.toFixed(2)];})
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='production_costing.csv'; a.click();
    Toast.success('Exported','Production costing report exported.');
  };
}
