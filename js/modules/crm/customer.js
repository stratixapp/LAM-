// ============================================================
// LAM — Customer Management — SAP/Zoho Level v2
// 5-tab modal: profile, contacts, financial, addresses, docs
// GST validation, credit limit, KYC, shipping addresses,
// customer rating, transaction history, outstanding ledger
// ============================================================
import { dbCreate, dbUpdate, dbDelete, dbGetAll, dbListen, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatCurrency, escHtml, setLoading, searchFilter, debounce, genId, getInitials } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose, avatarCell } from '../_shared.js';

let _customers=[], _filtered=[], _page=1, _unsub=null;
const PER=15;
let _pendingContacts=[], _pendingAddresses=[], _pendingDocs=[];

const CUST_TYPES = { b2b:'Business (B2B)', b2c:'Consumer (B2C)', govt:'Government', export:'Export/International', dealer:'Dealer/Distributor', agent:'Agent/Broker' };
const INDUSTRIES  = ['Logistics','Manufacturing','FMCG','Pharma','Automotive','Retail','E-commerce','Construction','IT','Trading','Healthcare','Education','Other'];

export async function renderCustomers(container) {
  container.innerHTML = pageShell({
    title:'👥 Customers',
    subtitle:'Complete customer lifecycle — KYC, credit, contacts, shipping addresses, transaction history.',
    actions:`
      <button class="btn btn-secondary btn-sm" onclick="toggleCustView()" id="cust-view-btn">⊞ Grid</button>
      <button class="btn btn-secondary btn-sm" onclick="exportCustomers()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openCustModal()">+ Add Customer</button>`,
    content:`
      <div class="grid-4" id="cust-kpis" style="margin-bottom:var(--space-5);"></div>
      ${searchBar({
        id:'customers', placeholder:'Search name, GSTIN, phone, city, industry…',
        filters:[
          {key:'type',   label:'All Types',  options:Object.entries(CUST_TYPES).map(([v,l])=>({value:v,label:l}))},
          {key:'status', label:'All Status', options:[{value:'active',label:'Active'},{value:'inactive',label:'Inactive'},{value:'blocked',label:'Blocked'}]},
          {key:'rating', label:'All Ratings',options:[{value:'5',label:'⭐⭐⭐⭐⭐'},{value:'4',label:'⭐⭐⭐⭐'},{value:'3',label:'⭐⭐⭐'}]},
        ],
        onSearch:'custSearch', onFilter:'custFilter',
      })}
      <div id="cust-list-wrap"></div>
      <div id="cust-pagination"></div>`,
  });

  document.getElementById('cust-modal')?.remove();
  document.getElementById('cust-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildCustModal());
  document.body.insertAdjacentHTML('beforeend', _buildCustViewModal());
  setupModalClose(); setupMenuClose();
  _registerCustGlobals();

  if (_unsub) _unsub();
  const cid=AuthState.company?.id;
  const q=cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')];
  _unsub=dbListen(COLLECTIONS.CUSTOMERS,q,data=>{_customers=data;_filtered=[...data];_renderCustKPIs();_renderCustList();});
}

function _renderCustKPIs(){
  const el=document.getElementById('cust-kpis'); if(!el) return; el.innerHTML='';
  const total=_customers.length, active=_customers.filter(c=>(c.status||'active')==='active').length;
  const totalRec=_customers.reduce((s,c)=>s+(Number(c.outstandingBalance)||0),0);
  const avgRating=_customers.filter(c=>c.rating).reduce((s,c,_,a)=>s+Number(c.rating)/a.length,0);
  [{label:'Total Customers',value:total,icon:'👥',color:'kpi-blue'},{label:'Active',value:active,icon:'✅',color:'kpi-green'},
   {label:'Total Receivable',value:formatCurrency(totalRec,true),icon:'💰',color:'kpi-orange'},{label:'Avg Rating',value:avgRating?avgRating.toFixed(1)+'★':'—',icon:'⭐',color:'kpi-yellow'}]
  .forEach((k,i)=>{el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;});
}

let _custViewMode='table';
function _renderCustList(){
  const wrap=document.getElementById('cust-list-wrap'),pg=document.getElementById('cust-pagination');
  const cnt=document.getElementById('customers-count'); if(cnt)cnt.textContent=`${_filtered.length} customer${_filtered.length!==1?'s':''}`;
  if(!wrap) return;
  const rows=_filtered.slice((_page-1)*PER,_page*PER);
  if(_custViewMode==='grid'){
    wrap.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--space-4);">${rows.map(r=>`
      <div class="card" style="padding:0;overflow:hidden;cursor:pointer;" onclick="viewCustomer('${r.id}')">
        <div style="height:3px;background:${r.status==='blocked'?'var(--brand-danger)':'var(--brand-primary)'};"></div>
        <div style="padding:14px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <div style="width:38px;height:38px;border-radius:10px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--brand-primary);">${getInitials(r.name||'?')}</div>
            <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.name||'—')}</div>
            <div style="font-size:10px;color:var(--text-muted);">${CUST_TYPES[r.type]||r.type||'Customer'}</div></div>${badge(r.status||'active')}
          </div>
          <div style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px;">
            ${r.phone?`<div>📞 ${escHtml(r.phone)}</div>`:''}
            ${r.city?`<div>📍 ${escHtml([r.city,r.state].filter(Boolean).join(', '))}</div>`:''}
            ${r.gstin?`<div style="font-family:var(--font-mono);">GST: ${escHtml(r.gstin)}</div>`:''}
          </div>
          ${r.rating?`<div style="margin-top:8px;color:#f59e0b;">${'★'.repeat(Math.round(r.rating))}${'☆'.repeat(5-Math.round(r.rating))}</div>`:''}
          ${r.outstandingBalance?`<div style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--brand-warning);margin-top:6px;">Receivable: ₹${Number(r.outstandingBalance).toLocaleString('en-IN')}</div>`:''}
        </div>
      </div>`).join('')}</div>`;
  } else {
    wrap.innerHTML=buildTable({id:'cust-table',columns:[
      {key:'name',label:'Customer',render:r=>avatarCell(r.name||'—',r.contactPerson||r.email||'—','var(--brand-primary)','rgba(10,132,255,0.12)')},
      {key:'type',label:'Type',render:r=>badge(r.type,CUST_TYPES[r.type]||r.type||'—')},
      {key:'phone',label:'Phone',render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.phone||'—')}</span>`},
      {key:'city',label:'Location',render:r=>`<span style="font-size:12px;color:var(--text-secondary);">${escHtml([r.city,r.state].filter(Boolean).join(', ')||'—')}</span>`},
      {key:'gstin',label:'GSTIN',render:r=>`<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.gstin||'—')}</span>`},
      {key:'creditLimit',label:'Credit',render:r=>r.creditLimit?`<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.creditLimit).toLocaleString('en-IN')}</span>`:'—'},
      {key:'outstandingBalance',label:'Receivable',render:r=>r.outstandingBalance?`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-warning);">₹${Number(r.outstandingBalance).toLocaleString('en-IN')}</span>`:'—'},
      {key:'rating',label:'Rating',render:r=>r.rating?`<span style="color:#f59e0b;">${'★'.repeat(Math.round(r.rating))}</span>`:'—'},
      {key:'status',label:'Status',render:r=>badge(r.status||'active')},
      {key:'actions',label:'',sortable:false,render:r=>actionsMenu(r.id,[
        {icon:'👁',label:'View Profile',action:`viewCustomer('${r.id}')`},
        {icon:'✏️',label:'Edit',action:`editCustomer('${r.id}')`},
        {icon:'⭐',label:'Rate Customer',action:`rateCustomer('${r.id}')`},
        {icon:'🗑',label:'Delete',action:`deleteCustomer('${r.id}')`,danger:true},
      ])},
    ],rows,emptyMsg:'No customers yet'});
  }
  if(pg)pg.innerHTML=buildPagination({id:'customers',total:_filtered.length,page:_page,perPage:PER,onChange:'setCustPage'});
}

