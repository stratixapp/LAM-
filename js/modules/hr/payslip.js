// ============================================================
// LAM — Payslip PDF Generator
// Professional Indian payslip with PF/ESI/TDS breakdown,
// CTC structure, YTD summary, printable / downloadable PDF
// Interconnects: HR → Payroll → Employees → Finance
// ============================================================

import { dbCreate, dbUpdate, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { HR_COLLECTIONS } from './advanced.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, formatCurrency, formatNumber
} from '../../core/utils.js';
import { pageShell, buildModal, validateForm, openModal, closeModal, setupModalClose } from '../_shared.js';

export async function renderPayslipGenerator(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  const [employees, payrollRuns] = await Promise.all([
    dbGetAll(COLLECTIONS.EMPLOYEES,   [...c]),
    dbGetAll(HR_COLLECTIONS.PAYROLL,  [...c, orderBy('month','desc')]),
  ]);

  container.innerHTML = pageShell({
    title: '🧾 Payslip Generator',
    subtitle: 'Generate professional payslips with full statutory deduction breakdown.',
    actions: `<button class="btn btn-primary" onclick="document.getElementById('ps-emp') && document.getElementById('ps-emp').focus(); document.querySelector('.card')?.scrollIntoView({behavior:'smooth'})">↓ Generate Payslip</button>`,
    content: `
      <!-- Quick stats -->
      <div class="grid-4" style="margin-bottom:var(--space-5);">
        ${[
          {label:'Total Employees',     value:employees.length,       icon:'👥', color:'kpi-blue'},
          {label:'Payroll Runs',        value:payrollRuns.length,     icon:'💰', color:'kpi-green'},
          {label:'Latest Month',        value:payrollRuns[0]?.month||'—', icon:'📅', color:'kpi-orange'},
          {label:'Total Net Paid',      value: payrollRuns.length ? formatCurrency(payrollRuns.reduce((s,r)=>s+(Number(r.totalNet)||0),0),true) : 'Run Payroll →', icon:'💳', color:'kpi-blue'},
        ].map((k,i)=>`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
      </div>

      <!-- Payslip selector -->
      <div class="card">
        <div class="card-header"><div class="card-title">📋 Generate Payslip</div></div>
        <div class="grid-3" style="gap:var(--space-3);padding:var(--space-4);">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Employee</label>
            <select id="ps-emp" class="form-select" onchange="previewPayslip()">
              <option value="">Select employee…</option>
              ${employees.map(e=>`<option value="${e.id}">${escHtml(e.name||'—')} — ${escHtml(e.department||e.role||'—')}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Month</label>
            <select id="ps-month" class="form-select" onchange="previewPayslip()">
              ${Array.from({length:12},(_,i)=>{const d=new Date();d.setMonth(d.getMonth()-i);const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;return `<option value="${val}">${d.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</option>`;}).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;display:flex;align-items:flex-end;">
            <button class="btn btn-primary" style="width:100%;" onclick="previewPayslip()">👁 Preview Payslip</button>
          </div>
        </div>
      </div>

      <!-- Payslip Preview -->
      <div id="payslip-preview" style="margin-top:var(--space-5);"></div>
    `,
  });

  setupModalClose();

  window.previewPayslip = async () => {
    const empId = document.getElementById('ps-emp')?.value;
    const month = document.getElementById('ps-month')?.value;
    if (!empId || !month) return;

    const emp = employees.find(e=>e.id===empId);
    if (!emp) return;

    // Find payroll run for this month
    const run = payrollRuns.find(r=>r.month===month);
    const slip = run?.slips?.find(s=>s.employeeId===empId);

    // Calculate salary components
    const basic     = Number(emp.salary)||0;
    const hra       = Math.round(basic * 0.40);       // 40% of basic
    const convAllow = 1600;                             // Standard ₹1,600
    const medAllow  = 1250;                             // Standard ₹1,250
    const specAllow = Math.max(0, basic - hra - convAllow - medAllow);
    const grossSalary = basic + hra + convAllow + medAllow + specAllow;

    // Deductions
    const pfEmployee   = Math.round(basic * 0.12);     // 12% of basic, max ₹15,000 basic
    const pfEmployer   = Math.round(basic * 0.12);
    const esiEmployee  = basic <= 21000 ? Math.round(grossSalary * 0.0075) : 0;
    const esiEmployer  = basic <= 21000 ? Math.round(grossSalary * 0.0325) : 0;
    const tds          = basic > 50000 ? Math.round((basic-50000)*0.1/12) : 0;
    const pt           = getProfTax(grossSalary);       // State professional tax
    const totalDeductions = pfEmployee + esiEmployee + tds + pt;
    const netPay       = grossSalary - totalDeductions;

    // CTC
    const ctc = grossSalary + pfEmployer + esiEmployer;

    // Days calculation
    const [year, mo] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mo, 0).getDate();
    const paidDays = slip ? (slip.paidDays || daysInMonth) : daysInMonth;
    const lopDays  = daysInMonth - paidDays;

    const company = AuthState.company || {};
    const previewEl = document.getElementById('payslip-preview');

    previewEl.innerHTML = `
      <div class="card" style="max-width:800px;margin:0 auto;">
        <div class="card-header" style="display:flex;justify-content:space-between;">
          <div class="card-title">Payslip Preview</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="printPayslip('${empId}','${month}')">🖨️ Print</button>
            <button class="btn btn-primary btn-sm" onclick="downloadPayslipPDF('${empId}','${month}')">⬇ Download PDF</button>
            <button class="btn btn-secondary btn-sm" onclick="emailPayslip('${empId}','${month}')">✉️ Email</button>
          </div>
        </div>

        <!-- Payslip HTML (printable) -->
        <div id="payslip-content-${empId}-${month}" style="padding:var(--space-4);">
          ${buildPayslipHTML({emp, month, year, mo, basic, hra, convAllow, medAllow, specAllow, grossSalary, pfEmployee, pfEmployer, esiEmployee, esiEmployer, tds, pt, totalDeductions, netPay, ctc, daysInMonth, paidDays, lopDays, company})}
        </div>
      </div>
    `;

    previewEl.scrollIntoView({behavior:'smooth'});
  };

  window.printPayslip = (empId, month) => {
    const content = document.getElementById(`payslip-content-${empId}-${month}`);
    if (!content) return;
    const win = window.open('', '_blank');
    win.document.write(`
      <html><head><title>Payslip</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:Arial,sans-serif;font-size:12px;color:#000;background:#fff;}
        .payslip{max-width:800px;margin:0 auto;padding:24px;}
        table{width:100%;border-collapse:collapse;}
        td,th{border:1px solid #ccc;padding:6px 10px;font-size:11px;}
        th{background:#f5f5f5;font-weight:700;text-align:left;}
        .header{background:#1a1a2e;color:#fff;padding:16px;margin-bottom:16px;border-radius:4px;}
        .section-title{background:#e8f0fe;font-weight:700;padding:6px 10px;font-size:12px;border:1px solid #ccc;}
        .total-row{background:#f0f0f0;font-weight:700;}
        .net-pay{background:#1a7f5a;color:#fff;font-size:14px;font-weight:800;padding:10px;text-align:center;margin-top:12px;border-radius:4px;}
        @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}}
      </style></head><body>
      <div class="payslip">${content.innerHTML}</div>
      <script>window.print();</script>
      </body></html>`);
    win.document.close();
  };

  window.downloadPayslipPDF = (empId, month) => {
    const btn = document.querySelector(`[onclick*="downloadPayslipPDF('${empId}','${month}')"]`);
    if (btn) setLoading(btn, true);

    // Works with OR without a payroll run — calculates from employee record
    const emp = employees.find(e => e.id === empId);
    if (!emp) { Toast.error('Not Found', 'Employee not found.'); if (btn) setLoading(btn, false); return; }

    const run   = payrollRuns.find(r => r.month === month);
    const slip  = run?.slips?.find(s => s.employeeId === empId);
    const co    = AuthState.company || {};
    const mo    = parseInt(month.split('-')[1]);
    const yr    = parseInt(month.split('-')[0]);

    // Prefer payroll-run values, fall back to employee record
    const basic     = Number(slip?.basic || emp.salary || 0);
    const hra       = Number(slip?.hra   || emp.hra   || Math.round(basic * 0.4));
    const conv      = Number(slip?.convAllowance  || emp.convAllowance  || 1600);
    const med       = Number(slip?.medAllowance   || emp.medAllowance   || 1250);
    const special   = Number(slip?.specialAllowance || emp.specialAllowance || 0);
    const lopDed    = Number(slip?.lopDeduction || 0);
    const otPay     = Number(slip?.otPay || 0);
    const gross     = basic + hra + conv + med + special - lopDed + otPay;
    const pf        = Math.round(basic * 0.12);
    const esi       = basic <= 21000 ? Math.round(gross * 0.0075) : 0;
    const pt        = getProfTax(gross);
    const tds       = Number(slip?.tds || (basic > 50000 ? Math.round((basic-50000)*0.1/12) : 0));
    const netPay    = Math.max(0, gross - pf - esi - pt - tds);
    const pfEr      = Math.round(basic * 0.12);
    const esiEr     = basic <= 21000 ? Math.round(gross * 0.0325) : 0;
    const daysInMo  = new Date(yr, mo, 0).getDate();
    const paidDays  = slip?.paidDays || daysInMo - (slip?.lopDays || 0);

    // If LAMPDF engine available, use it
    if (window.LAMPDF) {
      window.LAMPDF.payslip({
        emp, company: co, month: mo, year: yr,
        gross, deductions: pf + esi + pt + tds, net: netPay,
        paidDays,
        breakdown: [
          { earnLabel:'Basic Salary',          earnAmt: basic,   dedLabel:'PF (Employee 12%)',  dedAmt: pf  },
          { earnLabel:'House Rent Allowance',  earnAmt: hra,     dedLabel:'ESI (Emp 0.75%)',    dedAmt: esi },
          { earnLabel:'Conveyance Allowance',  earnAmt: conv,    dedLabel:'Professional Tax',   dedAmt: pt  },
          { earnLabel:'Medical Allowance',     earnAmt: med,     dedLabel:'TDS (Income Tax)',   dedAmt: tds },
          { earnLabel:'Special Allowance',     earnAmt: special, dedLabel:'',                   dedAmt: 0   },
        ],
      });
      if (btn) setLoading(btn, false);
      return;
    }

    // Fallback: Print-to-PDF using the preview HTML
    const content = document.getElementById(`payslip-content-${empId}-${month}`);
    if (!content) {
      Toast.info('Preview first', 'Please click Preview Payslip first, then download.');
      if (btn) setLoading(btn, false);
      return;
    }
    const win = window.open('', '_blank');
    if (!win) { Toast.error('Blocked', 'Allow popups for this site to download PDF.'); if (btn) setLoading(btn, false); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Payslip — ${emp.name} — ${month}</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:Arial,sans-serif;font-size:12px;color:#000;background:#fff;}
        .payslip{max-width:800px;margin:0 auto;padding:24px;}
        table{width:100%;border-collapse:collapse;}
        td,th{border:1px solid #ccc;padding:6px 10px;font-size:11px;}
        th{background:#f5f5f5;font-weight:700;text-align:left;}
        @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}}
      </style></head><body>
      <div class="payslip">${content.innerHTML}</div>
      <script>setTimeout(()=>{ window.print(); }, 400);<\/script>
      </body></html>`);
    win.document.close();
    Toast.success('Opening PDF', 'Print dialog opened — save as PDF.');
    if (btn) setLoading(btn, false);
  };

  window.emailPayslip = (empId, month) => {
    const emp = employees.find(e=>e.id===empId);
    const emp2 = employees.find(e=>e.id===empId);
    if (emp2?.email) {
      const subject = encodeURIComponent(`Payslip for ${month} — ${emp2.name}`);
      const body    = encodeURIComponent(`Dear ${emp2.name},\n\nPlease find attached your payslip for the month of ${month}.\n\nFor queries, contact HR.\n\nRegards,\n${AuthState.profile?.name||'HR Team'}`);
      window.open(`mailto:${emp2.email}?subject=${subject}&body=${body}`,'_blank');
      Toast.info('Email Client','Opening email client with pre-filled payslip email.');
    } else {
      Toast.warning('No Email','This employee has no email address on record.');
    }
  };
}

function getProfTax(grossSalary) {
  // Kerala professional tax slabs (₹200/month max)
  if (grossSalary > 20000) return 200;
  if (grossSalary > 15000) return 150;
  if (grossSalary > 10000) return 110;
  if (grossSalary > 7500)  return 75;
  return 0;
}

function buildPayslipHTML(data) {
  const {emp, month, year, mo, basic, hra, convAllow, medAllow, specAllow,
         grossSalary, pfEmployee, pfEmployer, esiEmployee, esiEmployer,
         tds, pt, totalDeductions, netPay, ctc, daysInMonth, paidDays, lopDays, company} = data;

  const monthLabel = new Date(year, mo-1, 1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  return `
    <!-- Payslip Header -->
    <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:20px 24px;border-radius:8px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-size:20px;font-weight:800;letter-spacing:0.5px;">${escHtml(company.name||'Company Name')}</div>
          <div style="font-size:11px;opacity:0.7;margin-top:2px;">${escHtml(company.address||'')}</div>
          ${company.gstin?`<div style="font-size:11px;opacity:0.7;">GSTIN: ${escHtml(company.gstin)}</div>`:''}
        </div>
        <div style="text-align:right;">
          <div style="font-size:16px;font-weight:700;opacity:0.9;">PAYSLIP</div>
          <div style="font-size:12px;opacity:0.7;">${monthLabel}</div>
        </div>
      </div>
    </div>

    <!-- Employee Details -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px;border:1px solid #ddd;">
      <tr style="background:#f8f9fa;">
        <td colspan="4" style="padding:8px 12px;font-weight:700;font-size:13px;color:#333;border-bottom:2px solid #dee2e6;">Employee Information</td>
      </tr>
      ${[
        ['Employee Name', emp.name||'—',                          'Employee ID',   emp.empId||emp.id?.slice(0,8)||'—'],
        ['Designation',   emp.designation||emp.role||'—',         'Department',    emp.department||'—'],
        ['Date of Join',  emp.joiningDate||'—',                   'Location',      emp.workLocation||company.city||'—'],
        ['Bank Account',  emp.bankDetails?.accountNumber||'—',    'Bank / IFSC',   (emp.bankDetails?.bankName||'—')+(emp.bankDetails?.ifsc?' / '+emp.bankDetails.ifsc:'')],
        ['PAN',           emp.govIds?.pan||'—',                   'UAN (PF)',      emp.govIds?.pfUan||'—'],
        ['Month',         monthLabel,              'Pay Date',      new Date().toLocaleDateString('en-IN')],
      ].map(([l1,v1,l2,v2])=>`
        <tr>
          <td style="padding:6px 12px;color:#666;font-size:11px;border:1px solid #eee;width:20%;">${l1}</td>
          <td style="padding:6px 12px;font-weight:600;border:1px solid #eee;width:30%;">${escHtml(String(v1||'—'))}</td>
          <td style="padding:6px 12px;color:#666;font-size:11px;border:1px solid #eee;width:20%;">${l2}</td>
          <td style="padding:6px 12px;font-weight:600;border:1px solid #eee;width:30%;">${escHtml(String(v2||'—'))}</td>
        </tr>`).join('')}
      <tr style="background:#fff3cd;">
        <td style="padding:6px 12px;color:#666;font-size:11px;border:1px solid #eee;">Working Days</td>
        <td style="padding:6px 12px;font-weight:700;border:1px solid #eee;">${daysInMonth}</td>
        <td style="padding:6px 12px;color:#666;font-size:11px;border:1px solid #eee;">Days Paid</td>
        <td style="padding:6px 12px;font-weight:700;color:${lopDays>0?'#dc3545':'#198754'};border:1px solid #eee;">${paidDays} ${lopDays>0?`(LOP: ${lopDays}d)`:''}</td>
      </tr>
    </table>

    <!-- Earnings & Deductions -->
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr>
        <th style="background:#1a7f5a;color:#fff;padding:8px 12px;border:1px solid #ccc;width:40%;">Earnings</th>
        <th style="background:#1a7f5a;color:#fff;padding:8px 12px;text-align:right;border:1px solid #ccc;width:10%;">Rate</th>
        <th style="background:#1a7f5a;color:#fff;padding:8px 12px;text-align:right;border:1px solid #ccc;width:15%;">Amount (₹)</th>
        <th style="background:#c0392b;color:#fff;padding:8px 12px;border:1px solid #ccc;width:25%;">Deductions</th>
        <th style="background:#c0392b;color:#fff;padding:8px 12px;text-align:right;border:1px solid #ccc;width:10%;">Amount (₹)</th>
      </tr>

      <!-- Earnings rows -->
      ${[
        ['Basic Salary',               basic],
        ['House Rent Allowance (HRA)',  hra],
        ['Conveyance Allowance',        convAllow],
        ['Medical Allowance',           medAllow],
        ['Special Allowance',           specAllow],
      ].map((earn, i) => {
        const ded = [
          ['Provident Fund (PF)',      pfEmployee],
          ['ESI (Employee Share)',     esiEmployee],
          ['TDS (Income Tax)',         tds],
          ['Professional Tax',        pt],
        ][i];
        return `
          <tr style="background:${i%2===0?'#fff':'#f9f9f9'};">
            <td style="padding:7px 12px;border:1px solid #eee;">${earn[0]}</td>
            <td style="padding:7px 12px;text-align:right;border:1px solid #eee;font-size:10px;color:#999;">${i===0?'Monthly':'—'}</td>
            <td style="padding:7px 12px;text-align:right;border:1px solid #eee;font-weight:600;">₹${earn[1].toLocaleString('en-IN')}</td>
            <td style="padding:7px 12px;border:1px solid #eee;">${ded?ded[0]:'—'}</td>
            <td style="padding:7px 12px;text-align:right;border:1px solid #eee;font-weight:600;color:#c0392b;">${ded&&ded[1]>0?'₹'+ded[1].toLocaleString('en-IN'):'—'}</td>
          </tr>`;
      }).join('')}

      <!-- Totals -->
      <tr style="background:#e8f5e9;font-weight:800;border-top:2px solid #1a7f5a;">
        <td colspan="2" style="padding:9px 12px;border:1px solid #ccc;color:#1a7f5a;font-size:13px;">GROSS SALARY</td>
        <td style="padding:9px 12px;text-align:right;border:1px solid #ccc;color:#1a7f5a;font-size:13px;">₹${grossSalary.toLocaleString('en-IN')}</td>
        <td style="padding:9px 12px;border:1px solid #ccc;color:#c0392b;font-size:13px;">TOTAL DEDUCTIONS</td>
        <td style="padding:9px 12px;text-align:right;border:1px solid #ccc;color:#c0392b;font-size:13px;">₹${totalDeductions.toLocaleString('en-IN')}</td>
      </tr>
    </table>

    <!-- Net Pay Banner -->
    <div style="background:linear-gradient(135deg,#1a7f5a,#16a085);color:#fff;padding:16px 24px;margin-top:16px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:11px;opacity:0.8;text-transform:uppercase;letter-spacing:0.5px;">Net Salary Payable for ${monthLabel}</div>
        <div style="font-size:22px;font-weight:800;margin-top:2px;">₹${netPay.toLocaleString('en-IN')}</div>
        <div style="font-size:10px;opacity:0.7;margin-top:2px;">${numberToWords(netPay)} Rupees Only</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;opacity:0.8;">CTC (Annual)</div>
        <div style="font-size:16px;font-weight:700;">₹${(ctc*12).toLocaleString('en-IN')}</div>
        <div style="font-size:10px;opacity:0.7;">Monthly CTC: ₹${ctc.toLocaleString('en-IN')}</div>
      </div>
    </div>

    <!-- Employer Contributions -->
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:16px;">
      <tr style="background:#f0f4ff;">
        <td colspan="4" style="padding:7px 12px;font-weight:700;border:1px solid #ddd;color:#333;">Employer Contributions (Not deducted from salary)</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;border:1px solid #eee;color:#666;">PF (Employer Share)</td>
        <td style="padding:6px 12px;border:1px solid #eee;font-weight:600;">₹${pfEmployer.toLocaleString('en-IN')}</td>
        <td style="padding:6px 12px;border:1px solid #eee;color:#666;">ESI (Employer Share)</td>
        <td style="padding:6px 12px;border:1px solid #eee;font-weight:600;">₹${esiEmployer.toLocaleString('en-IN')}</td>
      </tr>
    </table>

    <!-- YTD Summary -->
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:12px;">
      <tr style="background:#fff3cd;">
        <td colspan="6" style="padding:7px 12px;font-weight:700;border:1px solid #ddd;color:#333;">Year-to-Date (YTD) Summary — April to ${new Date(year,mo-1,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</td>
      </tr>
      <tr>
        ${[['YTD Gross','₹'+((grossSalary)*mo).toLocaleString('en-IN')],['YTD PF','₹'+(pfEmployee*mo).toLocaleString('en-IN')],['YTD TDS','₹'+(tds*mo).toLocaleString('en-IN')],['YTD Net','₹'+(netPay*mo).toLocaleString('en-IN')]].map(([l,v])=>`<td style="padding:7px 12px;border:1px solid #eee;color:#666;font-size:10px;">${l}</td><td style="padding:7px 12px;border:1px solid #eee;font-weight:700;">${v}</td>`).join('')}
      </tr>
    </table>

    <!-- Footer -->
    <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:flex-end;">
      <div style="font-size:10px;color:#999;">
        <div>This is a computer-generated payslip and does not require signature.</div>
        <div>For queries contact: HR Department</div>
      </div>
      <div style="text-align:center;">
        <div style="border-top:1px solid #ccc;padding-top:6px;width:180px;font-size:10px;color:#666;">Authorized Signatory</div>
      </div>
    </div>
  `;
}

// Number to words (Indian format)
function numberToWords(num) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  if (num === 0) return 'Zero';
  if (num < 0) return 'Minus ' + numberToWords(-num);
  let result = '';
  if (num >= 10000000) { result += numberToWords(Math.floor(num/10000000)) + ' Crore '; num %= 10000000; }
  if (num >= 100000)   { result += numberToWords(Math.floor(num/100000)) + ' Lakh '; num %= 100000; }
  if (num >= 1000)     { result += numberToWords(Math.floor(num/1000)) + ' Thousand '; num %= 1000; }
  if (num >= 100)      { result += ones[Math.floor(num/100)] + ' Hundred '; num %= 100; }
  if (num >= 20)       { result += tens[Math.floor(num/10)] + ' '; num %= 10; }
  if (num > 0)         { result += ones[num] + ' '; }
  return result.trim();
}
