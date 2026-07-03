// ============================================================
// LAM — Asset Management Module (Phase 6)
// Registration, Assignment, Depreciation, Maintenance, Audit
// Interconnects: Employees, Vehicles, Finance (Expenses)
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, avatarCell, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

export const ASSET_COLLECTIONS = { ASSETS: 'assets', ASSET_MAINT: 'asset_maintenance', ASSET_AUDIT: 'asset_audit' };

let _assets = [], _filt = [], _page = 1;
let _employees = [];
const PER = 15;
let _unsub = null;
let _activeTab = 'list';

export async function renderAssets(container) {
  _employees = await dbGetAll(COLLECTIONS.EMPLOYEES,
    AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []
  );

  container.innerHTML = pageShell({
    title: '🔧 Asset Management',
    subtitle: 'Track, assign, depreciate and audit every company asset.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportAssets()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openAssetModal()">+ Add Asset</button>
    `,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="asset-kpis"></div>

      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);width:fit-content;">
        ${[['list','📋 Assets'],['depreciation','📉 Depreciation'],['maintenance','🔧 Maintenance'],['audit','🔍 Audit']].map(([id,label])=>`
          <button class="asset-tab ${id==='list'?'active':''}" id="asset-tab-${id}" onclick="switchAssetTab('${id}')"
            style="padding:8px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;">${label}</button>
        `).join('')}
      </div>
      <div id="asset-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent=`.asset-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}`;
  document.head.appendChild(style);

  document.body.insertAdjacentHTML('beforeend', assetModal());
  document.body.insertAdjacentHTML('beforeend', assetMaintenanceModal());
  setupModalClose(); setupMenuClose();
  registerAssetGlobals();

  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const c = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen(ASSET_COLLECTIONS.ASSETS, c, data => {
    _assets = data; _filt = [...data];
    renderAssetKPIs();
    switchAssetTab(_activeTab);
  });
}

function renderAssetKPIs() {
  const el = document.getElementById('asset-kpis'); if (!el) return;
  el.innerHTML = '';
  const total     = _assets.length;
  const active    = _assets.filter(a => a.status === 'active').length;
  const totalVal  = _assets.reduce((s,a) => s + (Number(a.purchaseValue)||0), 0);
  const bookVal   = _assets.reduce((s,a) => s + (Number(a.currentValue)||Number(a.purchaseValue)||0), 0);
  const maintain  = _assets.filter(a => a.status === 'under-maintenance').length;

  [
    { label:'Total Assets',    value:total,                         icon:'🔧', color:'kpi-blue'   },
    { label:'Active',          value:active,                        icon:'✅', color:'kpi-green'  },
    { label:'Under Maintenance',value:maintain,                     icon:'🔨', color:'kpi-yellow' },
    { label:'Total Purchase Value', value:formatCurrency(totalVal,true), icon:'💰', color:'kpi-orange' },
    { label:'Current Book Value',   value:formatCurrency(bookVal,true),  icon:'📊', color:'kpi-blue'   },
  ].forEach((k,i) => {
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

window.switchAssetTab = (tab) => {
  _activeTab = tab;
  document.querySelectorAll('.asset-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`asset-tab-${tab}`)?.classList.add('active');
  const content = document.getElementById('asset-tab-content'); if (!content) return;
  switch(tab) {
    case 'list':        renderAssetList(content);        break;
    case 'depreciation':renderDepreciationTab(content);  break;
    case 'maintenance': renderMaintenanceTab(content);   break;
    case 'audit':       renderAuditTab(content);         break;
  }
};

function renderAssetList(container) {
  container.innerHTML = `
    ${searchBar({id:'assets',placeholder:'Search asset name, tag, category…',filters:[
      {key:'status',label:'All Status',options:[{value:'active',label:'Active'},{value:'under-maintenance',label:'Maintenance'},{value:'disposed',label:'Disposed'},{value:'lost',label:'Lost'}]},
      {key:'category',label:'All Categories',options:[{value:'it',label:'IT Equipment'},{value:'vehicle',label:'Vehicle'},{value:'machinery',label:'Machinery'},{value:'furniture',label:'Furniture'},{value:'building',label:'Building'},{value:'other',label:'Other'}]},
    ],onSearch:'assetSearch',onFilter:'assetFilter'})}
    <div id="assets-table-wrap"></div>
    <div id="assets-pagination"></div>
  `;
  renderAssetTable();
}

function renderAssetTable() {
  const wrap = document.getElementById('assets-table-wrap');
  const pg   = document.getElementById('assets-pagination');
  if (!wrap) return;
  const start    = (_page-1)*PER;
  const pageData = _filt.slice(start, start+PER);
  const cnt = document.getElementById('assets-count'); if(cnt) cnt.textContent=`${_filt.length} asset${_filt.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id:'assets-table',
    columns:[
      {key:'name',        label:'Asset',       render:r=>avatarCell(r.name,`TAG: ${r.assetTag||'—'}`,'var(--brand-orange)','rgba(255,107,53,0.12)')},
      {key:'category',    label:'Category',    render:r=>`<span class="badge badge-gray">${escHtml(r.category||'other')}</span>`},
      {key:'assignedTo',  label:'Assigned To', render:r=>{
        const e=_employees.find(x=>x.id===r.assignedToId);
        return e?`<span style="font-size:12px;">${escHtml(e.name)}</span>`:`<span style="color:var(--text-muted);font-size:12px;">Unassigned</span>`;
      }},
      {key:'purchaseValue',label:'Purchase Value',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.purchaseValue||0).toLocaleString('en-IN')}</span>`},
      {key:'currentValue', label:'Book Value',   render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">₹${Number(r.currentValue||r.purchaseValue||0).toLocaleString('en-IN')}</span>`},
      {key:'depreciationRate',label:'Dep. Rate', render:r=>`<span class="badge badge-yellow">${r.depreciationRate||0}%/yr</span>`},
      {key:'purchaseDate', label:'Purchase Date',render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.purchaseDate||'—'}</span>`},
      {key:'warrantyExpiry',label:'Warranty',   render:r=>{
        if(!r.warrantyExpiry) return '—';
        const days=Math.ceil((new Date(r.warrantyExpiry)-Date.now())/86400000);
        const color=days<=0?'var(--brand-danger)':days<=30?'var(--brand-warning)':'var(--text-muted)';
        return `<span style="font-size:11px;color:${color};">${r.warrantyExpiry}</span>`;
      }},
      {key:'status',       label:'Status',      render:r=>badge(r.status||'active')},
      {key:'actions',      label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'✏️',label:'Edit',          action:`editAsset('${r.id}')`},
          {icon:'👤',label:'Assign Employee',action:`assignAsset('${r.id}')`},
          {icon:'🔧',label:'Log Maintenance',action:`openAssetMaintModal('${r.id}')`},
          {icon:'📦',label:'Dispose Asset',  action:`disposeAsset('${r.id}')`},
          {icon:'🗑', label:'Delete',         action:`deleteAsset('${r.id}')`,danger:true},
        ]),
      },
    ],
    rows:pageData, emptyMsg:'No assets registered yet',
  });
  pg.innerHTML = buildPagination({id:'assets',total:_filt.length,page:_page,perPage:PER,onChange:'setAssetPage'});
}

function renderDepreciationTab(container) {
  const currentYear = new Date().getFullYear();
  const rows = _assets.filter(a=>a.depreciationRate&&a.purchaseValue).map(a=>{
    const purchase   = Number(a.purchaseValue)||0;
    const rate       = Number(a.depreciationRate)||0;
    const purchaseYr = a.purchaseDate ? new Date(a.purchaseDate).getFullYear() : currentYear;
    const years      = currentYear - purchaseYr;
    // Diminishing balance method
    let current = purchase;
    for(let y=0; y<years; y++) current *= (1 - rate/100);
    const annual  = purchase * (rate/100);
    const total   = purchase - current;
    return { ...a, computedCurrentVal: Math.round(current), annualDep: Math.round(annual), totalDep: Math.round(total), yearsOld: years };
  });

  container.innerHTML = `
    <div class="table-container">
      <table class="table">
        <thead>
          <tr><th>Asset</th><th>Purchase Value</th><th>Dep. Rate</th><th>Years Old</th><th>Annual Dep.</th><th>Total Dep.</th><th>Current Book Value</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(r=>`
            <tr>
              <td><div style="font-size:13px;font-weight:500;">${escHtml(r.name)}</div><div style="font-size:11px;color:var(--text-muted);">${escHtml(r.assetTag||'—')}</div></td>
              <td style="font-family:var(--font-mono);">₹${Number(r.purchaseValue).toLocaleString('en-IN')}</td>
              <td><span class="badge badge-yellow">${r.depreciationRate}%</span></td>
              <td style="font-family:var(--font-mono);">${r.yearsOld} yr${r.yearsOld!==1?'s':''}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-danger);">₹${r.annualDep.toLocaleString('en-IN')}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-danger);">₹${r.totalDep.toLocaleString('en-IN')}</td>
              <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${r.computedCurrentVal.toLocaleString('en-IN')}</td>
              <td><button class="btn btn-secondary btn-sm" onclick="updateBookValue('${r.id}',${r.computedCurrentVal})">Update</button></td>
            </tr>
          `).join('') : `<tr><td colspan="8"><div class="table-empty"><div class="empty-icon">📉</div><div class="empty-title">No assets with depreciation set</div><div class="empty-text">Add assets with depreciation rate to see calculations.</div></div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div style="margin-top:var(--space-4);padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-md);">
      <div style="font-size:12px;color:var(--text-muted);line-height:1.8;">
        <strong style="color:var(--text-secondary);">Depreciation Method:</strong> Diminishing/Written Down Value (WDV) — as per Indian Income Tax Act. 
        Assets are depreciated annually at the specified rate on their book value.
      </div>
    </div>
  `;
}

function renderMaintenanceTab(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <h3 style="font-size:16px;font-weight:600;">Asset Maintenance Log</h3>
    </div>
    <div id="asset-maint-list" style="display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>
    </div>
  `;
  loadAssetMaintenance();
}

async function loadAssetMaintenance() {
  const el = document.getElementById('asset-maint-list'); if(!el) return;
  try {
    const cid = AuthState.company?.id;
    const records = await dbGetAll(ASSET_COLLECTIONS.ASSET_MAINT,
      cid ? [where('companyId','==',cid), orderBy('date','desc')] : [orderBy('date','desc')]
    );
    el.innerHTML = records.length ? records.map(r => {
      const asset = _assets.find(a=>a.id===r.assetId);
      return `
        <div style="display:flex;align-items:center;gap:16px;padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid var(--brand-warning);">
          <div style="font-size:24px;">🔧</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;">${escHtml(asset?.name||'—')} — ${escHtml(r.type||'—')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${escHtml(r.description||'—')}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--brand-danger);">₹${Number(r.cost||0).toLocaleString('en-IN')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</div>
          </div>
        </div>
      `;
    }).join('') : `<div style="text-align:center;padding:40px;color:var(--text-muted);">No maintenance records yet</div>`;
  } catch(e) {
    el.innerHTML=`<div style="padding:20px;color:var(--text-muted);text-align:center;">Could not load maintenance records</div>`;
  }
}

function renderAuditTab(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
      <h3 style="font-size:16px;font-weight:600;">Asset Audit — Quick Verification</h3>
      <button class="btn btn-primary btn-sm" onclick="startAssetAudit()">🔍 Start Audit</button>
    </div>
    <div class="grid-3" style="margin-bottom:var(--space-4);">
      ${[
        ['Total Assets',  _assets.length,                                        'var(--brand-primary)'],
        ['Assigned',      _assets.filter(a=>a.assignedToId).length,              'var(--brand-secondary)'],
        ['Unassigned',    _assets.filter(a=>!a.assignedToId).length,             'var(--brand-warning)'],
      ].map(([l,v,c])=>`
        <div style="padding:16px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid ${c};">
          <div style="font-family:var(--font-display);font-size:24px;font-weight:700;color:${c};">${v}</div>
          <div style="font-size:12px;color:var(--text-muted);">${l}</div>
        </div>
      `).join('')}
    </div>
    <div class="table-container">
      <table class="table">
        <thead><tr><th>Asset</th><th>Tag</th><th>Category</th><th>Assigned To</th><th>Location</th><th>Status</th><th>Verify</th></tr></thead>
        <tbody>
          ${_assets.map(a=>{
            const e = _employees.find(x=>x.id===a.assignedToId);
            return `<tr>
              <td style="font-size:13px;font-weight:500;">${escHtml(a.name)}</td>
              <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(a.assetTag||'—')}</td>
              <td><span class="badge badge-gray">${escHtml(a.category||'other')}</span></td>
              <td style="font-size:12px;">${escHtml(e?.name||'Unassigned')}</td>
              <td style="font-size:12px;color:var(--text-secondary);">${escHtml(a.location||'—')}</td>
              <td>${badge(a.status||'active')}</td>
              <td>
                <select class="form-select" style="width:auto;" onchange="verifyAsset('${a.id}',this.value)">
                  <option value="">Mark…</option>
                  <option value="verified">✅ Verified</option>
                  <option value="missing">❌ Missing</option>
                  <option value="damaged">⚠️ Damaged</option>
                </select>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function assetModal() {
  const empOpts = _employees.map(e=>`<option value="${e.id}">${escHtml(e.name)} — ${escHtml(e.department||e.role||'')}</option>`).join('');
  return buildModal({
    id:'asset-modal', title:'<span id="asset-modal-title">Add Asset</span>', size:'lg',
    body:`
      <input type="hidden" id="asset-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Asset Name <span class="required">*</span></label><input type="text" id="a-name" class="form-input" placeholder="Dell Laptop, Tata Truck…"></div>
        <div class="form-group"><label class="form-label">Asset Tag / Code</label><input type="text" id="a-tag" class="form-input" value="AST-${genId()}" style="text-transform:uppercase;"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Category</label>
          <select id="a-category" class="form-select">
            <option value="it">IT Equipment</option><option value="vehicle">Vehicle</option>
            <option value="machinery">Machinery</option><option value="furniture">Furniture</option>
            <option value="building">Building/Land</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Make / Brand</label><input type="text" id="a-brand" class="form-input" placeholder="Dell, Tata, Samsung…"></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Purchase Value (₹) <span class="required">*</span></label><input type="number" id="a-value" class="form-input" placeholder="50000" min="0"></div>
        <div class="form-group"><label class="form-label">Purchase Date</label><input type="date" id="a-purchase-date" class="form-input"></div>
        <div class="form-group"><label class="form-label">Depreciation Rate (%/yr)</label><input type="number" id="a-dep-rate" class="form-input" placeholder="25" min="0" max="100"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Assigned To</label>
          <select id="a-assignee" class="form-select"><option value="">Unassigned</option>${empOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Location</label><input type="text" id="a-location" class="form-input" placeholder="Main office, Warehouse A…"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Warranty Expiry</label><input type="date" id="a-warranty" class="form-input"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select id="a-status" class="form-select"><option value="active">Active</option><option value="under-maintenance">Under Maintenance</option><option value="disposed">Disposed</option><option value="lost">Lost</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Serial Number</label><input type="text" id="a-serial" class="form-input" placeholder="Serial / model number"></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="a-notes" class="form-textarea" rows="2" placeholder="Additional details…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('asset-modal')">Cancel</button><button class="btn btn-primary" id="asset-save-btn" onclick="saveAsset()">Save Asset</button>`,
  });
}

function assetMaintenanceModal() {
  return buildModal({
    id:'asset-maint-modal', title:'🔧 Log Asset Maintenance',
    body:`
      <input type="hidden" id="amaint-asset-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Maintenance Type <span class="required">*</span></label>
          <select id="am-type" class="form-select"><option value="preventive">Preventive</option><option value="corrective">Corrective/Repair</option><option value="inspection">Inspection</option><option value="upgrade">Upgrade</option></select>
        </div>
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label><input type="date" id="am-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Cost (₹) <span class="required">*</span></label><input type="number" id="am-cost" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Vendor/Service Center</label><input type="text" id="am-vendor" class="form-input" placeholder="Service provider name"></div>
      </div>
      <div class="form-group"><label class="form-label">Next Maintenance Date</label><input type="date" id="am-next" class="form-input"></div>
      <div class="form-group"><label class="form-label">Description</label><textarea id="am-desc" class="form-textarea" rows="2" placeholder="Work done, parts replaced…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('asset-maint-modal')">Cancel</button><button class="btn btn-primary" id="amaint-save-btn" onclick="saveAssetMaint()">Save & Update Asset</button>`,
  });
}

function registerAssetGlobals() {
  window.assetSearch = debounce((q)=>{ _filt=searchFilter(_assets,q,['name','assetTag','category','brand','serialNo']); _page=1; if(_activeTab==='list')renderAssetTable(); },250);
  window.assetFilter = (k,v)=>{ _filt=v?_assets.filter(a=>a[k]===v):[..._assets]; _page=1; if(_activeTab==='list')renderAssetTable(); };
  window.setAssetPage = (p)=>{ _page=p; renderAssetTable(); };

  window.openAssetModal = ()=>{
    document.getElementById('asset-modal-title').textContent='Add Asset';
    document.getElementById('asset-id').value='';
    ['a-name','a-brand','a-value','a-dep-rate','a-location','a-warranty','a-serial','a-notes','a-purchase-date'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    document.getElementById('a-tag').value='AST-'+genId();
    document.getElementById('a-category').selectedIndex=0;
    document.getElementById('a-assignee').value='';
    document.getElementById('a-status').value='active';
    openModal('asset-modal');
  };

  window.saveAsset = async()=>{
    if(!validateForm([{id:'a-name',label:'Asset Name',required:true},{id:'a-value',label:'Purchase Value',required:true}])) return;
    const btn=document.getElementById('asset-save-btn'); setLoading(btn,true);
    const id=document.getElementById('asset-id').value;
    const data={
      name:             document.getElementById('a-name').value.trim(),
      assetTag:         document.getElementById('a-tag').value.trim().toUpperCase(),
      category:         document.getElementById('a-category').value,
      brand:            document.getElementById('a-brand').value.trim(),
      purchaseValue:    Number(document.getElementById('a-value').value)||0,
      currentValue:     Number(document.getElementById('a-value').value)||0,
      purchaseDate:     document.getElementById('a-purchase-date').value,
      depreciationRate: Number(document.getElementById('a-dep-rate').value)||0,
      assignedToId:     document.getElementById('a-assignee').value||null,
      location:         document.getElementById('a-location').value.trim(),
      warrantyExpiry:   document.getElementById('a-warranty').value||null,
      status:           document.getElementById('a-status').value,
      serialNo:         document.getElementById('a-serial').value.trim(),
      notes:            document.getElementById('a-notes').value.trim(),
      companyId:        AuthState.company?.id||null,
    };
    try{
      if(id){await dbUpdate(ASSET_COLLECTIONS.ASSETS,id,data);Toast.success('Updated',`${data.name} updated.`);}
      else  {await dbCreate(ASSET_COLLECTIONS.ASSETS,data);Toast.success('Added',`${data.name} registered.`);}
      closeModal('asset-modal');
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.editAsset=(id)=>{
    const a=_assets.find(x=>x.id===id); if(!a) return;
    document.getElementById('asset-modal-title').textContent='Edit Asset';
    document.getElementById('asset-id').value=a.id;
    document.getElementById('a-name').value=a.name||'';
    document.getElementById('a-tag').value=a.assetTag||'';
    document.getElementById('a-category').value=a.category||'other';
    document.getElementById('a-brand').value=a.brand||'';
    document.getElementById('a-value').value=a.purchaseValue||'';
    document.getElementById('a-purchase-date').value=a.purchaseDate||'';
    document.getElementById('a-dep-rate').value=a.depreciationRate||'';
    document.getElementById('a-assignee').value=a.assignedToId||'';
    document.getElementById('a-location').value=a.location||'';
    document.getElementById('a-warranty').value=a.warrantyExpiry||'';
    document.getElementById('a-status').value=a.status||'active';
    document.getElementById('a-serial').value=a.serialNo||'';
    document.getElementById('a-notes').value=a.notes||'';
    openModal('asset-modal');
  };

  window.assignAsset = (id)=>{
    const a = _assets.find(x=>x.id===id); if(!a) return;
    const empOpts = _employees.map(e=>`<option value="${e.id}" ${a.assignedToId===e.id?'selected':''}>${escHtml(e.name)} — ${escHtml(e.department||'')}</option>`).join('');
    document.getElementById('asset-assign-modal')?.remove();
    const html = buildModal({id:'asset-assign-modal',title:`Assign: ${a.name}`,body:`
      <div class="form-group"><label class="form-label">Assign To Employee</label>
        <select id="aa-employee" class="form-select"><option value="">Unassign</option>${empOpts}</select>
      </div>
      <div class="form-group"><label class="form-label">Location</label>
        <input type="text" id="aa-location" class="form-input" value="${escHtml(a.location||'')}" placeholder="Location of asset">
      </div>
      <input type="hidden" id="aa-asset-id" value="${id}">
    `,footer:`<button class="btn btn-secondary" onclick="closeModal('asset-assign-modal')">Cancel</button><button class="btn btn-primary" onclick="confirmAssetAssign()">Assign</button>`});
    document.body.insertAdjacentHTML('beforeend',html);
    openModal('asset-assign-modal');
  };

  window.confirmAssetAssign = async()=>{
    const assetId  = document.getElementById('aa-asset-id').value;
    const empId    = document.getElementById('aa-employee').value;
    const location = document.getElementById('aa-location').value.trim();
    try{
      await dbUpdate(ASSET_COLLECTIONS.ASSETS, assetId, { assignedToId: empId||null, location });
      await dbCreate(ASSET_COLLECTIONS.ASSET_AUDIT, { assetId, action:'assigned', assignedToId:empId||null, location, date:new Date().toISOString().slice(0,10), performedBy:AuthState.profile?.name||'', companyId:AuthState.company?.id||null });
      Toast.success('Assigned','Asset assignment updated.');
      closeModal('asset-assign-modal');
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.updateBookValue = async(id, value)=>{
    try{ await dbUpdate(ASSET_COLLECTIONS.ASSETS, id, { currentValue: value }); Toast.success('Updated','Book value updated.'); }
    catch(e){ Toast.error('Failed',e.message); }
  };

  window.openAssetMaintModal = (id)=>{ document.getElementById('amaint-asset-id').value=id; openModal('asset-maint-modal'); };
  window.saveAssetMaint = async()=>{
    if(!validateForm([{id:'am-type',label:'Type',required:true},{id:'am-date',label:'Date',required:true},{id:'am-cost',label:'Cost',required:true}])) return;
    const btn=document.getElementById('amaint-save-btn'); setLoading(btn,true);
    const assetId=document.getElementById('amaint-asset-id').value;
    const data={ assetId, type:document.getElementById('am-type').value, date:document.getElementById('am-date').value, cost:Number(document.getElementById('am-cost').value)||0, vendorName:document.getElementById('am-vendor').value.trim(), nextMaintenanceDate:document.getElementById('am-next').value||null, description:document.getElementById('am-desc').value.trim(), companyId:AuthState.company?.id||null };
    try{
      await dbCreate(ASSET_COLLECTIONS.ASSET_MAINT, data);
      await dbUpdate(ASSET_COLLECTIONS.ASSETS, assetId, { lastMaintenanceDate:data.date, nextMaintenanceDate:data.nextMaintenanceDate||null });
      Toast.success('Logged',`Maintenance logged for ₹${data.cost.toLocaleString('en-IN')}.`);
      closeModal('asset-maint-modal');
      if(_activeTab==='maintenance') loadAssetMaintenance();
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.disposeAsset = async(id)=>{
    const a=_assets.find(x=>x.id===id);
    if(!confirm(`Dispose asset "${a?.name}"? This marks it as permanently removed.`)) return;
    try{
      await dbUpdate(ASSET_COLLECTIONS.ASSETS,id,{status:'disposed',disposedAt:new Date().toISOString()});
      await dbCreate(ASSET_COLLECTIONS.ASSET_AUDIT,{assetId:id,action:'disposed',date:new Date().toISOString().slice(0,10),performedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
      Toast.warning('Disposed',`${a?.name} marked as disposed.`);
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.verifyAsset = async(id, result)=>{
    if(!result) return;
    try{
      await dbCreate(ASSET_COLLECTIONS.ASSET_AUDIT,{assetId:id,action:'audit-'+result,date:new Date().toISOString().slice(0,10),performedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
      Toast.success('Verified',`Asset marked as ${result}.`);
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.startAssetAudit = ()=>{ Toast.info('Audit Started','Mark each asset in the table below. Results saved to audit log.'); };

  window.deleteAsset = async(id)=>{
    const a=_assets.find(x=>x.id===id);
    if(!confirm(`Delete asset "${a?.name}"?`)) return;
    try{await dbDelete(ASSET_COLLECTIONS.ASSETS,id);Toast.success('Deleted','Asset removed.');}
    catch(e){Toast.error('Failed',e.message);}
  };

  window.exportAssets = ()=>{
    const csv=[['Name','Tag','Category','Brand','Purchase Value','Book Value','Dep Rate%','Status','Assigned To','Location','Warranty Expiry'],
      ..._filt.map(a=>{const e=_employees.find(x=>x.id===a.assignedToId);return[a.name,a.assetTag,a.category,a.brand,a.purchaseValue,a.currentValue||a.purchaseValue,a.depreciationRate,a.status,e?.name||'',a.location,a.warrantyExpiry];})
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const el=document.createElement('a'); el.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); el.download='assets_export.csv'; el.click();
    Toast.success('Exported',`${_filt.length} assets exported.`);
  };
}
