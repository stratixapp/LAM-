// ============================================================
// LAM — Purchase Order (PO) / Procurement Module
// Phase 3 — Growth Plan
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, genId, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

let _pos=[], _filt=[], _page=1;
let _vendors=[], _products=[];
const PER=15;
let _unsub=null;

export async function renderPO(container) {
  [_vendors, _products] = await Promise.all([
    dbGetAll(COLLECTIONS.VENDORS,  AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.PRODUCTS, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: 'Purchase Orders',
    subtitle: 'Create, approve and track procurement orders.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportPOs()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openPOModal()">+ Create PO</button>
    `,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="po-summary"></div>
      ${searchBar({
        id: 'po',
        placeholder: 'Search PO number, vendor…',
        filters: [
          { key:'status', label:'All Status', options:[
            {value:'draft',    label:'Draft'},
            {value:'pending',  label:'Pending Approval'},
            {value:'approved', label:'Approved'},
            {value:'ordered',  label:'Ordered'},
            {value:'received', label:'Received'},
            {value:'cancelled',label:'Cancelled'},
          ]},
        ],
        onSearch: 'poSearch',
        onFilter: 'poFilter',
      })}
      <div id="po-table-wrap"></div>
      <div id="po-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', poModal());
  setupModalClose(); setupMenuClose();
  registerPOGlobals();

  if(_unsub) _unsub();
  const cid=AuthState.company?.id;
  const c=cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')];
  _unsub=dbListen('purchase_orders',c,data=>{_pos=data;_filt=[...data];renderPOSummary();renderPOTable();});
}

function renderPOSummary() {
  const el=document.getElementById('po-summary'); if(!el) return;
  el.innerHTML='';
  const total   =_pos.length;
  const pending =_pos.filter(p=>p.status==='pending').length;
  const approved=_pos.filter(p=>p.status==='approved'||p.status==='ordered').length;
  const spend   =_pos.filter(p=>p.status!=='cancelled').reduce((s,p)=>s+(Number(p.totalAmount)||0),0);
  [
    {label:'Total POs',      value:total,   icon:'📋',color:'kpi-blue'},
    {label:'Pending Approval',value:pending,icon:'⏳',color:'kpi-yellow'},
    {label:'Approved/Ordered',value:approved,icon:'✅',color:'kpi-green'},
    {label:'Total Spend',    value:formatCurrency(spend,true),icon:'💸',color:'kpi-orange'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function renderPOTable() {
  const wrap=document.getElementById('po-table-wrap'); const pg=document.getElementById('po-pagination'); if(!wrap)return;
  const start=(_page-1)*PER; const pageData=_filt.slice(start,start+PER);
  document.getElementById('po-count').textContent=`${_filt.length} PO${_filt.length!==1?'s':''}`;
  wrap.innerHTML=buildTable({
    id:'po-table', onRowClick:'viewPO',
    columns:[
      {key:'poNumber',label:'PO #',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-primary);">${escHtml(r.poNumber||'—')}</span>`},
      {key:'vendorId',label:'Vendor',render:r=>`<span style="font-size:13px;">${escHtml(vendorName(r.vendorId))}</span>`},
      {key:'items',label:'Items',render:r=>`<span class="badge badge-blue">${r.items?.length||0} items</span>`},
      {key:'totalAmount',label:'Total',render:r=>`<span style="font-family:var(--font-mono);font-weight:600;">₹${Number(r.totalAmount||0).toLocaleString('en-IN')}</span>`},
      {key:'expectedDate',label:'Expected',render:r=>r.expectedDate?`<span style="font-size:11px;color:var(--text-muted);">${r.expectedDate}</span>`:'—'},
      {key:'status',label:'Status',render:r=>badge(r.status||'draft')},
      {key:'createdAt',label:'Created',render:r=>`<span style="font-size:11px;color:var(--text-muted);">${formatDate(r.createdAt)}</span>`},
      {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'👁',label:'View',action:`viewPO('${r.id}')`},
        {icon:'✅',label:'Approve',action:`approvePO('${r.id}')`},
        {icon:'📩',label:'Mark Ordered',action:`markOrdered('${r.id}')`},
        {icon:'🗑',label:'Cancel',action:`cancelPO('${r.id}')`,danger:true},
      ])},
    ],
    rows:pageData, emptyMsg:'No purchase orders yet',
  });
  pg.innerHTML=buildPagination({id:'po',total:_filt.length,page:_page,perPage:PER,onChange:'setPOPage'});
}

