// ============================================================
// LAM — Bin Locator / Warehouse Layout — SAP WM Level
// Visual bin grid, zone management, bin capacity, move stock,
// bin contents, search by item, barcode-ready
// ============================================================
import { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { escHtml, setLoading, genId, formatCurrency } from '../../core/utils.js';
import { pageShell, buildModal, validateForm, openModal, closeModal, setupModalClose, setupMenuClose, badge } from '../_shared.js';

const BIN_COLS = { ZONES:'wh_zones', BINS:'wh_bins', BIN_STOCK:'wh_bin_stock' };
let _zones=[], _bins=[], _binStock=[];
let _selectedZone=null, _unsubs=[];

const BIN_TYPES   = { storage:'Storage', picking:'Picking', staging:'Staging/Loading', return:'Returns', overflow:'Overflow', blocked:'Blocked' };
const BIN_STATUSES = { empty:'Empty', partial:'Partial', full:'Full', blocked:'Blocked' };

export async function renderBinLocator(container) {
  _unsubs.forEach(fn=>fn&&fn()); _unsubs=[];
  const cid=AuthState.company?.id;
  const c=cid?[where('companyId','==',cid)]:[];
  [_zones,_bins,_binStock]=await Promise.all([
    dbGetAll(BIN_COLS.ZONES,c).catch(()=>[]),
    dbGetAll(BIN_COLS.BINS,c).catch(()=>[]),
    dbGetAll(BIN_COLS.BIN_STOCK,c).catch(()=>[]),
  ]);

  container.innerHTML = pageShell({
    title:'🗂 Bin Locator — Warehouse Layout',
    subtitle:'Visual warehouse map — zones, bins, capacity, stock locations and movements.',
    actions:`
      <button class="btn btn-secondary btn-sm" onclick="openModal('zone-modal')">+ Add Zone</button>
      <button class="btn btn-secondary btn-sm" onclick="openModal('bin-modal')">+ Add Bin</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('move-modal')">↔ Move Stock</button>`,
    content:`
      <div class="grid-4" id="bin-kpis" style="margin-bottom:var(--space-5);"></div>
      <div class="grid-2" style="align-items:start;gap:var(--space-5);">
        <!-- Zone list -->
        <div class="card">
          <div class="card-header"><div class="card-title">🏭 Warehouse Zones</div></div>
          <div id="zones-list" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>
        <!-- Bin grid for selected zone -->
        <div class="card">
          <div class="card-header">
            <div class="card-title" id="bin-grid-title">Select a zone to view bins</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" id="bin-search" class="form-input" placeholder="Search bin or item…" style="width:160px;font-size:12px;" oninput="searchBins(this.value)">
            </div>
          </div>
          <div id="bin-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;min-height:80px;"></div>
        </div>
      </div>
      <!-- Bin detail panel -->
      <div id="bin-detail-panel" style="display:none;margin-top:var(--space-4);">
        <div class="card">
          <div class="card-header"><div class="card-title" id="bin-detail-title">Bin Contents</div></div>
          <div id="bin-detail-content"></div>
        </div>
      </div>`,
  });

  // Modals
  ['zone-modal','bin-modal','move-modal'].forEach(id=>document.getElementById(id)?.remove());
  document.body.insertAdjacentHTML('beforeend', _buildZoneModal());
  document.body.insertAdjacentHTML('beforeend', _buildBinModal());
  document.body.insertAdjacentHTML('beforeend', _buildMoveModal());
  setupModalClose(); setupMenuClose();
  _registerGlobals();
  _renderKPIs();
  _renderZones();
}

function _renderKPIs(){
  const el=document.getElementById('bin-kpis'); if(!el) return; el.innerHTML='';
  const total=_bins.length, empty=_bins.filter(b=>(b.status||'empty')==='empty').length;
  const full=_bins.filter(b=>b.status==='full').length, blocked=_bins.filter(b=>b.status==='blocked').length;
  [{label:'Total Bins',value:total,icon:'🗃',color:'kpi-blue'},{label:'Empty',value:empty,icon:'⬜',color:'kpi-green'},
   {label:'Full',value:full,icon:'📦',color:'kpi-orange'},{label:'Blocked',value:blocked,icon:'🚫',color:'kpi-red'}]
  .forEach((k,i)=>{el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;});
}

function _renderZones(){
  const el=document.getElementById('zones-list'); if(!el) return;
  if(!_zones.length){el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No zones yet. Click '+ Add Zone'</div>`;return;}
  el.innerHTML=_zones.map(z=>{
    const zoneBins=_bins.filter(b=>b.zoneId===z.id);
    const fullPct=zoneBins.length?Math.round(zoneBins.filter(b=>b.status==='full').length/zoneBins.length*100):0;
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px;background:${_selectedZone===z.id?'rgba(10,132,255,0.08)':'var(--bg-elevated)'};border-radius:var(--radius-md);cursor:pointer;border:1px solid ${_selectedZone===z.id?'var(--brand-primary)':'transparent'};" onclick="selectZone('${z.id}')">
      <div style="width:36px;height:36px;border-radius:10px;background:${z.color||'rgba(10,132,255,0.15)'};display:flex;align-items:center;justify-content:center;font-size:16px;">${z.icon||'🏭'}</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;">${escHtml(z.name||'—')}</div>
        <div style="font-size:11px;color:var(--text-muted);">${BIN_TYPES[z.type]||z.type||'Storage'} · ${zoneBins.length} bins</div>
        <div style="height:4px;background:var(--border-subtle);border-radius:2px;margin-top:5px;overflow:hidden;">
          <div style="width:${fullPct}%;height:100%;background:${fullPct>85?'var(--brand-danger)':fullPct>60?'var(--brand-warning)':'var(--brand-secondary)'};"></div>
        </div>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-secondary btn-sm" style="font-size:10px;" onclick="event.stopPropagation();editZone('${z.id}')">✏️</button>
        <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="event.stopPropagation();deleteZone('${z.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function _renderBinGrid(zoneId,filter=''){
  const el=document.getElementById('bin-grid'); if(!el) return;
  const title=document.getElementById('bin-grid-title');
  const zone=_zones.find(z=>z.id===zoneId)||{};
  if(title) title.textContent=`${zone.name||'Zone'} — Bins`;
  const zoneBins=_bins.filter(b=>b.zoneId===zoneId&&(!filter||b.binCode?.toLowerCase().includes(filter.toLowerCase())||b.currentItem?.toLowerCase().includes(filter.toLowerCase())));
  if(!zoneBins.length){el.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">${filter?'No bins match search.':'No bins in this zone yet.'}</div>`;return;}

  const colorsMap={empty:'var(--bg-elevated)',partial:'rgba(255,159,10,0.15)',full:'rgba(255,69,58,0.15)',blocked:'rgba(100,116,139,0.15)'};
  const borderMap={empty:'var(--border-subtle)',partial:'rgba(255,159,10,0.4)',full:'rgba(255,69,58,0.4)',blocked:'rgba(100,116,139,0.4)'};

  el.innerHTML=zoneBins.map(b=>{
    const st=b.status||'empty';
    const stock=_binStock.filter(s=>s.binId===b.id);
    const pct=b.capacity?Math.round((b.usedCapacity||0)/b.capacity*100):0;
    return `<div onclick="viewBinDetail('${b.id}')" style="background:${colorsMap[st]};border:1.5px solid ${borderMap[st]};border-radius:var(--radius-md);padding:8px;cursor:pointer;transition:transform 0.1s;" onmouseenter="this.style.transform='scale(1.04)'" onmouseleave="this.style.transform=''">
      <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text-primary);">${escHtml(b.binCode||'—')}</div>
      <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">${escHtml(BIN_TYPES[b.type]||b.type||'')}</div>
      ${stock.length?`<div style="font-size:9px;color:var(--text-secondary);margin-top:3px;">${stock.length} SKU${stock.length!==1?'s':''}</div>`:''}
      ${b.capacity?`<div style="height:3px;background:var(--border-subtle);border-radius:2px;margin-top:5px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${pct>85?'var(--brand-danger)':pct>60?'var(--brand-warning)':'var(--brand-secondary)'};"></div></div>`:''}
    </div>`;
  }).join('');
}

function _buildZoneModal(){
  return `<div class="modal-overlay hidden" id="zone-modal">
    <div class="modal modal-sm">
      <div class="modal-header"><div class="modal-title">Warehouse Zone</div><button class="modal-close" onclick="closeModal('zone-modal')">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="z-id">
        <div class="form-group"><label class="form-label">Zone Name <span class="required">*</span></label><input type="text" id="z-name" class="form-input" placeholder="Zone A — Raw Materials"></div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Zone Code</label><input type="text" id="z-code" class="form-input" placeholder="ZA" maxlength="4" style="text-transform:uppercase;"></div>
          <div class="form-group"><label class="form-label">Type</label>
            <select id="z-type" class="form-select">${Object.entries(BIN_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Icon</label><input type="text" id="z-icon" class="form-input" placeholder="🏭" maxlength="2"></div>
          <div class="form-group"><label class="form-label">Colour</label><input type="color" id="z-color" class="form-input" value="#e0f2fe" style="height:36px;padding:2px;"></div>
        </div>
        <div class="form-group"><label class="form-label">Description</label><textarea id="z-desc" class="form-textarea" rows="2" placeholder="Ambient temperature zone for finished goods."></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('zone-modal')">Cancel</button>
        <button class="btn btn-primary" id="zone-save-btn" onclick="saveZone()">Save Zone</button>
      </div>
    </div>
  </div>`;
}

function _buildBinModal(){
  const zoneOpts=_zones.map(z=>`<option value="${z.id}">${escHtml(z.name||z.id)}</option>`).join('');
  return `<div class="modal-overlay hidden" id="bin-modal">
    <div class="modal modal-md">
      <div class="modal-header"><div class="modal-title">Add / Edit Bin</div><button class="modal-close" onclick="closeModal('bin-modal')">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="b-id">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Bin Code <span class="required">*</span></label><input type="text" id="b-code" class="form-input" placeholder="A-01-03" style="text-transform:uppercase;font-family:var(--font-mono);"></div>
          <div class="form-group"><label class="form-label">Zone <span class="required">*</span></label>
            <select id="b-zone" class="form-select"><option value="">Select zone…</option>${zoneOpts}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Bin Type</label>
            <select id="b-type" class="form-select">${Object.entries(BIN_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label class="form-label">Status</label>
            <select id="b-status" class="form-select">${Object.entries(BIN_STATUSES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-3">
          <div class="form-group"><label class="form-label">Row</label><input type="text" id="b-row" class="form-input" placeholder="A"></div>
          <div class="form-group"><label class="form-label">Rack</label><input type="text" id="b-rack" class="form-input" placeholder="01"></div>
          <div class="form-group"><label class="form-label">Level</label><input type="text" id="b-level" class="form-input" placeholder="03"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Capacity (units)</label><input type="number" id="b-capacity" class="form-input" placeholder="100" min="0"></div>
          <div class="form-group"><label class="form-label">Current Stock (units)</label><input type="number" id="b-used" class="form-input" placeholder="0" min="0"></div>
        </div>
        <div class="form-group"><label class="form-label">Notes</label><textarea id="b-notes" class="form-textarea" rows="2" placeholder="Cold storage. Max weight 500Kg."></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('bin-modal')">Cancel</button>
        <button class="btn btn-primary" id="bin-save-btn" onclick="saveBin()">Save Bin</button>
      </div>
    </div>
  </div>`;
}

function _buildMoveModal(){
  const binOpts=_bins.map(b=>`<option value="${b.id}">${escHtml(b.binCode||b.id)} — ${escHtml(_zones.find(z=>z.id===b.zoneId)?.name||'')}</option>`).join('');
  return `<div class="modal-overlay hidden" id="move-modal">
    <div class="modal modal-sm">
      <div class="modal-header"><div class="modal-title">↔ Move Stock Between Bins</div><button class="modal-close" onclick="closeModal('move-modal')">✕</button></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Item / SKU <span class="required">*</span></label><input type="text" id="mv-item" class="form-input" placeholder="Item name or SKU code"></div>
        <div class="form-group"><label class="form-label">From Bin <span class="required">*</span></label>
          <select id="mv-from" class="form-select"><option value="">Select source bin…</option>${binOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">To Bin <span class="required">*</span></label>
          <select id="mv-to" class="form-select"><option value="">Select destination bin…</option>${binOpts}</select>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Quantity to Move <span class="required">*</span></label><input type="number" id="mv-qty" class="form-input" placeholder="0" min="1"></div>
          <div class="form-group"><label class="form-label">Move Date</label><input type="date" id="mv-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        </div>
        <div class="form-group"><label class="form-label">Reason</label>
          <select id="mv-reason" class="form-select">
            <option value="reorder">Space reorder</option><option value="damage">Near damaged area</option>
            <option value="dispatch">Pre-dispatch staging</option><option value="overflow">Overflow</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Notes</label><input type="text" id="mv-notes" class="form-input" placeholder="Optional notes…"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('move-modal')">Cancel</button>
        <button class="btn btn-primary" id="move-save-btn" onclick="executeStockMove()">↔ Move Stock</button>
      </div>
    </div>
  </div>`;
}

function _registerGlobals(){
  window.selectZone=(id)=>{
    _selectedZone=id;
    _renderZones();
    _renderBinGrid(id);
    document.getElementById('bin-detail-panel').style.display='none';
  };

  window.searchBins=(q)=>{
    if(_selectedZone) _renderBinGrid(_selectedZone,q);
  };

  window.viewBinDetail=(id)=>{
    const bin=_bins.find(b=>b.id===id); if(!bin) return;
    const zone=_zones.find(z=>z.id===bin.zoneId)||{};
    const stock=_binStock.filter(s=>s.binId===id);
    const pct=bin.capacity?Math.round((bin.usedCapacity||0)/bin.capacity*100):0;
    const panel=document.getElementById('bin-detail-panel');
    const title=document.getElementById('bin-detail-title');
    const content=document.getElementById('bin-detail-content');
    if(panel) panel.style.display='';
    if(title) title.textContent=`Bin ${escHtml(bin.binCode||'—')} — ${escHtml(zone.name||'—')}`;
    if(content) content.innerHTML=`
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:var(--space-4);">
        <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;flex:1;min-width:160px;">
          <div style="font-size:10px;text-transform:uppercase;font-weight:700;color:var(--text-muted);margin-bottom:6px;">Bin Info</div>
          <div style="font-size:12px;display:flex;flex-direction:column;gap:4px;">
            <div>Type: ${BIN_TYPES[bin.type]||bin.type||'—'}</div>
            <div>Row/Rack/Level: ${escHtml([bin.row,bin.rack,bin.level].filter(Boolean).join('-')||'—')}</div>
            <div>Status: ${badge(bin.status||'empty',BIN_STATUSES[bin.status||'empty'])}</div>
            ${bin.notes?`<div style="color:var(--text-muted);">${escHtml(bin.notes)}</div>`:''}
          </div>
        </div>
        <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;flex:1;min-width:160px;">
          <div style="font-size:10px;text-transform:uppercase;font-weight:700;color:var(--text-muted);margin-bottom:6px;">Capacity</div>
          ${bin.capacity?`
            <div style="font-size:24px;font-weight:800;font-family:var(--font-mono);color:${pct>85?'var(--brand-danger)':pct>60?'var(--brand-warning)':'var(--brand-secondary)'};">${pct}%</div>
            <div style="font-size:11px;color:var(--text-muted);">${bin.usedCapacity||0} / ${bin.capacity} units</div>
            <div style="height:6px;background:var(--border-subtle);border-radius:3px;margin-top:8px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${pct>85?'var(--brand-danger)':pct>60?'var(--brand-warning)':'var(--brand-secondary)'};"></div></div>`
          :`<div style="font-size:12px;color:var(--text-muted);">No capacity defined</div>`}
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:600;">Stock in this bin</div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" onclick="openModal('move-modal');document.getElementById('mv-from').value='${id}';">↔ Move</button>
          <button class="btn btn-secondary btn-sm" onclick="editBin('${id}')">✏️ Edit Bin</button>
          <button class="btn btn-danger btn-sm" onclick="deleteBin('${id}')">🗑 Delete</button>
        </div>
      </div>
      ${stock.length?`<div style="display:flex;flex-direction:column;gap:6px;">
        ${stock.map(s=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);font-size:12px;">
          <div style="flex:1;"><div style="font-weight:500;">${escHtml(s.itemName||'—')}</div><div style="font-size:10px;color:var(--text-muted);">SKU: ${escHtml(s.sku||'—')} · Batch: ${escHtml(s.batchNo||'—')}</div></div>
          <div style="font-family:var(--font-mono);font-weight:700;">${s.qty||0} ${escHtml(s.unit||'')}</div>
        </div>`).join('')}
      </div>`:`<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;">This bin is empty.</div>`}`;
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  };

  // Zone CRUD
  window.saveZone=async()=>{
    const name=document.getElementById('z-name')?.value?.trim(); if(!name){Toast.warning('Missing','Zone name required.');return;}
    const btn=document.getElementById('zone-save-btn'); setLoading(btn,true);
    const id=document.getElementById('z-id')?.value;
    const data={name,code:(document.getElementById('z-code')?.value||'').toUpperCase(),type:document.getElementById('z-type')?.value||'storage',icon:document.getElementById('z-icon')?.value||'🏭',color:document.getElementById('z-color')?.value||'#e0f2fe',description:document.getElementById('z-desc')?.value?.trim()||'',companyId:AuthState.company?.id||null};
    try{
      if(id){await dbUpdate(BIN_COLS.ZONES,id,data);const idx=_zones.findIndex(z=>z.id===id);if(idx>=0)_zones[idx]={...data,id};}
      else{const nz=await dbCreate(BIN_COLS.ZONES,data);_zones.push({...data,id:nz.id||genId()});}
      Toast.success('Saved','Zone saved.'); closeModal('zone-modal'); _renderZones();
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.editZone=(id)=>{
    const z=_zones.find(x=>x.id===id); if(!z) return;
    document.getElementById('z-id').value=z.id;
    document.getElementById('z-name').value=z.name||'';
    document.getElementById('z-code').value=z.code||'';
    document.getElementById('z-type').value=z.type||'storage';
    document.getElementById('z-icon').value=z.icon||'';
    document.getElementById('z-color').value=z.color||'#e0f2fe';
    document.getElementById('z-desc').value=z.description||'';
    openModal('zone-modal');
  };

  window.deleteZone=async(id)=>{
    if(!confirm('Delete this zone? All bins in this zone will also be deleted.')) return;
    try{await dbDelete(BIN_COLS.ZONES,id);_zones=_zones.filter(z=>z.id!==id);_bins=_bins.filter(b=>b.zoneId!==id);_renderZones();_renderKPIs();if(_selectedZone===id){_selectedZone=null;document.getElementById('bin-grid').innerHTML='';document.getElementById('bin-grid-title').textContent='Select a zone to view bins';}Toast.success('Deleted','Zone deleted.');}
    catch(e){Toast.error('Failed',e.message);}
  };

  // Bin CRUD
  window.saveBin=async()=>{
    const code=document.getElementById('b-code')?.value?.trim(),zone=document.getElementById('b-zone')?.value;
    if(!code||!zone){Toast.warning('Missing','Bin code and zone required.');return;}
    const btn=document.getElementById('bin-save-btn'); setLoading(btn,true);
    const id=document.getElementById('b-id')?.value;
    const cap=Number(document.getElementById('b-capacity')?.value)||0;
    const used=Number(document.getElementById('b-used')?.value)||0;
    const data={binCode:code.toUpperCase(),zoneId:zone,type:document.getElementById('b-type')?.value||'storage',status:document.getElementById('b-status')?.value||'empty',row:document.getElementById('b-row')?.value?.trim()||'',rack:document.getElementById('b-rack')?.value?.trim()||'',level:document.getElementById('b-level')?.value?.trim()||'',capacity:cap,usedCapacity:used,notes:document.getElementById('b-notes')?.value?.trim()||'',companyId:AuthState.company?.id||null};
    try{
      if(id){await dbUpdate(BIN_COLS.BINS,id,data);const idx=_bins.findIndex(b=>b.id===id);if(idx>=0)_bins[idx]={...data,id};}
      else{const nb=await dbCreate(BIN_COLS.BINS,data);_bins.push({...data,id:nb.id||genId()});}
      Toast.success('Saved','Bin saved.'); closeModal('bin-modal'); _renderKPIs();
      if(_selectedZone===zone)_renderBinGrid(zone);
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.editBin=(id)=>{
    const b=_bins.find(x=>x.id===id); if(!b) return;
    document.getElementById('b-id').value=b.id;
    document.getElementById('b-code').value=b.binCode||'';
    document.getElementById('b-zone').value=b.zoneId||'';
    document.getElementById('b-type').value=b.type||'storage';
    document.getElementById('b-status').value=b.status||'empty';
    document.getElementById('b-row').value=b.row||'';
    document.getElementById('b-rack').value=b.rack||'';
    document.getElementById('b-level').value=b.level||'';
    document.getElementById('b-capacity').value=b.capacity||'';
    document.getElementById('b-used').value=b.usedCapacity||'';
    document.getElementById('b-notes').value=b.notes||'';
    openModal('bin-modal');
  };

  window.deleteBin=async(id)=>{
    if(!confirm('Delete this bin?')) return;
    try{await dbDelete(BIN_COLS.BINS,id);_bins=_bins.filter(b=>b.id!==id);_renderKPIs();if(_selectedZone)_renderBinGrid(_selectedZone);document.getElementById('bin-detail-panel').style.display='none';Toast.success('Deleted','Bin deleted.');}
    catch(e){Toast.error('Failed',e.message);}
  };

  // Stock move
  window.executeStockMove=async()=>{
    const item=document.getElementById('mv-item')?.value?.trim();
    const from=document.getElementById('mv-from')?.value;
    const to=document.getElementById('mv-to')?.value;
    const qty=Number(document.getElementById('mv-qty')?.value)||0;
    if(!item||!from||!to||!qty){Toast.warning('Missing','Fill all fields.');return;}
    if(from===to){Toast.warning('Same Bin','Source and destination bins must be different.');return;}
    const btn=document.getElementById('move-save-btn'); setLoading(btn,true);
    const fromBin=_bins.find(b=>b.id===from), toBin=_bins.find(b=>b.id===to);
    try{
      await dbCreate('wh_stock_moves',{
        itemName:item, fromBinId:from, fromBinCode:fromBin?.binCode||'', toBinId:to, toBinCode:toBin?.binCode||'',
        qty, reason:document.getElementById('mv-reason')?.value||'', notes:document.getElementById('mv-notes')?.value?.trim()||'',
        movedBy:AuthState.profile?.name||'', movedAt:new Date().toISOString(), companyId:AuthState.company?.id||null,
      });
      Toast.success('Moved',`${qty} units of "${item}" moved from ${fromBin?.binCode||''} → ${toBin?.binCode||''}`);
      closeModal('move-modal');
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };
}

// ── Categories & Units page ────────────────────────────────
export async function renderCategories(container) {
  const { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, where, orderBy } = await import('../../core/firebase.js');
  const { AuthState } = await import('../../core/auth.js');
  const { Toast } = await import('../../core/notifications.js');
  const { escHtml, genId } = await import('../../core/utils.js');
  const { pageShell, buildTable, buildModal, openModal, closeModal, setupModalClose, badge } = await import('../_shared.js');

  let _cats=[], _units=[], _catUnsub=null, _unitsUnsub=null;
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  container.innerHTML = pageShell({
    title: '🏷 Categories & Units',
    subtitle: 'Manage product categories, sub-categories and units of measurement.',
    actions: `<button class="btn btn-primary" onclick="openModal('cat-modal')">+ Add Category</button>`,
    content: `
      <div class="grid-2" style="align-items:start;gap:var(--space-5);">
        <div class="card">
          <div class="card-header"><div class="card-title">📦 Product Categories</div></div>
          <div id="cat-list"><div style="display:flex;justify-content:center;padding:30px;"><div class="spinner"></div></div></div>
        </div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">📐 Units of Measurement</div>
            <button class="btn btn-secondary btn-sm" onclick="openModal('unit-modal')">+ Add Unit</button>
          </div>
          <div id="unit-list"><div style="display:flex;justify-content:center;padding:30px;"><div class="spinner"></div></div></div>
        </div>
      </div>
    `,
  });

  // Category modal
  document.getElementById('cat-modal')?.remove();
  document.getElementById('unit-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay hidden" id="cat-modal">
      <div class="modal modal-sm">
        <div class="modal-header"><div class="modal-title">Product Category</div><button class="modal-close" onclick="closeModal('cat-modal')">✕</button></div>
        <div class="modal-body">
          <input type="hidden" id="cat-id">
          <div class="form-group"><label class="form-label">Category Name *</label><input type="text" id="cat-name" class="form-input" placeholder="e.g. Spare Parts, Fuel, Tyres"></div>
          <div class="form-group"><label class="form-label">Parent Category</label>
            <select id="cat-parent" class="form-select"><option value="">None (Top Level)</option></select>
          </div>
          <div class="form-group"><label class="form-label">HSN/SAC Code</label><input type="text" id="cat-hsn" class="form-input" placeholder="27101990" style="font-family:var(--font-mono)"></div>
          <div class="form-group"><label class="form-label">Default GST Rate (%)</label>
            <select id="cat-gst" class="form-select">${[0,5,12,18,28].map(r=>`<option value="${r}">${r}%</option>`).join('')}</select>
          </div>
          <div class="form-group"><label class="form-label">Description</label><textarea id="cat-desc" class="form-textarea" rows="2"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('cat-modal')">Cancel</button>
          <button class="btn btn-primary" onclick="saveCat()">Save</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="unit-modal">
      <div class="modal modal-sm">
        <div class="modal-header"><div class="modal-title">Unit of Measurement</div><button class="modal-close" onclick="closeModal('unit-modal')">✕</button></div>
        <div class="modal-body">
          <input type="hidden" id="unit-id">
          <div class="form-grid-2">
            <div class="form-group"><label class="form-label">Unit Name *</label><input type="text" id="unit-name" class="form-input" placeholder="Kilogram"></div>
            <div class="form-group"><label class="form-label">Symbol *</label><input type="text" id="unit-symbol" class="form-input" placeholder="Kg" maxlength="10"></div>
          </div>
          <div class="form-group"><label class="form-label">Unit Type</label>
            <select id="unit-type" class="form-select">
              <option value="weight">Weight</option><option value="volume">Volume</option><option value="length">Length</option>
              <option value="area">Area</option><option value="count">Count/Piece</option><option value="time">Time</option><option value="other">Other</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('unit-modal')">Cancel</button>
          <button class="btn btn-primary" onclick="saveUnit()">Save</button>
        </div>
      </div>
    </div>
  `);
  setupModalClose();

  const renderCats = () => {
    const el=document.getElementById('cat-list'); if(!el) return;
    if(!_cats.length){el.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No categories yet. Click + Add Category.</div>';return;}
    const sel=document.getElementById('cat-parent');
    if(sel){sel.innerHTML='<option value="">None (Top Level)</option>'+_cats.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');}
    const top=_cats.filter(c=>!c.parentId);
    const children=id=>_cats.filter(c=>c.parentId===id);
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:4px;">
      ${top.map(c=>`
        <div style="padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid var(--brand-primary);">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div><div style="font-size:13px;font-weight:600;">${escHtml(c.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${c.hsn?`HSN: ${escHtml(c.hsn)} · `:''}GST: ${c.gst||18}%</div>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="btn btn-secondary btn-sm" onclick="editCat('${c.id}')">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteCat('${c.id}')">🗑</button>
            </div>
          </div>
          ${children(c.id).map(sub=>`
            <div style="margin-top:6px;padding:6px 12px;background:var(--bg-overlay);border-radius:var(--radius-sm);font-size:12px;display:flex;justify-content:space-between;align-items:center;">
              <span>↳ ${escHtml(sub.name)} ${sub.hsn?`<span style="color:var(--text-muted);">(${escHtml(sub.hsn)})</span>`:''}</span>
              <div style="display:flex;gap:4px;">
                <button class="btn btn-secondary btn-sm" style="font-size:10px;" onclick="editCat('${sub.id}')">✏️</button>
                <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="deleteCat('${sub.id}')">🗑</button>
              </div>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;
  };

  const renderUnits = () => {
    const el=document.getElementById('unit-list'); if(!el) return;
    if(!_units.length){el.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No units yet.</div>';return;}
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:4px;">
      ${_units.map(u=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <span style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--brand-primary);min-width:40px;">${escHtml(u.symbol||'—')}</span>
        <div style="flex:1;font-size:12px;"><div style="font-weight:500;">${escHtml(u.name||'—')}</div><div style="font-size:10px;color:var(--text-muted);">${escHtml(u.type||'')}</div></div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-secondary btn-sm" style="font-size:10px;" onclick="editUnit('${u.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="deleteUnit('${u.id}')">🗑</button>
        </div>
      </div>`).join('')}
    </div>`;
  };

  const catsQ = [...c, orderBy('name')];
  _catUnsub  = dbListen('product_categories', catsQ, d=>{ _cats=d; renderCats(); });
  _unitsUnsub= dbListen('product_units',      [...c, orderBy('name')], d=>{ _units=d; renderUnits(); });

  // Seed default units if none exist
  setTimeout(async()=>{
    if(_units.length===0){
      const defaults=[
        {name:'Kilogram',symbol:'Kg',type:'weight'},{name:'Gram',symbol:'g',type:'weight'},
        {name:'Litre',symbol:'Ltr',type:'volume'},{name:'Millilitre',symbol:'ml',type:'volume'},
        {name:'Piece / Number',symbol:'Nos',type:'count'},{name:'Box',symbol:'Box',type:'count'},
        {name:'Metre',symbol:'Mtr',type:'length'},{name:'Set',symbol:'Set',type:'count'},
        {name:'Bag',symbol:'Bag',type:'count'},{name:'Drum',symbol:'Drum',type:'count'},
        {name:'Metric Ton',symbol:'MT',type:'weight'},{name:'Quintal',symbol:'Qtl',type:'weight'},
        {name:'Roll',symbol:'Roll',type:'count'},{name:'Pair',symbol:'Pair',type:'count'},
      ];
      for(const u of defaults){
        await dbCreate('product_units',{...u,companyId:cid||null}).catch(()=>{});
      }
    }
  }, 1000);

  window.saveCat=async()=>{
    const name=document.getElementById('cat-name')?.value?.trim();
    if(!name){Toast.warning('Missing','Category name required.');return;}
    const id=document.getElementById('cat-id')?.value;
    const data={name,parentId:document.getElementById('cat-parent')?.value||'',hsn:document.getElementById('cat-hsn')?.value?.trim()||'',gst:Number(document.getElementById('cat-gst')?.value)||18,description:document.getElementById('cat-desc')?.value?.trim()||'',companyId:cid||null};
    try{if(id){await dbUpdate('product_categories',id,data);}else{await dbCreate('product_categories',data);}Toast.success('Saved','Category saved.');closeModal('cat-modal');['cat-id','cat-name','cat-hsn','cat-desc'].forEach(x=>{const e=document.getElementById(x);if(e)e.value='';});}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.editCat=(id)=>{
    const c=_cats.find(x=>x.id===id); if(!c) return;
    document.getElementById('cat-id').value=c.id;
    document.getElementById('cat-name').value=c.name||'';
    document.getElementById('cat-parent').value=c.parentId||'';
    document.getElementById('cat-hsn').value=c.hsn||'';
    document.getElementById('cat-gst').value=c.gst||18;
    document.getElementById('cat-desc').value=c.description||'';
    openModal('cat-modal');
  };
  window.deleteCat=async(id)=>{if(!confirm('Delete category?'))return;try{await dbDelete('product_categories',id);Toast.success('Deleted','Category removed.');}catch(e){Toast.error('Failed',e.message);}};

  window.saveUnit=async()=>{
    const name=document.getElementById('unit-name')?.value?.trim(),symbol=document.getElementById('unit-symbol')?.value?.trim();
    if(!name||!symbol){Toast.warning('Missing','Name and symbol required.');return;}
    const id=document.getElementById('unit-id')?.value;
    const data={name,symbol,type:document.getElementById('unit-type')?.value||'count',companyId:cid||null};
    try{if(id){await dbUpdate('product_units',id,data);}else{await dbCreate('product_units',data);}Toast.success('Saved','Unit saved.');closeModal('unit-modal');['unit-id','unit-name','unit-symbol'].forEach(x=>{const e=document.getElementById(x);if(e)e.value='';});}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.editUnit=(id)=>{
    const u=_units.find(x=>x.id===id); if(!u) return;
    document.getElementById('unit-id').value=u.id;
    document.getElementById('unit-name').value=u.name||'';
    document.getElementById('unit-symbol').value=u.symbol||'';
    document.getElementById('unit-type').value=u.type||'count';
    openModal('unit-modal');
  };
  window.deleteUnit=async(id)=>{if(!confirm('Delete unit?'))return;try{await dbDelete('product_units',id);Toast.success('Deleted','Unit removed.');}catch(e){Toast.error('Failed',e.message);}};
}
