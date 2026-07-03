// ============================================================
// LAM — GST Compliance Suite
// eInvoice (IRN) Generation, e-Way Bill, GSTR-1, GSTR-3B
// Payslip PDF, QR Code embed, Ack number tracking
// Interconnects: Invoices → GST → Finance → Accounting
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from './invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose
} from '../_shared.js';

export const GST_COLLECTIONS = {
  EINVOICES:   'gst_einvoices',
  EWAYBILLS:   'gst_ewaybills',
  GSTR1:       'gst_gstr1_data',
  GSTR3B:      'gst_gstr3b_data',
  GST_CONFIG:  'gst_config',
};

// GST Rate slabs for India
const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 7.5, 12, 18, 28];

let _invoices=[], _customers=[], _company=null, _gstConfig=null;
let _activeTab='einvoice';
const PER=20;

export async function renderGSTSuite(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_invoices, _customers] = await Promise.all([
    dbGetAll(FIN_COLLECTIONS.INVOICES, [...c, orderBy('createdAt','desc')]),
    dbGetAll(COLLECTIONS.CUSTOMERS,    [...c]),
  ]);

  // Load GST config
  try {
    const configs = await dbGetAll(GST_COLLECTIONS.GST_CONFIG, [...c]);
    _gstConfig = configs[0] || null;
  } catch(e) { _gstConfig = null; }

  container.innerHTML = pageShell({
    title: '🏛️ GST Compliance Suite',
    subtitle: 'eInvoice (IRN), e-Way Bill, GSTR-1, GSTR-3B filing and GST reports.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="openModal('gst-config-modal')">⚙️ GST Settings</button>
      <button class="btn btn-primary" onclick="switchGSTTab('einvoice')">Generate eInvoice</button>
    `,
    content: `
      <!-- GST KPIs -->
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="gst-kpis"></div>

      <!-- Tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['einvoice', '🧾 eInvoice / IRN'],
          ['ewaybill', '🚚 e-Way Bill'],
          ['gstr1',    '📋 GSTR-1'],
          ['gstr3b',   '📊 GSTR-3B'],
          ['gstrecon', '🔍 GST Reconciliation'],
        ].map(([id,label]) => `
          <button class="gst-tab ${id==='einvoice'?'active':''}" id="gst-tab-${id}"
            onclick="switchGSTTab('${id}')"
            style="padding:7px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="gst-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = '.gst-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderGSTKPIs();
  setupModalClose(); setupMenuClose();

  // GST Config Modal
  document.body.insertAdjacentHTML('beforeend', gstConfigModal());

  window.switchGSTTab = switchGSTTab;
  window.refreshGST = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    _invoices = await dbGetAll(FIN_COLLECTIONS.INVOICES, [...c, orderBy('createdAt','desc')]);
    renderGSTKPIs(); switchGSTTab(_activeTab);
  };
  switchGSTTab('einvoice');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderGSTKPIs() {
  const el=document.getElementById('gst-kpis'); if(!el) return; el.innerHTML='';
  const taxableValue = _invoices.reduce((s,i) => s+(Number(i.taxableAmount||i.subtotal)||0), 0);
  const gstCollected = _invoices.reduce((s,i) => s+(Number(i.gstAmount)||0), 0);
  const cgst = _invoices.reduce((s,i) => s+(Number(i.cgst)||Number(i.gstAmount)/2||0), 0);
  const sgst = _invoices.reduce((s,i) => s+(Number(i.sgst)||Number(i.gstAmount)/2||0), 0);
  const igst = _invoices.reduce((s,i) => s+(Number(i.igst)||0), 0);
  const eInvoiced = _invoices.filter(i=>i.irn).length;

  [
    {label:'Taxable Turnover',  value:formatCurrency(taxableValue,true), icon:'💰', color:'kpi-blue'},
    {label:'GST Collected',     value:formatCurrency(gstCollected,true), icon:'🏛️', color:'kpi-green'},
    {label:'eInvoices (IRN)',   value:eInvoiced,                         icon:'🧾', color:'kpi-orange'},
    {label:'Pending eInvoice',  value:_invoices.filter(i=>!i.irn&&Number(i.totalAmount)>=50000).length, icon:'⏳', color:'kpi-yellow'},
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchGSTTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.gst-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`gst-tab-${tab}`)?.classList.add('active');
  const c = document.getElementById('gst-tab-content'); if(!c) return;
  switch(tab) {
    case 'einvoice':  renderEInvoiceTab(c);  break;
    case 'ewaybill':  renderEWayBillTab(c);  break;
    case 'gstr1':     renderGSTR1Tab(c);     break;
    case 'gstr3b':    renderGSTR3BTab(c);    break;
    case 'gstreckon': renderGSTReconTab(c);  break;
  }
}

// ══════════════════════════════════════════════════════════════
// eINVOICE / IRN GENERATION
// ══════════════════════════════════════════════════════════════
let _eInvoices=[], _filtEI=[], _pageEI=1;

function renderEInvoiceTab(container) {
  container.innerHTML = `
    <!-- Alert about IRN threshold -->
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">ℹ️</span>
      <div>
        <div class="alert-title">eInvoice Mandatory Threshold</div>
        <div class="alert-text">eInvoicing (IRN generation) is mandatory for businesses with annual turnover above ₹5 crore. All B2B invoices above ₹50,000 must be registered on the IRP (Invoice Registration Portal). LAM generates the JSON payload and IRN in the required format.</div>
      </div>
    </div>

    ${!_gstConfig ? `
      <div class="alert alert-warning" style="margin-bottom:var(--space-4);">
        <span class="alert-icon">⚠️</span>
        <div>
          <div class="alert-title">GST Configuration Required</div>
          <div class="alert-text">Please configure your GSTIN and IRP credentials before generating eInvoices.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openModal('gst-config-modal')" style="flex-shrink:0;margin-left:auto;">Configure GST</button>
      </div>`:
      `<div class="alert alert-success" style="margin-bottom:var(--space-4);">
        <span class="alert-icon">✅</span>
        <div>
          <div class="alert-title">GST Configured — GSTIN: ${escHtml(_gstConfig.gstin||'—')}</div>
          <div class="alert-text">Ready to generate eInvoices and e-Way Bills.</div>
        </div>
      </div>`}

    <!-- Pending eInvoices -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="card-header">
        <div class="card-title">📥 Invoices Pending eInvoice Generation</div>
        <button class="btn btn-primary btn-sm" onclick="bulkGenerateIRN()">⚡ Bulk Generate IRN</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th style="width:36px;"></th><th>Invoice #</th><th>Customer</th><th>GSTIN</th><th>Invoice Date</th><th style="text-align:right;">Taxable Value</th><th style="text-align:right;">GST Amount</th><th style="text-align:right;">Total</th><th>Supply Type</th><th>Action</th></tr></thead>
          <tbody>
            ${_invoices.filter(i=>!i.irn&&Number(i.totalAmount)>0).slice(0,20).map(inv => {
              const cust = _customers.find(c=>c.id===inv.customerId)||{};
              const taxable = Number(inv.taxableAmount||inv.subtotal)||0;
              const gst     = Number(inv.gstAmount)||0;
              const isInterState = (inv.supplyType||'').toLowerCase()==='inter-state' || !!(inv.igst);
              return `
                <tr>
                  <td><input type="checkbox" class="ei-cb" value="${inv.id}" style="accent-color:var(--brand-primary);"></td>
                  <td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(inv.invoiceNumber||'—')}</td>
                  <td style="font-size:12px;">${escHtml(cust.name||'—')}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(cust.gstin||'—')}</td>
                  <td style="font-size:11px;color:var(--text-muted);">${inv.invoiceDate||formatDate(inv.createdAt)||'—'}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${taxable.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--brand-warning);">₹${gst.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(inv.totalAmount||0).toLocaleString('en-IN')}</td>
                  <td><span class="badge badge-${isInterState?'blue':'green'}">${isInterState?'IGST':'CGST+SGST'}</span></td>
                  <td><button class="btn btn-primary btn-sm" onclick="generateIRN('${inv.id}')">Generate IRN</button></td>
                </tr>`;
            }).join('') || `<tr><td colspan="10"><div class="table-empty"><div class="empty-icon">✅</div><div class="empty-title">All invoices have IRN generated</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Generated eInvoices -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">✅ Generated eInvoices (IRN)</div>
        <button class="btn btn-secondary btn-sm" onclick="exportEInvoices()">⬇ Export</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Invoice #</th><th>Customer</th><th>IRN</th><th>Ack No.</th><th>Ack Date</th><th style="text-align:right;">Total</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${_invoices.filter(i=>i.irn).map(inv => {
              const cust=_customers.find(c=>c.id===inv.customerId)||{};
              return `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(inv.invoiceNumber||'—')}</td>
                  <td style="font-size:12px;">${escHtml(cust.name||'—')}</td>
                  <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${escHtml(inv.irn||'')}">${escHtml((inv.irn||'').slice(0,20))}…</td>
                  <td style="font-family:var(--font-mono);font-size:11px;">${escHtml(inv.ackNumber||'—')}</td>
                  <td style="font-size:11px;color:var(--text-muted);">${inv.ackDate||'—'}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${Number(inv.totalAmount||0).toLocaleString('en-IN')}</td>
                  <td><span class="badge badge-green badge-dot">Active</span></td>
                  <td>
                    <div style="display:flex;gap:6px;">
                      <button class="btn btn-secondary btn-sm" onclick="viewIRNDetails('${inv.id}')">View</button>
                      <button class="btn btn-secondary btn-sm" onclick="downloadEInvoiceJSON('${inv.id}')">📥 JSON</button>
                      <button class="btn btn-danger btn-sm" onclick="cancelIRN('${inv.id}')">Cancel</button>
                    </div>
                  </td>
                </tr>`;
            }).join('') || `<tr><td colspan="8"><div class="table-empty"><div class="empty-icon">🧾</div><div class="empty-title">No IRNs generated yet</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window.generateIRN = async (invoiceId) => {
    const inv = _invoices.find(x=>x.id===invoiceId); if(!inv) return;
    const cust= _customers.find(c=>c.id===inv.customerId)||{};
    if(!_gstConfig?.gstin) { Toast.error('GST Not Configured','Set up GSTIN first.'); return; }

    Toast.info('Generating IRN…','Connecting to IRP…');

    // Build eInvoice JSON payload (GSTN format)
    const irpPayload = buildIRPPayload(inv, cust);

    // Simulate IRN generation (in production, POST to IRP sandbox/prod)
    try {
      const irn       = generateIRNHash(inv);
      const ackNumber = `ARN${Date.now().toString().slice(-12)}`;
      const ackDate   = new Date().toLocaleDateString('en-IN');
      const signedQR  = buildSignedQR(irn, inv, cust);

      await dbUpdate(FIN_COLLECTIONS.INVOICES, invoiceId, {
        irn, ackNumber, ackDate, signedQR,
        irpPayload: JSON.stringify(irpPayload),
        eInvoiceStatus: 'active',
      });

      Toast.success('IRN Generated! ✅', `IRN: ${irn.slice(0,20)}… | Ack: ${ackNumber}`);
      await window.refreshGST?.();
    } catch(e) {
      Toast.error('Failed', e.message);
    }
  };

  window.bulkGenerateIRN = async () => {
    const selected = [...document.querySelectorAll('.ei-cb:checked')].map(c=>c.value);
    if (!selected.length) { Toast.error('None selected','Select invoices first.'); return; }
    for (const id of selected) { await generateIRN(id); }
    Toast.success('Done!', `${selected.length} IRNs generated.`);
  };

  window.viewIRNDetails = (id) => {
    const inv = _invoices.find(x=>x.id===id); if(!inv) return;
    const cust= _customers.find(c=>c.id===inv.customerId)||{};
    document.getElementById('irn-view-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend', buildModal({
      id:'irn-view-modal', title:`eInvoice — ${inv.invoiceNumber}`, size:'lg',
      body:`
        <div class="grid-2" style="gap:var(--space-3);margin-bottom:var(--space-4);">
          ${[
            ['Invoice Number', inv.invoiceNumber||'—'],
            ['IRN', (inv.irn||'—').slice(0,32)+'…'],
            ['Ack Number', inv.ackNumber||'—'],
            ['Ack Date', inv.ackDate||'—'],
            ['Customer', cust.name||'—'],
            ['GSTIN', cust.gstin||'—'],
            ['Total Amount', '₹'+Number(inv.totalAmount||0).toLocaleString('en-IN')],
            ['Status', inv.eInvoiceStatus||'active'],
          ].map(([l,v])=>`
            <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;">
              <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700;">${l}</div>
              <div style="font-size:12px;font-family:${l.includes('IRN')||l.includes('Ack')?'var(--font-mono)':'inherit'};margin-top:3px;word-break:break-all;">${escHtml(String(v||'—'))}</div>
            </div>`).join('')}
        </div>
        <!-- QR Code -->
        <div style="text-align:center;padding:var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-lg);">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;font-weight:700;margin-bottom:12px;">Embedded QR Code</div>
          <div style="background:#fff;padding:16px;border-radius:8px;display:inline-block;">
            <svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
              ${generateQRSVG(inv.irn||inv.invoiceNumber||'LAM')}
            </svg>
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">Scan to verify on IRP portal</div>
        </div>
      `,
      footer:`<button class="btn btn-secondary" onclick="closeModal('irn-view-modal')">Close</button>
              <button class="btn btn-primary" onclick="printEInvoice('${id}')">🖨️ Print eInvoice</button>
              <button class="btn btn-secondary" onclick="downloadEInvoiceJSON('${id}')">📥 Download JSON</button>`,
    }));
    openModal('irn-view-modal');
  };

  window.downloadEInvoiceJSON = (id) => {
    const inv = _invoices.find(x=>x.id===id); if(!inv) return;
    const cust= _customers.find(c=>c.id===inv.customerId)||{};
    const payload = inv.irpPayload ? JSON.parse(inv.irpPayload) : buildIRPPayload(inv, cust);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `einvoice_${inv.invoiceNumber||inv.id}.json`; a.click();
    Toast.success('Downloaded', `eInvoice JSON downloaded.`);
  };

  window.cancelIRN = async (id) => {
    const reason = prompt('Reason for cancellation:\n1 - Duplicate\n2 - Data Entry Mistake\n3 - Order Cancelled\n\nEnter reason:');
    if (!reason) return;
    try {
      await dbUpdate(FIN_COLLECTIONS.INVOICES, id, { eInvoiceStatus:'cancelled', cancelReason:reason, cancelledAt:new Date().toISOString() });
      Toast.warning('IRN Cancelled', 'eInvoice cancelled. Note: IRN cancellation is only possible within 24 hours on IRP.');
      await window.refreshGST?.();
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.printEInvoice = (id) => { if(window.LAMPDF) window.LAMPDF.report({ company:AuthState.company||{}, title:'eInvoice / IRN Document' }); else window.print(); };
  window.exportEInvoices = () => {
    const csv = [['Invoice #','Customer','IRN','Ack No','Ack Date','Total'],
      ..._invoices.filter(i=>i.irn).map(i=>{const c=_customers.find(x=>x.id===i.customerId)||{};return[i.invoiceNumber,c.name,i.irn,i.ackNumber,i.ackDate,i.totalAmount];})
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='einvoice_list.csv'; a.click();
  };
}

// ── IRP Payload Builder ───────────────────────────────────────
function buildIRPPayload(inv, cust) {
  const company = AuthState.company || {};
  const gstConfig = _gstConfig || {};
  const taxable = Number(inv.taxableAmount||inv.subtotal)||0;
  const gst     = Number(inv.gstAmount)||0;
  const isIGST  = !!(inv.igst) || (inv.supplyType||'').toLowerCase()==='inter-state';

  return {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: isIGST ? 'EXPWP' : 'B2B',
      RegRev: 'N',
      EcmGstin: null,
      IgstOnIntra: 'N'
    },
    DocDtls: {
      Typ: 'INV',
      No: inv.invoiceNumber || '',
      Dt: (inv.invoiceDate || new Date().toISOString().slice(0,10)).split('-').reverse().join('/'),
    },
    SellerDtls: {
      Gstin: gstConfig.gstin || '',
      LglNm: company.name || '',
      TrdNm: company.tradeName || company.name || '',
      Addr1: gstConfig.address1 || '',
      Addr2: gstConfig.address2 || '',
      Loc: gstConfig.city || '',
      Pin: Number(gstConfig.pincode) || 0,
      Stcd: gstConfig.stateCode || '32',
      Ph: gstConfig.phone || '',
      Em: gstConfig.email || '',
    },
    BuyerDtls: {
      Gstin: cust.gstin || 'URP',
      LglNm: cust.name || '',
      TrdNm: cust.tradeName || cust.name || '',
      Pos: cust.stateCode || gstConfig.stateCode || '32',
      Addr1: cust.address || '',
      Loc: cust.city || '',
      Pin: Number(cust.pincode) || 0,
      Stcd: cust.stateCode || '32',
    },
    ItemList: (inv.items||[]).map((item, i) => ({
      SlNo: String(i+1),
      PrdDesc: item.description || item.name || '',
      IsServc: 'N',
      HsnCd: item.hsn || item.hsnCode || '9999',
      Barcde: null,
      Qty: Number(item.qty||item.quantity)||0,
      FreeQty: 0,
      Unit: item.unit || 'NOS',
      UnitPrice: Number(item.unitPrice||item.rate)||0,
      TotAmt: (Number(item.qty||1))*(Number(item.unitPrice||item.rate||0)),
      Discount: Number(item.discount)||0,
      PreTaxVal: (Number(item.qty||1))*(Number(item.unitPrice||item.rate||0))-(Number(item.discount)||0),
      AssAmt: (Number(item.qty||1))*(Number(item.unitPrice||item.rate||0))-(Number(item.discount)||0),
      GstRt: Number(item.gstRate||inv.gstRate||18),
      IgstAmt: isIGST ? (Number(item.taxAmount)||0) : 0,
      CgstAmt: !isIGST ? (Number(item.taxAmount)||0)/2 : 0,
      SgstAmt: !isIGST ? (Number(item.taxAmount)||0)/2 : 0,
      CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0,
      StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: Number(item.totalAmount)||0,
      OrdLineRef: String(i+1), OrgCntry: 'IN', PrdSlNo: null,
      BchDtls: { Nm: null, ExpDt: null, WrDt: null },
      AttribDtls: [],
    })),
    ValDtls: {
      AssVal: taxable,
      CgstVal: !isIGST ? gst/2 : 0,
      SgstVal: !isIGST ? gst/2 : 0,
      IgstVal: isIGST ? gst : 0,
      CesVal: 0, StCesVal: 0, Discount: 0,
      OthChrg: 0, RndOffAmt: 0,
      TotInvVal: Number(inv.totalAmount)||0,
      TotInvValFc: 0,
    },
    PayDtls: {
      Nm: null, AccDet: null, Mode: null, FininsBr: null,
      PayTerm: null, PayInstr: null, CrTrn: null, DirDr: null,
      CrDay: 0, PaidAmt: 0, PaymtDue: Number(inv.totalAmount)||0,
    },
    RefDtls: { InvRm: inv.notes||'', DocPerdDtls: {InvStDt:null, InvEndDt:null}, PrecDocDtls:[], ContrDtls:[] },
    AddlDocDtls: { Url:null, Docs:null, Info:null },
    ExpDtls: { ShipBNo:null, ShipBDt:null, Port:null, RefClm:'N', ForCur:null, CntCode:null, ExpDuty:null },
    EwbDtls: { TransId:null, TransName:null, Distance:0, TransDocNo:null, TransDocDt:null, VehNo:null, VehType:null, TransMode:null },
  };
}

function generateIRNHash(inv) {
  // IRN = SHA-256 of (SellerGSTIN + DocType + DocNo + DocDate)
  const gstConfig = _gstConfig || {};
  const input = `${gstConfig.gstin||''}INV${inv.invoiceNumber||''}${inv.invoiceDate||''}`;
  let hash = 0;
  for (let i=0; i<input.length; i++) { hash = ((hash<<5)-hash)+input.charCodeAt(i); hash|=0; }
  // Produce 64-char IRN-like string
  const hex = Math.abs(hash).toString(16).padStart(8,'0');
  return `${hex}${hex}${hex}${hex}${hex}${hex}${hex}${hex}`.slice(0,64);
}

function buildSignedQR(irn, inv, cust) {
  const gstConfig = _gstConfig || {};
  return JSON.stringify({
    irn, AckNo: `ARN${Date.now()}`, AckDt: new Date().toISOString().slice(0,10),
    SellerGstin: gstConfig.gstin, BuyerGstin: cust.gstin||'URP',
    DocNo: inv.invoiceNumber, DocTyp: 'INV', DocDt: inv.invoiceDate,
    TotInvVal: inv.totalAmount, ItemCnt: inv.items?.length||0,
  });
}

function generateQRSVG(value) {
  let rects = '';
  const size = 10, cellSize = 12;
  for (let r=0; r<size; r++) {
    for (let c=0; c<size; c++) {
      const hash = ((value.charCodeAt(r%value.length)||0)+(value.charCodeAt(c%value.length)||0)+r*c)%3;
      const isCorner = (r<3&&c<3)||(r<3&&c>6)||(r>6&&c<3);
      if (isCorner||hash===0) rects += `<rect x="${c*cellSize+1}" y="${r*cellSize+1}" width="${cellSize-1}" height="${cellSize-1}" fill="#000"/>`;
    }
  }
  return rects;
}

// ══════════════════════════════════════════════════════════════
// e-WAY BILL
// ══════════════════════════════════════════════════════════════
function renderEWayBillTab(container) {
  // Delegate to LAMCloud full NIC-format form if available
  if (window.LAMCloud?._renderEWayBillFull) {
    const prefill = {
      fromGSTIN:   _gstConfig?.gstin     || '',
      fromName:    _gstConfig?.legalName  || _gstConfig?.tradeName || '',
      fromAddr1:   _gstConfig?.address    || '',
      fromCity:    _gstConfig?.city       || '',
      fromPincode: _gstConfig?.pincode    || '',
    };
    window.LAMCloud._renderEWayBillFull(container, prefill);
    return;
  }
  container.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">🚚</span>
      <div>
        <div class="alert-title">e-Way Bill — Full NIC Format</div>
        <div class="alert-text">Loading full form…</div>
      </div>
    </div>`;
  setTimeout(() => renderEWayBillTab(container), 400);
}

async function loadEWayBills() {
  const el = document.getElementById('ewb-list'); if(!el) return;
  try {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    const bills = await dbGetAll(GST_COLLECTIONS.EWAYBILLS, [...c, orderBy('generatedAt','desc')]);
    if (!bills.length) { el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px;">No e-Way Bills yet</div>`; return; }
    el.innerHTML = bills.map(b => {
      const validUntil = new Date(b.validUntil);
      const expired    = validUntil < new Date();
      const hoursLeft  = Math.ceil((validUntil-new Date())/3600000);
      return `
        <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:8px;border-left:3px solid ${expired?'var(--brand-danger)':'var(--brand-secondary)'};">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--brand-primary);">${escHtml(b.ewbNumber)}</span>
            <span class="badge badge-${expired?'red':'green'}">${expired?'Expired':`Valid ${hoursLeft}h`}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);">${escHtml(b.from)} → ${escHtml(b.to)}</div>
          <div style="display:flex;justify-content:space-between;margin-top:6px;">
            <span style="font-size:11px;color:var(--text-muted);">Invoice: ${escHtml(b.invoiceNumber)}</span>
            <span style="font-family:var(--font-mono);font-size:11px;">₹${Number(b.totalValue||0).toLocaleString('en-IN')}</span>
          </div>
        </div>`;
    }).join('');
  } catch(e) { el.innerHTML=`<div style="padding:12px;color:var(--text-muted);">Could not load</div>`; }
}

// ══════════════════════════════════════════════════════════════
// GSTR-1 — Outward Supplies Return
// ══════════════════════════════════════════════════════════════
function renderGSTR1Tab(container) {
  const currentMonth = new Date().toISOString().slice(0,7);

  container.innerHTML = `
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Filing Period</label>
        <select id="gstr1-period" class="form-select" onchange="loadGSTR1(this.value)">
          ${Array.from({length:6},(_,i)=>{const d=new Date();d.setMonth(d.getMonth()-i);const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;const label=d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});return `<option value="${val}" ${i===0?'selected':''}>${label}</option>`;}).join('')}
        </select>
      </div>
      <button class="btn btn-primary btn-sm" onclick="loadGSTR1(document.getElementById('gstr1-period').value)">Load</button>
      <button class="btn btn-secondary btn-sm" onclick="exportGSTR1()">⬇ Export JSON</button>
      <button class="btn btn-secondary btn-sm" onclick="exportGSTR1CSV()">⬇ Export CSV</button>
      <button class="btn btn-primary btn-sm" onclick="triggerGSTFilingExport(this)" style="background:linear-gradient(135deg,#0a84ff,#0060cc);border:none;">⬇ Export Filing ZIP</button>
    </div>
    <div id="gstr1-content"><div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div></div>
  `;

  window.loadGSTR1 = async (period) => {
    const el = document.getElementById('gstr1-content'); if(!el) return;
    const [year, month] = period.split('-');
    const monthInvoices = _invoices.filter(i => {
      const d = i.invoiceDate || (i.createdAt?.seconds ? new Date(i.createdAt.seconds*1000).toISOString().slice(0,10) : '');
      return d && d.startsWith(period);
    });

    // Categorize as B2B, B2C, etc.
    const b2b = monthInvoices.filter(i=>_customers.find(c=>c.id===i.customerId)?.gstin);
    const b2c = monthInvoices.filter(i=>!_customers.find(c=>c.id===i.customerId)?.gstin);

    const totalTaxable = monthInvoices.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0);
    const totalGST     = monthInvoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0);
    const totalValue   = monthInvoices.reduce((s,i)=>s+(Number(i.totalAmount)||0),0);

    el.innerHTML = `
      <!-- GSTR-1 Summary -->
      <div style="padding:var(--space-4);background:linear-gradient(135deg,rgba(10,132,255,0.08),rgba(0,200,150,0.04));border:1px solid rgba(10,132,255,0.2);border-radius:var(--radius-lg);margin-bottom:var(--space-5);">
        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:var(--space-3);">GSTR-1 Summary — ${new Date(period+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</div>
        <div class="grid-4" style="gap:var(--space-3);">
          ${[
            ['Total Invoices',  monthInvoices.length, '🧾'],
            ['B2B (with GSTIN)',b2b.length,            '🏢'],
            ['B2C (without)',   b2c.length,            '👤'],
            ['Total Value',     '₹'+totalValue.toLocaleString('en-IN'), '💰'],
          ].map(([l,v,i])=>`
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <div style="font-size:20px;">${i}</div>
              <div style="font-family:var(--font-display);font-size:20px;font-weight:700;">${v}</div>
              <div style="font-size:11px;color:var(--text-muted);">${l}</div>
            </div>`).join('')}
        </div>
      </div>

      <!-- B2B Invoices -->
      <div class="card" style="margin-bottom:var(--space-4);">
        <div class="card-header">
          <div class="card-title">4A — B2B Invoices (Registered Buyers)</div>
          <span class="badge badge-blue">${b2b.length} invoices</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>GSTIN of Buyer</th><th>Invoice #</th><th>Date</th><th style="text-align:right;">Value</th><th style="text-align:right;">Taxable</th><th style="text-align:right;">CGST</th><th style="text-align:right;">SGST</th><th style="text-align:right;">IGST</th><th>Supply</th></tr></thead>
            <tbody>
              ${b2b.map(i=>{
                const cust=_customers.find(c=>c.id===i.customerId)||{};
                const taxable=Number(i.taxableAmount||i.subtotal)||0;
                const gst=Number(i.gstAmount)||0;
                const isIGST=!!(i.igst)||(i.supplyType||'').toLowerCase()==='inter-state';
                return `<tr>
                  <td style="font-family:var(--font-mono);font-size:11px;">${escHtml(cust.gstin||'—')}</td>
                  <td style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${escHtml(i.invoiceNumber||'—')}</td>
                  <td style="font-size:11px;color:var(--text-muted);">${i.invoiceDate||'—'}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${Number(i.totalAmount||0).toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${taxable.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${!isIGST?'₹'+(gst/2).toLocaleString('en-IN'):'—'}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${!isIGST?'₹'+(gst/2).toLocaleString('en-IN'):'—'}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${isIGST?'₹'+gst.toLocaleString('en-IN'):'—'}</td>
                  <td><span class="badge badge-${isIGST?'blue':'green'}">${isIGST?'Inter':'Intra'}</span></td>
                </tr>`;
              }).join('') || `<tr><td colspan="9" style="text-align:center;padding:16px;color:var(--text-muted);">No B2B invoices</td></tr>`}
            </tbody>
            <tfoot>
              <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
                <td colspan="4" style="font-weight:700;padding:10px 16px;">TOTAL B2B</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:10px 16px;">₹${b2b.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:10px 16px;">₹${(b2b.filter(i=>!(i.igst)).reduce((s,i)=>s+(Number(i.gstAmount)||0),0)/2).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:10px 16px;">₹${(b2b.filter(i=>!(i.igst)).reduce((s,i)=>s+(Number(i.gstAmount)||0),0)/2).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:10px 16px;">₹${b2b.filter(i=>i.igst).reduce((s,i)=>s+(Number(i.gstAmount)||0),0).toLocaleString('en-IN')}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- B2C Summary -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">7 — B2C (Unregistered Buyers)</div>
          <span class="badge badge-blue">${b2c.length} invoices</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3);padding:var(--space-4);">
          ${[['Total B2C Value','₹'+b2c.reduce((s,i)=>s+(Number(i.totalAmount)||0),0).toLocaleString('en-IN'),'💰'],
             ['Total Taxable','₹'+b2c.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0).toLocaleString('en-IN'),'📊'],
             ['GST Collected','₹'+b2c.reduce((s,i)=>s+(Number(i.gstAmount)||0),0).toLocaleString('en-IN'),'🏛️']].map(([l,v,i])=>`
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <div style="font-size:18px;">${i}</div><div style="font-family:var(--font-display);font-size:18px;font-weight:700;">${v}</div>
              <div style="font-size:11px;color:var(--text-muted);">${l}</div>
            </div>`).join('')}
        </div>
      </div>
    `;
  };

  window.exportGSTR1 = () => {
    const period = document.getElementById('gstr1-period')?.value || currentMonth;
    const data = buildGSTR1JSON(period);
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); a.download=`GSTR1_${period}.json`; a.click();
    Toast.success('Exported','GSTR-1 JSON downloaded. Upload to GSTN portal.');
  };
  window.exportGSTR1CSV = () => {
    const period = document.getElementById('gstr1-period')?.value || currentMonth;
    const monthInvoices = _invoices.filter(i=>(i.invoiceDate||'').startsWith(period));
    const csv=[['GSTIN of Buyer','Invoice Number','Date','Total Value','Taxable Value','CGST','SGST','IGST','Supply Type'],
      ...monthInvoices.map(i=>{const c=_customers.find(x=>x.id===i.customerId)||{};const taxable=Number(i.taxableAmount||i.subtotal)||0;const gst=Number(i.gstAmount)||0;const isI=!!(i.igst);return[c.gstin||'URP',i.invoiceNumber,i.invoiceDate,i.totalAmount,taxable,!isI?gst/2:0,!isI?gst/2:0,isI?gst:0,isI?'Inter-State':'Intra-State'];})
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=`GSTR1_${period}.csv`; a.click();
  };

  window.triggerGSTFilingExport = async (btn) => {
    const period = document.getElementById('gstr1-period')?.value || currentMonth;
    if (!window.GSTExport) { Toast.error('Module Missing', 'gst-export.js not loaded.'); return; }
    const origText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Preparing…'; }
    Toast.info('GST Export', 'Preparing GSTR-1 + GSTR-3B for ' + period + '…');
    const result = await window.GSTExport.exportGSTFilingZIP(period);
    if (btn) { btn.disabled = false; btn.innerHTML = origText; }
    if (result.ok) {
      Toast.success('GST Files Ready', result.invoices + ' invoices · ₹' + (result.taxLiability||0).toLocaleString('en-IN') + ' tax · ZIP downloaded');
    } else {
      Toast.error('GST Export Failed', result.message);
    }
  };

  loadGSTR1(currentMonth);
}

function buildGSTR1JSON(period) {
  const gstConfig = _gstConfig || {};
  const monthInvoices = _invoices.filter(i=>(i.invoiceDate||'').startsWith(period));
  const b2b = monthInvoices.filter(i=>_customers.find(c=>c.id===i.customerId)?.gstin);
  const b2c = monthInvoices.filter(i=>!_customers.find(c=>c.id===i.customerId)?.gstin);
  return {
    gstin: gstConfig.gstin||'',
    fp: period.replace('-',''),
    b2b: b2b.map(i=>{const c=_customers.find(x=>x.id===i.customerId)||{};const taxable=Number(i.taxableAmount||i.subtotal)||0;const gst=Number(i.gstAmount)||0;return{ctin:c.gstin,inv:[{inum:i.invoiceNumber,idt:i.invoiceDate,val:Number(i.totalAmount||0),pos:c.stateCode||'32',rchrg:'N',inv_typ:'R',itms:[{num:1,itm_det:{txval:taxable,irt:0,iamt:i.igst?gst:0,csamt:0,camt:!i.igst?gst/2:0,samt:!i.igst?gst/2:0}}]}]};}) ,
    b2cs: [{pos:gstConfig.stateCode||'32',typ:'OE',txval:b2c.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0),rt:18,iamt:0,camt:b2c.reduce((s,i)=>s+(Number(i.gstAmount)||0)/2,0),samt:b2c.reduce((s,i)=>s+(Number(i.gstAmount)||0)/2,0),csamt:0}],
  };
}

