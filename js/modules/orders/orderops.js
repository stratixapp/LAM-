// ============================================================
// LAM — Order Operations Module (Tools 26-30)
// Pick & Pack, Delivery Note, Returns/Refunds,
// Backorder Management, Bulk Order Processing
// Interconnects: Orders → Inventory → Finance → Transport
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, dbBatch, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, formatDateTime, escHtml, setLoading,
  searchFilter, debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

export const OMS_COLLECTIONS = {
  PICK_PACKS:   'oms_pick_packs',
  DELIVERY_NOTES:'oms_delivery_notes',
  RETURNS:      'oms_returns',
  BACKORDERS:   'oms_backorders',
};

let _orders=[], _customers=[], _products=[], _inventory=[], _warehouses=[];
let _activeTab='pickpack';
let _unsubs=[];
const PER=15;

function _cleanupListeners(){ _unsubs.forEach(fn=>fn&&fn()); _unsubs=[]; }

export async function renderOrderOps(container) {
  _cleanupListeners();
  [_orders, _customers, _products, _inventory, _warehouses] = await Promise.all([
    dbGetAll('sales_orders',         AuthState.company?.id ? [where('companyId','==',AuthState.company.id), where('status','in',['confirmed','processing'])] : [where('status','in',['confirmed','processing'])]),
    dbGetAll(COLLECTIONS.CUSTOMERS,  AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.PRODUCTS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.INVENTORY,  AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.WAREHOUSES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '📦 Order Operations',
    subtitle: 'Pick & Pack, delivery notes, returns, backorders and bulk processing.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshOrderOps()">↻ Refresh</button>`,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="oms-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['pickpack',  '📋 Pick & Pack'],
          ['delivery',  '🚚 Delivery Notes'],
          ['returns',   '↩️ Returns'],
          ['backorder', '⏳ Backorders'],
          ['bulk',      '📦 Bulk Processing'],
        ].map(([id,label])=>`
          <button class="oms-tab ${id==='pickpack'?'active':''}" id="oms-tab-${id}"
            onclick="switchOMSTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>
        `).join('')}
      </div>
      <div id="oms-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.oms-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderOMSKPIs();
  setupModalClose(); setupMenuClose();
  window.switchOMSTab=switchOMSTab;
  window.refreshOrderOps=async()=>{
    _orders=await dbGetAll('sales_orders',AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    renderOMSKPIs(); switchOMSTab(_activeTab);
  };
  switchOMSTab('pickpack');
}

function renderOMSKPIs(){
  const el=document.getElementById('oms-kpis'); if(!el) return;
  el.innerHTML='';
  const readyToPick=_orders.filter(o=>o.status==='confirmed').length;
  const packing    =_orders.filter(o=>o.status==='processing').length;
  const dispatched =_orders.filter(o=>o.status==='dispatched').length;
  const delivered  =_orders.filter(o=>o.status==='delivered').length;
  const cancelled  =_orders.filter(o=>o.status==='cancelled').length;
  [
    {label:'Ready to Pick', value:readyToPick, icon:'📋', color:'kpi-blue'},
    {label:'Packing',       value:packing,     icon:'📦', color:'kpi-yellow'},
    {label:'Dispatched',    value:dispatched,  icon:'🚚', color:'kpi-orange'},
    {label:'Delivered',     value:delivered,   icon:'✅', color:'kpi-green'},
    {label:'Cancelled',     value:cancelled,   icon:'❌', color:'kpi-red'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchOMSTab(tab){
  _activeTab=tab;
  document.querySelectorAll('.oms-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`oms-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('oms-tab-content'); if(!c) return;
  switch(tab){
    case 'pickpack':  renderPickPackTab(c);   break;
    case 'delivery':  renderDeliveryTab(c);   break;
    case 'returns':   renderReturnsTab(c);    break;
    case 'backorder': renderBackorderTab(c);  break;
    case 'bulk':      renderBulkTab(c);       break;
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 26: PICK & PACK ENGINE
// ══════════════════════════════════════════════════════════════
let _pickPacks=[], _filtPP=[], _pagePP=1;

function renderPickPackTab(container){
  container.innerHTML=`
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="input-wrapper" style="flex:1;max-width:300px;">
        <span class="input-icon-left">🔍</span>
        <input type="text" id="pp-search" class="form-input has-icon-left" placeholder="Search order, customer…" oninput="ppSearch(this.value)">
      </div>
      <div id="pp-count" style="font-size:12px;color:var(--text-muted);"></div>
      <button class="btn btn-primary" onclick="generatePickList()">📋 Generate Pick List</button>
    </div>
    <div id="pp-table-wrap"></div>
    <div id="pp-pagination"></div>
    <div id="pp-modal-area"></div>
  `;

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(OMS_COLLECTIONS.PICK_PACKS,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _pickPacks=data; _filtPP=[...data]; renderPPTable();
  }));

  window.ppSearch=debounce((q)=>{_filtPP=_pickPacks.filter(p=>(p.pickListNo||'').toLowerCase().includes(q.toLowerCase())||(custName(p.orderId)||'').toLowerCase().includes(q.toLowerCase()));_pagePP=1;renderPPTable();},250);
  window.setPPPage=(p)=>{_pagePP=p;renderPPTable();};
}

function renderPPTable(){
  const wrap=document.getElementById('pp-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('pp-count'); if(cnt) cnt.textContent=`${_filtPP.length} pick list${_filtPP.length!==1?'s':''}`;
  const start=(_pagePP-1)*PER;
  wrap.innerHTML=buildTable({id:'pp-table',
    columns:[
      {key:'pickListNo',label:'Pick List #',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.pickListNo||'—')}</span>`},
      {key:'orderId',   label:'Order',      render:r=>{const o=_orders.find(x=>x.id===r.orderId)||{};return `<div><div style="font-size:12px;font-weight:600;">${escHtml(o.orderNumber||r.orderId||'—')}</div><div style="font-size:11px;color:var(--text-muted);">${escHtml(custName(r.orderId))}</div></div>`}},
      {key:'items',     label:'Items',      render:r=>`<span class="badge badge-blue">${r.items?.length||0} items</span>`},
      {key:'pickedBy',  label:'Picker',     render:r=>`<span style="font-size:12px;">${escHtml(r.pickedBy||'—')}</span>`},
      {key:'packedBy',  label:'Packer',     render:r=>`<span style="font-size:12px;">${escHtml(r.packedBy||'—')}</span>`},
      {key:'status',    label:'Status',     render:r=>badge(r.status||'pending')},
      {key:'createdAt', label:'Created',    render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.createdAt ? formatDate(r.createdAt) : "—"}</span>`},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'👁', label:'View Pick List', action:`viewPickList('${r.id}')`},
        {icon:'✅', label:'Mark Packed',    action:`markPacked('${r.id}')`},
        {icon:'🚚', label:'Generate DN',    action:`generateDNFromPick('${r.id}')`},
      ])},
    ],
    rows:_filtPP.slice(start,start+PER),emptyMsg:'No pick lists generated yet',
  });
  document.getElementById('pp-pagination').innerHTML=buildPagination({id:'pp',total:_filtPP.length,page:_pagePP,perPage:PER,onChange:'setPPPage'});
}

window.generatePickList=async()=>{
  const pendingOrders=_orders.filter(o=>o.status==='confirmed');
  if(!pendingOrders.length){Toast.info('No Orders','No confirmed orders ready for picking.');return;}

  // Show order selection dialog
  document.getElementById('pp-modal-area').innerHTML=buildModal({
    id:'pick-select-modal',title:'Generate Pick List',size:'lg',
    body:`
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:var(--space-4);">Select orders to include in this pick list:</p>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;">
        ${pendingOrders.map(o=>{
          const cust=_customers.find(c=>c.id===o.customerId);
          return `
            <label style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;border:1px solid var(--border-subtle);"
                   onmouseenter="this.style.borderColor='var(--border-strong)'" onmouseleave="this.style.borderColor='var(--border-subtle)'">
              <input type="checkbox" value="${o.id}" checked style="accent-color:var(--brand-primary);flex-shrink:0;">
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;">${escHtml(o.orderNumber||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${escHtml(cust?.name||'—')} · ${o.items?.length||0} items · ₹${Number(o.totalAmount||0).toLocaleString('en-IN')}</div>
              </div>
              <span class="badge badge-blue">${o.items?.length||0} items</span>
            </label>`;
        }).join('')}
      </div>
      <div class="form-grid-2" style="margin-top:var(--space-4);">
        <div class="form-group"><label class="form-label">Assigned Picker</label><input type="text" id="pp-picker" class="form-input" placeholder="Staff name"></div>
        <div class="form-group"><label class="form-label">Assigned Packer</label><input type="text" id="pp-packer" class="form-input" placeholder="Staff name"></div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('pick-select-modal')">Cancel</button>
            <button class="btn btn-primary" id="gen-pick-btn" onclick="confirmGeneratePickList()">Generate Pick List</button>`,
  });
  openModal('pick-select-modal');
};

window.confirmGeneratePickList=async()=>{
  const selectedIds=[...document.querySelectorAll('#pick-select-modal input[type=checkbox]:checked')].map(c=>c.value);
  if(!selectedIds.length){Toast.error('None selected','Select at least one order.');return;}
  const picker=document.getElementById('pp-picker').value.trim();
  const packer=document.getElementById('pp-packer').value.trim();
  const btn=document.getElementById('gen-pick-btn'); setLoading(btn,true);

  // Consolidate all items across selected orders
  const consolidatedItems={};
  selectedIds.forEach(orderId=>{
    const order=_orders.find(o=>o.id===orderId);
    (order?.items||[]).forEach(item=>{
      if(!consolidatedItems[item.productId]) consolidatedItems[item.productId]={productId:item.productId,totalQty:0,orders:[]};
      consolidatedItems[item.productId].totalQty+=Number(item.qty)||0;
      consolidatedItems[item.productId].orders.push({orderId,qty:item.qty});
    });
  });

  // Enrich with product + bin location
  const items=Object.values(consolidatedItems).map(item=>{
    const p=_products.find(x=>x.id===item.productId);
    const inv=_inventory.find(i=>i.productId===item.productId);
    return {...item,productName:p?.name||'—',sku:p?.sku||'—',binLocation:inv?.binLocation||'—',unit:p?.unit||'pcs',picked:false};
  });

  try{
    await dbCreate(OMS_COLLECTIONS.PICK_PACKS,{
      pickListNo:'PL-'+genId(),orderIds:selectedIds,items,
      pickedBy:picker,packedBy:packer,status:'pending',
      companyId:AuthState.company?.id||null,
    });
    // Update orders to processing
    await Promise.all(selectedIds.map(id=>dbUpdate('sales_orders',id,{status:'processing'})));
    Toast.success('Pick List Created',`${items.length} unique items across ${selectedIds.length} orders.`);
    closeModal('pick-select-modal');
  }catch(e){Toast.error('Failed',e.message);}
  finally{setLoading(btn,false);}
};

window.viewPickList=(id)=>{
  const pl=_pickPacks.find(x=>x.id===id); if(!pl) return;
  document.getElementById('pick-view-modal')?.remove();
  const html=buildModal({
    id:'pick-view-modal',title:`Pick List — ${pl.pickListNo}`,size:'xl',
    body:`
      <div class="grid-3" style="margin-bottom:var(--space-4);">
        ${[['Pick List #',pl.pickListNo],['Orders',pl.orderIds?.length||0],['Picker',pl.pickedBy||'—'],['Packer',pl.packedBy||'—'],['Status',pl.status],['Created',formatDate(pl.createdAt)]].map(([l,v])=>`
          <div style="padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">${l}</div>
            <div style="font-size:13px;margin-top:3px;">${escHtml(String(v||'—'))}</div>
          </div>`).join('')}
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>✓</th><th>Product</th><th>SKU</th><th>Bin Location</th><th>Qty Needed</th><th>Unit</th></tr></thead>
          <tbody>
            ${(pl.items||[]).map((item,i)=>`
              <tr style="${item.picked?'opacity:0.5;text-decoration:line-through;':''}">
                <td><input type="checkbox" ${item.picked?'checked':''} style="accent-color:var(--brand-primary);" onchange="togglePickItem('${id}',${i},this.checked)"></td>
                <td style="font-size:13px;font-weight:500;">${escHtml(item.productName)}</td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(item.sku)}</td>
                <td><span style="background:rgba(10,132,255,0.12);color:var(--brand-primary);padding:2px 8px;border-radius:4px;font-size:11px;">📍 ${escHtml(item.binLocation)}</span></td>
                <td style="font-family:var(--font-mono);font-weight:700;font-size:14px;">${formatNumber(item.totalQty)}</td>
                <td><span class="badge badge-gray">${escHtml(item.unit)}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('pick-view-modal')">Close</button>
            <button class="btn btn-primary" onclick="closeModal('pick-view-modal');markPacked('${id}')">✅ All Picked — Mark Packed</button>`,
  });
  document.body.insertAdjacentHTML('beforeend',html);
  openModal('pick-view-modal');
};

window.togglePickItem=async(plId,idx,checked)=>{
  const pl=_pickPacks.find(x=>x.id===plId); if(!pl) return;
  const items=[...(pl.items||[])];
  items[idx]={...items[idx],picked:checked};
  try{ await dbUpdate(OMS_COLLECTIONS.PICK_PACKS,plId,{items}); }
  catch(e){ Toast.error('Failed',e.message); }
};

window.markPacked=async(id)=>{
  if(!confirm('Mark this pick list as packed and ready for dispatch?')) return;
  try{
    await dbUpdate(OMS_COLLECTIONS.PICK_PACKS,id,{status:'packed',packedAt:new Date().toISOString()});
    Toast.success('Packed!','Pick list marked as packed. Ready for delivery note.');
  }catch(e){Toast.error('Failed',e.message);}
};

window.generateDNFromPick=async(id)=>{
  const pl=_pickPacks.find(x=>x.id===id); if(!pl) return;
  switchOMSTab('delivery');
  setTimeout(()=>openDeliveryNoteModal(pl),500);
};

function custName(orderId){ const o=_orders.find(x=>x.id===orderId); const c=_customers.find(x=>x.id===o?.customerId); return c?.name||o?.customerId||'—'; }

// ══════════════════════════════════════════════════════════════
// TOOL 27: DELIVERY NOTE GENERATION
// ══════════════════════════════════════════════════════════════
let _deliveries=[], _filtDel=[], _pageDel=1;

function renderDeliveryTab(container){
  container.innerHTML=`
    ${searchBar({id:'del',placeholder:'Search delivery note, order…',
      filters:[{key:'status',label:'All Status',options:[{value:'draft',label:'Draft'},{value:'issued',label:'Issued'},{value:'delivered',label:'Delivered'}]}],
      onSearch:'delSearch',onFilter:'delFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openDeliveryNoteModal()">+ Create Delivery Note</button>
    </div>
    <div id="del-table-wrap"></div>
    <div id="del-pagination"></div>
    <div id="del-modal-area"></div>
  `;

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(OMS_COLLECTIONS.DELIVERY_NOTES,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _deliveries=data; _filtDel=[...data]; renderDeliveryTable();
  }));

  window.delSearch=debounce((q)=>{_filtDel=searchFilter(_deliveries,q,['dnNumber','notes']);_pageDel=1;renderDeliveryTable();},250);
  window.delFilter=(k,v)=>{_filtDel=v?_deliveries.filter(d=>d[k]===v):[..._deliveries];_pageDel=1;renderDeliveryTable();};
  window.setDelPage=(p)=>{_pageDel=p;renderDeliveryTable();};
}

function renderDeliveryTable(){
  const wrap=document.getElementById('del-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('del-count'); if(cnt) cnt.textContent=`${_filtDel.length} delivery note${_filtDel.length!==1?'s':''}`;
  const start=(_pageDel-1)*PER;
  wrap.innerHTML=buildTable({id:'del-table',
    columns:[
      {key:'dnNumber',  label:'DN #',       render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.dnNumber||'—')}</span>`},
      {key:'orderId',   label:'Order',       render:r=>{const o=_orders.find(x=>x.id===r.orderId)||{}; return `<span style="font-size:12px;">${escHtml(o.orderNumber||r.orderId||'—')}</span>`}},
      {key:'customerId',label:'Customer',    render:r=>{const c=_customers.find(x=>x.id===r.customerId); return `<span style="font-size:12px;">${escHtml(c?.name||'—')}</span>`}},
      {key:'items',     label:'Items',       render:r=>`<span class="badge badge-blue">${r.items?.length||0} items</span>`},
      {key:'deliveryDate',label:'Date',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.deliveryDate||'—'}</span>`},
      {key:'deliveryAddress',label:'Address',render:r=>`<span style="font-size:11px;color:var(--text-secondary);">${escHtml((r.deliveryAddress||'').slice(0,40))}${(r.deliveryAddress||'').length>40?'…':''}</span>`},
      {key:'status',    label:'Status',      render:r=>badge(r.status||'draft')},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'🖨️',label:'Print DN',       action:`printDN('${r.id}')`},
        {icon:'✅',label:'Mark Delivered',  action:`markDNDelivered('${r.id}')`},
        {icon:'🗑',label:'Delete',          action:`deleteDN('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtDel.slice(start,start+PER),emptyMsg:'No delivery notes created yet',
  });
  document.getElementById('del-pagination').innerHTML=buildPagination({id:'del',total:_filtDel.length,page:_pageDel,perPage:PER,onChange:'setDelPage'});
}

window.openDeliveryNoteModal=(pickList=null)=>{
  document.getElementById('del-modal-area').innerHTML=buildDNModal(pickList);
  openModal('dn-modal');
};

function buildDNModal(pickList){
  const orderOpts=_orders.filter(o=>['confirmed','processing'].includes(o.status)).map(o=>{
    const c=_customers.find(x=>x.id===o.customerId);
    return `<option value="${o.id}">${escHtml(o.orderNumber||'—')} — ${escHtml(c?.name||'—')}</option>`;
  }).join('');

  return buildModal({
    id:'dn-modal',title:'Create Delivery Note',size:'lg',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">DN Number</label><input type="text" id="dn-no" class="form-input" value="DN-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Sales Order <span class="required">*</span></label>
          <select id="dn-order" class="form-select" onchange="autoFillDN(this.value)"><option value="">Select order…</option>${orderOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Delivery Date</label><input type="date" id="dn-date" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-group"><label class="form-label">Delivery Address <span class="required">*</span></label>
        <textarea id="dn-address" class="form-textarea" rows="2" placeholder="Full delivery address…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Contact Person</label><input type="text" id="dn-contact" class="form-input" placeholder="Recipient name"></div>
        <div class="form-group"><label class="form-label">Contact Phone</label><input type="tel" id="dn-phone" class="form-input" placeholder="9876543210"></div>
      </div>
      <div id="dn-items-section" style="margin-top:var(--space-4);">
        <div style="font-size:13px;font-weight:600;margin-bottom:var(--space-3);">Items</div>
        <div id="dn-items-list"><div style="font-size:12px;color:var(--text-muted);">Select an order to auto-populate items</div></div>
      </div>
      <div class="form-group" style="margin-top:var(--space-3);"><label class="form-label">Notes</label>
        <textarea id="dn-notes" class="form-textarea" rows="2" placeholder="Special delivery instructions…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('dn-modal')">Cancel</button>
            <button class="btn btn-primary" id="dn-save-btn" onclick="saveDN()">Create Delivery Note</button>`,
  });
}

window.autoFillDN=(orderId)=>{
  const order=_orders.find(o=>o.id===orderId); if(!order) return;
  const cust=_customers.find(c=>c.id===order.customerId);
  const addrEl=document.getElementById('dn-address');
  const contactEl=document.getElementById('dn-contact');
  const phoneEl=document.getElementById('dn-phone');
  if(addrEl&&cust?.address) addrEl.value=cust.address;
  if(contactEl&&cust?.name) contactEl.value=cust.name;
  if(phoneEl&&cust?.phone) phoneEl.value=cust.phone;

  const itemsEl=document.getElementById('dn-items-list');
  if(itemsEl&&order.items){
    itemsEl.innerHTML=`
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Product</th><th>Ordered Qty</th><th>Delivering Qty</th><th>Unit</th></tr></thead>
          <tbody>
            ${order.items.map((item,i)=>{
              const p=_products.find(x=>x.id===item.productId);
              return `<tr>
                <td style="font-size:12px;">${escHtml(p?.name||item.productId||'—')}</td>
                <td style="font-family:var(--font-mono);">${item.qty||0}</td>
                <td><input type="number" id="dn-item-qty-${i}" class="form-input" style="width:80px;" value="${item.qty||0}" min="0" max="${item.qty||0}"></td>
                <td><span class="badge badge-gray">${escHtml(p?.unit||'pcs')}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }
};

window.saveDN=async()=>{
  if(!validateForm([{id:'dn-order',label:'Order',required:true},{id:'dn-address',label:'Delivery Address',required:true}])) return;
  const btn=document.getElementById('dn-save-btn'); setLoading(btn,true);
  const orderId=document.getElementById('dn-order').value;
  const order=_orders.find(o=>o.id===orderId);
  const items=(order?.items||[]).map((item,i)=>({
    ...item,
    deliveryQty:Number(document.getElementById(`dn-item-qty-${i}`)?.value)||item.qty||0,
  }));
  try{
    const data={
      dnNumber:document.getElementById('dn-no').value.trim(),
      orderId,customerId:order?.customerId||null,
      deliveryDate:document.getElementById('dn-date').value,
      deliveryAddress:document.getElementById('dn-address').value.trim(),
      contactPerson:document.getElementById('dn-contact').value.trim(),
      contactPhone:document.getElementById('dn-phone').value.trim(),
      notes:document.getElementById('dn-notes').value.trim(),
      items,status:'issued',
      companyId:AuthState.company?.id||null,
    };
    await dbCreate(OMS_COLLECTIONS.DELIVERY_NOTES,data);
    await dbUpdate('sales_orders',orderId,{status:'dispatched',dnNumber:data.dnNumber});
    Toast.success('Delivery Note Created',`${data.dnNumber} issued. Order marked as dispatched.`);
    closeModal('dn-modal');
  }catch(e){Toast.error('Failed',e.message);}
  finally{setLoading(btn,false);}
};

window.printDN=(id)=>{ if(window.LAMPDF){ const dn=_dns?.find?.(d=>d.id===id)||{}; window.LAMPDF.deliveryNote(dn, AuthState.company||{}, {}, dn.items||[]); return; }; const _orig=(id)=>{
  const dn=_deliveries.find(x=>x.id===id); if(!dn) return;
  const o=_orders.find(x=>x.id===dn.orderId)||{};
  const c=_customers.find(x=>x.id===dn.customerId)||{};
  const win=window.open('','_blank');
  win.document.write(`
    <html><head><title>Delivery Note — ${dn.dnNumber}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:sans-serif;padding:40px;color:#000;}
    h1{font-size:24px;margin-bottom:4px;}table{width:100%;border-collapse:collapse;margin-top:16px;}
    th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;font-size:13px;}th{background:#f5f5f5;font-weight:600;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;}
    .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;}
    .val{font-size:13px;font-weight:500;margin-top:2px;}
    .section{margin-bottom:16px;}.section-title{font-size:13px;font-weight:700;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;color:#666;}
    @media print{button{display:none;}}</style></head>
    <body>
    <div class="header">
      <div><h1>Delivery Note</h1><div style="font-size:16px;font-weight:700;color:#0a84ff;">${escHtml(dn.dnNumber)}</div></div>
      <div style="text-align:right;"><div class="label">Date</div><div class="val">${dn.deliveryDate||'—'}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;">
      <div><div class="section-title">Deliver To</div><div style="font-weight:600;">${escHtml(c.name||'—')}</div><div style="white-space:pre-line;font-size:13px;">${escHtml(dn.deliveryAddress||'—')}</div><div style="margin-top:6px;">Contact: ${escHtml(dn.contactPerson||'—')} · ${escHtml(dn.contactPhone||'—')}</div></div>
      <div><div class="section-title">Order Details</div><div class="label">Order No.</div><div class="val">${escHtml(o.orderNumber||dn.orderId||'—')}</div></div>
    </div>
    <table><thead><tr><th>#</th><th>Product</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>
      ${(dn.items||[]).map((item,i)=>{const p=_products.find(x=>x.id===item.productId);return `<tr><td>${i+1}</td><td>${escHtml(p?.name||item.productId||'—')}</td><td>${item.deliveryQty||item.qty||0}</td><td>${escHtml(p?.unit||'pcs')}</td></tr>`;}).join('')}
    </tbody></table>
    ${dn.notes?`<div style="margin-top:16px;padding:12px;background:#f9f9f9;border-radius:6px;font-size:12px;"><strong>Notes:</strong> ${escHtml(dn.notes)}</div>`:''}
    <div style="margin-top:48px;display:flex;justify-content:space-between;">
      <div style="border-top:1px solid #000;padding-top:6px;width:200px;text-align:center;font-size:12px;">Authorized Signature</div>
      <div style="border-top:1px solid #000;padding-top:6px;width:200px;text-align:center;font-size:12px;">Receiver's Signature</div>
    </div>
    <script>window.print();</script></body></html>`);
};

window.markDNDelivered=async(id)=>{
  if(!confirm('Mark as delivered?')) return;
  const dn=_deliveries.find(x=>x.id===id);
  try{
    await dbUpdate(OMS_COLLECTIONS.DELIVERY_NOTES,id,{status:'delivered',deliveredAt:new Date().toISOString()});
    if(dn?.orderId) await dbUpdate('sales_orders',dn.orderId,{status:'delivered'});
    Toast.success('Delivered','Delivery confirmed.');
    window.LAMSync?.Notify.deliveryComplete(dn?.dnNumber || 'DN', dn?.receiverName || 'Receiver');
  }catch(e){Toast.error('Failed',e.message);}
};
window.deleteDN=async(id)=>{if(!confirm('Delete delivery note?'))return;try{await dbDelete(OMS_COLLECTIONS.DELIVERY_NOTES,id);Toast.success('Deleted','Delivery note removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 28: RETURN & REFUND MANAGEMENT
// ══════════════════════════════════════════════════════════════
let _returns=[], _filtRet=[], _pageRet=1;

function renderReturnsTab(container){
  container.innerHTML=`
    ${searchBar({id:'ret',placeholder:'Search return no, customer…',
      filters:[{key:'status',label:'All Status',options:[{value:'requested',label:'Requested'},{value:'approved',label:'Approved'},{value:'received',label:'Received'},{value:'refunded',label:'Refunded'},{value:'rejected',label:'Rejected'}]},
               {key:'reason',label:'All Reasons',options:[{value:'damage',label:'Damaged'},{value:'wrong-item',label:'Wrong Item'},{value:'quality',label:'Quality Issue'},{value:'excess',label:'Excess Qty'},{value:'other',label:'Other'}]}],
      onSearch:'retSearch',onFilter:'retFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('return-modal')">+ Create Return</button>
    </div>
    <div id="ret-table-wrap"></div>
    <div id="ret-pagination"></div>
  `;

  document.getElementById('return-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildReturnModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(OMS_COLLECTIONS.RETURNS,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _returns=data; _filtRet=[...data]; renderReturnTable();
  }));
  window.retSearch=debounce((q)=>{_filtRet=searchFilter(_returns,q,['returnNo','notes']);_pageRet=1;renderReturnTable();},250);
  window.retFilter=(k,v)=>{_filtRet=v?_returns.filter(r=>r[k]===v):[..._returns];_pageRet=1;renderReturnTable();};
  window.setRetPage=(p)=>{_pageRet=p;renderReturnTable();};
}

function buildReturnModal(){
  const orderOpts=_orders.map(o=>{const c=_customers.find(x=>x.id===o.customerId);return `<option value="${o.id}">${escHtml(o.orderNumber||'—')} — ${escHtml(c?.name||'—')}</option>`;}).join('');
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  return buildModal({
    id:'return-modal',title:'Create Return / Refund Request',size:'lg',
    body:`
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Return No.</label><input type="text" id="rt-no" class="form-input" value="RET-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Original Order</label>
          <select id="rt-order" class="form-select" onchange="autoFillReturn(this.value)"><option value="">Select order…</option>${orderOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Customer</label>
          <select id="rt-customer" class="form-select"><option value="">Auto-filled…</option>${custOpts}</select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Return Reason <span class="required">*</span></label>
          <select id="rt-reason" class="form-select">
            <option value="damage">Damaged / Defective</option><option value="wrong-item">Wrong Item Received</option>
            <option value="quality">Quality Issue</option><option value="excess">Excess Quantity</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Return Type</label>
          <select id="rt-type" class="form-select">
            <option value="refund">Full Refund</option><option value="replacement">Replacement</option>
            <option value="credit-note">Credit Note</option><option value="partial-refund">Partial Refund</option>
          </select>
        </div>
      </div>
      <div id="rt-items-section" style="margin:var(--space-4) 0;">
        <div style="font-size:13px;font-weight:600;margin-bottom:var(--space-3);">Items Being Returned</div>
        <div id="rt-items-list"><div style="font-size:12px;color:var(--text-muted);">Select an order to auto-populate items</div></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Refund Amount (₹)</label><input type="number" id="rt-amount" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select id="rt-status" class="form-select"><option value="requested">Requested</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes / Reason Details</label>
        <textarea id="rt-notes" class="form-textarea" rows="2" placeholder="Describe the return issue in detail…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('return-modal')">Cancel</button>
            <button class="btn btn-primary" id="rt-save-btn" onclick="saveReturn()">Submit Return</button>`,
  });
}

function renderReturnTable(){
  const wrap=document.getElementById('ret-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('ret-count'); if(cnt) cnt.textContent=`${_filtRet.length} return${_filtRet.length!==1?'s':''}`;
  const start=(_pageRet-1)*PER;
  wrap.innerHTML=buildTable({id:'ret-table',
    columns:[
      {key:'returnNo',  label:'Return #',  render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-accent);">${escHtml(r.returnNo||'—')}</span>`},
      {key:'orderId',   label:'Order',     render:r=>{const o=_orders.find(x=>x.id===r.orderId)||{};return `<span style="font-size:12px;">${escHtml(o.orderNumber||'—')}</span>`}},
      {key:'customerId',label:'Customer',  render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||'—')}</span>`}},
      {key:'reason',    label:'Reason',    render:r=>`<span class="badge badge-orange">${escHtml(r.reason||'—')}</span>`},
      {key:'type',      label:'Type',      render:r=>`<span class="badge badge-blue">${escHtml(r.returnType||'—')}</span>`},
      {key:'refundAmount',label:'Refund',  render:r=>r.refundAmount?`<span style="font-family:var(--font-mono);color:var(--brand-danger);">₹${Number(r.refundAmount).toLocaleString('en-IN')}</span>`:'—'},
      {key:'status',    label:'Status',    render:r=>badge(r.status||'requested')},
      {key:'createdAt', label:'Date',      render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.createdAt ? formatDate(r.createdAt) : "—"}</span>`},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'✅',label:'Approve',         action:`approveReturn('${r.id}')`},
        {icon:'📦',label:'Mark Received',   action:`markReturnReceived('${r.id}')`},
        {icon:'💳',label:'Mark Refunded',   action:`markRefunded('${r.id}')`},
        {icon:'❌',label:'Reject',          action:`rejectReturn('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtRet.slice(start,start+PER),emptyMsg:'No return requests yet',
  });
  document.getElementById('ret-pagination').innerHTML=buildPagination({id:'ret',total:_filtRet.length,page:_pageRet,perPage:PER,onChange:'setRetPage'});
}

window.autoFillReturn=(orderId)=>{
  const order=_orders.find(o=>o.id===orderId); if(!order) return;
  const custEl=document.getElementById('rt-customer');
  if(custEl) custEl.value=order.customerId||'';
  const amtEl=document.getElementById('rt-amount');
  if(amtEl) amtEl.value=order.totalAmount||0;
  const el=document.getElementById('rt-items-list');
  if(el&&order.items){
    el.innerHTML=`
      <div class="table-container"><table class="table">
        <thead><tr><th>Product</th><th>Original Qty</th><th>Return Qty</th><th>Condition</th></tr></thead>
        <tbody>
          ${order.items.map((item,i)=>{
            const p=_products.find(x=>x.id===item.productId);
            return `<tr>
              <td style="font-size:12px;">${escHtml(p?.name||'—')}</td>
              <td style="font-family:var(--font-mono);">${item.qty||0}</td>
              <td><input type="number" id="rt-item-qty-${i}" class="form-input" style="width:70px;" value="${item.qty||0}" min="0" max="${item.qty||0}"></td>
              <td><select id="rt-item-cond-${i}" class="form-select" style="width:auto;">
                <option value="new">Like New</option><option value="damaged">Damaged</option><option value="used">Used</option>
              </select></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  }
};

window.saveReturn=async()=>{
  if(!validateForm([{id:'rt-reason',label:'Reason',required:true}])) return;
  const btn=document.getElementById('rt-save-btn'); setLoading(btn,true);
  const orderId=document.getElementById('rt-order').value;
  const order=_orders.find(o=>o.id===orderId);
  const items=(order?.items||[]).map((item,i)=>({
    ...item,
    returnQty:Number(document.getElementById(`rt-item-qty-${i}`)?.value)||0,
    condition:document.getElementById(`rt-item-cond-${i}`)?.value||'used',
  })).filter(item=>item.returnQty>0);
  try{
    const data={
      returnNo:document.getElementById('rt-no').value.trim(),
      orderId,customerId:document.getElementById('rt-customer').value,
      reason:document.getElementById('rt-reason').value,
      returnType:document.getElementById('rt-type').value,
      items,refundAmount:Number(document.getElementById('rt-amount').value)||0,
      status:document.getElementById('rt-status').value,
      notes:document.getElementById('rt-notes').value.trim(),
      companyId:AuthState.company?.id||null,
    };
    await dbCreate(OMS_COLLECTIONS.RETURNS,data);
    Toast.success('Return Created',`${data.returnNo} submitted.`);
    closeModal('return-modal');
  }catch(e){Toast.error('Failed',e.message);}
  finally{setLoading(btn,false);}
};

window.approveReturn=async(id)=>{try{await dbUpdate(OMS_COLLECTIONS.RETURNS,id,{status:'approved',approvedAt:new Date().toISOString()});Toast.success('Approved','Return approved.');}catch(e){Toast.error('Failed',e.message);}};
window.markReturnReceived=async(id)=>{
  if(!confirm('Confirm goods received? This will restore stock in inventory.')) return;
  const ret=_returns.find(x=>x.id===id); if(!ret) return;
  try{
    const ops=(ret.items||[]).map(item=>{
      const inv=_inventory.find(i=>i.productId===item.productId);
      return inv?{collection:COLLECTIONS.INVENTORY,id:inv.id,type:'update',data:{quantity:Number(inv.quantity)+Number(item.returnQty||0)}}:null;
    }).filter(Boolean);
    if(ops.length) await dbBatch(ops);
    await dbUpdate(OMS_COLLECTIONS.RETURNS,id,{status:'received',receivedAt:new Date().toISOString()});
    Toast.success('Received','Return received. Stock restored to inventory.');
  }catch(e){Toast.error('Failed',e.message);}
};
window.markRefunded=async(id)=>{try{await dbUpdate(OMS_COLLECTIONS.RETURNS,id,{status:'refunded',refundedAt:new Date().toISOString()});Toast.success('Refunded','Return marked as refunded.');}catch(e){Toast.error('Failed',e.message);}};
window.rejectReturn=async(id)=>{if(!confirm('Reject this return?'))return;try{await dbUpdate(OMS_COLLECTIONS.RETURNS,id,{status:'rejected'});Toast.warning('Rejected','Return request rejected.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 29: BACKORDER MANAGEMENT
// ══════════════════════════════════════════════════════════════
let _backorders=[], _filtBO=[], _pageBO=1;

function renderBackorderTab(container){
  // Auto-detect backorder scenarios from confirmed orders
  const autoBackorders=_orders.filter(o=>o.status==='confirmed').filter(order=>{
    return (order.items||[]).some(item=>{
      const totalAvailable=_inventory.filter(i=>i.productId===item.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
      return totalAvailable < Number(item.qty||0);
    });
  });

  container.innerHTML=`
    ${autoBackorders.length?`
      <div class="alert alert-warning" style="margin-bottom:var(--space-4);">
        <span class="alert-icon">⚠️</span>
        <div>
          <div class="alert-title">${autoBackorders.length} Order${autoBackorders.length>1?'s':''} with Insufficient Stock</div>
          <div class="alert-text">These orders cannot be fully fulfilled. Create backorders or split fulfillment.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="autoCreateBackorders()" style="flex-shrink:0;margin-left:auto;">Auto-Create Backorders</button>
      </div>
    `:''}

    ${searchBar({id:'bo',placeholder:'Search backorder no, product…',
      filters:[{key:'status',label:'All Status',options:[{value:'pending',label:'Pending'},{value:'partially-fulfilled',label:'Partial'},{value:'fulfilled',label:'Fulfilled'},{value:'cancelled',label:'Cancelled'}]}],
      onSearch:'boSearch',onFilter:'boFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('backorder-modal')">+ Create Backorder</button>
    </div>
    <div id="bo-table-wrap"></div>
    <div id="bo-pagination"></div>
  `;

  document.getElementById('backorder-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildBackorderModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(OMS_COLLECTIONS.BACKORDERS,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _backorders=data; _filtBO=[...data]; renderBOTable();
  }));
  window.boSearch=debounce((q)=>{_filtBO=searchFilter(_backorders,q,['backorderNo','productName','notes']);_pageBO=1;renderBOTable();},250);
  window.boFilter=(k,v)=>{_filtBO=v?_backorders.filter(b=>b[k]===v):[..._backorders];_pageBO=1;renderBOTable();};
  window.setBOPage=(p)=>{_pageBO=p;renderBOTable();};
}

function buildBackorderModal(){
  const orderOpts=_orders.filter(o=>['confirmed','processing'].includes(o.status)).map(o=>{
    const c=_customers.find(x=>x.id===o.customerId);
    return `<option value="${o.id}">${escHtml(o.orderNumber||'—')} — ${escHtml(c?.name||'—')}</option>`;
  }).join('');
  const prodOpts=_products.map(p=>`<option value="${p.id}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');
  return buildModal({
    id:'backorder-modal',title:'Create Backorder',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Backorder No.</label><input type="text" id="bo-no" class="form-input" value="BO-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Original Order</label>
          <select id="bo-order" class="form-select"><option value="">Select…</option>${orderOpts}</select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product <span class="required">*</span></label>
          <select id="bo-product" class="form-select" onchange="checkBOStock(this.value)"><option value="">Select…</option>${prodOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Available Stock</label>
          <input type="text" id="bo-avail" class="form-input" readonly style="background:var(--bg-overlay);" value="—">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Ordered Qty</label><input type="number" id="bo-ordered" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Can Supply Now</label><input type="number" id="bo-supply-now" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Backorder Qty</label><input type="number" id="bo-qty" class="form-input" placeholder="0" min="1" readonly style="background:var(--bg-overlay);"></div>
      </div>
      <div class="form-group"><label class="form-label">Expected Fulfillment Date</label>
        <input type="date" id="bo-eta" class="form-input">
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea id="bo-notes" class="form-textarea" rows="2" placeholder="Reason for backorder, supplier ETA…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('backorder-modal')">Cancel</button>
            <button class="btn btn-primary" id="bo-save-btn" onclick="saveBackorder()">Create Backorder</button>`,
  });
}

function renderBOTable(){
  const wrap=document.getElementById('bo-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('bo-count'); if(cnt) cnt.textContent=`${_filtBO.length} backorder${_filtBO.length!==1?'s':''}`;
  const start=(_pageBO-1)*PER;
  wrap.innerHTML=buildTable({id:'bo-table',
    columns:[
      {key:'backorderNo',label:'BO #',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-warning);">${escHtml(r.backorderNo||'—')}</span>`},
      {key:'orderId',    label:'Order',     render:r=>{const o=_orders.find(x=>x.id===r.orderId)||{};return `<span style="font-size:12px;">${escHtml(o.orderNumber||'—')}</span>`}},
      {key:'productName',label:'Product',   render:r=>`<span style="font-size:12px;">${escHtml(r.productName||'—')}</span>`},
      {key:'backorderQty',label:'BO Qty',   render:r=>`<span style="font-family:var(--font-mono);font-weight:700;color:var(--brand-warning);">${r.backorderQty||0}</span>`},
      {key:'suppliedNow', label:'Supplied', render:r=>`<span style="font-family:var(--font-mono);">${r.supplyNow||0}</span>`},
      {key:'expectedDate',label:'ETA',      render:r=>r.expectedDate?`<span style="font-size:11px;color:var(--text-muted);">${r.expectedDate}</span>`:'—'},
      {key:'status',     label:'Status',    render:r=>badge(r.status||'pending')},
      {key:'actions',    label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'✅',label:'Mark Fulfilled',action:`fulfillBackorder('${r.id}')`},
        {icon:'❌',label:'Cancel',        action:`cancelBackorder('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtBO.slice(start,start+PER),emptyMsg:'No backorders',
  });
  document.getElementById('bo-pagination').innerHTML=buildPagination({id:'bo',total:_filtBO.length,page:_pageBO,perPage:PER,onChange:'setBOPage'});
}

window.checkBOStock=(productId)=>{
  const total=_inventory.filter(i=>i.productId===productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
  const el=document.getElementById('bo-avail'); if(el) el.value=total+' units';
  const p=_products.find(x=>x.id===productId);
  const supEl=document.getElementById('bo-supply-now');
  supEl?.addEventListener('input',()=>{
    const ordered=Number(document.getElementById('bo-ordered')?.value)||0;
    const supplied=Number(supEl.value)||0;
    const boEl=document.getElementById('bo-qty'); if(boEl) boEl.value=Math.max(0,ordered-supplied);
  });
};
window.saveBackorder=async()=>{
  if(!validateForm([{id:'bo-product',label:'Product',required:true},{id:'bo-ordered',label:'Ordered Qty',required:true}])) return;
  const btn=document.getElementById('bo-save-btn'); setLoading(btn,true);
  const productId=document.getElementById('bo-product').value;
  const p=_products.find(x=>x.id===productId);
  const orderId=document.getElementById('bo-order').value;
  const ordered=Number(document.getElementById('bo-ordered').value)||0;
  const supplyNow=Number(document.getElementById('bo-supply-now').value)||0;
  const backorderQty=Math.max(0,ordered-supplyNow);
  try{
    await dbCreate(OMS_COLLECTIONS.BACKORDERS,{
      backorderNo:document.getElementById('bo-no').value.trim(),
      orderId:orderId||null,productId,productName:p?.name||'—',sku:p?.sku||'—',
      orderedQty:ordered,supplyNow,backorderQty,
      expectedDate:document.getElementById('bo-eta').value,
      status:backorderQty>0?'pending':'fulfilled',
      notes:document.getElementById('bo-notes').value.trim(),
      companyId:AuthState.company?.id||null,
    });
    Toast.success('Backorder Created',`${backorderQty} units on backorder.`);
    closeModal('backorder-modal');
  }catch(e){Toast.error('Failed',e.message);}
  finally{setLoading(btn,false);}
};
window.autoCreateBackorders=async()=>{
  const pending=_orders.filter(o=>o.status==='confirmed');
  let count=0;
  for(const order of pending){
    for(const item of (order.items||[])){
      const avail=_inventory.filter(i=>i.productId===item.productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
      const needed=Number(item.qty)||0;
      if(avail<needed){
        const p=_products.find(x=>x.id===item.productId);
        await dbCreate(OMS_COLLECTIONS.BACKORDERS,{
          backorderNo:'BO-'+genId(),orderId:order.id,productId:item.productId,productName:p?.name||'—',
          orderedQty:needed,supplyNow:avail,backorderQty:needed-avail,
          status:'pending',notes:'Auto-created from stock shortage',
          companyId:AuthState.company?.id||null,
        });
        count++;
      }
    }
  }
  Toast.success('Done',`${count} backorder${count!==1?'s':''} created automatically.`);
};
window.fulfillBackorder=async(id)=>{if(!confirm('Mark this backorder as fulfilled?'))return;try{await dbUpdate(OMS_COLLECTIONS.BACKORDERS,id,{status:'fulfilled',fulfilledAt:new Date().toISOString()});Toast.success('Fulfilled','Backorder fulfilled.');}catch(e){Toast.error('Failed',e.message);}};
window.cancelBackorder=async(id)=>{if(!confirm('Cancel backorder?'))return;try{await dbUpdate(OMS_COLLECTIONS.BACKORDERS,id,{status:'cancelled'});Toast.warning('Cancelled','Backorder cancelled.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 30: BULK ORDER PROCESSING
// ══════════════════════════════════════════════════════════════
function renderBulkTab(container){
  const pendingOrders=_orders.filter(o=>['confirmed','processing'].includes(o.status));

  container.innerHTML=`
    <div class="grid-3" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Pending Orders',    value:pendingOrders.length, icon:'📋',color:'kpi-blue'},
        {label:'Total Items',       value:pendingOrders.reduce((s,o)=>s+(o.items?.length||0),0), icon:'📦',color:'kpi-orange'},
        {label:'Total Value',       value:formatCurrency(pendingOrders.reduce((s,o)=>s+(Number(o.totalAmount)||0),0),true), icon:'💰',color:'kpi-green'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div class="card" style="margin-bottom:var(--space-4);">
      <div class="card-header">
        <div class="card-title">⚡ Bulk Actions</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
        ${[
          {label:'Generate All Pick Lists',  icon:'📋', fn:'bulkGeneratePickLists',  color:'var(--brand-primary)'},
          {label:'Generate All Delivery Notes',icon:'🚚',fn:'bulkGenerateDeliveryNotes',color:'var(--brand-secondary)'},
          {label:'Mark All as Processing',   icon:'⚙️', fn:'bulkMarkProcessing',     color:'var(--brand-warning)'},
          {label:'Export All to CSV',        icon:'⬇️', fn:'bulkExportOrders',       color:'var(--text-secondary)'},
          {label:'Send Confirmation Emails', icon:'✉️', fn:'bulkSendEmails',         color:'var(--brand-info)'},
          {label:'Auto-Assign to Warehouse', icon:'🏭', fn:'bulkAssignWarehouse',    color:'var(--brand-accent)'},
        ].map(action=>`
          <div style="padding:16px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;text-align:center;transition:all 0.2s;"
               onclick="${action.fn}()"
               onmouseenter="this.style.borderColor='${action.color}'"
               onmouseleave="this.style.borderColor='var(--border-subtle)'">
            <div style="font-size:24px;">${action.icon}</div>
            <div style="font-size:12px;font-weight:500;color:var(--text-secondary);">${action.label}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Bulk orders table -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📦 Pending Orders Queue</div>
        <div style="display:flex;gap:8px;">
          <input type="checkbox" id="bulk-select-all" style="accent-color:var(--brand-primary);" onchange="toggleBulkAll(this.checked)">
          <label for="bulk-select-all" style="font-size:12px;color:var(--text-muted);">Select All</label>
        </div>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th style="width:36px;"></th><th>Order #</th><th>Customer</th><th>Items</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${pendingOrders.map(o=>{
              const c=_customers.find(x=>x.id===o.customerId)||{};
              return `<tr>
                <td><input type="checkbox" class="bulk-order-cb" value="${o.id}" style="accent-color:var(--brand-primary);"></td>
                <td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(o.orderNumber||'—')}</td>
                <td style="font-size:12px;">${escHtml(c.name||'—')}</td>
                <td><span class="badge badge-blue">${o.items?.length||0} items</span></td>
                <td style="font-family:var(--font-mono);">₹${Number(o.totalAmount||0).toLocaleString('en-IN')}</td>
                <td>${badge(o.status||'confirmed')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${formatDate(o.createdAt)}</td>
              </tr>`;
            }).join('')||`<tr><td colspan="7"><div class="table-empty"><div class="empty-icon">📦</div><div class="empty-title">No pending orders</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window.toggleBulkAll=(checked)=>document.querySelectorAll('.bulk-order-cb').forEach(cb=>cb.checked=checked);
  window.getSelectedOrders=()=>[...document.querySelectorAll('.bulk-order-cb:checked')].map(c=>c.value);

  window.bulkGeneratePickLists=async()=>{
    const ids=getSelectedOrders();
    if(!ids.length){Toast.error('None selected','Select orders first.');return;}
    await confirmGeneratePickList_bulk(ids);
  };
  window.bulkMarkProcessing=async()=>{
    const ids=getSelectedOrders();
    if(!ids.length){Toast.error('None selected','Select orders first.');return;}
    if(!confirm(`Mark ${ids.length} orders as processing?`)) return;
    try{await Promise.all(ids.map(id=>dbUpdate('sales_orders',id,{status:'processing'})));Toast.success('Updated',`${ids.length} orders marked as processing.`);}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.bulkExportOrders=()=>{
    const ids=getSelectedOrders();
    const toExport=ids.length?pendingOrders.filter(o=>ids.includes(o.id)):pendingOrders;
    const csv=[['Order #','Customer','Items','Amount','Status','Date'],
      ...toExport.map(o=>{const c=_customers.find(x=>x.id===o.customerId)||{};return[o.orderNumber,c.name,o.items?.length,o.totalAmount,o.status,formatDate(o.createdAt)];})
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='bulk_orders_export.csv'; a.click();
    Toast.success('Exported',`${toExport.length} orders exported.`);
  };
  window.bulkGenerateDeliveryNotes=()=>Toast.info('Bulk DN','Generating delivery notes for selected orders…');
  window.bulkSendEmails=()=>Toast.info('Emails','Order confirmation emails require email backend setup.');
  window.bulkAssignWarehouse=()=>{
    if(!_warehouses.length){Toast.error('No warehouses','Add warehouses first.');return;}
    Toast.info('Auto-Assign',`Auto-assigning ${getSelectedOrders().length||pendingOrders.length} orders to ${_warehouses[0].name}.`);
  };
}

async function confirmGeneratePickList_bulk(orderIds){
  if(!confirm(`Generate 1 consolidated pick list for ${orderIds.length} selected orders?`)) return;
  try{
    const consolidatedItems={};
    orderIds.forEach(orderId=>{
      const order=_orders.find(o=>o.id===orderId);
      (order?.items||[]).forEach(item=>{
        if(!consolidatedItems[item.productId]) consolidatedItems[item.productId]={productId:item.productId,totalQty:0,orders:[]};
        consolidatedItems[item.productId].totalQty+=Number(item.qty)||0;
        consolidatedItems[item.productId].orders.push({orderId,qty:item.qty});
      });
    });
    const items=Object.values(consolidatedItems).map(item=>{
      const p=_products.find(x=>x.id===item.productId);
      const inv=_inventory.find(i=>i.productId===item.productId);
      return {...item,productName:p?.name||'—',sku:p?.sku||'—',binLocation:inv?.binLocation||'—',unit:p?.unit||'pcs',picked:false};
    });
    await dbCreate(OMS_COLLECTIONS.PICK_PACKS,{pickListNo:'PL-'+genId(),orderIds,items,status:'pending',companyId:AuthState.company?.id||null});
    await Promise.all(orderIds.map(id=>dbUpdate('sales_orders',id,{status:'processing'})));
    Toast.success('Pick List Created',`${items.length} items across ${orderIds.length} orders.`);
  }catch(e){Toast.error('Failed',e.message);}
}
}
