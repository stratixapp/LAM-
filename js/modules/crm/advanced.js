// ============================================================
// LAM — CRM Advanced Module
// Customer Portal, SLA Tracking, Tickets, Communication History
// Interconnects: Customers → Orders → Invoices → Tickets
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatDateTime, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency, timeAgo } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose, avatarCell } from '../_shared.js';

export const CRM_ADV_COLLECTIONS = {
  TICKETS:       'crm_tickets',
  COMMUNICATIONS:'crm_communications',
  SLA_CONFIGS:   'crm_sla_configs',
};

let _customers=[], _orders=[], _invoices=[], _tickets=[], _comms=[];
let _activeTab='overview';
let _unsubs = [];
function _cleanupListeners(){ _unsubs.forEach(fn=>fn&&fn()); _unsubs=[]; }
const PER=15;

export async function renderCRMAdvanced(container) {
  _cleanupListeners();
  [_customers, _orders, _invoices] = await Promise.all([
    dbGetAll(COLLECTIONS.CUSTOMERS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll('sales_orders',          AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(FIN_COLLECTIONS.INVOICES, AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '👥 CRM — Customer Hub',
    subtitle: 'Complete customer relationship management — orders, invoices, tickets, SLA and portal.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshCRM()">↻ Refresh</button>`,
    content: `
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="crm-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['overview', '📊 Overview'],
          ['tickets',  '🎫 Support Tickets'],
          ['sla',      '⏱ SLA Tracking'],
          ['comms',    '💬 Communication Log'],
          ['portal',   '🌐 Customer Portal'],
        ].map(([id,label]) => `
          <button class="crm-tab ${id==='overview'?'active':''}" id="crm-tab-${id}"
            onclick="switchCRMTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="crm-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.crm-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderCRMKPIs();
  setupModalClose(); setupMenuClose();
  window.switchCRMTab=switchCRMTab;
  window.refreshCRM=async()=>{
    _customers=await dbGetAll(COLLECTIONS.CUSTOMERS,AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    renderCRMKPIs(); switchCRMTab(_activeTab);
  };
  switchCRMTab('overview');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderCRMKPIs(){
  const el=document.getElementById('crm-kpis'); if(!el) return; el.innerHTML='';
  const active    =_customers.filter(c=>c.status==='active'||!c.status).length;
  const premium   =_customers.filter(c=>c.type==='premium').length;
  const revenue   =_invoices.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
  const outstanding=_invoices.filter(i=>i.paymentStatus!=='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
  const orders    =_orders.length;
  [
    {label:'Total Customers',    value:_customers.length, icon:'👥',color:'kpi-blue'},
    {label:'Active',             value:active,            icon:'✅',color:'kpi-green'},
    {label:'Premium Accounts',   value:premium,           icon:'⭐',color:'kpi-yellow'},
    {label:'Revenue (Paid)',      value:formatCurrency(revenue,true), icon:'💰',color:'kpi-green'},
    {label:'Outstanding',        value:formatCurrency(outstanding,true),icon:'⏳',color:outstanding>0?'kpi-orange':'kpi-green'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchCRMTab(tab){
  _activeTab=tab;
  document.querySelectorAll('.crm-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`crm-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('crm-tab-content'); if(!c) return;
  switch(tab){
    case 'overview': renderCRMOverview(c);  break;
    case 'tickets':  renderTicketsTab(c);   break;
    case 'sla':      renderSLATab(c);       break;
    case 'comms':    renderCommsTab(c);     break;
    case 'portal':   renderPortalTab(c);    break;
  }
}

// ══════════════════════════════════════════════════════════════
// CRM OVERVIEW — Customer 360° View
// ══════════════════════════════════════════════════════════════
function renderCRMOverview(container){
  container.innerHTML=`
    ${searchBar({id:'crm-cust',placeholder:'Search customer, phone, city…',
      filters:[
        {key:'type',label:'All Types',options:[{value:'retail',label:'Retail'},{value:'wholesale',label:'Wholesale'},{value:'premium',label:'Premium'},{value:'corporate',label:'Corporate'}]},
        {key:'status',label:'All Status',options:[{value:'active',label:'Active'},{value:'inactive',label:'Inactive'}]},
      ],onSearch:'crmCustSearch',onFilter:'crmCustFilter'})}
    <div id="crm-cust-table-wrap"></div>
    <div id="crm-cust-pagination"></div>
    <div id="crm-customer-360"></div>
  `;

  let filtCust=[..._customers], pageCust=1;

  const renderCustTable=()=>{
    const wrap=document.getElementById('crm-cust-table-wrap'); if(!wrap)return;
    const cnt=document.getElementById('crm-cust-count'); if(cnt) cnt.textContent=`${filtCust.length} customer${filtCust.length!==1?'s':''}`;
    const start=(pageCust-1)*PER;
    wrap.innerHTML=buildTable({id:'crm-cust-table',
      columns:[
        {key:'name',     label:'Customer',    render:r=>avatarCell(r.name,r.email,'var(--brand-secondary)','rgba(0,200,150,0.12)')},
        {key:'type',     label:'Type',        render:r=>badge(r.type||'retail')},
        {key:'phone',    label:'Phone',       render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.phone||'—')}</span>`},
        {key:'orders',   label:'Orders',      render:r=>{const cnt=_orders.filter(o=>o.customerId===r.id).length;return `<span class="badge badge-blue">${cnt}</span>`}},
        {key:'revenue',  label:'Revenue',     render:r=>{const rev=_invoices.filter(i=>i.customerId===r.id&&i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);return `<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">₹${rev.toLocaleString('en-IN')}</span>`}},
        {key:'outstanding',label:'Outstanding',render:r=>{const out=_invoices.filter(i=>i.customerId===r.id&&i.paymentStatus!=='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);return out>0?`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-danger);">₹${out.toLocaleString('en-IN')}</span>`:`<span style="color:var(--brand-secondary);font-size:12px;">Clear</span>`}},
        {key:'creditLimit',label:'Credit',    render:r=>r.creditLimit?`<span style="font-family:var(--font-mono);font-size:11px;">₹${Number(r.creditLimit).toLocaleString('en-IN')}</span>`:'—'},
        {key:'status',   label:'Status',      render:r=>badge(r.status||'active')},
        {key:'actions',  label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View 360°',  action:`viewCustomer360('${r.id}')`},
          {icon:'🎫',label:'New Ticket', action:`openNewTicket('${r.id}')`},
          {icon:'💬',label:'Log Comm.',  action:`openLogComm('${r.id}')`},
        ])},
      ],
      rows:filtCust.slice(start,start+PER),emptyMsg:'No customers found',
    });
    document.getElementById('crm-cust-pagination').innerHTML=buildPagination({id:'crm-cust',total:filtCust.length,page:pageCust,perPage:PER,onChange:'setCRMCustPage'});
  };

  window.crmCustSearch=debounce((q)=>{filtCust=searchFilter(_customers,q,['name','phone','email','city','gstin']);pageCust=1;renderCustTable();},250);
  window.crmCustFilter=(k,v)=>{filtCust=v?_customers.filter(c=>c[k]===v):[..._customers];pageCust=1;renderCustTable();};
  window.setCRMCustPage=(p)=>{pageCust=p;renderCustTable();};
  window.viewCustomer360=async(id)=>{
    const c=_customers.find(x=>x.id===id); if(!c) return;
    const custOrders=_orders.filter(o=>o.customerId===id);
    const custInvoices=_invoices.filter(i=>i.customerId===id);
    const totalRev=custInvoices.filter(i=>i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
    const outstanding=custInvoices.filter(i=>i.paymentStatus!=='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0);
    const creditUtil=c.creditLimit?Math.round((outstanding/Number(c.creditLimit))*100):0;

    const el=document.getElementById('crm-customer-360');
    el.innerHTML=`
      <div class="card" style="margin-top:var(--space-5);border:1px solid var(--border-strong);">
        <div style="display:flex;align-items:center;gap:16px;padding:var(--space-5);border-bottom:1px solid var(--border-subtle);">
          <div style="width:56px;height:56px;border-radius:var(--radius-lg);background:rgba(0,200,150,0.12);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:var(--brand-secondary);flex-shrink:0;">${(c.name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}</div>
          <div style="flex:1;">
            <div style="font-family:var(--font-display);font-size:20px;font-weight:700;">${escHtml(c.name||'—')}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${escHtml(c.email||'—')} · ${escHtml(c.phone||'—')} · ${escHtml(c.city||'')} ${escHtml(c.state||'')}</div>
          </div>
          <div style="display:flex;gap:8px;">${badge(c.type||'retail')} ${badge(c.status||'active')}</div>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('crm-customer-360').innerHTML=''">✕</button>
        </div>

        <!-- 360 Metrics -->
        <div class="grid-4" style="padding:var(--space-4);gap:var(--space-3);">
          ${[
            ['Total Orders',    custOrders.length,              '🛒', 'var(--brand-primary)'],
            ['Revenue Paid',    '₹'+totalRev.toLocaleString('en-IN'), '💰', 'var(--brand-secondary)'],
            ['Outstanding',     '₹'+outstanding.toLocaleString('en-IN'), '⏳', outstanding>0?'var(--brand-danger)':'var(--brand-secondary)'],
            ['Credit Util.',    creditUtil+'%',                 '💳', creditUtil>=80?'var(--brand-danger)':creditUtil>=60?'var(--brand-warning)':'var(--brand-secondary)'],
          ].map(([l,v,i,c])=>`
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <div style="font-size:20px;">${i}</div>
              <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:${c};margin:4px 0;">${v}</div>
              <div style="font-size:11px;color:var(--text-muted);">${l}</div>
            </div>`).join('')}
        </div>

        <!-- Order timeline -->
        <div style="padding:0 var(--space-5) var(--space-5);">
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Recent Orders</div>
          ${custOrders.length?`
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${custOrders.slice(0,5).map(o=>`
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                  <div>
                    <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-primary);">${escHtml(o.orderNumber||'—')}</span>
                    <span style="margin-left:8px;font-size:11px;color:var(--text-muted);">${formatDate(o.createdAt)}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-family:var(--font-mono);font-size:12px;">₹${Number(o.totalAmount||0).toLocaleString('en-IN')}</span>
                    ${badge(o.status||'confirmed')}
                  </div>
                </div>`).join('')}
            </div>`:`<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;">No orders yet</div>`}
        </div>
      </div>`;
    el.scrollIntoView({behavior:'smooth'});
  };

  renderCustTable();
}

// ══════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ══════════════════════════════════════════════════════════════
let _filtTickets=[], _pageTickets=1;

function renderTicketsTab(container){
  container.innerHTML=`
    ${searchBar({id:'tickets',placeholder:'Search ticket, customer, issue…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'open',label:'Open'},{value:'in-progress',label:'In Progress'},{value:'resolved',label:'Resolved'},{value:'closed',label:'Closed'}]},
        {key:'priority',label:'All Priority',options:[{value:'critical',label:'Critical'},{value:'high',label:'High'},{value:'medium',label:'Medium'},{value:'low',label:'Low'}]},
      ],onSearch:'ticketSearch',onFilter:'ticketFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openNewTicket()">+ New Ticket</button>
    </div>
    <div id="tickets-table-wrap"></div>
    <div id="tickets-pagination"></div>
  `;

  document.getElementById('ticket-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildTicketModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(CRM_ADV_COLLECTIONS.TICKETS,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _tickets=data; _filtTickets=[...data]; renderTicketsTable();
  }));
  window.ticketSearch=debounce((q)=>{_filtTickets=searchFilter(_tickets,q,['ticketNo','subject','description']);_pageTickets=1;renderTicketsTable();},250);
  window.ticketFilter=(k,v)=>{_filtTickets=v?_tickets.filter(t=>t[k]===v):[..._tickets];_pageTickets=1;renderTicketsTable();};
  window.setTicketsPage=(p)=>{_pageTickets=p;renderTicketsTable();};
}

function buildTicketModal(){
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  return buildModal({
    id:'ticket-modal',title:'<span id="ticket-modal-title">New Support Ticket</span>',size:'lg',
    body:`
      <input type="hidden" id="ticket-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Ticket No.</label><input type="text" id="tk-no" class="form-input" value="TKT-${genId()}" style="text-transform:uppercase;"></div>
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label>
          <select id="tk-customer" class="form-select"><option value="">Select…</option>${custOpts}</select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Subject <span class="required">*</span></label>
        <input type="text" id="tk-subject" class="form-input" placeholder="Brief description of the issue…">
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Category</label>
          <select id="tk-category" class="form-select">
            <option value="order">Order Issue</option><option value="delivery">Delivery</option>
            <option value="billing">Billing/Invoice</option><option value="product">Product Quality</option>
            <option value="return">Return/Refund</option><option value="general">General Inquiry</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Priority <span class="required">*</span></label>
          <select id="tk-priority" class="form-select">
            <option value="low">Low</option><option value="medium" selected>Medium</option>
            <option value="high">High</option><option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Status</label>
          <select id="tk-status" class="form-select">
            <option value="open">Open</option><option value="in-progress">In Progress</option>
            <option value="resolved">Resolved</option><option value="closed">Closed</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description <span class="required">*</span></label>
        <textarea id="tk-desc" class="form-textarea" rows="3" placeholder="Detailed description of the issue…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Assigned To</label>
          <input type="text" id="tk-assigned" class="form-input" placeholder="Staff member name" value="${escHtml(AuthState.profile?.name||'')}">
        </div>
        <div class="form-group"><label class="form-label">Due Date</label>
          <input type="date" id="tk-due" class="form-input">
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('ticket-modal')">Cancel</button>
            <button class="btn btn-primary" id="ticket-save-btn" onclick="saveTicket()">Save Ticket</button>`,
  });
}

function renderTicketsTable(){
  const wrap=document.getElementById('tickets-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('tickets-count'); if(cnt) cnt.textContent=`${_filtTickets.length} ticket${_filtTickets.length!==1?'s':''}`;
  const start=(_pageTickets-1)*PER;
  const priorityColor={critical:'var(--brand-danger)',high:'var(--brand-warning)',medium:'var(--brand-primary)',low:'var(--text-muted)'};
  wrap.innerHTML=buildTable({id:'tickets-table',
    columns:[
      {key:'ticketNo',   label:'Ticket #',   render:r=>`<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(r.ticketNo||'—')}</span>`},
      {key:'customerId', label:'Customer',   render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||'—')}</span>`}},
      {key:'subject',    label:'Subject',    render:r=>`<div style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.subject||'—')}</div>`},
      {key:'category',   label:'Category',   render:r=>`<span class="badge badge-gray">${escHtml(r.category||'general')}</span>`},
      {key:'priority',   label:'Priority',   render:r=>`<span style="padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${priorityColor[r.priority]||'var(--text-muted)'}20;color:${priorityColor[r.priority]||'var(--text-muted)'};">${(r.priority||'medium').toUpperCase()}</span>`},
      {key:'assignedTo', label:'Assigned',   render:r=>`<span style="font-size:12px;">${escHtml(r.assignedTo||'—')}</span>`},
      {key:'dueDate',    label:'Due',        render:r=>{if(!r.dueDate)return '—';const overdue=new Date(r.dueDate)<new Date()&&r.status!=='resolved'&&r.status!=='closed';return `<span style="font-size:11px;color:${overdue?'var(--brand-danger)':'var(--text-muted)'};">${r.dueDate}</span>`}},
      {key:'status',     label:'Status',     render:r=>badge(r.status||'open')},
      {key:'createdAt',  label:'Created',    render:r=>`<span style="font-size:11px;color:var(--text-muted);">${timeAgo(r.createdAt)}</span>`},
      {key:'actions',    label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'✏️',label:'Edit',            action:`editTicket('${r.id}')`},
        {icon:'✅',label:'Resolve',         action:`resolveTicket('${r.id}')`},
        {icon:'⬆️',label:'Escalate',        action:`escalateTicket('${r.id}')`},
        {icon:'⭐',label:'Satisfaction',    action:`rateSatisfaction('${r.id}')`},
        {icon:'🔒',label:'Close',          action:`closeTicket('${r.id}')`},
        {icon:'🗑',label:'Delete',         action:`deleteTicket('${r.id}')`,danger:true},
      ])},
    ],
    rows:_filtTickets.slice(start,start+PER),emptyMsg:'No support tickets',
  });
  document.getElementById('tickets-pagination').innerHTML=buildPagination({id:'tickets',total:_filtTickets.length,page:_pageTickets,perPage:PER,onChange:'setTicketsPage'});
}

window.openNewTicket=(customerId='')=>{
  // Modal may not be in DOM if CRM module hasn't rendered yet — guard all selectors
  const titleEl = document.getElementById('ticket-modal-title');
  if (!titleEl) {
    console.warn('LAM: openNewTicket called before CRM module rendered');
    return;
  }
  titleEl.textContent='New Support Ticket';
  const idEl = document.getElementById('ticket-id'); if(idEl) idEl.value='';
  const noEl = document.getElementById('tk-no'); if(noEl) noEl.value='TKT-'+genId();
  ['tk-subject','tk-desc','tk-due'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  const stEl=document.getElementById('tk-status'); if(stEl) stEl.value='open';
  const prEl=document.getElementById('tk-priority'); if(prEl) prEl.value='medium';
  const caEl=document.getElementById('tk-category'); if(caEl) caEl.value='order';
  if(customerId){ const cuEl=document.getElementById('tk-customer'); if(cuEl) cuEl.value=customerId; }
  openModal('ticket-modal');
};
window.editTicket=(id)=>{
  const t=_tickets.find(x=>x.id===id); if(!t) return;
  document.getElementById('ticket-modal-title').textContent='Edit Ticket';
  document.getElementById('ticket-id').value=t.id;
  document.getElementById('tk-no').value=t.ticketNo||'';
  document.getElementById('tk-customer').value=t.customerId||'';
  document.getElementById('tk-subject').value=t.subject||'';
  document.getElementById('tk-category').value=t.category||'general';
  document.getElementById('tk-priority').value=t.priority||'medium';
  document.getElementById('tk-status').value=t.status||'open';
  document.getElementById('tk-desc').value=t.description||'';
  document.getElementById('tk-assigned').value=t.assignedTo||'';
  document.getElementById('tk-due').value=t.dueDate||'';
  openModal('ticket-modal');
};
window.saveTicket=async()=>{
  if(!validateForm([{id:'tk-customer',label:'Customer',required:true},{id:'tk-subject',label:'Subject',required:true},{id:'tk-desc',label:'Description',required:true}])) return;
  const btn=document.getElementById('ticket-save-btn'); setLoading(btn,true);
  const id=document.getElementById('ticket-id').value;
  const data={ticketNo:document.getElementById('tk-no').value.trim(),customerId:document.getElementById('tk-customer').value,subject:document.getElementById('tk-subject').value.trim(),category:document.getElementById('tk-category').value,priority:document.getElementById('tk-priority').value,status:document.getElementById('tk-status').value,description:document.getElementById('tk-desc').value.trim(),assignedTo:document.getElementById('tk-assigned').value.trim(),dueDate:document.getElementById('tk-due').value||null,companyId:AuthState.company?.id||null};
  try{
    if(id){await dbUpdate(CRM_ADV_COLLECTIONS.TICKETS,id,data);Toast.success('Updated','Ticket updated.');}
    else{await dbCreate(CRM_ADV_COLLECTIONS.TICKETS,data);Toast.success('Created',`Ticket ${data.ticketNo} created.`);}
    closeModal('ticket-modal');
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.resolveTicket=async(id)=>{try{await dbUpdate(CRM_ADV_COLLECTIONS.TICKETS,id,{status:'resolved',resolvedAt:new Date().toISOString(),resolvedBy:AuthState.profile?.name||''});Toast.success('Resolved','Ticket resolved.');}catch(e){Toast.error('Failed',e.message);}};
window.closeTicket=async(id)=>{try{await dbUpdate(CRM_ADV_COLLECTIONS.TICKETS,id,{status:'closed',closedAt:new Date().toISOString()});Toast.success('Closed','Ticket closed.');}catch(e){Toast.error('Failed',e.message);}};
window.deleteTicket=async(id)=>{if(!confirm('Delete ticket?'))return;try{await dbDelete(CRM_ADV_COLLECTIONS.TICKETS,id);Toast.success('Deleted','Ticket removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// SLA TRACKING
// ══════════════════════════════════════════════════════════════
function renderSLATab(container){
  const slaConfig={critical:4,high:24,medium:72,low:168}; // hours
  const now=Date.now();

  const slaStats=Object.entries(slaConfig).map(([priority,hours])=>{
    const priorityTickets=_tickets.filter(t=>t.priority===priority&&t.status!=='closed'&&t.status!=='resolved');
    const breached=priorityTickets.filter(t=>{
      if(!t.createdAt) return false;
      const created=t.createdAt?.seconds?t.createdAt.seconds*1000:new Date(t.createdAt).getTime();
      const elapsed=(now-created)/3600000;
      return elapsed>hours;
    });
    const atRisk=priorityTickets.filter(t=>{
      if(!t.createdAt) return false;
      const created=t.createdAt?.seconds?t.createdAt.seconds*1000:new Date(t.createdAt).getTime();
      const elapsed=(now-created)/3600000;
      return elapsed>hours*0.75&&elapsed<=hours;
    });
    return {priority,hours,total:priorityTickets.length,breached:breached.length,atRisk:atRisk.length};
  });

  const totalTickets=_tickets.filter(t=>t.status!=='closed'&&t.status!=='resolved').length;
  const totalBreached=slaStats.reduce((s,x)=>s+x.breached,0);
  const slaRate=totalTickets?Math.round(((totalTickets-totalBreached)/totalTickets)*100):100;

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Open Tickets',    value:totalTickets,  icon:'🎫',color:'kpi-blue'},
        {label:'SLA Breached',    value:totalBreached, icon:'🚨',color:totalBreached>0?'kpi-red':'kpi-green'},
        {label:'SLA Compliance',  value:slaRate+'%',   icon:'📊',color:slaRate>=90?'kpi-green':slaRate>=70?'kpi-yellow':'kpi-red'},
        {label:'Avg Resolution',  value:'—',           icon:'⏱',color:'kpi-orange'},
      ].map((k,i)=>`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <!-- SLA by Priority -->
    <div class="grid-2" style="margin-bottom:var(--space-5);">
      <div class="card">
        <div class="card-header"><div class="card-title">⏱ SLA Status by Priority</div></div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${slaStats.map(s=>{
            const compliance=s.total?Math.round(((s.total-s.breached)/s.total)*100):100;
            const color=s.priority==='critical'?'var(--brand-danger)':s.priority==='high'?'var(--brand-warning)':s.priority==='medium'?'var(--brand-primary)':'var(--text-muted)';
            return `
              <div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${color}20;color:${color};text-transform:uppercase;">${s.priority}</span>
                    <span style="font-size:11px;color:var(--text-muted);">SLA: ${s.hours}h · ${s.total} tickets</span>
                  </div>
                  <div style="display:flex;gap:8px;font-size:11px;">
                    ${s.breached>0?`<span style="color:var(--brand-danger);font-weight:600;">${s.breached} breached</span>`:''}
                    ${s.atRisk>0?`<span style="color:var(--brand-warning);">${s.atRisk} at risk</span>`:''}
                  </div>
                </div>
                <div style="background:var(--bg-overlay);border-radius:4px;height:8px;overflow:hidden;">
                  <div style="height:100%;width:${compliance}%;background:${compliance>=90?'var(--brand-secondary)':compliance>=70?'var(--brand-warning)':'var(--brand-danger)'};border-radius:4px;"></div>
                </div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${compliance}% compliance</div>
              </div>`;
          }).join('')}
        </div>
      </div>

      <!-- SLA Config -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚙️ SLA Configuration</div>
          <button class="btn btn-primary btn-sm" onclick="saveSLAConfig()">Save</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${Object.entries(slaConfig).map(([priority,hours])=>{
            const color={critical:'var(--brand-danger)',high:'var(--brand-warning)',medium:'var(--brand-primary)',low:'var(--text-muted)'}[priority];
            return `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <span style="padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${color}20;color:${color};text-transform:uppercase;flex-shrink:0;width:80px;text-align:center;">${priority}</span>
                <div style="flex:1;">
                  <div style="font-size:12px;color:var(--text-secondary);">Response within</div>
                </div>
                <input type="number" id="sla-${priority}" class="form-input" style="width:70px;text-align:right;" value="${hours}" min="1">
                <span style="font-size:12px;color:var(--text-muted);">hours</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- Breached tickets -->
    ${totalBreached>0?`
      <div class="card">
        <div class="card-header">
          <div class="card-title">🚨 SLA Breached Tickets</div>
          <span class="badge badge-red">${totalBreached} breached</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Ticket</th><th>Customer</th><th>Subject</th><th>Priority</th><th>Time Elapsed</th><th>SLA Limit</th><th>Action</th></tr></thead>
            <tbody>
              ${_tickets.filter(t=>t.status!=='closed'&&t.status!=='resolved').map(t=>{
                if(!t.createdAt) return '';
                const hours=slaConfig[t.priority||'medium']||72;
                const created=t.createdAt?.seconds?t.createdAt.seconds*1000:new Date(t.createdAt).getTime();
                const elapsed=Math.ceil((now-created)/3600000);
                if(elapsed<=hours) return '';
                const c=_customers.find(x=>x.id===t.customerId)||{};
                return `<tr>
                  <td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(t.ticketNo||'—')}</td>
                  <td style="font-size:12px;">${escHtml(c.name||'—')}</td>
                  <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.subject||'—')}</td>
                  <td><span style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:var(--brand-danger)20;color:var(--brand-danger);text-transform:uppercase;">${t.priority||'—'}</span></td>
                  <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-danger);">${elapsed}h</td>
                  <td style="font-family:var(--font-mono);">${hours}h</td>
                  <td><button class="btn btn-primary btn-sm" onclick="resolveTicket('${t.id}')">Resolve</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`:''}
  `;

  window.saveSLAConfig=async()=>{
    try{
      const config={};
      ['critical','high','medium','low'].forEach(p=>{const e=document.getElementById(`sla-${p}`);if(e)config[p]=Number(e.value)||24;});
      await dbCreate(CRM_ADV_COLLECTIONS.SLA_CONFIGS,{config,updatedAt:new Date().toISOString(),updatedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
      Toast.success('Saved','SLA configuration saved.');
    }catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// COMMUNICATION LOG
// ══════════════════════════════════════════════════════════════
let _filtComms=[], _pageComms=1;

function renderCommsTab(container){
  container.innerHTML=`
    ${searchBar({id:'comms',placeholder:'Search by customer, subject…',
      filters:[{key:'type',label:'All Types',options:[{value:'call',label:'Call'},{value:'email',label:'Email'},{value:'meeting',label:'Meeting'},{value:'whatsapp',label:'WhatsApp'},{value:'visit',label:'Visit'}]}],
      onSearch:'commsSearch',onFilter:'commsFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openLogComm()">+ Log Communication</button>
    </div>
    <div id="comms-table-wrap"></div>
    <div id="comms-pagination"></div>
  `;

  document.getElementById('comm-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',buildCommModal());

  const cid=AuthState.company?.id;
  _unsubs.push(dbListen(CRM_ADV_COLLECTIONS.COMMUNICATIONS,cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],data=>{
    _comms=data; _filtComms=[...data]; renderCommsTable();
  }));
  window.commsSearch=debounce((q)=>{_filtComms=searchFilter(_comms,q,['subject','notes']);_pageComms=1;renderCommsTable();},250);
  window.commsFilter=(k,v)=>{_filtComms=v?_comms.filter(c=>c[k]===v):[..._comms];_pageComms=1;renderCommsTable();};
  window.setCommsPage=(p)=>{_pageComms=p;renderCommsTable();};
}

function buildCommModal(){
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  return buildModal({
    id:'comm-modal',title:'Log Communication',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Customer <span class="required">*</span></label>
          <select id="cm-customer" class="form-select"><option value="">Select…</option>${custOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Type <span class="required">*</span></label>
          <select id="cm-type" class="form-select">
            <option value="call">📞 Phone Call</option><option value="email">✉️ Email</option>
            <option value="meeting">🤝 Meeting</option><option value="whatsapp">💬 WhatsApp</option>
            <option value="visit">🏢 Site Visit</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="cm-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group"><label class="form-label">Duration</label>
          <input type="text" id="cm-duration" class="form-input" placeholder="e.g. 30 minutes">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Subject <span class="required">*</span></label>
        <input type="text" id="cm-subject" class="form-input" placeholder="What was discussed?">
      </div>
      <div class="form-group"><label class="form-label">Notes / Summary</label>
        <textarea id="cm-notes" class="form-textarea" rows="3" placeholder="Key points, decisions, follow-ups…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Follow-up Date</label>
          <input type="date" id="cm-followup" class="form-input">
        </div>
        <div class="form-group"><label class="form-label">Outcome</label>
          <select id="cm-outcome" class="form-select">
            <option value="positive">Positive</option><option value="neutral">Neutral</option>
            <option value="negative">Negative</option><option value="follow-up">Follow-up Required</option>
          </select>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('comm-modal')">Cancel</button>
            <button class="btn btn-primary" id="comm-save-btn" onclick="saveComm()">Log Communication</button>`,
  });
}

function renderCommsTable(){
  const wrap=document.getElementById('comms-table-wrap'); if(!wrap)return;
  const cnt=document.getElementById('comms-count'); if(cnt) cnt.textContent=`${_filtComms.length} log${_filtComms.length!==1?'s':''}`;
  const start=(_pageComms-1)*PER;
  const typeIcons={call:'📞',email:'✉️',meeting:'🤝',whatsapp:'💬',visit:'🏢'};
  wrap.innerHTML=buildTable({id:'comms-table',
    columns:[
      {key:'type',      label:'Type',     render:r=>`<span style="font-size:16px;">${typeIcons[r.type]||'💬'}</span>`},
      {key:'customerId',label:'Customer', render:r=>{const c=_customers.find(x=>x.id===r.customerId)||{};return `<span style="font-size:12px;">${escHtml(c.name||'—')}</span>`}},
      {key:'subject',   label:'Subject',  render:r=>`<span style="font-size:12px;font-weight:500;">${escHtml(r.subject||'—')}</span>`},
      {key:'duration',  label:'Duration', render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml(r.duration||'—')}</span>`},
      {key:'outcome',   label:'Outcome',  render:r=>badge(r.outcome||'neutral')},
      {key:'followUp',  label:'Follow-up',render:r=>r.followUp?`<span style="font-size:11px;color:var(--brand-warning);">${r.followUp}</span>`:'—'},
      {key:'date',      label:'Date',     render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.date||'—'}</span>`},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[{icon:'🗑',label:'Delete',action:`deleteComm('${r.id}')`,danger:true}])},
    ],
    rows:_filtComms.slice(start,start+PER),emptyMsg:'No communications logged',
  });
  document.getElementById('comms-pagination').innerHTML=buildPagination({id:'comms',total:_filtComms.length,page:_pageComms,perPage:PER,onChange:'setCommsPage'});
}

window.openLogComm=(customerId='')=>{
  if(customerId){const el=document.getElementById('cm-customer');if(el)el.value=customerId;}
  openModal('comm-modal');
};
window.saveComm=async()=>{
  if(!validateForm([{id:'cm-customer',label:'Customer',required:true},{id:'cm-subject',label:'Subject',required:true},{id:'cm-date',label:'Date',required:true}])) return;
  const btn=document.getElementById('comm-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(CRM_ADV_COLLECTIONS.COMMUNICATIONS,{
      customerId:document.getElementById('cm-customer').value,
      type:document.getElementById('cm-type').value,
      date:document.getElementById('cm-date').value,
      duration:document.getElementById('cm-duration').value.trim(),
      subject:document.getElementById('cm-subject').value.trim(),
      notes:document.getElementById('cm-notes').value.trim(),
      followUp:document.getElementById('cm-followup').value||null,
      outcome:document.getElementById('cm-outcome').value,
      loggedBy:AuthState.profile?.name||'',
      companyId:AuthState.company?.id||null,
    });
    Toast.success('Logged','Communication recorded.');
    closeModal('comm-modal');
    ['cm-subject','cm-notes','cm-duration','cm-followup'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
window.deleteComm=async(id)=>{if(!confirm('Delete communication log?'))return;try{await dbDelete(CRM_ADV_COLLECTIONS.COMMUNICATIONS,id);Toast.success('Deleted','Log removed.');}catch(e){Toast.error('Failed',e.message);}};

// ══════════════════════════════════════════════════════════════
// TOOL 70: CUSTOMER SELF-SERVICE PORTAL
// ══════════════════════════════════════════════════════════════
function renderPortalTab(container){
  container.innerHTML=`
    <div class="grid-2" style="align-items:start;gap:var(--space-5);">
      <!-- Portal Preview -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">🌐 Customer Portal Preview</div>
          <span class="badge badge-green badge-dot">Live</span>
        </div>

        <!-- Portal UI mock -->
        <div style="background:#0D0F14;border-radius:var(--radius-lg);overflow:hidden;margin-bottom:var(--space-4);">
          <!-- Portal header -->
          <div style="background:linear-gradient(135deg,var(--brand-primary),var(--brand-secondary));padding:20px 24px;">
            <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:#fff;">Customer Portal</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;">Track orders, invoices and raise tickets</div>
          </div>
          <!-- Portal tiles -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px;">
            ${[
              {icon:'🛒',label:'My Orders',    val:_orders.length,    color:'rgba(10,132,255,0.2)'},
              {icon:'🧾',label:'Invoices',     val:_invoices.length,  color:'rgba(0,200,150,0.2)'},
              {icon:'🎫',label:'Support',      val:_tickets.length,   color:'rgba(255,107,53,0.2)'},
              {icon:'💳',label:'Payments',     val:'—',               color:'rgba(255,159,10,0.2)'},
            ].map(t=>`
              <div style="background:${t.color};border-radius:10px;padding:14px;text-align:center;">
                <div style="font-size:24px;">${t.icon}</div>
                <div style="font-family:var(--font-display);font-size:20px;font-weight:700;color:#fff;margin:4px 0;">${t.val}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.6);">${t.label}</div>
              </div>`).join('')}
          </div>
        </div>

        <div class="alert alert-info">
          <span class="alert-icon">ℹ️</span>
          <div>
            <div class="alert-title">Portal Access</div>
            <div class="alert-text">Each customer gets a secure login link. They can view their orders, download invoices, track deliveries and raise support tickets — all without contacting you directly.</div>
          </div>
        </div>
      </div>

      <!-- Portal Settings -->
      <div style="display:flex;flex-direction:column;gap:var(--space-4);">
        <div class="card">
          <div class="card-header"><div class="card-title">⚙️ Portal Features</div></div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            ${[
              ['Order Tracking',        true],
              ['Invoice Download',      true],
              ['Payment History',       true],
              ['Raise Support Ticket',  true],
              ['Track Delivery',        true],
              ['Return Request',        true],
              ['Account Statement',     false],
              ['Price List View',       false],
            ].map(([feature,enabled])=>`
              <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <span style="font-size:13px;">${feature}</span>
                <label class="toggle">
                  <input type="checkbox" ${enabled?'checked':''} onchange="togglePortalFeature('${feature}',this.checked)">
                  <span class="toggle-slider"></span>
                </label>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">📧 Send Portal Invites</div></div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="form-group">
              <label class="form-label">Select Customer</label>
              <select id="portal-customer" class="form-select">
                <option value="">All customers</option>
                ${_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Custom Message (optional)</label>
              <textarea id="portal-message" class="form-textarea" rows="2" placeholder="Welcome to our customer portal…"></textarea>
            </div>
            <button class="btn btn-primary" onclick="sendPortalInvite()">✉️ Send Portal Invite</button>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">📊 Portal Activity</div></div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${[
              {event:'Ticket raised by Rajesh Kumar',   time:'2h ago', icon:'🎫'},
              {event:'Invoice downloaded by ABC Corp',  time:'5h ago', icon:'📥'},
              {event:'Order tracked by Priya Sharma',   time:'1d ago', icon:'🔍'},
              {event:'Payment made by XYZ Ltd',         time:'2d ago', icon:'💳'},
            ].map(a=>`
              <div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <span>${a.icon}</span>
                <div style="flex:1;font-size:12px;">${a.event}</div>
                <span style="font-size:10px;color:var(--text-muted);">${a.time}</span>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  window.togglePortalFeature=(feature,enabled)=>{
    Toast.success('Updated', `${feature} ${enabled?'enabled':'disabled'} for this customer.`);
  };
  window.sendPortalInvite=()=>{
    const custId=document.getElementById('portal-customer').value;
    const cust=_customers.find(c=>c.id===custId);
    const count=custId?1:_customers.length;
    Toast.success('Invites Sent',`Portal invite${count>1?'s':''} sent to ${custId?cust?.name:count+' customers'}. (Requires email backend.)`);
  };
}

window.escalateTicket = async (id) => {
  const t = _tickets.find(x=>x.id===id); if(!t) return;
  const to = prompt(`Escalate "${t.subject}" to (enter name/team):`);
  if (!to) return;
  try {
    await dbUpdate(CRM_COLLECTIONS.TICKETS, id, {
      status:'escalated', escalatedTo:to.trim(),
      escalatedAt:new Date().toISOString(),
      escalatedBy:AuthState.profile?.name||'',
      priority:'high',
    });
    Toast.warning('Escalated', `Ticket escalated to ${to}.`);
  } catch(e) { Toast.error('Failed', e.message); }
};

window.rateSatisfaction = async (id) => {
  const t = _tickets.find(x=>x.id===id); if(!t) return;
  const scores = ['1 ⭐ — Very Poor','2 ⭐⭐ — Poor','3 ⭐⭐⭐ — Average','4 ⭐⭐⭐⭐ — Good','5 ⭐⭐⭐⭐⭐ — Excellent'];
  const score = prompt(`Rate customer satisfaction for ticket ${t.ticketNo||t.id}:\n${scores.join('\n')}\n\nEnter score (1-5):`);
  const n = Number(score);
  if (!n || n<1 || n>5) { Toast.warning('Invalid','Enter a score between 1 and 5.'); return; }
  try {
    await dbUpdate(CRM_COLLECTIONS.TICKETS, id, {
      satisfactionScore:n,
      satisfactionNote:`Rated ${n}/5 by ${AuthState.profile?.name||'team'}`,
      ratedAt:new Date().toISOString(),
    });
    Toast.success('Rated', `Satisfaction score ${n}/5 saved.`);
  } catch(e) { Toast.error('Failed', e.message); }
};