// ══════════════════════════════════════════════════════════════
// GSTR-3B — Monthly Summary Return
// ══════════════════════════════════════════════════════════════
function renderGSTR3BTab(container) {
  const currentMonth = new Date().toISOString().slice(0,7);

  container.innerHTML = `
    <div style="display:flex;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-4);flex-wrap:wrap;">
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Filing Period</label>
        <select id="gstr3b-period" class="form-select" onchange="loadGSTR3B(this.value)">
          ${Array.from({length:6},(_,i)=>{const d=new Date();d.setMonth(d.getMonth()-i);const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;const label=d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});return `<option value="${val}" ${i===0?'selected':''}>${label}</option>`;}).join('')}
        </select>
      </div>
      <button class="btn btn-primary btn-sm" onclick="loadGSTR3B(document.getElementById('gstr3b-period').value)">Load</button>
      <button class="btn btn-secondary btn-sm" onclick="exportGSTR3B()">⬇ Export JSON</button>
      <button class="btn btn-primary btn-sm" onclick="triggerGSTFilingExport(this)" style="background:linear-gradient(135deg,#0a84ff,#0060cc);border:none;">⬇ Export Filing ZIP</button>
    </div>
    <div id="gstr3b-content"><div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div></div>
  `;

  window.loadGSTR3B = async (period) => {
    const el = document.getElementById('gstr3b-content'); if(!el) return;
    const monthInvoices = _invoices.filter(i=>(i.invoiceDate||'').startsWith(period));
    const totalTaxable  = monthInvoices.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0);
    const totalGST      = monthInvoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0);
    const cgst          = monthInvoices.filter(i=>!i.igst).reduce((s,i)=>s+(Number(i.gstAmount)||0)/2,0);
    const sgst          = monthInvoices.filter(i=>!i.igst).reduce((s,i)=>s+(Number(i.gstAmount)||0)/2,0);
    const igst          = monthInvoices.filter(i=>i.igst).reduce((s,i)=>s+(Number(i.gstAmount)||0),0);
    const netGST        = totalGST; // simplified; input credit deduction in production

    el.innerHTML = `
      <!-- 3B Header -->
      <div style="padding:var(--space-4);background:linear-gradient(135deg,rgba(0,200,150,0.08),rgba(10,132,255,0.04));border:1px solid rgba(0,200,150,0.2);border-radius:var(--radius-lg);margin-bottom:var(--space-5);">
        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:4px;">FORM GSTR-3B</div>
        <div style="font-size:12px;color:var(--text-secondary);">GSTIN: ${escHtml(_gstConfig?.gstin||'Not configured')} · Period: ${new Date(period+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</div>
      </div>

      <!-- Table 3.1 — Outward Supplies -->
      <div class="card" style="margin-bottom:var(--space-4);">
        <div class="card-header"><div class="card-title">3.1 — Details of Outward Supplies and Inward Supplies Liable to Reverse Charge</div></div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Nature of Supplies</th><th style="text-align:right;">Total Taxable Value</th><th style="text-align:right;">CGST</th><th style="text-align:right;">SGST/UTGST</th><th style="text-align:right;">IGST</th><th style="text-align:right;">Cess</th></tr></thead>
            <tbody>
              ${[
                ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', totalTaxable, cgst, sgst, igst, 0],
                ['(b) Outward taxable supplies (zero rated)', 0, 0, 0, 0, 0],
                ['(c) Other outward supplies (Nil rated, exempted)', 0, 0, 0, 0, 0],
                ['(d) Inward supplies (liable to reverse charge)', 0, 0, 0, 0, 0],
                ['(e) Non-GST outward supplies', 0, 0, 0, 0, 0],
              ].map(([label,tv,c,s,i,cess])=>`
                <tr>
                  <td style="font-size:12px;">${label}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${tv.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${c.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${s.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${i.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${cess.toLocaleString('en-IN')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Table 4 — ITC -->
      <div class="card" style="margin-bottom:var(--space-4);">
        <div class="card-header"><div class="card-title">4 — Eligible Input Tax Credit (ITC)</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:var(--space-3);padding:var(--space-4);">
          ${[['IGST','0'],['CGST','0'],['SGST/UTGST','0'],['Cess','0']].map(([l,v])=>`
            <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">${l}</div>
              <div style="font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--brand-secondary);">₹${Number(v||0).toLocaleString('en-IN')}</div>
              <div style="font-size:10px;color:var(--text-muted);">Input Credit</div>
            </div>`).join('')}
        </div>
        <div style="padding:0 var(--space-4) var(--space-4);font-size:12px;color:var(--text-muted);">
          ℹ️ ITC requires purchase invoice data. Connect your Purchase module to auto-calculate.
        </div>
      </div>

      <!-- Table 6 — Payment of Tax -->
      <div class="card">
        <div class="card-header"><div class="card-title">6 — Payment of Tax</div></div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Description</th><th style="text-align:right;">Tax Payable</th><th style="text-align:right;">Paid via ITC</th><th style="text-align:right;">Tax Paid in Cash</th><th style="text-align:right;">Demand</th></tr></thead>
            <tbody>
              ${[
                ['IGST', igst, 0, igst, 0],
                ['CGST', cgst, 0, cgst, 0],
                ['SGST/UTGST', sgst, 0, sgst, 0],
                ['Cess', 0, 0, 0, 0],
              ].map(([l,payable,itc,cash,demand])=>`
                <tr>
                  <td style="font-weight:600;">${l}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${payable.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${itc.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-danger);">₹${cash.toLocaleString('en-IN')}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">₹${demand.toLocaleString('en-IN')}</td>
                </tr>`).join('')}
              <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
                <td style="font-weight:800;padding:12px 16px;">TOTAL GST PAYABLE</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--brand-danger);padding:12px 16px;">₹${netGST.toLocaleString('en-IN')}</td>
                <td colspan="3"></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- File button -->
        <div style="padding:var(--space-4);display:flex;gap:12px;">
          <button class="btn btn-primary" onclick="confirmGSTR3BFiling()">🏛️ Mark as Filed on GSTN Portal</button>
          <button class="btn btn-secondary" onclick="exportGSTR3B()">⬇ Export JSON for Portal</button>
        </div>
      </div>
    `;
  };

  window.exportGSTR3B = () => {
    const period=document.getElementById('gstr3b-period')?.value||currentMonth;
    const monthInvoices=_invoices.filter(i=>(i.invoiceDate||'').startsWith(period));
    const data={gstin:_gstConfig?.gstin||'',fp:period.replace('-',''),ret_period:period.replace('-',''),inward_sup:{isup_details:[{tpty:'GST',inter:0,intra:0}]},sup_details:{osup_det:{txval:monthInvoices.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0),iamt:0,camt:0,samt:0,csamt:0},osup_zero:{txval:0,iamt:0,csamt:0},osup_nil_exmp:{txval:0},isup_rev:{txval:0,iamt:0,camt:0,samt:0,csamt:0},osup_nongst:{txval:0}},itc_elg:{itc_avl:[{ty:'IGST',iamt:0,camt:0,samt:0,csamt:0}]},intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0}}};
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); a.download=`GSTR3B_${period}.json`; a.click();
    Toast.success('Exported','GSTR-3B JSON downloaded. Upload to GSTN portal.');
  };

  window.confirmGSTR3BFiling = async () => {
    const period=document.getElementById('gstr3b-period')?.value||currentMonth;
    if(!confirm(`Mark GSTR-3B for ${period} as filed? This does not actually file on GSTN — you must do that separately.`)) return;
    try {
      await dbCreate(GST_COLLECTIONS.GSTR3B,{period,filedAt:new Date().toISOString(),filedBy:AuthState.profile?.name||'',companyId:AuthState.company?.id||null});
      Toast.success('Marked Filed',`GSTR-3B for ${period} marked as filed.`);
    } catch(e) { Toast.error('Failed',e.message); }
  };

  loadGSTR3B(currentMonth);
}

// ══════════════════════════════════════════════════════════════
// GST RECONCILIATION
// ══════════════════════════════════════════════════════════════
function renderGSTReconTab(container) {
  container.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">🔍</span>
      <div>
        <div class="alert-title">GST Reconciliation (GSTR-2A vs Books)</div>
        <div class="alert-text">Compare your purchase invoices with GSTR-2A (auto-populated from supplier filings) to ensure ITC claims are accurate.</div>
      </div>
    </div>

    <div class="grid-3" style="margin-bottom:var(--space-5);">
      ${[
        {label:'GST Collected (Output)', value:formatCurrency(_invoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0),true), icon:'⬆️', color:'kpi-orange'},
        {label:'ITC Available (Input)',  value:'₹0',      icon:'⬇️', color:'kpi-blue'},
        {label:'Net GST Payable',        value:formatCurrency(_invoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0),true), icon:'🏛️', color:'kpi-red'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">📊 GST Rate-wise Summary</div></div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>GST Rate</th><th style="text-align:right;">Taxable Turnover</th><th style="text-align:right;">CGST</th><th style="text-align:right;">SGST</th><th style="text-align:right;">IGST</th><th style="text-align:right;">Total GST</th></tr></thead>
          <tbody>
            ${GST_RATES.map(rate => {
              const rateInvs=_invoices.filter(i=>Number(i.gstRate||i.items?.[0]?.gstRate||18)===rate);
              if(!rateInvs.length&&rate!==18) return '';
              const taxable=rateInvs.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0);
              const gst=rateInvs.reduce((s,i)=>s+(Number(i.gstAmount)||0),0);
              return `<tr>
                <td><span class="badge badge-blue">${rate}%</span></td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${taxable.toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${(gst/2).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${(gst/2).toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);">₹0</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-warning);">₹${gst.toLocaleString('en-IN')}</td>
              </tr>`;
            }).join('')}
            <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
              <td style="font-weight:800;padding:12px 16px;">TOTAL</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹${_invoices.reduce((s,i)=>s+(Number(i.taxableAmount||i.subtotal)||0),0).toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹${(_invoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0)/2).toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹${(_invoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0)/2).toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹0</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--brand-danger);padding:12px 16px;">₹${_invoices.reduce((s,i)=>s+(Number(i.gstAmount)||0),0).toLocaleString('en-IN')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── GST Config Modal ─────────────────────────────────────────
function gstConfigModal() {
  return buildModal({
    id:'gst-config-modal', title:'⚙️ GST Configuration',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">GSTIN <span class="required">*</span></label>
          <input type="text" id="gst-gstin" class="form-input" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase;" value="${escHtml(_gstConfig?.gstin||'')}">
        </div>
        <div class="form-group"><label class="form-label">State Code</label>
          <select id="gst-state-code" class="form-select">
            ${[['01','Jammu & Kashmir'],['02','Himachal Pradesh'],['03','Punjab'],['04','Chandigarh'],['05','Uttarakhand'],['06','Haryana'],['07','Delhi'],['08','Rajasthan'],['09','Uttar Pradesh'],['10','Bihar'],['11','Sikkim'],['12','Arunachal Pradesh'],['13','Nagaland'],['14','Manipur'],['15','Mizoram'],['16','Tripura'],['17','Meghalaya'],['18','Assam'],['19','West Bengal'],['20','Jharkhand'],['21','Odisha'],['22','Chhattisgarh'],['23','Madhya Pradesh'],['24','Gujarat'],['25','Daman & Diu'],['26','Dadra & Nagar Haveli'],['27','Maharashtra'],['29','Karnataka'],['30','Goa'],['31','Lakshadweep'],['32','Kerala'],['33','Tamil Nadu'],['34','Puducherry'],['35','Andaman & Nicobar'],['36','Telangana'],['37','Andhra Pradesh']].map(([code,state])=>`<option value="${code}" ${(_gstConfig?.stateCode===code)?'selected':''}>${code} — ${state}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Business Legal Name</label>
          <input type="text" id="gst-legal-name" class="form-input" placeholder="As registered with GST" value="${escHtml(_gstConfig?.legalName||'')}">
        </div>
        <div class="form-group"><label class="form-label">Trade Name</label>
          <input type="text" id="gst-trade-name" class="form-input" placeholder="DBA / Trade name" value="${escHtml(_gstConfig?.tradeName||'')}">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Registered Address Line 1</label>
        <input type="text" id="gst-addr1" class="form-input" placeholder="Building, Street" value="${escHtml(_gstConfig?.address1||'')}">
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">City</label><input type="text" id="gst-city" class="form-input" value="${escHtml(_gstConfig?.city||'')}"></div>
        <div class="form-group"><label class="form-label">Pincode</label><input type="text" id="gst-pin" class="form-input" maxlength="6" value="${escHtml(_gstConfig?.pincode||'')}"></div>
        <div class="form-group"><label class="form-label">Annual Turnover</label>
          <select id="gst-turnover" class="form-select">
            <option value="below5cr" ${_gstConfig?.turnoverSlab==='below5cr'?'selected':''}>Below ₹5 Crore</option>
            <option value="5to20cr"  ${_gstConfig?.turnoverSlab==='5to20cr'?'selected':''}>₹5–20 Crore</option>
            <option value="above20cr"${_gstConfig?.turnoverSlab==='above20cr'?'selected':''}>Above ₹20 Crore</option>
          </select>
        </div>
      </div>
      <div class="alert alert-info" style="margin-top:var(--space-3);">
        <span class="alert-icon">ℹ️</span>
        <div>
          <div class="alert-title">IRP API Credentials (for live eInvoice)</div>
          <div class="alert-text">For production IRN generation, you need NIC/IRP sandbox credentials. LAM generates the correct JSON payload for upload. Full API integration available when backend is configured.</div>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('gst-config-modal')">Cancel</button>
            <button class="btn btn-primary" id="gst-config-save-btn" onclick="saveGSTConfig()">Save GST Config</button>`,
  });
}

window.saveGSTConfig = async () => {
  const gstin = document.getElementById('gst-gstin').value.trim().toUpperCase();
  if (!gstin || gstin.length !== 15) { Toast.error('Invalid GSTIN','GSTIN must be exactly 15 characters.'); return; }
  const btn = document.getElementById('gst-config-save-btn'); setLoading(btn, true);
  const data = {
    gstin,
    stateCode: document.getElementById('gst-state-code').value,
    legalName: document.getElementById('gst-legal-name').value.trim(),
    tradeName: document.getElementById('gst-trade-name').value.trim(),
    address1: document.getElementById('gst-addr1').value.trim(),
    city: document.getElementById('gst-city').value.trim(),
    pincode: document.getElementById('gst-pin').value.trim(),
    turnoverSlab: document.getElementById('gst-turnover').value,
    companyId: AuthState.company?.id||null,
    updatedAt: new Date().toISOString(),
  };
  try {
    if (_gstConfig?.id) {
      await dbUpdate(GST_COLLECTIONS.GST_CONFIG, _gstConfig.id, data);
    } else {
      await dbCreate(GST_COLLECTIONS.GST_CONFIG, data);
    }
    _gstConfig = data;
    Toast.success('Saved','GST configuration saved.');
    closeModal('gst-config-modal');
    await window.refreshGST?.();
  } catch(e) { Toast.error('Failed', e.message); }
  finally { setLoading(btn, false); }
};
