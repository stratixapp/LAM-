// ============================================================
// LAM — Advanced Procurement Module (Tools 22 & 24)
// PO Multi-Level Approval Workflow + 3-Way Invoice Matching
// Interconnects: PO → GRN → Vendor Invoice → Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, escHtml, setLoading, searchFilter, debounce, genId, formatNumber, formatCurrency } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose, avatarCell } from '../_shared.js';

export const PROC_COLLECTIONS = {
  APPROVALS:       'proc_approvals',
  INVOICE_MATCHES: 'proc_invoice_matches',
};

let _pos=[], _grns=[], _vendors=[], _products=[];
let _activeTab='approval';
const PER=15;

export async function renderProcurementAdvanced(container) {
  [_pos, _grns, _vendors, _products] = await Promise.all([
    dbGetAll('purchase_orders',      AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll('grns',                 AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.VENDORS,    AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
    dbGetAll(COLLECTIONS.PRODUCTS,   AuthState.company?.id ? [where('companyId','==',AuthState.company.id)] : []),
  ]);

  container.innerHTML = pageShell({
    title: '🔄 Procurement Hub',
    subtitle: 'Purchase orders, approval workflows and 3-way invoice matching.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshProcurement()">↻ Refresh</button>`,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="proc-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);width:fit-content;">
        ${[['approval','✅ PO Approvals'],['matching','🔍 Invoice Matching'],['history','📜 Match History']].map(([id,label])=>`
          <button class="proc-tab ${id==='approval'?'active':''}" id="proc-tab-${id}"
            onclick="switchProcTab('${id}')"
            style="padding:8px 16px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="proc-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.proc-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderProcKPIs();
  setupModalClose(); setupMenuClose();
  window.switchProcTab=switchProcTab;
  window.refreshProcurement=async()=>{
    _pos=await dbGetAll('purchase_orders',AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    _grns=await dbGetAll('grns',AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]);
    renderProcKPIs(); switchProcTab(_activeTab);
  };
  switchProcTab('approval');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderProcKPIs(){
  const el=document.getElementById('proc-kpis'); if(!el) return; el.innerHTML='';
  const pending   =_pos.filter(p=>p.status==='pending').length;
  const approved  =_pos.filter(p=>p.status==='approved').length;
  const totalSpend=_pos.filter(p=>p.status!=='cancelled').reduce((s,p)=>s+(Number(p.totalAmount)||0),0);
  const unmatched =_grns.filter(g=>!g.invoiceMatched).length;
  [
    {label:'Pending Approval', value:pending,                         icon:'⏳', color:'kpi-yellow'},
    {label:'Approved POs',     value:approved,                        icon:'✅', color:'kpi-green'},
    {label:'Total Spend',      value:formatCurrency(totalSpend,true), icon:'💸', color:'kpi-blue'},
    {label:'Unmatched GRNs',   value:unmatched,                       icon:'🔍', color:unmatched>0?'kpi-orange':'kpi-green'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchProcTab(tab){
  _activeTab=tab;
  document.querySelectorAll('.proc-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`proc-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('proc-tab-content'); if(!c) return;
  switch(tab){
    case 'approval': renderApprovalTab(c); break;
    case 'matching': renderMatchingTab(c); break;
    case 'history':  renderMatchHistoryTab(c); break;
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 22: PO APPROVAL WORKFLOW
// ══════════════════════════════════════════════════════════════
let _approvals=[], _filtAppr=[], _pageAppr=1;

function renderApprovalTab(container){
  const pendingPOs=_pos.filter(p=>p.status==='pending'||p.status==='draft');

  container.innerHTML=`
    ${pendingPOs.length?`
      <div class="alert alert-warning" style="margin-bottom:var(--space-4);">
        <span class="alert-icon">⏳</span>
        <div>
          <div class="alert-title">${pendingPOs.length} PO${pendingPOs.length>1?'s':''} Awaiting Approval</div>
          <div class="alert-text">Total value: ${formatCurrency(pendingPOs.reduce((s,p)=>s+(Number(p.totalAmount)||0),0))}</div>
        </div>
      </div>`:''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);margin-bottom:var(--space-5);">
      <!-- Approval Queue -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📋 Approval Queue</div>
          <span class="badge badge-yellow">${pendingPOs.length} pending</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto;">
          ${pendingPOs.length?pendingPOs.map(po=>{
            const vendor=_vendors.find(v=>v.id===po.vendorId)||{};
            return `
              <div style="padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid var(--brand-warning);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <div>
                    <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(po.poNumber||'—')}</span>
                    <span style="margin-left:8px;font-size:11px;color:var(--text-muted);">${formatDate(po.createdAt)}</span>
                  </div>
                  ${badge(po.status||'pending')}
                </div>
                <div style="font-size:13px;font-weight:500;margin-bottom:4px;">${escHtml(vendor.name||vendor.companyName||'—')}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;">
                  <div>
                    <span class="badge badge-blue">${po.items?.length||0} items</span>
                    <span style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--brand-secondary);margin-left:8px;">₹${Number(po.totalAmount||0).toLocaleString('en-IN')}</span>
                  </div>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-success btn-sm" onclick="approvePOWithNote('${po.id}')">✅ Approve</button>
                    <button class="btn btn-secondary btn-sm" onclick="requestRevision('${po.id}')">✏️ Revise</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectPO('${po.id}')">❌ Reject</button>
                  </div>
                </div>
              </div>`;
          }).join(''):`<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px;">✅ No POs awaiting approval</div>`}
        </div>
      </div>

      <!-- Approval Rules -->
      <div class="card">
        <div class="card-header"><div class="card-title">⚙️ Approval Rules</div></div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${[
            {label:'POs up to ₹50,000',    approver:'Manager',        icon:'👤'},
            {label:'₹50,001 – ₹2,00,000', approver:'Senior Manager',  icon:'👔'},
            {label:'₹2,00,001 – ₹10,00,000',approver:'Director',      icon:'🏢'},
            {label:'Above ₹10,00,000',     approver:'MD / CEO',        icon:'👑'},
          ].map(rule=>`
            <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
              <span style="font-size:20px;">${rule.icon}</span>
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:500;">${rule.label}</div>
                <div style="font-size:11px;color:var(--text-muted);">Required approver: ${rule.approver}</div>
              </div>
              <span class="badge badge-green">Active</span>
            </div>`).join('')}
          <div class="alert alert-info" style="margin-top:4px;">
            <span class="alert-icon">ℹ️</span>
            <div><div class="alert-text">Approval rules are configurable. Contact admin to modify thresholds.</div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Approval History -->
    <div class="card">
      <div class="card-header"><div class="card-title">📜 Approval History</div></div>
      <div id="approval-history-list">
        <div style="display:flex;justify-content:center;padding:30px;"><div class="spinner"></div></div>
      </div>
    </div>
  `;

  loadApprovalHistory();

  window.approvePOWithNote=async(id)=>{
    const note=prompt('Add approval note (optional):');
    const btn=_pos.find(p=>p.id===id);
    try{
      await dbUpdate('purchase_orders',id,{status:'approved',approvedBy:AuthState.profile?.name||'',approvedAt:new Date().toISOString(),approvalNote:note||''});
      await dbCreate(PROC_COLLECTIONS.APPROVALS,{poId:id,poNumber:btn?.poNumber||'',action:'approved',by:AuthState.profile?.name||'',note:note||'',amount:btn?.totalAmount||0,timestamp:new Date().toISOString(),companyId:AuthState.company?.id||null});
      Toast.success('Approved!',`PO ${btn?.poNumber||''} approved.`);
      window.refreshProcurement?.();
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.requestRevision=async(id)=>{
    const reason=prompt('What needs to be revised?');
    if(!reason) return;
    const po=_pos.find(p=>p.id===id);
    try{
      await dbUpdate('purchase_orders',id,{status:'draft',revisionNote:reason,revisedAt:new Date().toISOString()});
      await dbCreate(PROC_COLLECTIONS.APPROVALS,{poId:id,poNumber:po?.poNumber||'',action:'revision-requested',by:AuthState.profile?.name||'',note:reason,timestamp:new Date().toISOString(),companyId:AuthState.company?.id||null});
      Toast.warning('Revision Requested',`PO sent back for revision.`);
      window.refreshProcurement?.();
    }catch(e){Toast.error('Failed',e.message);}
  };

  window.rejectPO=async(id)=>{
    const reason=prompt('Reason for rejection:');
    if(!reason) return;
    const po=_pos.find(p=>p.id===id);
    if(!confirm(`Reject PO "${po?.poNumber}"?`)) return;
    try{
      await dbUpdate('purchase_orders',id,{status:'cancelled',rejectionReason:reason,rejectedBy:AuthState.profile?.name||'',rejectedAt:new Date().toISOString()});
      await dbCreate(PROC_COLLECTIONS.APPROVALS,{poId:id,poNumber:po?.poNumber||'',action:'rejected',by:AuthState.profile?.name||'',note:reason,timestamp:new Date().toISOString(),companyId:AuthState.company?.id||null});
      Toast.error('Rejected',`PO ${po?.poNumber||''} rejected.`);
      window.refreshProcurement?.();
    }catch(e){Toast.error('Failed',e.message);}
  };
}

async function loadApprovalHistory(){
  const el=document.getElementById('approval-history-list'); if(!el) return;
  try{
    const cid=AuthState.company?.id;
    const history=await dbGetAll(PROC_COLLECTIONS.APPROVALS,cid?[where('companyId','==',cid),orderBy('timestamp','desc')]:[orderBy('timestamp','desc')]);
    if(!history.length){el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No approval history yet</div>`;return;}
    const colors={approved:'var(--brand-secondary)',rejected:'var(--brand-danger)','revision-requested':'var(--brand-warning)'};
    const icons={approved:'✅',rejected:'❌','revision-requested':'✏️'};
    el.innerHTML=`
      <div style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;padding:4px;">
        ${history.map(h=>`
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${colors[h.action]||'var(--text-muted)'};">
            <span style="font-size:16px;">${icons[h.action]||'📋'}</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:600;">${escHtml(h.poNumber||'—')} — <span style="text-transform:capitalize;">${escHtml(h.action||'—')}</span></div>
              <div style="font-size:11px;color:var(--text-muted);">By ${escHtml(h.by||'—')} ${h.note?`· "${escHtml(h.note.slice(0,50))}"`:''}</div>
            </div>
            <div style="text-align:right;">
              ${h.amount?`<div style="font-family:var(--font-mono);font-size:12px;">₹${Number(h.amount).toLocaleString('en-IN')}</div>`:''}
              <div style="font-size:10px;color:var(--text-muted);">${h.timestamp?new Date(h.timestamp).toLocaleDateString('en-IN'):''}</div>
            </div>
          </div>`).join('')}
      </div>`;
  }catch(e){el.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-muted);">Could not load history</div>`;}
}

// ══════════════════════════════════════════════════════════════
// TOOL 24: 3-WAY INVOICE MATCHING (PO → GRN → Vendor Invoice)
// ══════════════════════════════════════════════════════════════
let _matches=[], _filtMatch=[], _pageMatch=1;

function renderMatchingTab(container){
  const unmatchedGRNs=_grns.filter(g=>!g.invoiceMatched&&g.status==='received');

  container.innerHTML=`
    <div class="alert alert-info" style="margin-bottom:var(--space-5);">
      <span class="alert-icon">🔍</span>
      <div>
        <div class="alert-title">3-Way Invoice Matching</div>
        <div class="alert-text">Verifies: <strong>Purchase Order</strong> → <strong>Goods Receipt Note</strong> → <strong>Vendor Invoice</strong>. All three must match before payment.</div>
      </div>
    </div>

    ${unmatchedGRNs.length?`
      <div class="card" style="margin-bottom:var(--space-5);">
        <div class="card-header">
          <div class="card-title">📥 GRNs Awaiting Invoice Match</div>
          <span class="badge badge-orange">${unmatchedGRNs.length} unmatched</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;">
          ${unmatchedGRNs.map(grn=>{
            const vendor=_vendors.find(v=>v.id===grn.vendorId)||{};
            const po=_pos.find(p=>p.id===grn.linkedPOId)||null;
            return `
              <div style="padding:14px;background:var(--bg-elevated);border-radius:var(--radius-lg);border-left:3px solid var(--brand-orange);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <div>
                    <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(grn.grnNumber||'—')}</span>
                    <span style="margin-left:8px;font-size:11px;color:var(--text-muted);">${formatDate(grn.createdAt)}</span>
                  </div>
                  <span class="badge badge-orange">Unmatched</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;">
                  <div>
                    <div style="font-size:12px;font-weight:500;">${escHtml(vendor.name||vendor.companyName||'—')}</div>
                    <div style="font-size:11px;color:var(--text-muted);">Invoice: ${escHtml(grn.invoiceNo||'None')} · ${grn.items?.length||0} items · ₹${Number(grn.totalValue||0).toLocaleString('en-IN')}</div>
                    ${po?`<div style="font-size:11px;color:var(--brand-primary);">Linked PO: ${escHtml(po.poNumber||'—')}</div>`:'<div style="font-size:11px;color:var(--brand-warning);">⚠ No linked PO found</div>'}
                  </div>
                  <button class="btn btn-primary btn-sm" onclick="startMatching('${grn.id}')">🔍 Start Match</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`:''}

    <!-- Manual matching form -->
    <div class="card" id="matching-form" style="display:none;margin-bottom:var(--space-5);"></div>

    <!-- Recent matches -->
    <div class="card">
      <div class="card-header"><div class="card-title">✅ Recent Matches</div></div>
      <div id="match-recent-list"><div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No matches yet</div></div>
    </div>
  `;

  loadRecentMatches();

  window.startMatching=(grnId)=>{
    const grn=_grns.find(x=>x.id===grnId); if(!grn) return;
    const po=_pos.find(p=>p.id===grn.linkedPOId)||null;
    const vendor=_vendors.find(v=>v.id===grn.vendorId)||{};
    const matchForm=document.getElementById('matching-form');
    matchForm.style.display='';

    // Auto-compare PO vs GRN
    const discrepancies=[];
    if(po){
      (grn.items||[]).forEach(grnItem=>{
        const poItem=(po.items||[]).find(i=>i.productId===grnItem.productId);
        if(!poItem){discrepancies.push({type:'extra',productId:grnItem.productId,detail:'Item received but not in PO'});return;}
        const qtyDiff=Number(grnItem.receivedQty)-Number(poItem.qty);
        const priceDiff=Number(grnItem.costPerUnit)-Number(poItem.unitCost);
        if(Math.abs(qtyDiff)>0) discrepancies.push({type:'qty',productId:grnItem.productId,detail:`Qty diff: PO=${poItem.qty}, GRN=${grnItem.receivedQty} (${qtyDiff>0?'+':''}${qtyDiff})`});
        if(Math.abs(priceDiff)>1) discrepancies.push({type:'price',productId:grnItem.productId,detail:`Price diff: PO=₹${Number(poItem.unitCost||0).toLocaleString('en-IN')}, GRN=₹${Number(grnItem.costPerUnit||0).toLocaleString('en-IN')} (${priceDiff>0?'+':''}₹${priceDiff.toFixed(2)})`});
      });
    }

    matchForm.innerHTML=`
      <div class="card-header">
        <div class="card-title">🔍 Matching: ${escHtml(grn.grnNumber||'—')}</div>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('matching-form').style.display='none'">✕ Close</button>
      </div>
      <div style="padding:var(--space-4);">
        <!-- 3-column comparison -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-4);">
          <!-- PO -->
          <div style="background:rgba(10,132,255,0.08);border:1px solid rgba(10,132,255,0.2);border-radius:var(--radius-lg);padding:14px;">
            <div style="font-size:11px;font-weight:700;color:var(--brand-primary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📋 Purchase Order</div>
            ${po?`
              <div style="font-size:13px;font-weight:600;">${escHtml(po.poNumber||'—')}</div>
              <div style="font-size:11px;color:var(--text-muted);">Vendor: ${escHtml(vendor.name||'—')}</div>
              <div style="font-size:11px;color:var(--text-muted);">${po.items?.length||0} items</div>
              <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--brand-primary);margin-top:6px;">₹${Number(po.totalAmount||0).toLocaleString('en-IN')}</div>
            `:`<div style="font-size:12px;color:var(--brand-warning);">⚠ No PO linked</div>`}
          </div>
          <!-- GRN -->
          <div style="background:rgba(0,200,150,0.08);border:1px solid rgba(0,200,150,0.2);border-radius:var(--radius-lg);padding:14px;">
            <div style="font-size:11px;font-weight:700;color:var(--brand-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📦 Goods Receipt</div>
            <div style="font-size:13px;font-weight:600;">${escHtml(grn.grnNumber||'—')}</div>
            <div style="font-size:11px;color:var(--text-muted);">Invoice: ${escHtml(grn.invoiceNo||'None')}</div>
            <div style="font-size:11px;color:var(--text-muted);">${grn.items?.length||0} items received</div>
            <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--brand-secondary);margin-top:6px;">₹${Number(grn.totalValue||0).toLocaleString('en-IN')}</div>
          </div>
          <!-- Vendor Invoice Input -->
          <div style="background:rgba(255,107,53,0.08);border:1px solid rgba(255,107,53,0.2);border-radius:var(--radius-lg);padding:14px;">
            <div style="font-size:11px;font-weight:700;color:var(--brand-accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🧾 Vendor Invoice</div>
            <div class="form-group" style="margin-bottom:8px;"><label class="form-label" style="font-size:10px;">Invoice No. *</label><input type="text" id="match-inv-no" class="form-input" placeholder="${escHtml(grn.invoiceNo||'Enter invoice no…')}"></div>
            <div class="form-group" style="margin-bottom:8px;"><label class="form-label" style="font-size:10px;">Invoice Amount (₹) *</label><input type="number" id="match-inv-amount" class="form-input" placeholder="${grn.totalValue||0}" value="${grn.totalValue||0}"></div>
            <div class="form-group"><label class="form-label" style="font-size:10px;">Invoice Date</label><input type="date" id="match-inv-date" class="form-input" value="${grn.invoiceDate||new Date().toISOString().slice(0,10)}"></div>
          </div>
        </div>

        <!-- Discrepancies -->
        ${discrepancies.length?`
          <div class="alert alert-warning" style="margin-bottom:var(--space-4);">
            <span class="alert-icon">⚠️</span>
            <div>
              <div class="alert-title">${discrepancies.length} Discrepanc${discrepancies.length>1?'ies':'y'} Found</div>
              <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">
                ${discrepancies.map(d=>{
                  const p=_products.find(x=>x.id===d.productId);
                  return `<div style="font-size:11px;color:var(--text-secondary);">• ${escHtml(p?.name||d.productId||'—')}: ${escHtml(d.detail)}</div>`;
                }).join('')}
              </div>
            </div>
          </div>`:'<div class="alert alert-success" style="margin-bottom:var(--space-4);"><span class="alert-icon">✅</span><div><div class="alert-title">PO vs GRN Match Perfect</div><div class="alert-text">All quantities and prices match.</div></div></div>'}

        <!-- Tolerance setting -->
        <div style="display:flex;align-items:center;gap:var(--space-4);margin-bottom:var(--space-4);">
          <div class="form-group" style="margin-bottom:0;flex:1;">
            <label class="form-label">Match Decision</label>
            <select id="match-decision" class="form-select">
              <option value="matched">✅ Fully Matched — Approve for Payment</option>
              <option value="matched-tolerance">⚠️ Matched with Tolerance — Approve</option>
              <option value="disputed">❌ Disputed — Hold Payment</option>
              <option value="partial">📦 Partial Match — Approve Partial</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;flex:1;">
            <label class="form-label">Notes</label>
            <input type="text" id="match-notes" class="form-input" placeholder="Matching notes…">
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn btn-secondary" onclick="document.getElementById('matching-form').style.display='none'">Cancel</button>
          <button class="btn btn-primary" id="match-save-btn" onclick="saveMatch('${grnId}','${po?.id||''}')">💾 Save Match Decision</button>
        </div>
      </div>
    `;
    matchForm.scrollIntoView({behavior:'smooth'});
  };

  window.saveMatch=async(grnId,poId)=>{
    const invNo    =document.getElementById('match-inv-no').value.trim();
    const invAmount=Number(document.getElementById('match-inv-amount').value)||0;
    const invDate  =document.getElementById('match-inv-date').value;
    const decision =document.getElementById('match-decision').value;
    const notes    =document.getElementById('match-notes').value.trim();
    if(!invNo){Toast.error('Required','Enter vendor invoice number.');return;}
    const btn=document.getElementById('match-save-btn'); setLoading(btn,true);
    try{
      const matchData={
        grnId,poId:poId||null,
        vendorInvoiceNo:invNo,vendorInvoiceAmount:invAmount,vendorInvoiceDate:invDate,
        decision,notes,matchedBy:AuthState.profile?.name||'',
        matchedAt:new Date().toISOString(),
        companyId:AuthState.company?.id||null,
      };
      await dbCreate(PROC_COLLECTIONS.INVOICE_MATCHES,matchData);
      await dbUpdate('grns',grnId,{invoiceMatched:true,matchDecision:decision,vendorInvoiceNo:invNo});
      if(poId&&(decision==='matched'||decision==='matched-tolerance')){
        await dbUpdate('purchase_orders',poId,{status:'received',invoiceMatched:true});
      }
      Toast.success('Match Saved',`Decision: ${decision}. ${decision.includes('matched')?'PO cleared for payment.':'Payment on hold.'}`);
      document.getElementById('matching-form').style.display='none';
      window.refreshProcurement?.();
    }catch(e){Toast.error('Failed',e.message);}
    finally{setLoading(btn,false);}
  };
}

async function loadRecentMatches(){
  const el=document.getElementById('match-recent-list'); if(!el) return;
  try{
    const cid=AuthState.company?.id;
    const matches=await dbGetAll(PROC_COLLECTIONS.INVOICE_MATCHES,cid?[where('companyId','==',cid),orderBy('matchedAt','desc')]:[orderBy('matchedAt','desc')]);
    if(!matches.length){el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No matches recorded yet</div>`;return;}
    el.innerHTML=`
      <div class="table-container">
        <table class="table">
          <thead><tr><th>GRN</th><th>PO</th><th>Vendor Invoice</th><th>Amount</th><th>Decision</th><th>By</th><th>Date</th></tr></thead>
          <tbody>
            ${matches.slice(0,20).map(m=>{
              const grn=_grns.find(g=>g.id===m.grnId)||{};
              const po=_pos.find(p=>p.id===m.poId)||{};
              const decColor={matched:'green','matched-tolerance':'yellow',disputed:'red',partial:'orange'};
              return `<tr>
                <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(grn.grnNumber||m.grnId||'—')}</td>
                <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(po.poNumber||'—')}</td>
                <td style="font-family:var(--font-mono);font-size:12px;">${escHtml(m.vendorInvoiceNo||'—')}</td>
                <td style="font-family:var(--font-mono);">₹${Number(m.vendorInvoiceAmount||0).toLocaleString('en-IN')}</td>
                <td>${badge(m.decision||'pending')}</td>
                <td style="font-size:12px;">${escHtml(m.matchedBy||'—')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${m.matchedAt?new Date(m.matchedAt).toLocaleDateString('en-IN'):''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }catch(e){el.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-muted);">Could not load matches</div>`;}
}

function renderMatchHistoryTab(container){
  container.innerHTML=`<div id="match-history-full"><div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div></div>`;
  loadRecentMatches(); // reuse
  // Redirect output
  setTimeout(()=>{
    const src=document.getElementById('match-recent-list');
    const dst=document.getElementById('match-history-full');
    if(src&&dst) dst.innerHTML=src.innerHTML;
  },800);
}
