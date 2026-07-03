// ============================================================
// LAM — Stock / Inventory Tracker (renderInventory)
// Phase 1: shows current stock levels per product/warehouse
// ============================================================
import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, formatNumber } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, openModal, closeModal, setupModalClose, setupMenuClose, avatarCell , validateForm} from '../_shared.js';

let _inv=[], _filt=[], _page=1, _products=[], _warehouses=[];
const PER=20;
let _unsub=null;

export async function renderInventory(container) {
  [_products, _warehouses] = await Promise.all([
    dbGetAll(COLLECTIONS.PRODUCTS, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.WAREHOUSES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title:'Stock / Inventory',
    subtitle:'Real-time stock levels across all warehouses.',
    actions:`<button class="btn btn-primary" onclick="openModal('stock-modal')">+ Adjust Stock</button>`,
    content:`
      ${searchBar({id:'inv',placeholder:'Search product, SKU, warehouse…',filters:[
        {key:'warehouseId',label:'All Warehouses',options:_warehouses.map(w=>({value:w.id,label:w.name}))},
      ],onSearch:'invSearch',onFilter:'invFilter'})}
      <div id="inv-table-wrap"></div>
      <div id="inv-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', buildModal({
    id:'stock-modal', title:'Adjust Stock',
    body:`
      <input type="hidden" id="stock-id">
      <div class="form-group"><label class="form-label">Product <span class="required">*</span></label>
        <select id="s-product" class="form-select">
          <option value="">Select product…</option>
          ${_products.map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Warehouse <span class="required">*</span></label>
        <select id="s-warehouse" class="form-select">
          <option value="">Select warehouse…</option>
          ${_warehouses.map(w=>`<option value="${w.id}">${escHtml(w.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Quantity <span class="required">*</span></label><input type="number" id="s-qty" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Reorder Point</label><input type="number" id="s-reorder" class="form-input" placeholder="10" min="0"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Batch / Lot No.</label><input type="text" id="s-batch" class="form-input" placeholder="BATCH-001"></div>
        <div class="form-group"><label class="form-label">Expiry Date</label><input type="date" id="s-expiry" class="form-input"></div>
      </div>
      <div class="form-group"><label class="form-label">Location (Bin)</label><input type="text" id="s-bin" class="form-input" placeholder="Zone A / Rack 2 / Bin 5"></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea id="s-notes" class="form-textarea" rows="2" placeholder="Reason for adjustment…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('stock-modal')">Cancel</button><button class="btn btn-primary" id="stock-save-btn" onclick="saveStock()">Save Stock</button>`,
  }));

  setupModalClose(); setupMenuClose();

  if (_unsub) _unsub();
  const cid=AuthState.company?.id;
  const c=cid?[where('companyId','==',cid),orderBy('updatedAt','desc')]:[orderBy('updatedAt','desc')];
  _unsub=dbListen(COLLECTIONS.INVENTORY,c,data=>{_inv=data;_filt=[...data];renderInvTable();});
}

function productName(id) { return _products.find(p=>p.id===id)?.name || id || '—'; }
function productSku(id)  { return _products.find(p=>p.id===id)?.sku  || ''; }
function whName(id)      { return _warehouses.find(w=>w.id===id)?.name || id || '—'; }

function renderInvTable() {
  const wrap=document.getElementById('inv-table-wrap'); const pg=document.getElementById('inv-pagination'); if(!wrap)return;
  const start=(_page-1)*PER; const pageData=_filt.slice(start,start+PER);
  document.getElementById('inv-count').textContent=`${_filt.length} record${_filt.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({id:'inv-table',columns:[
    {key:'productId',label:'Product',render:r=>avatarCell(productName(r.productId),`SKU: ${productSku(r.productId)}`,'var(--brand-accent)','rgba(255,107,53,0.12)')},
    {key:'warehouseId',label:'Warehouse',render:r=>`<span style="color:var(--text-secondary)">${escHtml(whName(r.warehouseId))}</span>`},
    {key:'quantity',label:'Qty',render:r=>{
      const qty=Number(r.quantity)||0; const rp=Number(r.reorderPoint)||0;
      const color=qty===0?'var(--brand-danger)':qty<=rp?'var(--brand-warning)':'var(--brand-secondary)';
      return `<span style="font-family:var(--font-mono);font-weight:700;color:${color};">${formatNumber(qty)}</span>`;
    }},
    {key:'reorderPoint',label:'Reorder At',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">${r.reorderPoint||'—'}</span>`},
    {key:'batch',label:'Batch',render:r=>`<span style="font-size:12px;">${escHtml(r.batch||'—')}</span>`},
    {key:'binLocation',label:'Bin Location',render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml(r.binLocation||'—')}</span>`},
    {key:'expiryDate',label:'Expiry',render:r=>r.expiryDate?`<span style="font-size:12px;color:var(--text-muted);">${r.expiryDate}</span>`:'—'},
    {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[{icon:'✏️',label:'Edit',action:`editStock('${r.id}')`},{icon:'🗑',label:'Delete',action:`deleteStock('${r.id}')`,danger:true}])},
  ], rows:pageData, emptyMsg:'No stock records yet' });
  pg.innerHTML=buildPagination({id:'inv',total:_filt.length,page:_page,perPage:PER,onChange:'setInvPage'});
}

window.invSearch=debounce((q)=>{_filt=_inv.filter(i=>productName(i.productId).toLowerCase().includes(q.toLowerCase())||whName(i.warehouseId).toLowerCase().includes(q.toLowerCase())||(i.batch||'').toLowerCase().includes(q.toLowerCase()));_page=1;renderInvTable();},250);
window.invFilter=(k,v)=>{_filt=v?_inv.filter(i=>i[k]===v):[..._inv];_page=1;renderInvTable();};
window.setInvPage=(p)=>{_page=p;renderInvTable();};
window.saveStock=async()=>{
  if(!validateForm([{id:'s-product',label:'Product',required:true},{id:'s-warehouse',label:'Warehouse',required:true},{id:'s-qty',label:'Quantity',required:true}])) return;
  const btn=document.getElementById('stock-save-btn'); setLoading(btn,true);
  const id=document.getElementById('stock-id').value;
  const data={productId:document.getElementById('s-product').value,warehouseId:document.getElementById('s-warehouse').value,quantity:Number(document.getElementById('s-qty').value)||0,reorderPoint:Number(document.getElementById('s-reorder').value)||0,batch:document.getElementById('s-batch').value.trim(),expiryDate:document.getElementById('s-expiry').value,binLocation:document.getElementById('s-bin').value.trim(),notes:document.getElementById('s-notes').value.trim(),companyId:AuthState.company?.id||null};
  try{
    if(id){await dbUpdate(COLLECTIONS.INVENTORY,id,data);Toast.success('Updated','Stock updated.');}
    else{await dbCreate(COLLECTIONS.INVENTORY,data);Toast.success('Added','Stock record created.');}
    closeModal('stock-modal');
    ['stock-id','s-qty','s-reorder','s-batch','s-expiry','s-bin','s-notes'].forEach(x=>{const e=document.getElementById(x);if(e)e.value='';});
    document.getElementById('s-product').value=''; document.getElementById('s-warehouse').value='';
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.editStock=(id)=>{
  const s=_inv.find(x=>x.id===id);if(!s)return;
  document.getElementById('stock-id').value=s.id;
  document.getElementById('s-product').value=s.productId||'';
  document.getElementById('s-warehouse').value=s.warehouseId||'';
  document.getElementById('s-qty').value=s.quantity||'';
  document.getElementById('s-reorder').value=s.reorderPoint||'';
  document.getElementById('s-batch').value=s.batch||'';
  document.getElementById('s-expiry').value=s.expiryDate||'';
  document.getElementById('s-bin').value=s.binLocation||'';
  document.getElementById('s-notes').value=s.notes||'';
  openModal('stock-modal');
};
window.deleteStock=async(id)=>{
  if(!confirm('Delete this stock record?')) return;
  try{await dbDelete(COLLECTIONS.INVENTORY,id);Toast.success('Deleted','Stock record removed.');}
  catch(e){Toast.error('Failed',e.message);}
};


// ── Delivery Clustering (Tier 5 — LAMMaps) ───────────────────
window.clusterDeliveries = async () => {
  if (!window.LAMMaps) {
    Toast.info('LAMMaps required', 'Delivery clustering needs LAMMaps engine.');
    return;
  }

  // Get all pending delivery notes with addresses
  const dns = _dns || [];
  const pending = dns.filter(d => d.status !== 'delivered');

  if (!pending.length) {
    Toast.info('No Deliveries', 'No pending deliveries to cluster.');
    return;
  }

  Toast.info('Clustering…', `Grouping ${pending.length} deliveries into optimal zones.`);

  // Geocode delivery addresses (use offline first)
  const geocoded = [];
  for (const dn of pending.slice(0, 30)) {
    const addr = dn.deliveryAddress || dn.customerName || '';
    if (!addr) continue;
    const result = window.LAMMaps.geocodeOffline(addr);
    if (result) {
      geocoded.push({ ...result, dnId: dn.id, dnNumber: dn.dnNumber, customerName: dn.customerName });
    }
  }

  if (!geocoded.length) {
    Toast.info('No Coordinates', 'Could not geocode delivery addresses. Add city names to delivery notes.');
    return;
  }

  // Cluster into 3 zones (vehicles)
  const numVehicles = Math.min(3, Math.ceil(geocoded.length / 5));
  const clustered   = window.LAMMaps.clusterDeliveries(geocoded, numVehicles);

  // Optimize route within each cluster
  const colors = ['#0A84FF','#30D158','#FF9F0A','#BF5AF2'];
  const zones  = {};
  clustered.forEach(stop => {
    if (!zones[stop.cluster]) zones[stop.cluster] = [];
    zones[stop.cluster].push(stop);
  });

  // Show clustering result in a modal
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;width:100%;max-width:700px;max-height:90vh;overflow:auto;">
      <div style="padding:14px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between;">
        <div style="font-weight:700;">🗺️ Delivery Zone Clustering — ${geocoded.length} Stops</div>
        <button onclick="this.closest('div').parentElement.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:18px;">✕</button>
      </div>
      <div style="padding:12px;">
        <canvas id="cluster-map" style="width:100%;height:280px;border-radius:10px;border:1px solid var(--border-subtle);display:block;"></canvas>
      </div>
      <div style="padding:0 16px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
        ${Object.entries(zones).map(([cluster, stops]) => `
          <div style="background:var(--bg-elevated);border-radius:10px;padding:12px;border-left:4px solid ${colors[cluster]||'#94A3B8'};">
            <div style="font-weight:700;font-size:13px;margin-bottom:6px;">Zone ${parseInt(cluster)+1} — ${stops.length} stops</div>
            ${stops.map(s=>`<div style="font-size:11px;color:var(--text-muted);padding:2px 0;">${s.dnNumber||'—'} · ${s.customerName||s.label?.slice(0,20)||'—'}</div>`).join('')}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

  // Render clusters on map
  setTimeout(() => {
    const canvas = document.getElementById('cluster-map');
    if (!canvas || !window.LAMGPS) return;
    const map = new window.LAMGPS.LAMMap(canvas, {
      zoom: 9,
      center: { lat: geocoded.reduce((s,g)=>s+g.lat,0)/geocoded.length, lng: geocoded.reduce((s,g)=>s+g.lng,0)/geocoded.length },
    });
    clustered.forEach(stop => {
      map.addMarker({
        lat: stop.lat, lng: stop.lng,
        title: stop.customerName?.slice(0,12)||stop.dnNumber||'Stop',
        color: colors[stop.cluster||0],
        type: 'dot',
        radius: 8,
      });
    });
    map.render();
  }, 150);

  Toast.success('Clustered!', `${geocoded.length} deliveries grouped into ${numVehicles} vehicle zones.`);
};
