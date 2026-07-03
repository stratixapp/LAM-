// ============================================================
// LAM — Company Setup — SAP Level v2
// Logo, letterhead, bank details, branches, signature,
// GST config, invoice numbering, preferences, plan info
// ============================================================
import { dbSet, dbGet, dbGetAll, dbCreate, dbUpdate, dbDelete, COLLECTIONS, where } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { setLoading, escHtml, genId, formatDate } from '../../core/utils.js';
import { pageShell, buildModal, validateForm, openModal, closeModal, setupModalClose, badge } from '../_shared.js';

const TABS = [
  ['profile',    '🏢 Profile'],
  ['identity',   '🎨 Identity'],
  ['bank',       '🏦 Bank & Tax'],
  ['branches',   '🏪 Branches'],
  ['numbering',  '🔢 Numbering'],
  ['preferences','⚙️ Preferences'],
];

let _branches = [];
let _activeTab = 'profile';

export async function renderCompany(container) {
  const co = AuthState.company || {};
  const cid = co.id;
  _branches = cid ? await dbGetAll('company_branches', [where('companyId','==',cid)]).catch(()=>[]) : [];

  const tabBtns = TABS.map(([id,label],i) => `
    <button class="co-tab ${i===0?'active':''}" id="cotab-${id}" onclick="switchCoTab('${id}')"
      style="padding:10px 16px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;color:var(--text-muted);background:transparent;border:none;cursor:pointer;white-space:nowrap;transition:all 0.15s;">
      ${label}
    </button>`).join('');

  container.innerHTML = pageShell({
    title: '🏢 Company Setup',
    subtitle: 'Complete company configuration — profile, identity, bank, branches, numbering.',
    actions: `<button class="btn btn-primary" id="co-save-btn" onclick="saveCompany()">💾 Save All Settings</button>`,
    content: `
      <style>
        .co-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}
        .co-pane{display:none;} .co-pane.active{display:block;}
        .co-divider{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--border-subtle);}
        #logo-preview{width:80px;height:80px;border-radius:12px;border:2px dashed var(--border-default);display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;overflow:hidden;background:var(--bg-elevated);}
        #sig-preview{width:200px;height:60px;border:1px solid var(--border-default);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted);overflow:hidden;background:var(--bg-elevated);}
      </style>

      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);overflow-x:auto;width:fit-content;">
        ${tabBtns}
      </div>

      <!-- TAB 1: PROFILE -->
      <div class="co-pane active" id="copane-profile">
        <div class="grid-2" style="align-items:start;gap:var(--space-5);">
          <div class="card">
            <div class="card-header"><div class="card-title">Basic Information</div></div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Company Name <span class="required">*</span></label>
                <input type="text" id="co-name" class="form-input" value="${escHtml(co.name||'')}" placeholder="ABC Logistics Pvt Ltd">
              </div>
              <div class="form-group">
                <label class="form-label">Short Name / Brand</label>
                <input type="text" id="co-shortname" class="form-input" value="${escHtml(co.shortName||'')}" placeholder="ABC Logistics">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Industry</label>
                <select id="co-industry" class="form-select">
                  ${['Logistics & Transport','Manufacturing','FMCG','Pharma','Automotive','Retail','E-commerce','Construction','IT Services','Trading','Other']
                    .map(i=>`<option value="${i}" ${co.industry===i?'selected':''}>${i}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Business Type</label>
                <select id="co-biz-type" class="form-select">
                  ${['Private Limited (Pvt Ltd)','Public Limited (Ltd)','LLP','Partnership','Proprietorship','One Person Company (OPC)','Society/Trust','Govt/PSU']
                    .map(t=>`<option value="${t}" ${co.businessType===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Phone</label>
                <input type="tel" id="co-phone" class="form-input" value="${escHtml(co.phone||'')}" placeholder="9876543210">
              </div>
              <div class="form-group">
                <label class="form-label">Alternate Phone</label>
                <input type="tel" id="co-phone2" class="form-input" value="${escHtml(co.phone2||'')}" placeholder="022-12345678">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" id="co-email" class="form-input" value="${escHtml(co.email||'')}" placeholder="info@company.com">
              </div>
              <div class="form-group">
                <label class="form-label">Website</label>
                <input type="url" id="co-website" class="form-input" value="${escHtml(co.website||'')}" placeholder="https://company.com">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Registered Address <span class="required">*</span></label>
              <textarea id="co-address" class="form-textarea" rows="2" placeholder="Building No., Street, Area…">${escHtml(co.address||'')}</textarea>
            </div>
            <div class="form-grid-3">
              <div class="form-group">
                <label class="form-label">City</label>
                <input type="text" id="co-city" class="form-input" value="${escHtml(co.city||'')}" placeholder="Mumbai">
              </div>
              <div class="form-group">
                <label class="form-label">State</label>
                <select id="co-state" class="form-select">
                  <option value="">Select…</option>
                  ${['Kerala','Tamil Nadu','Karnataka','Telangana','Andhra Pradesh','Maharashtra','Gujarat','Delhi','Rajasthan','Uttar Pradesh','West Bengal','Odisha','Bihar','Madhya Pradesh','Punjab','Haryana'].map(s=>`<option value="${s}" ${co.state===s?'selected':''}>${s}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">PIN Code</label>
                <input type="text" id="co-pin" class="form-input" value="${escHtml(co.pin||'')}" placeholder="400001" maxlength="6">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Founded Year</label>
                <input type="number" id="co-founded" class="form-input" value="${co.founded||''}" placeholder="2010" min="1900" max="2030">
              </div>
              <div class="form-group">
                <label class="form-label">No. of Employees</label>
                <input type="number" id="co-emp-count" class="form-input" value="${co.employeeCount||''}" placeholder="250">
              </div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <!-- Plan card -->
            <div class="card">
              <div class="card-header"><div class="card-title">📋 Current Plan</div></div>
              ${_planCard(co.plan||'starter')}
              <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="LAM?.showUpgradeModal?.()">⬆ Upgrade Plan</button>
            </div>
            <!-- Quick stats -->
            <div class="card">
              <div class="card-header"><div class="card-title">📊 Company Summary</div></div>
              <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;">
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
                  <span style="color:var(--text-muted);">Branches / Locations</span>
                  <span style="font-weight:600;">${_branches.length}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
                  <span style="color:var(--text-muted);">Financial Year</span>
                  <span style="font-weight:600;">${co.fyStart==='january'?'Jan–Dec':'Apr–Mar'} (${new Date().getFullYear()})</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;">
                  <span style="color:var(--text-muted);">Default Currency</span>
                  <span style="font-weight:600;">${co.currency||'INR'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2: IDENTITY (Logo, Letterhead, Signature) -->
      <div class="co-pane" id="copane-identity">
        <div class="grid-2" style="align-items:start;gap:var(--space-5);">
          <div class="card">
            <div class="card-header"><div class="card-title">🖼 Company Logo</div></div>
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:var(--space-4);">
              <div id="logo-preview" onclick="_pickLogo()" title="Click to upload logo">
                ${co.logo?`<img src="${co.logo}" style="width:100%;height:100%;object-fit:contain;">`:'🏢'}
              </div>
              <div>
                <div style="font-size:12px;font-weight:500;">Company Logo</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Appears on invoices, POs, payslips, reports.</div>
                <div style="display:flex;gap:8px;margin-top:8px;">
                  <button class="btn btn-secondary btn-sm" onclick="_pickLogo()">📁 Upload</button>
                  <button class="btn btn-danger btn-sm" onclick="_clearLogo()">✕ Remove</button>
                </div>
              </div>
              <input type="hidden" id="co-logo">
              <input type="file" id="logo-file-input" accept="image/*" style="display:none;" onchange="_onLogoFile(this)">
            </div>
            <div class="co-divider">Letterhead Preview</div>
            <div id="letterhead-preview" style="border:1px solid var(--border-default);border-radius:var(--radius-md);padding:16px;font-size:11px;background:var(--bg-elevated);">
              <div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid var(--brand-primary);padding-bottom:10px;margin-bottom:10px;">
                <div id="lh-logo-box" style="width:40px;height:40px;border-radius:8px;background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:16px;">🏢</div>
                <div>
                  <div style="font-size:14px;font-weight:800;color:var(--brand-primary);" id="lh-name">${escHtml(co.name||'Your Company Name')}</div>
                  <div style="font-size:10px;color:var(--text-muted);" id="lh-addr">${escHtml(co.address||'Company Address')}</div>
                </div>
                <div style="margin-left:auto;text-align:right;font-size:10px;color:var(--text-muted);">
                  <div id="lh-phone">${co.phone||''}</div>
                  <div id="lh-email">${co.email||''}</div>
                  <div id="lh-gstin">GSTIN: ${co.gstin||'—'}</div>
                </div>
              </div>
              <div style="color:var(--text-muted);font-size:10px;text-align:center;">← Document content will appear here →</div>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">✍️ Authorised Signature</div></div>
            <div style="margin-bottom:var(--space-3);">
              <div id="sig-preview" onclick="_pickSignature()" style="cursor:pointer;" title="Click to upload signature">
                ${co.signature?`<img src="${co.signature}" style="max-width:100%;max-height:100%;object-fit:contain;">`:'Click to upload signature image'}
              </div>
              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="btn btn-secondary btn-sm" onclick="_pickSignature()">📁 Upload Signature</button>
                <button class="btn btn-danger btn-sm" onclick="_clearSig()">✕ Remove</button>
              </div>
              <input type="hidden" id="co-signature">
              <input type="file" id="sig-file-input" accept="image/*" style="display:none;" onchange="_onSigFile(this)">
            </div>
            <div class="co-divider">Signatory Details</div>
            <div class="form-group">
              <label class="form-label">Authorised Signatory Name</label>
              <input type="text" id="co-signatory" class="form-input" value="${escHtml(co.signatory||'')}" placeholder="Managing Director">
            </div>
            <div class="form-group">
              <label class="form-label">Designation</label>
              <input type="text" id="co-signatory-desig" class="form-input" value="${escHtml(co.signatoryDesig||'')}" placeholder="Director / CEO">
            </div>
            <div class="co-divider">Brand Colours (for PDF letterhead)</div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Primary Colour</label>
                <input type="color" id="co-primary-color" value="${co.primaryColor||'#0a84ff'}" class="form-input" style="height:36px;padding:2px;">
              </div>
              <div class="form-group">
                <label class="form-label">Accent Colour</label>
                <input type="color" id="co-accent-color" value="${co.accentColor||'#1e3a5f'}" class="form-input" style="height:36px;padding:2px;">
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 3: BANK & TAX -->
      <div class="co-pane" id="copane-bank">
        <div class="grid-2" style="align-items:start;gap:var(--space-5);">
          <div class="card">
            <div class="card-header"><div class="card-title">🏦 Primary Bank Account</div></div>
            <div class="form-group">
              <label class="form-label">Bank Name</label>
              <input type="text" id="co-bank-name" class="form-input" value="${escHtml(co.bankDetails?.bankName||'')}" placeholder="State Bank of India">
            </div>
            <div class="form-group">
              <label class="form-label">Account Holder Name</label>
              <input type="text" id="co-bank-holder" class="form-input" value="${escHtml(co.bankDetails?.accountHolder||'')}" placeholder="ABC Logistics Pvt Ltd">
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Account Number</label>
                <input type="text" id="co-bank-acc" class="form-input" value="${escHtml(co.bankDetails?.accountNumber||'')}" placeholder="Account number">
              </div>
              <div class="form-group">
                <label class="form-label">IFSC Code</label>
                <input type="text" id="co-bank-ifsc" class="form-input" value="${escHtml(co.bankDetails?.ifsc||'')}" placeholder="SBIN0001234" maxlength="11" style="text-transform:uppercase;">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Branch</label>
                <input type="text" id="co-bank-branch" class="form-input" value="${escHtml(co.bankDetails?.branch||'')}" placeholder="MG Road, Kochi">
              </div>
              <div class="form-group">
                <label class="form-label">Account Type</label>
                <select id="co-bank-type" class="form-select">
                  ${['Current Account','Savings Account','Cash Credit','Overdraft'].map(t=>`<option ${co.bankDetails?.type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">UPI ID (for QR on invoices)</label>
              <input type="text" id="co-upi" class="form-input" value="${escHtml(co.bankDetails?.upi||'')}" placeholder="company@upi">
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">📋 Tax Registration</div></div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">GSTIN</label>
                <input type="text" id="co-gstin" class="form-input" value="${escHtml(co.gstin||'')}" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase;">
              </div>
              <div class="form-group">
                <label class="form-label">GST Registration Type</label>
                <select id="co-gst-type" class="form-select">
                  ${['Regular','Composition Scheme','SEZ Unit','Overseas'].map(t=>`<option ${co.gstType===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">PAN Number</label>
                <input type="text" id="co-pan" class="form-input" value="${escHtml(co.pan||'')}" placeholder="AAAPL1234C" maxlength="10" style="text-transform:uppercase;">
              </div>
              <div class="form-group">
                <label class="form-label">TAN (for TDS)</label>
                <input type="text" id="co-tan" class="form-input" value="${escHtml(co.tan||'')}" placeholder="MUMH12345A" maxlength="10">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">CIN (Company Reg.)</label>
                <input type="text" id="co-cin" class="form-input" value="${escHtml(co.cin||'')}" placeholder="U12345KA2010PTC123456">
              </div>
              <div class="form-group">
                <label class="form-label">MSME Reg. No.</label>
                <input type="text" id="co-msme" class="form-input" value="${escHtml(co.msme||'')}" placeholder="UDYAM-KL-00-0000000">
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label class="form-label">Financial Year Start</label>
                <select id="co-fy" class="form-select">
                  <option value="april" ${co.fyStart==='april'||!co.fyStart?'selected':''}>April (Indian FY: Apr–Mar)</option>
                  <option value="january" ${co.fyStart==='january'?'selected':''}>January (Jan–Dec)</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Default GST Rate (%)</label>
                <select id="co-default-gst" class="form-select">
                  ${[0,5,12,18,28].map(r=>`<option value="${r}" ${Number(co.defaultGst)===r?'selected':''}>${r}% GST</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Transport Service / SAC Code</label>
              <input type="text" id="co-sac" class="form-input" value="${escHtml(co.sacCode||'996511')}" placeholder="996511 — Road Transport">
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 4: BRANCHES -->
      <div class="co-pane" id="copane-branches">
        <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
          <button class="btn btn-primary" onclick="openModal('branch-modal')">+ Add Branch / Location</button>
        </div>
        <div id="branches-list"></div>
      </div>

      <!-- TAB 5: NUMBERING -->
      <div class="co-pane" id="copane-numbering">
        <div class="card">
          <div class="card-header"><div class="card-title">🔢 Document Number Series</div></div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-4);">Configure prefix, starting number and padding for all auto-generated document numbers.</div>
          <div style="display:flex;flex-direction:column;gap:0;">
            ${[
              {key:'invoice',   label:'Sales Invoice',      icon:'🧾', default:'INV-',  ex:'INV-2024-0001'},
              {key:'po',        label:'Purchase Order',      icon:'📋', default:'PO-',   ex:'PO-2024-0001'},
              {key:'grn',       label:'GRN (Goods Receipt)', icon:'📦', default:'GRN-',  ex:'GRN-2024-0001'},
              {key:'trip',      label:'Trip / Consignment',  icon:'🚛', default:'TRIP-', ex:'TRIP-0001'},
              {key:'so',        label:'Sales Order',         icon:'📄', default:'SO-',   ex:'SO-2024-0001'},
              {key:'payslip',   label:'Payslip',             icon:'💰', default:'PAY-',  ex:'PAY-2024-EMP-001'},
              {key:'quotation', label:'Quotation',           icon:'💬', default:'QT-',   ex:'QT-2024-0001'},
              {key:'debit_note',label:'Debit Note',          icon:'📑', default:'DN-',   ex:'DN-2024-0001'},
              {key:'credit_note',label:'Credit Note',        icon:'📑', default:'CN-',   ex:'CN-2024-0001'},
            ].map(s=>`
              <div style="display:grid;grid-template-columns:200px 120px 100px 80px 1fr;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-subtle);">
                <div style="font-size:12px;font-weight:500;">${s.icon} ${s.label}</div>
                <input type="text" class="form-input" id="num-prefix-${s.key}" value="${escHtml((co.numbering?.[s.key]?.prefix)||s.default)}" placeholder="${s.default}" style="font-family:var(--font-mono);font-size:12px;">
                <input type="number" class="form-input" id="num-start-${s.key}" value="${(co.numbering?.[s.key]?.start)||1}" min="1" style="font-family:var(--font-mono);font-size:12px;" placeholder="1">
                <select class="form-select" id="num-pad-${s.key}" style="font-size:12px;">
                  ${[3,4,5,6].map(p=>`<option value="${p}" ${(co.numbering?.[s.key]?.pad||4)===p?'selected':''}>${p} digits</option>`).join('')}
                </select>
                <span style="font-size:10px;color:var(--text-muted);">e.g. ${s.ex}</span>
              </div>`).join('')}
          </div>
          <div style="margin-top:var(--space-3);padding:10px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);font-size:11px;color:var(--text-muted);">
            ℹ️ Changes apply to new documents only. Existing document numbers are not affected.
          </div>
        </div>
      </div>

      <!-- TAB 6: PREFERENCES -->
      <div class="co-pane" id="copane-preferences">
        <div class="grid-2" style="align-items:start;gap:var(--space-5);">
          <div class="card">
            <div class="card-header"><div class="card-title">🌍 Localisation</div></div>
            <div class="form-group">
              <label class="form-label">Default Currency</label>
              <select id="pref-currency" class="form-select">
                ${['INR — ₹ Indian Rupee','USD — $ US Dollar','EUR — € Euro','AED — د.إ Dirham','GBP — £ Pound','SGD — S$ Singapore Dollar']
                  .map(c=>`<option value="${c.split(' ')[0]}" ${co.currency===c.split(' ')[0]?'selected':''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Date Format</label>
              <select id="pref-date" class="form-select">
                ${[['dd-mm-yyyy','DD-MM-YYYY (India Standard)'],['mm-dd-yyyy','MM-DD-YYYY (US)'],['yyyy-mm-dd','YYYY-MM-DD (ISO 8601)']]
                  .map(([v,l])=>`<option value="${v}" ${co.dateFormat===v?'selected':''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Number Format</label>
              <select id="pref-number" class="form-select">
                <option value="indian" ${co.numberFormat==='indian'||!co.numberFormat?'selected':''}>Indian (1,00,000)</option>
                <option value="international" ${co.numberFormat==='international'?'selected':''}>International (100,000)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Time Zone</label>
              <select id="pref-tz" class="form-select">
                <option value="Asia/Kolkata" selected>Asia/Kolkata (IST +5:30)</option>
                <option value="UTC">UTC</option>
                <option value="Asia/Dubai">Asia/Dubai (GST +4)</option>
                <option value="Asia/Singapore">Asia/Singapore (SGT +8)</option>
              </select>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">📄 Invoice Defaults</div></div>
            <div class="form-group">
              <label class="form-label">Default Payment Terms</label>
              <select id="pref-terms" class="form-select">
                ${['Immediate','Net 15','Net 30','Net 45','Net 60','Advance'].map(t=>`<option ${co.defaultPaymentTerms===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Invoice Footer / Terms Text</label>
              <textarea id="pref-invoice-footer" class="form-textarea" rows="3" placeholder="E&OE. Subject to Kottayam jurisdiction. Interest @18% p.a. on overdue amounts.">${escHtml(co.invoiceFooter||'')}</textarea>
            </div>
            <div class="form-group">
              <label class="form-label">Default Invoice Notes</label>
              <textarea id="pref-invoice-notes" class="form-textarea" rows="2" placeholder="Thank you for your business.">${escHtml(co.invoiceNotes||'')}</textarea>
            </div>
            <div class="form-group">
              <label class="form-label">PO Terms & Conditions</label>
              <textarea id="pref-po-terms" class="form-textarea" rows="2" placeholder="Goods once dispatched will not be returned.">${escHtml(co.poTerms||'')}</textarea>
            </div>
          </div>
        </div>
      </div>
    `,
  });

  // Branch modal
  document.getElementById('branch-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildBranchModal());
  setupModalClose();
  _renderBranches();
  _registerGlobals(co);
}

function _planCard(plan) {
  const plans = {
    starter:    { label:'Starter',    price:'₹2,499/yr', users:'5 users',  modules:'Core modules',   color:'var(--brand-primary)' },
    growth:     { label:'Growth',     price:'₹4,999/yr', users:'25 users', modules:'40 modules',     color:'var(--brand-warning)' },
    enterprise: { label:'Enterprise', price:'₹9,999/yr', users:'Unlimited',modules:'All 50+ modules',color:'var(--brand-secondary)' },
  };
  const p = plans[plan]||plans.starter;
  return `<div style="padding:14px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${p.color};">
    <div style="font-size:16px;font-weight:700;color:${p.color};">${p.label}</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${p.users} · ${p.modules}</div>
    <div style="font-family:var(--font-mono);font-size:18px;font-weight:800;color:${p.color};margin-top:6px;">${p.price}</div>
  </div>`;
}

function _buildBranchModal() {
  return `<div class="modal-overlay hidden" id="branch-modal">
    <div class="modal modal-md">
      <div class="modal-header"><div class="modal-title">Add Branch / Location</div><button class="modal-close" onclick="closeModal('branch-modal')">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="br-id">
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Branch Name <span class="required">*</span></label><input type="text" id="br-name" class="form-input" placeholder="Kochi Warehouse"></div>
          <div class="form-group"><label class="form-label">Branch Code</label><input type="text" id="br-code" class="form-input" placeholder="KCH-WH" style="text-transform:uppercase;"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Type</label>
            <select id="br-type" class="form-select">
              ${['Head Office','Branch Office','Warehouse','Factory','Depot','Sales Office','Retail Store'].map(t=>`<option>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label class="form-label">GSTIN (if different)</label><input type="text" id="br-gstin" class="form-input" placeholder="Leave blank if same as HO" maxlength="15" style="text-transform:uppercase;"></div>
        </div>
        <div class="form-group"><label class="form-label">Address <span class="required">*</span></label><textarea id="br-address" class="form-textarea" rows="2" placeholder="Branch address…"></textarea></div>
        <div class="form-grid-3">
          <div class="form-group"><label class="form-label">City</label><input type="text" id="br-city" class="form-input" placeholder="Kochi"></div>
          <div class="form-group"><label class="form-label">State</label><input type="text" id="br-state" class="form-input" placeholder="Kerala"></div>
          <div class="form-group"><label class="form-label">PIN</label><input type="text" id="br-pin" class="form-input" maxlength="6" placeholder="682001"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-group"><label class="form-label">Manager Name</label><input type="text" id="br-manager" class="form-input" placeholder="Rajesh Kumar"></div>
          <div class="form-group"><label class="form-label">Contact Number</label><input type="tel" id="br-phone" class="form-input" placeholder="9876543210"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('branch-modal')">Cancel</button>
        <button class="btn btn-primary" id="br-save-btn" onclick="saveBranch()">Save Branch</button>
      </div>
    </div>
  </div>`;
}

function _renderBranches() {
  const el = document.getElementById('branches-list'); if (!el) return;
  if (!_branches.length) {
    el.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted);">No branches added yet. Click '+ Add Branch' to add your first location.</div>`;
    return;
  }
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--space-4);">
    ${_branches.map(b => `
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="height:3px;background:var(--brand-primary);"></div>
        <div style="padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:14px;font-weight:600;">${escHtml(b.name||'—')}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(b.code||'')} · ${escHtml(b.type||'Branch')}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-secondary btn-sm" onclick="editBranch('${b.id}')">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteBranch('${b.id}')">🗑</button>
            </div>
          </div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px;">
            ${b.address?`<div>📍 ${escHtml([b.address,b.city,b.state].filter(Boolean).join(', '))}</div>`:''}
            ${b.manager?`<div>👤 ${escHtml(b.manager)}</div>`:''}
            ${b.phone?`<div>📞 ${escHtml(b.phone)}</div>`:''}
            ${b.gstin?`<div style="font-family:var(--font-mono);font-size:11px;">GST: ${escHtml(b.gstin)}</div>`:''}
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

function _registerGlobals(co) {
  window.switchCoTab = (tab) => {
    _activeTab = tab;
    document.querySelectorAll('.co-tab').forEach(b=>b.classList.remove('active'));
    document.getElementById(`cotab-${tab}`)?.classList.add('active');
    document.querySelectorAll('.co-pane').forEach(p=>p.classList.remove('active'));
    document.getElementById(`copane-${tab}`)?.classList.add('active');
  };

  // Logo
  window._pickLogo = () => document.getElementById('logo-file-input')?.click();
  window._clearLogo = () => {
    document.getElementById('co-logo').value='';
    document.getElementById('logo-preview').innerHTML='🏢';
  };
  window._onLogoFile = (input) => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('co-logo').value = e.target.result;
      document.getElementById('logo-preview').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:contain;">`;
      document.getElementById('lh-logo-box').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:contain;border-radius:6px;">`;
    };
    reader.readAsDataURL(file);
  };

  // Signature
  window._pickSignature = () => document.getElementById('sig-file-input')?.click();
  window._clearSig = () => { document.getElementById('co-signature').value=''; document.getElementById('sig-preview').innerHTML='Click to upload signature image'; };
  window._onSigFile = (input) => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('co-signature').value = e.target.result;
      document.getElementById('sig-preview').innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:100%;object-fit:contain;">`;
    };
    reader.readAsDataURL(file);
  };

  // Live letterhead preview
  document.getElementById('co-name')?.addEventListener('input', e => {
    const el = document.getElementById('lh-name'); if(el) el.textContent=e.target.value||'Your Company Name';
  });

  // Save everything
  window.saveCompany = async () => {
    if (!validateForm([{id:'co-name',label:'Company Name',required:true}])) { switchCoTab('profile'); return; }
    const btn = document.getElementById('co-save-btn'); setLoading(btn,true);

    const numKeys = ['invoice','po','grn','trip','so','payslip','quotation','debit_note','credit_note'];
    const numbering = {};
    numKeys.forEach(k => {
      numbering[k] = {
        prefix: document.getElementById(`num-prefix-${k}`)?.value || '',
        start:  Number(document.getElementById(`num-start-${k}`)?.value)||1,
        pad:    Number(document.getElementById(`num-pad-${k}`)?.value)||4,
      };
    });

    const data = {
      name:          document.getElementById('co-name')?.value?.trim()||'',
      shortName:     document.getElementById('co-shortname')?.value?.trim()||'',
      industry:      document.getElementById('co-industry')?.value||'',
      businessType:  document.getElementById('co-biz-type')?.value||'',
      phone:         document.getElementById('co-phone')?.value?.trim()||'',
      phone2:        document.getElementById('co-phone2')?.value?.trim()||'',
      email:         document.getElementById('co-email')?.value?.trim()||'',
      website:       document.getElementById('co-website')?.value?.trim()||'',
      address:       document.getElementById('co-address')?.value?.trim()||'',
      city:          document.getElementById('co-city')?.value?.trim()||'',
      state:         document.getElementById('co-state')?.value||'',
      pin:           document.getElementById('co-pin')?.value?.trim()||'',
      founded:       Number(document.getElementById('co-founded')?.value)||0,
      employeeCount: Number(document.getElementById('co-emp-count')?.value)||0,
      logo:          document.getElementById('co-logo')?.value || co.logo || '',
      signature:     document.getElementById('co-signature')?.value || co.signature || '',
      signatory:     document.getElementById('co-signatory')?.value?.trim()||'',
      signatoryDesig:document.getElementById('co-signatory-desig')?.value?.trim()||'',
      primaryColor:  document.getElementById('co-primary-color')?.value||'#0a84ff',
      accentColor:   document.getElementById('co-accent-color')?.value||'#1e3a5f',
      bankDetails: {
        bankName:      document.getElementById('co-bank-name')?.value?.trim()||'',
        accountHolder: document.getElementById('co-bank-holder')?.value?.trim()||'',
        accountNumber: document.getElementById('co-bank-acc')?.value?.trim()||'',
        ifsc:          (document.getElementById('co-bank-ifsc')?.value||'').toUpperCase(),
        branch:        document.getElementById('co-bank-branch')?.value?.trim()||'',
        type:          document.getElementById('co-bank-type')?.value||'Current Account',
        upi:           document.getElementById('co-upi')?.value?.trim()||'',
      },
      gstin:          (document.getElementById('co-gstin')?.value||'').toUpperCase(),
      gstType:        document.getElementById('co-gst-type')?.value||'Regular',
      pan:            (document.getElementById('co-pan')?.value||'').toUpperCase(),
      tan:            (document.getElementById('co-tan')?.value||'').toUpperCase(),
      cin:            document.getElementById('co-cin')?.value?.trim()||'',
      msme:           document.getElementById('co-msme')?.value?.trim()||'',
      fyStart:        document.getElementById('co-fy')?.value||'april',
      defaultGst:     Number(document.getElementById('co-default-gst')?.value)||18,
      sacCode:        document.getElementById('co-sac')?.value?.trim()||'996511',
      numbering,
      currency:       document.getElementById('pref-currency')?.value||'INR',
      dateFormat:     document.getElementById('pref-date')?.value||'dd-mm-yyyy',
      numberFormat:   document.getElementById('pref-number')?.value||'indian',
      timeZone:       document.getElementById('pref-tz')?.value||'Asia/Kolkata',
      defaultPaymentTerms: document.getElementById('pref-terms')?.value||'Net 30',
      invoiceFooter:  document.getElementById('pref-invoice-footer')?.value?.trim()||'',
      invoiceNotes:   document.getElementById('pref-invoice-notes')?.value?.trim()||'',
      poTerms:        document.getElementById('pref-po-terms')?.value?.trim()||'',
    };

    try {
      await dbSet(COLLECTIONS.COMPANIES, AuthState.company?.id, data);
      AuthState.company = {...AuthState.company, ...data};
      Toast.success('Saved', 'All company settings saved successfully.');
    } catch(e) { Toast.error('Failed', e.message); }
    finally    { setLoading(btn,false); }
  };

  // Branch CRUD
  window.saveBranch = async () => {
    const name = document.getElementById('br-name')?.value?.trim();
    if (!name) { Toast.warning('Missing','Branch name is required.'); return; }
    const btn = document.getElementById('br-save-btn'); setLoading(btn,true);
    const id  = document.getElementById('br-id')?.value;
    const data = {
      name, code:    (document.getElementById('br-code')?.value||'').toUpperCase(),
      type:   document.getElementById('br-type')?.value||'Branch Office',
      gstin:  (document.getElementById('br-gstin')?.value||'').toUpperCase(),
      address:document.getElementById('br-address')?.value?.trim()||'',
      city:   document.getElementById('br-city')?.value?.trim()||'',
      state:  document.getElementById('br-state')?.value?.trim()||'',
      pin:    document.getElementById('br-pin')?.value?.trim()||'',
      manager:document.getElementById('br-manager')?.value?.trim()||'',
      phone:  document.getElementById('br-phone')?.value?.trim()||'',
      companyId: AuthState.company?.id||null,
    };
    try {
      if (id) { await dbUpdate('company_branches',id,data); }
      else    { const newB = await dbCreate('company_branches',data); _branches.push({...data,id:newB.id||genId()}); }
      if (id) { const idx=_branches.findIndex(b=>b.id===id); if(idx>=0) _branches[idx]={...data,id}; }
      Toast.success('Saved','Branch saved.');
      closeModal('branch-modal');
      _renderBranches();
    } catch(e) { Toast.error('Failed',e.message); }
    finally    { setLoading(btn,false); }
  };

  window.editBranch = (id) => {
    const b = _branches.find(x=>x.id===id); if(!b) return;
    document.getElementById('br-id').value=b.id;
    document.getElementById('br-name').value=b.name||'';
    document.getElementById('br-code').value=b.code||'';
    document.getElementById('br-type').value=b.type||'Branch Office';
    document.getElementById('br-gstin').value=b.gstin||'';
    document.getElementById('br-address').value=b.address||'';
    document.getElementById('br-city').value=b.city||'';
    document.getElementById('br-state').value=b.state||'';
    document.getElementById('br-pin').value=b.pin||'';
    document.getElementById('br-manager').value=b.manager||'';
    document.getElementById('br-phone').value=b.phone||'';
    openModal('branch-modal');
  };

  window.deleteBranch = async (id) => {
    if (!confirm('Delete this branch?')) return;
    try {
      await dbDelete('company_branches',id);
      _branches = _branches.filter(b=>b.id!==id);
      _renderBranches();
      Toast.success('Deleted','Branch removed.');
    } catch(e) { Toast.error('Failed',e.message); }
  };
}