function poModal() {
  const vendOpts=_vendors.map(v=>`<option value="${v.id}">${escHtml(v.name||v.companyName||'—')}</option>`).join('');
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-cost="${p.costPrice||0}" data-gst="${p.gstRate||18}">${escHtml(p.name)} (${p.sku||'—'})</option>`).join('');

  return buildModal({
    id:'po-modal', title:'Create Purchase Order', size:'xl',
    body:`
      <input type="hidden" id="po-id">
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">PO Number</label><input type="text" id="po-number" class="form-input" value="PO-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Vendor <span class="required">*</span></label><select id="po-vendor" class="form-select"><option value="">Select vendor…</option>${vendOpts}</select></div>
        <div class="form-group"><label class="form-label">Expected Delivery</label><input type="date" id="po-expected" class="form-input"></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Payment Terms</label><select id="po-terms" class="form-select"><option value="immediate">Immediate</option><option value="net15">Net 15</option><option value="net30">Net 30</option><option value="net45">Net 45</option></select></div>
        <div class="form-group"><label class="form-label">Shipping Address</label><input type="text" id="po-ship" class="form-input" placeholder="Delivery warehouse address"></div>
        <div class="form-group"><label class="form-label">Status</label><select id="po-status" class="form-select"><option value="draft">Draft</option><option value="pending">Pending Approval</option><option value="approved">Approved</option></select></div>
      </div>

      <!-- Line Items -->
      <div style="margin:var(--space-4) 0 var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <div style="font-size:13px;font-weight:600;">Items to Purchase</div>
          <button class="btn btn-secondary btn-sm" type="button" onclick="addPOLine()">+ Add Item</button>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th style="min-width:180px;">Product</th><th style="width:80px;">Qty</th><th style="width:100px;">Unit Cost (₹)</th><th style="width:70px;">GST%</th><th style="width:90px;">Total</th><th style="width:40px;"></th></tr></thead>
            <tbody id="po-line-body"></tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px;flex-direction:column;align-items:flex-end;gap:4px;">
          <div style="font-size:12px;color:var(--text-muted);">Subtotal: <strong id="po-subtotal">₹0</strong></div>
          <div style="font-size:12px;color:var(--text-muted);">GST: <strong id="po-gst-amt">₹0</strong></div>
          <div style="font-size:14px;font-weight:700;color:var(--brand-secondary);">Total: <span id="po-grand-total">₹0</span></div>
        </div>
      </div>

      <div class="form-group"><label class="form-label">Notes / Terms</label><textarea id="po-notes" class="form-textarea" rows="2" placeholder="Additional terms, notes…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('po-modal')">Cancel</button><button class="btn btn-primary" id="po-save-btn" onclick="savePO()">Create PO</button>`,
  });
}

let _poLines = [];

function addPOLine(line={}) {
  const idx=_poLines.length;
  _poLines.push({productId:'',qty:1,unitCost:0,gstRate:18,...line});
  const prodOpts=_products.map(p=>`<option value="${p.id}" data-cost="${p.costPrice||0}" data-gst="${p.gstRate||18}" ${line.productId===p.id?'selected':''}>${escHtml(p.name)}</option>`).join('');
  const row=document.createElement('tr'); row.id=`po-line-${idx}`;
  row.innerHTML=`
    <td><select class="form-select" style="min-width:160px;" onchange="updatePOLine(${idx},'productId',this.value);autoFillPOCost(${idx},this)"><option value="">Select…</option>${prodOpts}</select></td>
    <td><input type="number" class="form-input" style="width:70px;" value="${line.qty||1}" min="1" onchange="updatePOLine(${idx},'qty',this.value);calcPOTotals()"></td>
    <td><input type="number" class="form-input" id="po-cost-${idx}" style="width:90px;" value="${line.unitCost||0}" min="0" step="0.01" onchange="updatePOLine(${idx},'unitCost',this.value);calcPOTotals()"></td>
    <td><input type="number" class="form-input" id="po-gst-${idx}" style="width:60px;" value="${line.gstRate||18}" min="0" max="28" onchange="updatePOLine(${idx},'gstRate',this.value);calcPOTotals()"></td>
    <td><span id="po-line-total-${idx}" style="font-family:var(--font-mono);font-size:12px;font-weight:600;">₹0</span></td>
    <td><button class="btn btn-ghost btn-icon" style="color:var(--brand-danger);" onclick="removePOLine(${idx})">✕</button></td>
  `;
  document.getElementById('po-line-body').appendChild(row);
  calcPOTotals();
}

function registerPOGlobals() {
  _poLines=[]; addPOLine();
  window.addPOLine=addPOLine;
  window.updatePOLine=(idx,key,val)=>{if(_poLines[idx])_poLines[idx][key]=val;};
  window.autoFillPOCost=(idx,select)=>{
    const opt=select.options[select.selectedIndex];
    const cost=Number(opt?.dataset?.cost||0); const gst=Number(opt?.dataset?.gst||18);
    if(_poLines[idx]){_poLines[idx].unitCost=cost;_poLines[idx].gstRate=gst;}
    const ce=document.getElementById(`po-cost-${idx}`); if(ce)ce.value=cost;
    const ge=document.getElementById(`po-gst-${idx}`);  if(ge)ge.value=gst;
    calcPOTotals();
  };
  window.removePOLine=(idx)=>{document.getElementById(`po-line-${idx}`)?.remove();_poLines[idx]=null;calcPOTotals();};
  window.calcPOTotals=calcPOTotals;

  window.poSearch=debounce((q)=>{_filt=_pos.filter(p=>(p.poNumber||'').toLowerCase().includes(q.toLowerCase())||(vendorName(p.vendorId)||'').toLowerCase().includes(q.toLowerCase()));_page=1;renderPOTable();},250);
  window.poFilter=(k,v)=>{_filt=v?_pos.filter(p=>p[k]===v):[..._pos];_page=1;renderPOTable();};
  window.setPOPage=(p)=>{_page=p;renderPOTable();};

  window.savePO=async()=>{
    if(!validateForm([{id:'po-vendor',label:'Vendor',required:true}])) return;
    const valid=_poLines.filter(l=>l&&l.productId);
    if(!valid.length){Toast.error('No items','Add at least one item.');return;}
    const btn=document.getElementById('po-save-btn'); setLoading(btn,true);
    const sub=valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitCost)||0)+s,0);
    const gst=valid.reduce((s,l)=>(Number(l.qty)||0)*(Number(l.unitCost)||0)*((Number(l.gstRate)||0)/100)+s,0);
    const data={poNumber:document.getElementById('po-number').value.trim(),vendorId:document.getElementById('po-vendor').value,expectedDate:document.getElementById('po-expected').value,paymentTerms:document.getElementById('po-terms').value,shippingAddress:document.getElementById('po-ship').value.trim(),status:document.getElementById('po-status').value,notes:document.getElementById('po-notes').value.trim(),items:valid,subtotal:sub,gstAmount:gst,totalAmount:sub+gst,companyId:AuthState.company?.id||null};
    try{await dbCreate('purchase_orders',data);Toast.success('PO Created',`${data.poNumber} created.`);closeModal('po-modal');_poLines=[];document.getElementById('po-line-body').innerHTML='';addPOLine();}
    catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };
  window.viewPO = (id) => {
    const p = _pos.find(x => x.id === id);
    if (!p) return;
    const co = AuthState.company || {};
    const vn = vendorName(p.vendorId);
    const vendor = _vendors?.find?.(v=>v.id===p.vendorId) || {};

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { Toast.error('Blocked','Allow popups to view PO.'); return; }

    const itemRows = (p.items||[]).map((it,i) => {
      const qty    = Number(it.qty)||0;
      const cost   = Number(it.unitCost)||0;
      const gstPct = Number(it.gstRate)||0;
      const subtot = qty*cost;
      const gstAmt = subtot*gstPct/100;
      return `<tr>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${i+1}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;">${escHtml(it.productName||it.productId||'—')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;">${escHtml(it.description||'—')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${qty} ${escHtml(it.unit||'Nos')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;">₹${cost.toLocaleString('en-IN')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:center;">${gstPct}%</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;">₹${gstAmt.toLocaleString('en-IN')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;text-align:right;font-weight:600;">₹${(subtot+gstAmt).toLocaleString('en-IN')}</td>
      </tr>`;
    }).join('');

    const statusColor = {approved:'#166534',ordered:'#1d4ed8',received:'#166534',cancelled:'#991b1b',draft:'#475569'}[p.status]||'#475569';
    const statusBg    = {approved:'#dcfce7',ordered:'#dbeafe',received:'#dcfce7',cancelled:'#fee2e2',draft:'#f1f5f9'}[p.status]||'#f1f5f9';

    win.document.write(`<!DOCTYPE html><html><head>
      <title>PO ${escHtml(p.poNumber||'—')} — ${escHtml(vn)}</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b;background:#f8fafc;padding:24px;}
        .doc{max-width:850px;margin:0 auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-radius:8px;overflow:hidden;}
        .header{background:linear-gradient(135deg,#1e3a5f,#0a84ff);color:#fff;padding:28px 32px;}
        .header h1{font-size:22px;font-weight:800;} .header .sub{font-size:11px;opacity:0.75;margin-top:3px;}
        .body{padding:24px 32px;}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;}
        .box{background:#f8fafc;border-radius:8px;padding:14px;}
        .box .lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:8px;}
        .row{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid #f1f5f9;}
        .row:last-child{border:none;} .row .k{color:#64748b;} .row .v{font-weight:600;}
        table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px;}
        th{background:#1e3a5f;color:#fff;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;}
        .tots{display:flex;justify-content:flex-end;}
        .tots-box{width:260px;}
        .tot-row{display:flex;justify-content:space-between;padding:5px 10px;font-size:12px;border-bottom:1px solid #f1f5f9;}
        .tot-final{background:#0a84ff;color:#fff;border-radius:5px;font-weight:800;font-size:14px;padding:8px 10px;border:none;}
        .terms{background:#fff8e1;border-left:4px solid #f59e0b;padding:12px 14px;border-radius:0 6px 6px 0;font-size:11px;margin-bottom:16px;}
        .actions{display:flex;gap:10px;padding:14px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;}
        .btn{border:none;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;}
        .btn-blue{background:#0a84ff;color:#fff;} .btn-gray{background:#e2e8f0;color:#475569;}
        .sig{display:flex;justify-content:space-between;margin-top:24px;}
        .sig-box{text-align:center;width:180px;}
        .sig-line{border-top:1px solid #cbd5e1;padding-top:6px;font-size:10px;color:#64748b;}
        @media print{.actions{display:none;}body{background:#fff;padding:0;}.doc{box-shadow:none;}}
      </style></head><body>
      <div class="doc">
        <div class="header">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div><h1>${escHtml(co.name||'Company Name')}</h1>
              <div class="sub">${escHtml(co.address||'')}${co.gstin?'  |  GSTIN: '+co.gstin:''}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:20px;font-weight:800;letter-spacing:1px;">PURCHASE ORDER</div>
              <div style="font-size:13px;margin-top:4px;opacity:0.85;">${escHtml(p.poNumber||'—')}</div>
              <span style="display:inline-block;margin-top:8px;padding:3px 12px;border-radius:99px;font-size:10px;font-weight:700;background:${statusBg};color:${statusColor};">${(p.status||'DRAFT').toUpperCase()}</span>
            </div>
          </div>
        </div>

        <div class="body">
          <div class="meta">
            <div class="box">
              <div class="lbl">Vendor Details</div>
              <div style="font-size:14px;font-weight:700;color:#0a84ff;margin-bottom:6px;">${escHtml(vn||'—')}</div>
              ${vendor.addr1?`<div style="font-size:11px;color:#64748b;">${escHtml([vendor.addr1,vendor.addr2,vendor.city,vendor.state].filter(Boolean).join(', '))}</div>`:''}
              ${vendor.gstin?`<div style="font-size:11px;color:#64748b;margin-top:3px;">GSTIN: ${escHtml(vendor.gstin)}</div>`:''}
              ${vendor.phone?`<div style="font-size:11px;color:#64748b;">📞 ${escHtml(vendor.phone)}</div>`:''}
            </div>
            <div class="box">
              <div class="lbl">Order Details</div>
              <div class="row"><span class="k">PO Number</span><span class="v">${escHtml(p.poNumber||'—')}</span></div>
              <div class="row"><span class="k">PO Date</span><span class="v">${p.createdAt ? formatDate(p.createdAt) : "—"}</span></div>
              <div class="row"><span class="k">Expected By</span><span class="v">${p.expectedDate||'—'}</span></div>
              <div class="row"><span class="k">Payment Terms</span><span class="v">${p.paymentTerms||'—'}</span></div>
              ${p.shippingAddress?`<div class="row"><span class="k">Ship To</span><span class="v" style="max-width:140px;text-align:right;">${escHtml(p.shippingAddress)}</span></div>`:''}
            </div>
          </div>

          <table>
            <thead><tr>
              <th style="width:4%;">#</th>
              <th style="width:18%;">Item</th>
              <th style="width:25%;">Description</th>
              <th style="width:10%;text-align:center;">Qty</th>
              <th style="width:12%;text-align:right;">Rate (₹)</th>
              <th style="width:8%;text-align:center;">GST%</th>
              <th style="width:11%;text-align:right;">GST (₹)</th>
              <th style="width:12%;text-align:right;">Total (₹)</th>
            </tr></thead>
            <tbody>${itemRows||'<tr><td colspan="8" style="padding:20px;text-align:center;color:#94a3b8;">No items</td></tr>'}</tbody>
          </table>

          <div class="tots">
            <div class="tots-box">
              <div class="tot-row"><span>Subtotal</span><span>₹${Number(p.subtotal||0).toLocaleString('en-IN')}</span></div>
              <div class="tot-row"><span>GST Amount</span><span>₹${Number(p.gstAmount||0).toLocaleString('en-IN')}</span></div>
              <div class="tot-row tot-final"><span>TOTAL</span><span>₹${Number(p.totalAmount||0).toLocaleString('en-IN')}</span></div>
            </div>
          </div>

          ${p.notes?`<div class="terms"><strong>Notes / Instructions:</strong><br>${escHtml(p.notes)}</div>`:''}

          <div class="sig">
            <div class="sig-box"><div class="sig-line">Prepared By</div></div>
            <div class="sig-box"><div class="sig-line">Approved By</div></div>
            <div class="sig-box"><div class="sig-line">Vendor Acknowledgement</div></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-blue" onclick="window.print()">🖨️ Print / Save PDF</button>
          <button class="btn btn-gray" onclick="window.close()">✕ Close</button>
        </div>
      </div>
    </body></html>`);
    win.document.close();
  };
  window.approvePO=async(id)=>{if(!confirm('Approve this PO?'))return;try{await dbUpdate('purchase_orders',id,{status:'approved',approvedBy:AuthState.profile?.name,approvedAt:new Date().toISOString()});Toast.success('Approved','PO approved.');}catch(e){Toast.error('Failed',e.message);}};
  window.markOrdered=async(id)=>{if(!confirm('Mark as ordered/sent to vendor?'))return;try{await dbUpdate('purchase_orders',id,{status:'ordered'});Toast.success('Ordered','PO marked as ordered.');}catch(e){Toast.error('Failed',e.message);}};
  window.cancelPO=async(id)=>{const p=_pos.find(x=>x.id===id);if(!confirm(`Cancel PO "${p?.poNumber}"?`))return;try{await dbUpdate('purchase_orders',id,{status:'cancelled'});Toast.warning('Cancelled','PO cancelled.');}catch(e){Toast.error('Failed',e.message);}};
  window.exportPOs=()=>{
    const csv=[['PO #','Vendor','Items','Total','Status','Expected Date','Created'],..._filt.map(p=>[p.poNumber,vendorName(p.vendorId),p.items?.length,p.totalAmount,p.status,p.expectedDate,p.createdAt ? formatDate(p.createdAt) : "—"])].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='purchase_orders_export.csv'; a.click();
    Toast.success('Exported',`${_filt.length} POs exported.`);
  };
  window.openPOModal=()=>{_poLines=[];document.getElementById('po-line-body').innerHTML='';document.getElementById('po-number').value='PO-'+genId();addPOLine();openModal('po-modal');};
}

function calcPOTotals() {
  let sub=0,gst=0;
  _poLines.filter(Boolean).forEach((l,idx)=>{
    if(!l.productId) return;
    const base=(Number(l.qty)||0)*(Number(l.unitCost)||0);
    const g=base*((Number(l.gstRate)||0)/100);
    sub+=base; gst+=g;
    const te=document.getElementById(`po-line-total-${idx}`);
    if(te) te.textContent='₹'+(base+g).toLocaleString('en-IN',{maximumFractionDigits:0});
  });
  const s=document.getElementById('po-subtotal');   if(s)s.textContent='₹'+sub.toLocaleString('en-IN',{maximumFractionDigits:0});
  const g=document.getElementById('po-gst-amt');    if(g)g.textContent='₹'+gst.toLocaleString('en-IN',{maximumFractionDigits:0});
  const t=document.getElementById('po-grand-total');if(t)t.textContent='₹'+(sub+gst).toLocaleString('en-IN',{maximumFractionDigits:0});
}

function vendorName(id){return _vendors.find(v=>v.id===id)?.name||_vendors.find(v=>v.id===id)?.companyName||id||'—';}