function _buildCustModal(){
  const tabs=[['profile','👤 Profile'],['contacts','📞 Contacts'],['financial','💰 Financial'],['addresses','📍 Addresses'],['docs','📎 KYC Docs']];
  const tabBtns=tabs.map(([id,label],i)=>`<button class="ct-tab ${i===0?'active':''}" id="ctab-${id}" onclick="switchCtTab('${id}')" style="padding:8px 12px;border-radius:var(--radius-sm);font-size:11px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;white-space:nowrap;">${label}</button>`).join('');
  const stateOpts=['Kerala','Tamil Nadu','Karnataka','Maharashtra','Gujarat','Delhi','Rajasthan','West Bengal','Uttar Pradesh','Telangana','Andhra Pradesh','Punjab','Haryana','Odisha','Madhya Pradesh'].map(s=>`<option value="${s}">${s}</option>`).join('');
  const termOpts=['Immediate','Net 7','Net 15','Net 30','Net 45','Net 60','Net 90','Advance'].map(t=>`<option value="${t}">${t}</option>`).join('');
  return buildModal({id:'cust-modal',title:'<span id="cust-modal-title">Add Customer</span>',size:'lg',body:`
    <style>.ct-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}.ct-pane{display:none;}.ct-pane.active{display:block;}.ct-div{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:14px 0 8px;padding-top:12px;border-top:1px solid var(--border-subtle);}</style>
    <input type="hidden" id="c-id">
    <div style="display:flex;gap:2px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:3px;margin-bottom:var(--space-4);overflow-x:auto;">${tabBtns}</div>

    <!-- PROFILE -->
    <div class="ct-pane active" id="ctpane-profile">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Customer Name <span class="required">*</span></label><input type="text" id="c-name" class="form-input" placeholder="Ravi Logistics Pvt Ltd"></div>
        <div class="form-group"><label class="form-label">Display Name / Short Name</label><input type="text" id="c-alias" class="form-input" placeholder="Ravi Logistics"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Customer Type</label>
          <select id="c-type" class="form-select">${Object.entries(CUST_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label class="form-label">Industry</label>
          <select id="c-industry" class="form-select"><option value="">Select…</option>${INDUSTRIES.map(i=>`<option value="${i}">${i}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Phone <span class="required">*</span></label><input type="tel" id="c-phone" class="form-input" placeholder="9876543210" maxlength="10"></div>
        <div class="form-group"><label class="form-label">Email</label><input type="email" id="c-email" class="form-input" placeholder="accounts@customer.com"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Website</label><input type="url" id="c-website" class="form-input" placeholder="https://customer.com"></div>
        <div class="form-group"><label class="form-label">Customer Since</label><input type="date" id="c-since" class="form-input"></div>
      </div>
      <div class="form-group"><label class="form-label">Billing Address</label><textarea id="c-address" class="form-textarea" rows="2" placeholder="Building, Street, Area…"></textarea></div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">City</label><input type="text" id="c-city" class="form-input" placeholder="Kochi"></div>
        <div class="form-group"><label class="form-label">State</label><select id="c-state" class="form-select"><option value="">Select…</option>${stateOpts}</select></div>
        <div class="form-group"><label class="form-label">PIN</label><input type="text" id="c-pin" class="form-input" maxlength="6" placeholder="682001"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Status</label>
          <select id="c-status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option><option value="blocked">Blocked</option><option value="prospect">Prospect</option></select>
        </div>
        <div class="form-group"><label class="form-label">Rating (1–5 ⭐)</label>
          <select id="c-rating" class="form-select"><option value="">Not rated</option><option value="5">⭐⭐⭐⭐⭐ Excellent</option><option value="4">⭐⭐⭐⭐ Good</option><option value="3">⭐⭐⭐ Average</option><option value="2">⭐⭐ Poor</option><option value="1">⭐ Very Poor</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Internal Notes</label><textarea id="c-notes" class="form-textarea" rows="2" placeholder="Key account — handle with priority. Contact Rajesh for escalations."></textarea></div>
    </div>

    <!-- CONTACTS -->
    <div class="ct-pane" id="ctpane-contacts">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Add multiple contact persons — accounts, purchase manager, MD, etc.</div>
      <div id="c-contacts-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
      <div class="card" style="padding:14px;">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Name <span class="required">*</span></label><input type="text" id="cc-name" class="form-input" placeholder="Rajesh Kumar"></div>
          <div class="form-group"><label class="form-label">Designation</label><input type="text" id="cc-desig" class="form-input" placeholder="Purchase Manager"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Phone</label><input type="tel" id="cc-phone" class="form-input" placeholder="9876543210"></div>
          <div class="form-group"><label class="form-label">Email</label><input type="email" id="cc-email" class="form-input" placeholder="rajesh@customer.com"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Department</label>
            <select id="cc-dept" class="form-select"><option value="purchase">Purchase</option><option value="accounts">Accounts</option><option value="logistics">Logistics</option><option value="management">Management</option><option value="other">Other</option></select>
          </div>
          <div class="form-group"><label class="form-label">Primary Contact?</label>
            <select id="cc-primary" class="form-select"><option value="no">No</option><option value="yes">Yes — Make Primary</option></select>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="addCustContact()">+ Add Contact</button>
      </div>
    </div>

    <!-- FINANCIAL -->
    <div class="ct-pane" id="ctpane-financial">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">GSTIN</label>
          <input type="text" id="c-gstin" class="form-input" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase;" oninput="validateCustGSTIN(this)">
          <div id="c-gstin-status" style="font-size:10px;margin-top:3px;"></div>
        </div>
        <div class="form-group"><label class="form-label">PAN Number</label><input type="text" id="c-pan" class="form-input" placeholder="AAAPL1234C" maxlength="10" style="text-transform:uppercase;"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">GST Registration Type</label>
          <select id="c-gst-type" class="form-select">
            <option value="regular">Regular (GSTIN)</option><option value="composition">Composition</option><option value="unregistered">Unregistered</option><option value="sez">SEZ</option><option value="overseas">Export/Overseas</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">TDS Applicable?</label>
          <select id="c-tds" class="form-select"><option value="">Not Applicable</option><option value="194c">194C — 1%/2%</option><option value="194j">194J — 10%</option><option value="194q">194Q — 0.1%</option></select>
        </div>
      </div>
      <div class="ct-div">Credit Configuration</div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Credit Limit (₹)</label><input type="number" id="c-credit" class="form-input" placeholder="0" min="0"></div>
        <div class="form-group"><label class="form-label">Outstanding Balance (₹)</label><input type="number" id="c-outstanding" class="form-input" placeholder="0" min="0"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Payment Terms</label><select id="c-terms" class="form-select">${termOpts}</select></div>
        <div class="form-group"><label class="form-label">Currency</label>
          <select id="c-currency" class="form-select">${['INR','USD','EUR','AED','GBP','SGD'].map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Tags / Category Labels</label><input type="text" id="c-tags" class="form-input" placeholder="Key Account, Freight, Annual Contract… (comma separated)"></div>
    </div>

    <!-- ADDRESSES -->
    <div class="ct-pane" id="ctpane-addresses">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Add multiple shipping / delivery addresses for this customer.</div>
      <div id="c-addresses-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
      <div class="card" style="padding:14px;">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Address Label <span class="required">*</span></label><input type="text" id="ca-label" class="form-input" placeholder="Warehouse, Factory, Site A…"></div>
          <div class="form-group"><label class="form-label">Contact Person</label><input type="text" id="ca-person" class="form-input" placeholder="Name at delivery point"></div>
        </div>
        <div class="form-group"><label class="form-label">Address</label><textarea id="ca-addr" class="form-textarea" rows="2" placeholder="Building, street, area…"></textarea></div>
        <div class="form-grid-3">
          <div class="form-group"><label class="form-label">City</label><input type="text" id="ca-city" class="form-input" placeholder="City"></div>
          <div class="form-group"><label class="form-label">State</label><input type="text" id="ca-state" class="form-input" placeholder="State"></div>
          <div class="form-group"><label class="form-label">PIN</label><input type="text" id="ca-pin" class="form-input" maxlength="6" placeholder="PIN"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Phone at Location</label><input type="tel" id="ca-phone" class="form-input" placeholder="9876543210"></div>
          <div class="form-group"><label class="form-label">GSTIN at this address (if different)</label><input type="text" id="ca-gstin" class="form-input" placeholder="Optional" maxlength="15" style="text-transform:uppercase;"></div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="addCustAddress()">+ Add Address</button>
      </div>
    </div>

    <!-- DOCS -->
    <div class="ct-pane" id="ctpane-docs">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">KYC documents, agreements, credit approvals and compliance records.</div>
      <div id="c-docs-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
      <div class="card" style="padding:14px;">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Document Type</label>
            <select id="cd-type" class="form-select">
              <option value="pan">PAN Card</option><option value="gstin">GST Certificate</option><option value="msme">MSME Certificate</option>
              <option value="credit_app">Credit Application</option><option value="agreement">Service Agreement</option>
              <option value="kyc">KYC Form</option><option value="bank">Bank Letter / Cheque</option><option value="other">Other</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">Document Name</label><input type="text" id="cd-name" class="form-input" placeholder="e.g. GST Cert 2024"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Expiry Date</label><input type="date" id="cd-expiry" class="form-input"></div>
          <div class="form-group"><label class="form-label">URL / Link</label><input type="url" id="cd-url" class="form-input" placeholder="https://drive.google.com/…"></div>
        </div>
        <div class="form-group"><label class="form-label">Notes</label><input type="text" id="cd-note" class="form-input" placeholder="Verified by accounts team on 01-Jan-2025"></div>
        <button class="btn btn-secondary btn-sm" onclick="addCustDoc()">+ Add Document</button>
      </div>
    </div>
  `,footer:`
    <div style="flex:1;"><span id="ctab-indicator" style="font-size:11px;color:var(--text-muted);"></span></div>
    <button class="btn btn-secondary" onclick="closeModal('cust-modal')">Cancel</button>
    <button class="btn btn-primary" id="cust-save-btn" onclick="saveCustomer()">💾 Save Customer</button>
  `});
}

function _buildCustViewModal(){
  return buildModal({id:'cust-view-modal',title:'<span id="cview-title">Customer Profile</span>',size:'lg',
    body:`<div id="cview-content"></div>`,
    footer:`<button class="btn btn-secondary" onclick="closeModal('cust-view-modal')">Close</button><button class="btn btn-primary" id="cview-edit-btn">✏️ Edit</button>`});
}

function _renderCustView(c){
  const tags=(c.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
  return `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:var(--space-4);">
      <div style="width:56px;height:56px;border-radius:14px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:var(--brand-primary);">${getInitials(c.name||'?')}</div>
      <div style="flex:1;">
        <div style="font-size:18px;font-weight:700;">${escHtml(c.name||'—')}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${CUST_TYPES[c.type]||c.type||'Customer'}${c.industry?' · '+escHtml(c.industry):''}</div>
        <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">${badge(c.status||'active')}${c.gstin?`<span class="badge badge-blue" style="font-family:var(--font-mono);">${escHtml(c.gstin)}</span>`:''}${c.rating?`<span style="color:#f59e0b;">${'★'.repeat(Math.round(c.rating))}</span>`:''}</div>
      </div>
      <div style="text-align:right;">
        ${c.creditLimit?`<div style="font-size:11px;color:var(--text-muted);">Credit Limit</div><div style="font-family:var(--font-mono);font-size:14px;font-weight:700;">₹${Number(c.creditLimit).toLocaleString('en-IN')}</div>`:''}
        ${c.outstandingBalance?`<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Receivable</div><div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--brand-warning);">₹${Number(c.outstandingBalance).toLocaleString('en-IN')}</div>`:''}
      </div>
    </div>
    <div class="grid-2" style="gap:var(--space-4);">
      <div>
        <div class="ct-div" style="margin-top:0;border-top:none;">Contact Information</div>
        ${_cRow('📞',c.phone)}${_cRow('✉️',c.email)}${_cRow('🌐',c.website)}${_cRow('📍',[c.address,c.city,c.state,c.pin].filter(Boolean).join(', '))}
        ${(c.contacts||[]).length?`<div class="ct-div">Contact Persons</div>${(c.contacts||[]).map(ct=>`<div style="padding:8px;background:var(--bg-elevated);border-radius:8px;margin-bottom:6px;font-size:12px;"><div style="font-weight:600;">${escHtml(ct.name)} ${ct.isPrimary?'<span class="badge badge-blue" style="font-size:9px;">Primary</span>':''}</div><div style="color:var(--text-muted);">${escHtml(ct.designation||'—')} · ${escHtml(ct.phone||'')} ${ct.email?'· '+escHtml(ct.email):''}</div></div>`).join('')}`:''}
      </div>
      <div>
        <div class="ct-div" style="margin-top:0;border-top:none;">Financial Details</div>
        ${_cRow('🆔 GSTIN',c.gstin)}${_cRow('📋 PAN',c.pan)}${_cRow('💳 Terms',c.paymentTerms)}${_cRow('💰 Currency',c.currency||'INR')}
        ${(c.shippingAddresses||[]).length?`<div class="ct-div">Shipping Addresses</div>${(c.shippingAddresses||[]).map(a=>`<div style="padding:8px;background:var(--bg-elevated);border-radius:8px;margin-bottom:6px;font-size:12px;"><div style="font-weight:600;">${escHtml(a.label||'Address')}</div><div style="color:var(--text-muted);">${escHtml([a.address,a.city,a.state,a.pin].filter(Boolean).join(', '))}</div></div>`).join('')}`:''}
      </div>
    </div>
    ${tags.length?`<div class="ct-div">Tags</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${tags.map(t=>`<span class="badge badge-blue">${escHtml(t)}</span>`).join('')}</div>`:''}
    ${(c.documents||[]).length?`<div class="ct-div">KYC Documents</div><div style="display:flex;flex-direction:column;gap:6px;">${(c.documents||[]).map(d=>{const exp=d.expiry&&new Date(d.expiry)<new Date();return`<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);"><span>📎</span><div style="flex:1;"><div style="font-size:12px;font-weight:500;">${escHtml(d.name||'—')}</div>${d.expiry?`<div style="font-size:10px;color:${exp?'var(--brand-danger)':'var(--text-muted)'};">${exp?'⚠️ EXPIRED: ':'Expires: '}${d.expiry}</div>`:''}</div>${d.url?`<a href="${d.url}" target="_blank" class="btn btn-secondary btn-sm" style="font-size:10px;">Open ↗</a>`:''}</div>`;}).join('')}</div>`:''}
    ${c.notes?`<div class="ct-div">Notes</div><div style="font-size:12px;color:var(--text-secondary);padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">${escHtml(c.notes)}</div>`:''}`;
}

function _cRow(l,v){return v?`<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-subtle);"><div style="font-size:11px;color:var(--text-muted);min-width:80px;">${l}</div><div style="font-size:12px;">${escHtml(String(v))}</div></div>`:''}

function _renderCustContacts(){
  const el=document.getElementById('c-contacts-list'); if(!el)return;
  el.innerHTML=_pendingContacts.map((c,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
    <div style="width:30px;height:30px;border-radius:8px;background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--brand-primary);">${getInitials(c.name)}</div>
    <div style="flex:1;font-size:12px;"><div style="font-weight:600;">${escHtml(c.name)} ${c.isPrimary?'<span class="badge badge-blue" style="font-size:9px;">Primary</span>':''}</div><div style="color:var(--text-muted);">${escHtml(c.designation||'—')} · ${escHtml(c.phone||'')} ${c.email?'· '+escHtml(c.email):''}</div></div>
    <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeCustContact(${i})">✕</button>
  </div>`).join('')||'<div style="font-size:12px;color:var(--text-muted);padding:8px;">No contacts added.</div>';
}
function _renderCustAddresses(){
  const el=document.getElementById('c-addresses-list'); if(!el)return;
  el.innerHTML=_pendingAddresses.map((a,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
    <span>📍</span><div style="flex:1;font-size:12px;"><div style="font-weight:600;">${escHtml(a.label||'Address')}</div><div style="color:var(--text-muted);">${escHtml([a.address,a.city,a.state,a.pin].filter(Boolean).join(', '))}</div></div>
    <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeCustAddress(${i})">✕</button>
  </div>`).join('')||'<div style="font-size:12px;color:var(--text-muted);padding:8px;">No addresses added.</div>';
}
function _renderCustDocs(){
  const el=document.getElementById('c-docs-list'); if(!el)return;
  el.innerHTML=_pendingDocs.map((d,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
    <span>📎</span><div style="flex:1;font-size:12px;"><div style="font-weight:500;">${escHtml(d.name)}</div>${d.expiry?`<div style="font-size:10px;color:var(--text-muted);">Expires: ${d.expiry}</div>`:''}</div>
    <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeCustDoc(${i})">✕</button>
  </div>`).join('')||'<div style="font-size:12px;color:var(--text-muted);padding:8px;">No documents added.</div>';
}

function _registerCustGlobals(){
  const CTABS=['profile','contacts','financial','addresses','docs'];
  window.switchCtTab=(tab)=>{_activeCtTab=tab;document.querySelectorAll('.ct-tab').forEach(b=>b.classList.remove('active'));document.getElementById(`ctab-${tab}`)?.classList.add('active');document.querySelectorAll('.ct-pane').forEach(p=>p.classList.remove('active'));document.getElementById(`ctpane-${tab}`)?.classList.add('active');const idx=CTABS.indexOf(tab)+1;const ind=document.getElementById('ctab-indicator');if(ind)ind.textContent=`Tab ${idx}/${CTABS.length}`;};
  let _activeCtTab='profile';
  window.validateCustGSTIN=(el)=>{const v=el.value.toUpperCase();el.value=v;const st=document.getElementById('c-gstin-status');if(!st)return;if(!v){st.textContent='';return;}const re=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;if(re.test(v)){st.textContent=`✅ Valid GSTIN — State code ${v.slice(0,2)}`;st.style.color='var(--brand-secondary)';}else{st.textContent='❌ Invalid GSTIN format';st.style.color='var(--brand-danger)';}};
  window.addCustContact=()=>{const name=document.getElementById('cc-name')?.value?.trim();if(!name){Toast.warning('Missing','Enter contact name.');return;}const c={id:genId('cc'),name,designation:document.getElementById('cc-desig')?.value?.trim()||'',phone:document.getElementById('cc-phone')?.value?.trim()||'',email:document.getElementById('cc-email')?.value?.trim()||'',department:document.getElementById('cc-dept')?.value||'',isPrimary:document.getElementById('cc-primary')?.value==='yes'};if(c.isPrimary)_pendingContacts.forEach(x=>x.isPrimary=false);_pendingContacts.push(c);_renderCustContacts();['cc-name','cc-desig','cc-phone','cc-email'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});};
  window.removeCustContact=(i)=>{_pendingContacts.splice(i,1);_renderCustContacts();};
  window.addCustAddress=()=>{const label=document.getElementById('ca-label')?.value?.trim();if(!label){Toast.warning('Missing','Enter address label.');return;}_pendingAddresses.push({id:genId('ca'),label,person:document.getElementById('ca-person')?.value?.trim()||'',address:document.getElementById('ca-addr')?.value?.trim()||'',city:document.getElementById('ca-city')?.value?.trim()||'',state:document.getElementById('ca-state')?.value?.trim()||'',pin:document.getElementById('ca-pin')?.value?.trim()||'',phone:document.getElementById('ca-phone')?.value?.trim()||'',gstin:(document.getElementById('ca-gstin')?.value||'').toUpperCase()});_renderCustAddresses();['ca-label','ca-person','ca-addr','ca-city','ca-state','ca-pin','ca-phone','ca-gstin'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});};
  window.removeCustAddress=(i)=>{_pendingAddresses.splice(i,1);_renderCustAddresses();};
  window.addCustDoc=()=>{const name=document.getElementById('cd-name')?.value?.trim();if(!name){Toast.warning('Missing','Enter document name.');return;}_pendingDocs.push({id:genId('cd'),type:document.getElementById('cd-type')?.value||'other',name,expiry:document.getElementById('cd-expiry')?.value||'',url:document.getElementById('cd-url')?.value?.trim()||'',note:document.getElementById('cd-note')?.value?.trim()||''});_renderCustDocs();['cd-name','cd-expiry','cd-url','cd-note'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});};
  window.removeCustDoc=(i)=>{_pendingDocs.splice(i,1);_renderCustDocs();};

  window.openCustModal=()=>{
    _pendingContacts=[];_pendingAddresses=[];_pendingDocs=[];
    _renderCustContacts();_renderCustAddresses();_renderCustDocs();
    document.getElementById('cust-modal-title').textContent='Add Customer';
    ['c-id','c-name','c-alias','c-phone','c-email','c-website','c-address','c-city','c-pin','c-gstin','c-pan','c-credit','c-outstanding','c-tags','c-notes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    ['c-type','c-industry','c-state','c-status','c-rating','c-gst-type','c-tds','c-terms','c-currency'].forEach(id=>{const el=document.getElementById(id);if(el)el.selectedIndex=0;});
    document.getElementById('c-gstin-status').textContent='';
    switchCtTab('profile'); openModal('cust-modal');
  };

  window.saveCustomer=async()=>{
    if(!validateForm([{id:'c-name',label:'Customer Name',required:true},{id:'c-phone',label:'Phone',required:true,minLength:10}])){switchCtTab('profile');return;}
    const btn=document.getElementById('cust-save-btn'); setLoading(btn,true);
    const id=document.getElementById('c-id')?.value;
    const data={
      name:document.getElementById('c-name')?.value?.trim()||'',alias:document.getElementById('c-alias')?.value?.trim()||'',
      type:document.getElementById('c-type')?.value||'b2b',industry:document.getElementById('c-industry')?.value||'',
      phone:document.getElementById('c-phone')?.value?.trim()||'',email:document.getElementById('c-email')?.value?.trim()||'',
      website:document.getElementById('c-website')?.value?.trim()||'',since:document.getElementById('c-since')?.value||'',
      address:document.getElementById('c-address')?.value?.trim()||'',city:document.getElementById('c-city')?.value?.trim()||'',
      state:document.getElementById('c-state')?.value||'',pin:document.getElementById('c-pin')?.value?.trim()||'',
      status:document.getElementById('c-status')?.value||'active',rating:document.getElementById('c-rating')?.value||'',
      notes:document.getElementById('c-notes')?.value?.trim()||'',
      contacts:[..._pendingContacts],
      gstin:(document.getElementById('c-gstin')?.value||'').toUpperCase(),pan:(document.getElementById('c-pan')?.value||'').toUpperCase(),
      gstType:document.getElementById('c-gst-type')?.value||'regular',tdsCategory:document.getElementById('c-tds')?.value||'',
      creditLimit:Number(document.getElementById('c-credit')?.value)||0,outstandingBalance:Number(document.getElementById('c-outstanding')?.value)||0,
      paymentTerms:document.getElementById('c-terms')?.value||'Net 30',currency:document.getElementById('c-currency')?.value||'INR',
      tags:document.getElementById('c-tags')?.value?.trim()||'',
      shippingAddresses:[..._pendingAddresses],documents:[..._pendingDocs],
      companyId:AuthState.company?.id||null,
    };
    try{if(id){await dbUpdate(COLLECTIONS.CUSTOMERS,id,data);Toast.success('Updated',`${data.name} updated.`);}else{await dbCreate(COLLECTIONS.CUSTOMERS,data);Toast.success('Added',`${data.name} added.`);}closeModal('cust-modal');}
    catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };

  window.editCustomer=(id)=>{
    const c=_customers.find(x=>x.id===id); if(!c) return;
    _pendingContacts=[...(c.contacts||[])];_pendingAddresses=[...(c.shippingAddresses||[])];_pendingDocs=[...(c.documents||[])];
    document.getElementById('cust-modal-title').textContent='Edit Customer';
    document.getElementById('c-id').value=c.id;
    const s=(id,v)=>{const el=document.getElementById(id);if(el&&v!==undefined)el.value=String(v);};
    s('c-name',c.name);s('c-alias',c.alias);s('c-phone',c.phone);s('c-email',c.email);s('c-website',c.website);s('c-since',c.since);
    s('c-address',c.address);s('c-city',c.city);s('c-state',c.state);s('c-pin',c.pin);s('c-status',c.status||'active');s('c-rating',c.rating||'');s('c-notes',c.notes);
    s('c-type',c.type||'b2b');s('c-industry',c.industry||'');s('c-gstin',c.gstin);s('c-pan',c.pan);s('c-gst-type',c.gstType||'regular');s('c-tds',c.tdsCategory||'');
    s('c-credit',c.creditLimit);s('c-outstanding',c.outstandingBalance);s('c-terms',c.paymentTerms||'Net 30');s('c-currency',c.currency||'INR');s('c-tags',c.tags);
    if(c.gstin)validateCustGSTIN(document.getElementById('c-gstin'));
    _renderCustContacts();_renderCustAddresses();_renderCustDocs();
    switchCtTab('profile'); openModal('cust-modal');
  };

  window.viewCustomer=(id)=>{
    const c=_customers.find(x=>x.id===id); if(!c) return;
    document.getElementById('cview-title').textContent=c.name||'Customer Profile';
    document.getElementById('cview-content').innerHTML=_renderCustView(c);
    const eb=document.getElementById('cview-edit-btn'); if(eb)eb.onclick=()=>{closeModal('cust-view-modal');editCustomer(id);};
    openModal('cust-view-modal');
  };

  window.rateCustomer=(id)=>{editCustomer(id);setTimeout(()=>switchCtTab('profile'),200);};

  window.deleteCustomer=async(id)=>{
    const c=_customers.find(x=>x.id===id); if(!c)return;
    if(!confirm(`Delete customer "${c.name}"?`))return;
    try{await dbDelete(COLLECTIONS.CUSTOMERS,id);Toast.success('Deleted','Customer removed.');}catch(e){Toast.error('Failed',e.message);}
  };

  window.custSearch=debounce((q)=>{_filtered=searchFilter(_customers,q,['name','alias','contactPerson','phone','email','city','gstin','industry','tags']);_page=1;_renderCustList();},250);
  window.custFilter=(k,v)=>{_filtered=v?_customers.filter(c=>c[k]===v):[..._customers];_page=1;_renderCustList();};
  window.setCustPage=(p)=>{_page=p;_renderCustList();};
  window.toggleCustView=()=>{_custViewMode=_custViewMode==='table'?'grid':'table';document.getElementById('cust-view-btn').textContent=_custViewMode==='table'?'⊞ Grid':'☰ Table';_renderCustList();};
  window.exportCustomers=()=>{
    const h=['Name','Type','Phone','Email','City','State','GSTIN','PAN','Credit Limit','Outstanding','Payment Terms','Rating','Status'];
    const rows=_filtered.map(c=>[c.name,CUST_TYPES[c.type]||c.type,c.phone,c.email,c.city,c.state,c.gstin,c.pan,c.creditLimit||0,c.outstandingBalance||0,c.paymentTerms,c.rating||'',c.status||'active']);
    const csv=[h,...rows].map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='customers_export.csv';a.click();
    Toast.success('Exported',`${_filtered.length} customers exported.`);
  };
}
