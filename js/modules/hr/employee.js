// ============================================================
// LAM — Employee Management Module (HR) — DEEP v2
// Full employee lifecycle: profile, salary, bank, docs, photo
// Emergency contact, skills, shift, contract type, ID proofs
// Interconnects: HR Advanced → Payroll → Finance → Audit
// ============================================================

import {
  dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll,
  COLLECTIONS, where, orderBy,
} from '../../core/firebase.js';
import { AuthState }   from '../../core/auth.js';
import { Toast }        from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter, debounce,
  getInitials, formatCurrency, genId,
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  avatarCell, badge, actionsMenu, buildPagination,
  validateForm, openModal, closeModal,
  setupModalClose, setupMenuClose,
} from '../_shared.js';
import { ROLES, ROLE_LABELS } from '../../core/auth.js';

// ── State ─────────────────────────────────────────────────────
let _employees = [];
let _filtered  = [];
let _page      = 1;
const PER_PAGE  = 15;
let _unsub     = null;
let _viewMode  = 'table';   // 'table' | 'grid'
let _activeTab = 'profile'; // modal tab

// ── Departments master list (editable by admin) ───────────────
const DEPARTMENTS = [
  'Warehouse','Transport','Finance','HR','Admin',
  'Operations','Sales','Customer Support','IT','Management',
];

// ── Employment types ──────────────────────────────────────────
const EMP_TYPES = {
  full_time:   'Full Time',
  part_time:   'Part Time',
  contract:    'Contract',
  intern:      'Intern',
  consultant:  'Consultant',
  probation:   'Probation',
};

// ── Shift options ─────────────────────────────────────────────
const SHIFTS = {
  general:  'General (9–6)',
  morning:  'Morning (6–2)',
  afternoon:'Afternoon (2–10)',
  night:    'Night (10–6)',
  flexible: 'Flexible',
};

// ── Blood groups ──────────────────────────────────────────────
const BLOOD_GROUPS = ['A+','A−','B+','B−','AB+','AB−','O+','O−'];

// ─────────────────────────────────────────────────────────────
export async function renderEmployees(container) {
  container.innerHTML = pageShell({
    title: '👥 Employees',
    subtitle: 'Complete workforce management — profiles, salary, documents and more.',
    actions: `
      <button class="btn btn-secondary btn-sm" id="emp-view-toggle" onclick="toggleEmpView()" title="Switch view">⊞ Grid</button>
      <button class="btn btn-secondary btn-sm" onclick="exportEmployees()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openEmpModal()">+ Add Employee</button>
    `,
    content: `
      <!-- KPI strip -->
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="emp-kpis"></div>

      <!-- Department quick-filter chips -->
      <div id="emp-dept-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--space-4);"></div>

      ${searchBar({
        id: 'employees',
        placeholder: 'Search name, email, phone, designation, department…',
        filters: [
          { key:'role',       label:'All Roles',    options: Object.entries(ROLE_LABELS).map(([v,l])=>({value:v,label:l})) },
          { key:'status',     label:'All Status',   options: [{value:'active',label:'Active'},{value:'inactive',label:'Inactive'},{value:'on_leave',label:'On Leave'}] },
          { key:'empType',    label:'All Types',    options: Object.entries(EMP_TYPES).map(([v,l])=>({value:v,label:l})) },
          { key:'department', label:'All Depts',    options: DEPARTMENTS.map(d=>({value:d,label:d})) },
        ],
        onSearch: 'employeeSearch',
        onFilter: 'employeeFilter',
      })}

      <div id="employees-list-wrap"></div>
      <div id="employees-pagination"></div>
    `,
  });

  // Inject modal (once)
  document.getElementById('employee-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildEmpModal());
  document.getElementById('emp-view-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildViewModal());

  setupModalClose();
  setupMenuClose();
  _registerGlobals();

  // Live listener
  if (_unsub) _unsub();
  const cid = AuthState.company?.id;
  const q   = cid ? [where('companyId','==',cid), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen(COLLECTIONS.EMPLOYEES, q, data => {
    _employees = data;
    _filtered  = [...data];
    _page = 1;
    _renderKPIs();
    _renderDeptChips();
    _renderList();
  });
}

// ─────────────────────────────────────────────────────────────
// KPI STRIP
// ─────────────────────────────────────────────────────────────
function _renderKPIs() {
  const el = document.getElementById('emp-kpis');
  if (!el) return;
  const total    = _employees.length;
  const active   = _employees.filter(e => (e.status||'active') === 'active').length;
  const onLeave  = _employees.filter(e => e.status === 'on_leave').length;
  const monthly  = _employees.reduce((s,e) => s + (Number(e.salary)||0), 0);
  [
    { label:'Total',        value: total,                       icon:'👥', color:'kpi-blue'   },
    { label:'Active',       value: active,                      icon:'✅', color:'kpi-green'  },
    { label:'On Leave',     value: onLeave,                     icon:'🏖', color:'kpi-yellow' },
    { label:'Monthly Payroll', value: formatCurrency(monthly,true), icon:'💰', color:'kpi-orange' },
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
      <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
    </div>`;
  });
}

// ─────────────────────────────────────────────────────────────
// DEPARTMENT CHIPS
// ─────────────────────────────────────────────────────────────
let _activeDeptChip = '';
function _renderDeptChips() {
  const el = document.getElementById('emp-dept-chips');
  if (!el) return;
  const depts = [...new Set(_employees.map(e => e.department).filter(Boolean))].sort();
  el.innerHTML = `
    <button class="btn btn-sm ${!_activeDeptChip?'btn-primary':'btn-secondary'}" 
      onclick="filterByDept('')" style="border-radius:999px;font-size:11px;">All (${_employees.length})</button>
    ${depts.map(d => {
      const cnt = _employees.filter(e=>e.department===d).length;
      const active = _activeDeptChip===d;
      return `<button class="btn btn-sm ${active?'btn-primary':'btn-secondary'}"
        onclick="filterByDept('${escHtml(d)}')"
        style="border-radius:999px;font-size:11px;">${escHtml(d)} (${cnt})</button>`;
    }).join('')}
  `;
}

// ─────────────────────────────────────────────────────────────
// LIST RENDERER (table or grid)
// ─────────────────────────────────────────────────────────────
function _renderList() {
  const start    = (_page-1)*PER_PAGE;
  const pageData = _filtered.slice(start, start+PER_PAGE);
  const wrap     = document.getElementById('employees-list-wrap');
  const pg       = document.getElementById('employees-pagination');
  if (!wrap) return;

  const cnt = document.getElementById('employees-count');
  if (cnt) cnt.textContent = `${_filtered.length} employee${_filtered.length!==1?'s':''}`;

  if (_viewMode === 'grid') {
    _renderGrid(wrap, pageData);
  } else {
    _renderTable(wrap, pageData);
  }

  if (pg) pg.innerHTML = buildPagination({
    id:'employees', total:_filtered.length,
    page:_page, perPage:PER_PAGE, onChange:'setEmpPage',
  });
}

function _renderTable(wrap, rows) {
  wrap.innerHTML = buildTable({
    id: 'employees-table',
    columns: [
      { key:'name',        label:'Employee',    render: r => _empCell(r) },
      { key:'designation', label:'Designation', render: r => `<span style="font-size:12px;color:var(--text-secondary);">${escHtml(r.designation||'—')}</span>` },
      { key:'department',  label:'Dept',        render: r => r.department?`<span class="badge badge-blue">${escHtml(r.department)}</span>`:'—' },
      { key:'empType',     label:'Type',        render: r => r.empType?badge(r.empType, EMP_TYPES[r.empType]||r.empType):'—' },
      { key:'phone',       label:'Phone',       render: r => `<span style="font-family:var(--font-mono);font-size:12px;">${escHtml(r.phone||'—')}</span>` },
      { key:'salary',      label:'Salary',      render: r => r.salary?`<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.salary).toLocaleString('en-IN')}</span>`:'—' },
      { key:'shift',       label:'Shift',       render: r => r.shift?`<span style="font-size:11px;color:var(--text-muted);">${SHIFTS[r.shift]||r.shift}</span>`:'—' },
      { key:'status',      label:'Status',      render: r => badge(r.status||'active') },
      { key:'joiningDate', label:'Joined',      render: r => `<span style="color:var(--text-muted);font-size:12px;">${r.joiningDate?formatDate(r.joiningDate):'—'}</span>` },
      { key:'actions', label:'', sortable:false, render: r => actionsMenu(r.id,[
          { icon:'👁', label:'View Profile', action:`viewEmployee('${r.id}')` },
          { icon:'✏️', label:'Edit',          action:`editEmployee('${r.id}')` },
          { icon:'💰', label:'Salary Details',action:`viewSalary('${r.id}')` },
          { icon:'🗑', label:'Delete',         action:`deleteEmployee('${r.id}')`, danger:true },
        ]),
      },
    ],
    rows: pageData,
    emptyMsg: 'No employees yet — add your first team member',
  });
}

function _renderGrid(wrap, rows) {
  if (!rows.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted);">No employees found.</div>`;
    return;
  }
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--space-4);">
    ${rows.map(r => `
      <div class="card" style="cursor:pointer;transition:transform 0.15s;padding:0;overflow:hidden;" 
        onmouseenter="this.style.transform='translateY(-2px)'"
        onmouseleave="this.style.transform=''"
        onclick="viewEmployee('${r.id}')">
        <div style="background:linear-gradient(135deg,var(--brand-primary) 0%,rgba(10,132,255,0.7) 100%);height:60px;"></div>
        <div style="padding:0 16px 16px;">
          <div style="width:56px;height:56px;border-radius:14px;background:rgba(10,132,255,0.15);border:3px solid var(--bg-base);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--brand-primary);margin-top:-28px;overflow:hidden;">
            ${r.photo?`<img src="${r.photo}" style="width:100%;height:100%;object-fit:cover;">`:`${getInitials(r.name||'?')}`}
          </div>
          <div style="margin-top:8px;">
            <div style="font-size:14px;font-weight:600;">${escHtml(r.name||'—')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escHtml(r.designation||r.role||'—')}</div>
            ${r.department?`<span class="badge badge-blue" style="margin-top:6px;display:inline-block;">${escHtml(r.department)}</span>`:''}
          </div>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:4px;">
            ${r.phone?`<div style="font-size:11px;color:var(--text-secondary);">📞 ${escHtml(r.phone)}</div>`:''}
            ${r.email?`<div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">✉️ ${escHtml(r.email)}</div>`:''}
          </div>
          <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
            ${badge(r.status||'active')}
            <div style="display:flex;gap:6px;">
              <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:4px 8px;" onclick="event.stopPropagation();editEmployee('${r.id}')">✏️</button>
              <button class="btn btn-danger btn-sm" style="font-size:10px;padding:4px 8px;" onclick="event.stopPropagation();deleteEmployee('${r.id}')">🗑</button>
            </div>
          </div>
        </div>
      </div>
    `).join('')}
  </div>`;
}

function _empCell(r) {
  const initials = getInitials(r.name||'?');
  const hasPhoto = !!r.photo;
  const avatarHtml = hasPhoto
    ? `<img src="${r.photo}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;" onerror="this.style.display='none'">`
    : `<div style="width:36px;height:36px;border-radius:10px;background:rgba(255,159,10,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-warning);flex-shrink:0;">${initials}</div>`;
  return `<div style="display:flex;align-items:center;gap:10px;">
    ${avatarHtml}
    <div>
      <div style="font-size:13px;font-weight:500;">${escHtml(r.name||'—')}</div>
      <div style="font-size:11px;color:var(--text-muted);">${escHtml(r.email||'—')}</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// MODAL BUILDER — TABBED (5 tabs)
// Profile | Job | Salary | Bank | Documents
// ─────────────────────────────────────────────────────────────
function _buildEmpModal() {
  const tabs = [
    ['profile',   '👤 Profile'],
    ['job',       '💼 Job Details'],
    ['salary',    '💰 Salary'],
    ['bank',      '🏦 Bank & ID'],
    ['documents', '📎 Documents'],
  ];
  const roleOpts = Object.entries(ROLE_LABELS)
    .filter(([k])=>k!=='super_admin')
    .map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const deptOpts = DEPARTMENTS.map(d=>`<option value="${d}">${d}</option>`).join('');
  const typeOpts = Object.entries(EMP_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const shiftOpts= Object.entries(SHIFTS).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  const bgOpts   = BLOOD_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join('');

  const tabBtns = tabs.map(([id,label]) => `
    <button class="emp-tab ${id==='profile'?'active':''}" id="emp-tab-btn-${id}"
      onclick="switchEmpTab('${id}')"
      style="padding:8px 12px;border-radius:var(--radius-sm);font-size:11px;font-weight:500;
             color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
      ${label}
    </button>`).join('');

  const body = `
    <style>
      .emp-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}
      .emp-tab-pane{display:none;}
      .emp-tab-pane.active{display:block;}
      .section-divider{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--border-subtle);}
      #emp-photo-preview{width:72px;height:72px;border-radius:14px;background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:var(--brand-primary);overflow:hidden;flex-shrink:0;border:2px dashed var(--border-default);cursor:pointer;}
    </style>

    <input type="hidden" id="emp-id">

    <!-- Tab nav -->
    <div style="display:flex;gap:2px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:3px;margin-bottom:var(--space-4);overflow-x:auto;">
      ${tabBtns}
    </div>

    <!-- ── TAB: PROFILE ──────────────────────────────────── -->
    <div class="emp-tab-pane active" id="emp-pane-profile">
      <!-- Photo row -->
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:var(--space-4);">
        <div id="emp-photo-preview" onclick="window._captureEmpPhoto()" title="Click to add photo">📷</div>
        <div>
          <div style="font-size:12px;font-weight:500;">Employee Photo</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Click to take/upload photo</div>
          <button class="btn btn-secondary btn-sm" style="margin-top:6px;font-size:11px;" onclick="window._captureEmpPhoto()">📷 Upload Photo</button>
        </div>
        <input type="hidden" id="emp-photo">
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Full Name <span class="required">*</span></label>
          <input type="text" id="emp-name" class="form-input" placeholder="Full name">
        </div>
        <div class="form-group">
          <label class="form-label">Display Name / Alias</label>
          <input type="text" id="emp-alias" class="form-input" placeholder="Short name or nickname">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Email <span class="required">*</span></label>
          <input type="email" id="emp-email" class="form-input" placeholder="emp@company.com">
        </div>
        <div class="form-group">
          <label class="form-label">Phone <span class="required">*</span></label>
          <input type="tel" id="emp-phone" class="form-input" placeholder="9876543210" maxlength="10">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Date of Birth</label>
          <input type="date" id="emp-dob" class="form-input">
        </div>
        <div class="form-group">
          <label class="form-label">Gender</label>
          <select id="emp-gender" class="form-select">
            <option value="">Select…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
            <option value="prefer_not">Prefer not to say</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Blood Group</label>
          <select id="emp-blood" class="form-select">
            <option value="">Select…</option>
            ${bgOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Marital Status</label>
          <select id="emp-marital" class="form-select">
            <option value="">Select…</option>
            <option value="single">Single</option>
            <option value="married">Married</option>
            <option value="divorced">Divorced</option>
            <option value="widowed">Widowed</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Residential Address</label>
        <textarea id="emp-address" class="form-textarea" rows="2" placeholder="House No., Street, City, State, PIN…"></textarea>
      </div>

      <div class="section-divider">Emergency Contact</div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Emergency Contact Name</label>
          <input type="text" id="emp-ec-name" class="form-input" placeholder="Spouse / Parent name">
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <select id="emp-ec-rel" class="form-select">
            <option value="">Select…</option>
            <option value="spouse">Spouse</option>
            <option value="parent">Parent</option>
            <option value="sibling">Sibling</option>
            <option value="child">Child</option>
            <option value="friend">Friend</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Emergency Phone</label>
          <input type="tel" id="emp-ec-phone" class="form-input" placeholder="Emergency contact number" maxlength="10">
        </div>
        <div class="form-group">
          <label class="form-label">Emergency Email</label>
          <input type="email" id="emp-ec-email" class="form-input" placeholder="optional">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Notes / Remarks</label>
        <textarea id="emp-notes" class="form-textarea" rows="2" placeholder="Internal notes…"></textarea>
      </div>
    </div>

    <!-- ── TAB: JOB DETAILS ───────────────────────────────── -->
    <div class="emp-tab-pane" id="emp-pane-job">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Employee ID</label>
          <input type="text" id="emp-emp-id" class="form-input" placeholder="EMP-001 (auto if blank)">
        </div>
        <div class="form-group">
          <label class="form-label">Designation <span class="required">*</span></label>
          <input type="text" id="emp-designation" class="form-input" placeholder="e.g. Warehouse Supervisor">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Department</label>
          <select id="emp-dept" class="form-select">
            <option value="">Select department…</option>
            ${deptOpts}
            <option value="__other__">Other (type below)</option>
          </select>
        </div>
        <div class="form-group" id="emp-dept-other-wrap" style="display:none;">
          <label class="form-label">Custom Department</label>
          <input type="text" id="emp-dept-other" class="form-input" placeholder="Enter department name">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">System Role <span class="required">*</span></label>
          <select id="emp-role" class="form-select">${roleOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Employment Type</label>
          <select id="emp-emp-type" class="form-select">
            <option value="">Select…</option>
            ${typeOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Joining Date</label>
          <input type="date" id="emp-joining" class="form-input">
        </div>
        <div class="form-group">
          <label class="form-label">Contract End Date</label>
          <input type="date" id="emp-contract-end" class="form-input">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Work Location</label>
          <input type="text" id="emp-location" class="form-input" placeholder="e.g. Kottayam Warehouse">
        </div>
        <div class="form-group">
          <label class="form-label">Shift</label>
          <select id="emp-shift" class="form-select">
            <option value="">Select shift…</option>
            ${shiftOpts}
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Reporting Manager</label>
          <select id="emp-manager" class="form-select">
            <option value="">None / Self-managed</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="emp-status" class="form-select">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="on_leave">On Leave</option>
            <option value="terminated">Terminated</option>
            <option value="resigned">Resigned</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Skills / Expertise</label>
        <input type="text" id="emp-skills" class="form-input" placeholder="Forklift, GST Filing, Tally, Python… (comma separated)">
        <span style="font-size:10px;color:var(--text-muted);">Separate with commas</span>
      </div>
      <div class="form-group">
        <label class="form-label">Qualifications</label>
        <input type="text" id="emp-qualifications" class="form-input" placeholder="B.Com, Diploma in Logistics, ITI…">
      </div>
    </div>

    <!-- ── TAB: SALARY ───────────────────────────────────── -->
    <div class="emp-tab-pane" id="emp-pane-salary">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Basic Salary (₹/month)</label>
          <input type="number" id="emp-salary" class="form-input" placeholder="0" min="0" oninput="calcCTC()">
        </div>
        <div class="form-group">
          <label class="form-label">HRA (₹/month)</label>
          <input type="number" id="emp-hra" class="form-input" placeholder="Auto: 40% of basic" oninput="calcCTC()">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Conveyance Allowance</label>
          <input type="number" id="emp-conv" class="form-input" placeholder="1600" min="0" oninput="calcCTC()">
        </div>
        <div class="form-group">
          <label class="form-label">Medical Allowance</label>
          <input type="number" id="emp-med" class="form-input" placeholder="1250" min="0" oninput="calcCTC()">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Special Allowance</label>
          <input type="number" id="emp-special" class="form-input" placeholder="0" min="0" oninput="calcCTC()">
        </div>
        <div class="form-group">
          <label class="form-label">Bonus / Performance Pay</label>
          <input type="number" id="emp-bonus" class="form-input" placeholder="0" min="0">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Payment Mode</label>
          <select id="emp-pay-mode" class="form-select">
            <option value="bank_transfer">Bank Transfer</option>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
            <option value="upi">UPI</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Payment Cycle</label>
          <select id="emp-pay-cycle" class="form-select">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="daily">Daily Wage</option>
          </select>
        </div>
      </div>

      <!-- CTC Calculator -->
      <div id="emp-ctc-preview" style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:16px;margin-top:var(--space-3);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;">Live CTC Breakdown</div>
        <div id="emp-ctc-table" style="font-size:12px;"></div>
      </div>
    </div>

    <!-- ── TAB: BANK & ID ────────────────────────────────── -->
    <div class="emp-tab-pane" id="emp-pane-bank">
      <div class="section-divider" style="margin-top:0;border-top:none;">Bank Account Details</div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Account Holder Name</label>
          <input type="text" id="emp-bank-name" class="form-input" placeholder="As per bank records">
        </div>
        <div class="form-group">
          <label class="form-label">Account Number</label>
          <input type="text" id="emp-bank-acc" class="form-input" placeholder="Bank account number">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">IFSC Code</label>
          <input type="text" id="emp-bank-ifsc" class="form-input" placeholder="SBIN0001234" style="text-transform:uppercase;" maxlength="11">
        </div>
        <div class="form-group">
          <label class="form-label">Bank Name & Branch</label>
          <input type="text" id="emp-bank-branch" class="form-input" placeholder="SBI, MG Road Branch">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">UPI ID (for payments)</label>
        <input type="text" id="emp-upi" class="form-input" placeholder="9876543210@upi">
      </div>

      <div class="section-divider">Government IDs</div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">PAN Number</label>
          <input type="text" id="emp-pan" class="form-input" placeholder="ABCDE1234F" maxlength="10" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Aadhaar Number</label>
          <input type="text" id="emp-aadhaar" class="form-input" placeholder="XXXX XXXX XXXX" maxlength="12">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">PF Account Number (UAN)</label>
          <input type="text" id="emp-pf-uan" class="form-input" placeholder="Universal Account Number">
        </div>
        <div class="form-group">
          <label class="form-label">ESI Number</label>
          <input type="text" id="emp-esi" class="form-input" placeholder="ESI registration number">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Driving Licence (if driver)</label>
          <input type="text" id="emp-dl" class="form-input" placeholder="DL number">
        </div>
        <div class="form-group">
          <label class="form-label">Passport Number</label>
          <input type="text" id="emp-passport" class="form-input" placeholder="Passport number (optional)">
        </div>
      </div>
    </div>

    <!-- ── TAB: DOCUMENTS ────────────────────────────────── -->
    <div class="emp-tab-pane" id="emp-pane-documents">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">
        Upload or link documents for this employee's record.
      </div>
      <div id="emp-docs-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-4);"></div>
      <div class="card" style="padding:12px;">
        <div class="form-grid-2">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Document Type</label>
            <select id="emp-doc-type" class="form-select">
              <option value="offer_letter">Offer Letter</option>
              <option value="appointment_letter">Appointment Letter</option>
              <option value="id_proof">ID Proof (Aadhaar / PAN)</option>
              <option value="address_proof">Address Proof</option>
              <option value="education_cert">Education Certificate</option>
              <option value="experience_letter">Experience Letter</option>
              <option value="medical_cert">Medical Certificate</option>
              <option value="nda">NDA / Agreement</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Document Name / Label</label>
            <input type="text" id="emp-doc-name" class="form-input" placeholder="e.g. Aadhaar Card">
          </div>
        </div>
        <div class="form-group" style="margin-top:8px;">
          <label class="form-label">URL / Link</label>
          <input type="url" id="emp-doc-url" class="form-input" placeholder="https://drive.google.com/…">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Notes</label>
          <input type="text" id="emp-doc-note" class="form-input" placeholder="Verified on 01-Jan-2025…">
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="addEmpDoc()">+ Add Document</button>
      </div>
    </div>
  `;

  return buildModal({
    id: 'employee-modal',
    title: '<span id="emp-modal-title">Add Employee</span>',
    size: 'lg',
    body,
    footer: `
      <div style="display:flex;gap:8px;align-items:center;flex:1;">
        <span id="emp-tab-indicator" style="font-size:11px;color:var(--text-muted);"></span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" onclick="closeModal('employee-modal')">Cancel</button>
        <button class="btn btn-secondary btn-sm" onclick="switchEmpTab(prevEmpTab())" id="emp-prev-btn" style="display:none;">← Back</button>
        <button class="btn btn-primary" id="emp-save-btn" onclick="saveEmployee()">💾 Save Employee</button>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────
// VIEW PROFILE MODAL
// ─────────────────────────────────────────────────────────────
function _buildViewModal() {
  return buildModal({
    id: 'emp-view-modal',
    title: '<span id="emp-view-title">Employee Profile</span>',
    size: 'lg',
    body: `<div id="emp-view-content"></div>`,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal('emp-view-modal')">Close</button>
      <button class="btn btn-primary" id="emp-view-edit-btn">✏️ Edit</button>
    `,
  });
}

function _renderProfileView(emp) {
  const age = emp.dob
    ? Math.floor((Date.now() - new Date(emp.dob)) / (365.25*24*60*60*1000))
    : null;
  const tenure = emp.joiningDate
    ? Math.floor((Date.now() - new Date(emp.joiningDate)) / (365.25*24*60*60*1000))
    : null;
  const skills = (emp.skills||'').split(',').map(s=>s.trim()).filter(Boolean);

  return `
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:20px;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-bottom:var(--space-4);">
      <div style="width:72px;height:72px;border-radius:16px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:var(--brand-primary);overflow:hidden;flex-shrink:0;">
        ${emp.photo?`<img src="${emp.photo}" style="width:100%;height:100%;object-fit:cover;">`:`${getInitials(emp.name||'?')}`}
      </div>
      <div style="flex:1;">
        <div style="font-size:18px;font-weight:700;">${escHtml(emp.name||'—')}</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${escHtml(emp.designation||emp.role||'—')}${emp.department?` • ${escHtml(emp.department)}`:''}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          ${badge(emp.status||'active')}
          ${emp.empType?badge(emp.empType, EMP_TYPES[emp.empType]||emp.empType):''}
          ${emp.shift?`<span class="badge badge-gray">${SHIFTS[emp.shift]||emp.shift}</span>`:''}
          ${emp.empId?`<span class="badge badge-blue">${escHtml(emp.empId)}</span>`:''}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        ${age?`<div style="font-size:11px;color:var(--text-muted);">Age: ${age} yrs</div>`:''}
        ${tenure!==null?`<div style="font-size:11px;color:var(--text-muted);">Tenure: ${tenure===0?'<1 yr':tenure+' yrs'}</div>`:''}
        ${emp.salary?`<div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--brand-secondary);margin-top:4px;">₹${Number(emp.salary).toLocaleString('en-IN')}/mo</div>`:''}
      </div>
    </div>

    <!-- 2-col details -->
    <div class="grid-2" style="gap:var(--space-4);">
      <!-- Left: Contact + Emergency -->
      <div>
        <div class="section-divider" style="margin-top:0;border-top:none;">Contact Information</div>
        ${_viewRow('📧 Email',      emp.email)}
        ${_viewRow('📞 Phone',      emp.phone)}
        ${_viewRow('🩸 Blood',      emp.blood)}
        ${_viewRow('⚥ Gender',     emp.gender)}
        ${_viewRow('💒 Marital',    emp.marital)}
        ${_viewRow('🗓 DOB',        emp.dob?formatDate(emp.dob):null)}
        ${_viewRow('📍 Address',    emp.address)}

        <div class="section-divider">Emergency Contact</div>
        ${_viewRow('👤 Name',       emp.emergencyContact?.name)}
        ${_viewRow('📞 Phone',      emp.emergencyContact?.phone)}
        ${_viewRow('🔗 Relation',   emp.emergencyContact?.relation)}
      </div>

      <!-- Right: Job + Bank -->
      <div>
        <div class="section-divider" style="margin-top:0;border-top:none;">Job Details</div>
        ${_viewRow('🆔 Emp ID',     emp.empId)}
        ${_viewRow('📅 Joined',     emp.joiningDate?formatDate(emp.joiningDate):null)}
        ${_viewRow('⏰ Shift',      emp.shift?SHIFTS[emp.shift]:null)}
        ${_viewRow('📍 Location',   emp.workLocation)}
        ${_viewRow('👤 Manager',    emp.managerName)}
        ${_viewRow('📚 Quals',      emp.qualifications)}

        <div class="section-divider">Bank & IDs</div>
        ${_viewRow('🏦 Bank',       emp.bankDetails?.bankName)}
        ${_viewRow('💳 A/C',        emp.bankDetails?.accountNumber?'••••'+emp.bankDetails.accountNumber.slice(-4):null)}
        ${_viewRow('🔢 IFSC',       emp.bankDetails?.ifsc)}
        ${_viewRow('🔑 UAN (PF)',   emp.govIds?.pfUan)}
        ${_viewRow('📜 PAN',        emp.govIds?.pan?emp.govIds.pan.slice(0,5)+'*****':null)}
      </div>
    </div>

    ${skills.length?`
      <div class="section-divider">Skills</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${skills.map(s=>`<span class="badge badge-blue">${escHtml(s)}</span>`).join('')}
      </div>
    `:''}

    ${(emp.documents||[]).length?`
      <div class="section-divider">Documents</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${(emp.documents||[]).map(d=>`
          <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <span style="font-size:14px;">📎</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:500;">${escHtml(d.name||d.type||'Document')}</div>
              ${d.note?`<div style="font-size:10px;color:var(--text-muted);">${escHtml(d.note)}</div>`:''}
            </div>
            ${d.url?`<a href="${d.url}" target="_blank" class="btn btn-secondary btn-sm" style="font-size:10px;">Open ↗</a>`:''}
          </div>
        `).join('')}
      </div>
    `:''}

    ${emp.notes?`
      <div class="section-divider">Notes</div>
      <div style="font-size:12px;color:var(--text-secondary);padding:10px;background:var(--bg-elevated);border-radius:var(--radius-md);">${escHtml(emp.notes)}</div>
    `:''}
  `;
}

function _viewRow(label, val) {
  if (!val) return '';
  return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
    <div style="font-size:11px;color:var(--text-muted);min-width:90px;flex-shrink:0;">${label}</div>
    <div style="font-size:12px;color:var(--text-primary);">${escHtml(String(val))}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// GLOBALS
// ─────────────────────────────────────────────────────────────
const TAB_ORDER = ['profile','job','salary','bank','documents'];

function _registerGlobals() {
  // Search & filter
  window.employeeSearch = debounce(async (q) => {
    if (!q) { _filtered = [..._employees]; }
    else if (_employees.length > 300 && window.LAMWorker) {
      try { _filtered = await window.LAMWorker.searchItems(_employees, q, ['name','email','phone','department','designation','skills'], 0.35); }
      catch { _filtered = searchFilter(_employees, q, ['name','email','phone','department','designation','skills']); }
    } else {
      _filtered = searchFilter(_employees, q, ['name','email','phone','department','designation','skills']);
    }
    _page = 1; _renderList();
  }, 250);

  window.employeeFilter = (key, val) => {
    _filtered = val ? _employees.filter(e => e[key] === val) : [..._employees];
    _activeDeptChip = '';
    _page = 1; _renderList();
  };

  window.filterByDept = (dept) => {
    _activeDeptChip = dept;
    _filtered = dept ? _employees.filter(e => e.department === dept) : [..._employees];
    _page = 1; _renderDeptChips(); _renderList();
  };

  window.setEmpPage = (p) => { _page = p; _renderList(); };

  window.toggleEmpView = () => {
    _viewMode = _viewMode === 'table' ? 'grid' : 'table';
    const btn = document.getElementById('emp-view-toggle');
    if (btn) btn.textContent = _viewMode === 'table' ? '⊞ Grid' : '☰ Table';
    _renderList();
  };

  // Tab switching
  window.switchEmpTab = (tab) => {
    _activeTab = tab;
    document.querySelectorAll('.emp-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(`emp-tab-btn-${tab}`)?.classList.add('active');
    document.querySelectorAll('.emp-tab-pane').forEach(p => p.classList.remove('active'));
    document.getElementById(`emp-pane-${tab}`)?.classList.add('active');
    // Update indicator
    const idx = TAB_ORDER.indexOf(tab)+1;
    const ind = document.getElementById('emp-tab-indicator');
    if (ind) ind.textContent = `Step ${idx} of ${TAB_ORDER.length}`;
    const prevBtn = document.getElementById('emp-prev-btn');
    if (prevBtn) prevBtn.style.display = idx > 1 ? '' : 'none';
  };

  window.prevEmpTab = () => {
    const idx = TAB_ORDER.indexOf(_activeTab);
    return TAB_ORDER[Math.max(0, idx-1)];
  };

  // Dept "other" toggle
  const deptSel = document.getElementById('emp-dept');
  if (deptSel) {
    deptSel.addEventListener('change', () => {
      const wrap = document.getElementById('emp-dept-other-wrap');
      if (wrap) wrap.style.display = deptSel.value === '__other__' ? '' : 'none';
    });
  }

  // CTC calculator
  window.calcCTC = () => {
    const basic   = Number(document.getElementById('emp-salary')?.value)||0;
    const hra     = Number(document.getElementById('emp-hra')?.value)||Math.round(basic*0.4);
    const conv    = Number(document.getElementById('emp-conv')?.value)||1600;
    const med     = Number(document.getElementById('emp-med')?.value)||1250;
    const special = Number(document.getElementById('emp-special')?.value)||0;
    const gross   = basic+hra+conv+med+special;
    const pfEmp   = Math.round(basic*0.12);
    const pfEr    = Math.round(basic*0.12);
    const esiEmp  = basic<=21000?Math.round(gross*0.0075):0;
    const esiEr   = basic<=21000?Math.round(gross*0.0325):0;
    const tds     = basic>50000?Math.round((basic-50000)*0.1/12):0;
    const net     = gross-pfEmp-esiEmp-tds;
    const ctc     = gross+pfEr+esiEr;
    const el = document.getElementById('emp-ctc-table');
    if (!el) return;
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tbody>
          ${_ctcRow('Basic',          basic)}
          ${_ctcRow('HRA',            hra)}
          ${_ctcRow('Conveyance',     conv)}
          ${_ctcRow('Medical',        med)}
          ${special?_ctcRow('Special Allow', special):''}
          <tr><td colspan="2" style="height:1px;background:var(--border-subtle);padding:0;"></td></tr>
          ${_ctcRow('Gross Salary',   gross, true)}
          ${_ctcRow('PF (Employee)',  -pfEmp, false, true)}
          ${esiEmp?_ctcRow('ESI (Employee)', -esiEmp, false, true):''}
          ${tds?_ctcRow('TDS',        -tds, false, true):''}
          <tr><td colspan="2" style="height:1px;background:var(--border-subtle);padding:0;"></td></tr>
          ${_ctcRow('Net Pay',        net, true, false, 'var(--brand-secondary)')}
          ${_ctcRow('CTC (Annual)',   ctc*12, true, false, 'var(--brand-primary)')}
        </tbody>
      </table>
    `;
  };

  // Document management (in-memory before save)
  let _pendingDocs = [];
  window.addEmpDoc = () => {
    const type = document.getElementById('emp-doc-type')?.value;
    const name = document.getElementById('emp-doc-name')?.value?.trim();
    const url  = document.getElementById('emp-doc-url')?.value?.trim();
    const note = document.getElementById('emp-doc-note')?.value?.trim();
    if (!name) { Toast.warning('Missing','Enter a document name.'); return; }
    _pendingDocs.push({ id:genId('doc'), type, name, url, note, addedAt: new Date().toISOString() });
    _renderDocsPreview(_pendingDocs);
    ['emp-doc-name','emp-doc-url','emp-doc-note'].forEach(id => {
      const el = document.getElementById(id); if(el) el.value='';
    });
  };

  function _renderDocsPreview(docs) {
    const el = document.getElementById('emp-docs-list'); if(!el) return;
    el.innerHTML = docs.length ? docs.map((d,i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <span>📎</span>
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:500;">${escHtml(d.name)}</div>
          ${d.url?`<div style="font-size:10px;color:var(--brand-primary);">${escHtml(d.url.slice(0,50))}…</div>`:''}
          ${d.note?`<div style="font-size:10px;color:var(--text-muted);">${escHtml(d.note)}</div>`:''}
        </div>
        <button class="btn btn-danger btn-sm" style="font-size:10px;" onclick="removeEmpDoc(${i})">✕</button>
      </div>
    `).join('') : '';
  }

  window.removeEmpDoc = (i) => {
    _pendingDocs.splice(i,1);
    _renderDocsPreview(_pendingDocs);
  };

  // Open modal (new)
  window.openEmpModal = () => {
    _pendingDocs = [];
    _renderDocsPreview([]);
    _activeTab = 'profile';
    document.getElementById('emp-modal-title').textContent = 'Add Employee';
    // Clear all fields
    [
      'emp-id','emp-name','emp-alias','emp-email','emp-phone','emp-dob','emp-address',
      'emp-photo','emp-ec-name','emp-ec-phone','emp-ec-email','emp-notes',
      'emp-emp-id','emp-designation','emp-skills','emp-qualifications','emp-joining',
      'emp-contract-end','emp-location','emp-salary','emp-hra','emp-conv',
      'emp-med','emp-special','emp-bonus','emp-bank-name','emp-bank-acc',
      'emp-bank-ifsc','emp-bank-branch','emp-upi','emp-pan','emp-aadhaar',
      'emp-pf-uan','emp-esi','emp-dl','emp-passport',
    ].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    ['emp-gender','emp-blood','emp-marital','emp-dept','emp-role','emp-emp-type',
     'emp-shift','emp-status','emp-manager','emp-pay-mode','emp-pay-cycle'].forEach(id => {
      const el = document.getElementById(id); if(el) el.selectedIndex = 0;
    });
    const photoPreview = document.getElementById('emp-photo-preview');
    if (photoPreview) { photoPreview.style.background=''; photoPreview.innerHTML='📷'; }
    // Populate manager dropdown
    _populateManagerDropdown(null);
    // Reset tab
    switchEmpTab('profile');
    calcCTC();
    openModal('employee-modal');
  };

  function _populateManagerDropdown(currentId) {
    const sel = document.getElementById('emp-manager'); if(!sel) return;
    const existing = sel.innerHTML.split('\n')[0]; // Keep "None" option
    sel.innerHTML = `<option value="">None / Self-managed</option>
      ${_employees
        .filter(e => (e.status||'active') === 'active' && e.id !== currentId)
        .map(e => `<option value="${e.id}">${escHtml(e.name||'—')} — ${escHtml(e.designation||e.role||'')}</option>`)
        .join('')}`;
  }

  // Save employee
  window.saveEmployee = async () => {
    // Validate required fields across tabs
    const valid = validateForm([
      { id:'emp-name',  label:'Full Name',   required:true },
      { id:'emp-email', label:'Email',        required:true },
      { id:'emp-phone', label:'Phone',        required:true },
    ]);
    if (!valid) { switchEmpTab('profile'); return; }

    const btn = document.getElementById('emp-save-btn');
    setLoading(btn, true);
    const id = document.getElementById('emp-id').value;

    // Resolve department
    let dept = document.getElementById('emp-dept').value;
    if (dept === '__other__') dept = document.getElementById('emp-dept-other')?.value?.trim()||'';

    // Resolve manager name
    const managerId = document.getElementById('emp-manager').value;
    const managerEmp = _employees.find(e => e.id === managerId);

    const basic   = Number(document.getElementById('emp-salary')?.value)||0;
    const hra     = Number(document.getElementById('emp-hra')?.value)||Math.round(basic*0.4);
    const conv    = Number(document.getElementById('emp-conv')?.value)||1600;
    const med     = Number(document.getElementById('emp-med')?.value)||1250;
    const special = Number(document.getElementById('emp-special')?.value)||0;

    const data = {
      // Profile
      name:             document.getElementById('emp-name').value.trim(),
      alias:            document.getElementById('emp-alias')?.value?.trim()||'',
      email:            document.getElementById('emp-email').value.trim(),
      phone:            document.getElementById('emp-phone').value.trim(),
      dob:              document.getElementById('emp-dob')?.value||'',
      gender:           document.getElementById('emp-gender')?.value||'',
      blood:            document.getElementById('emp-blood')?.value||'',
      marital:          document.getElementById('emp-marital')?.value||'',
      address:          document.getElementById('emp-address')?.value?.trim()||'',
      photo:            document.getElementById('emp-photo')?.value||'',
      emergencyContact: {
        name:     document.getElementById('emp-ec-name')?.value?.trim()||'',
        relation: document.getElementById('emp-ec-rel')?.value||'',
        phone:    document.getElementById('emp-ec-phone')?.value?.trim()||'',
        email:    document.getElementById('emp-ec-email')?.value?.trim()||'',
      },
      notes: document.getElementById('emp-notes')?.value?.trim()||'',
      // Job
      empId:          document.getElementById('emp-emp-id')?.value?.trim()||`EMP-${String(Date.now()).slice(-5)}`,
      designation:    document.getElementById('emp-designation')?.value?.trim()||'',
      department:     dept,
      role:           document.getElementById('emp-role')?.value||'viewer',
      empType:        document.getElementById('emp-emp-type')?.value||'',
      joiningDate:    document.getElementById('emp-joining')?.value||'',
      contractEndDate:document.getElementById('emp-contract-end')?.value||'',
      workLocation:   document.getElementById('emp-location')?.value?.trim()||'',
      shift:          document.getElementById('emp-shift')?.value||'',
      managerId:      managerId||'',
      managerName:    managerEmp?.name||'',
      status:         document.getElementById('emp-status')?.value||'active',
      skills:         document.getElementById('emp-skills')?.value?.trim()||'',
      qualifications: document.getElementById('emp-qualifications')?.value?.trim()||'',
      // Salary
      salary:         basic,
      hra,
      convAllowance:  conv,
      medAllowance:   med,
      specialAllowance: special,
      bonus:          Number(document.getElementById('emp-bonus')?.value)||0,
      paymentMode:    document.getElementById('emp-pay-mode')?.value||'bank_transfer',
      paymentCycle:   document.getElementById('emp-pay-cycle')?.value||'monthly',
      // Bank
      bankDetails: {
        accountHolderName: document.getElementById('emp-bank-name')?.value?.trim()||'',
        accountNumber:     document.getElementById('emp-bank-acc')?.value?.trim()||'',
        ifsc:              (document.getElementById('emp-bank-ifsc')?.value?.trim()||'').toUpperCase(),
        bankName:          document.getElementById('emp-bank-branch')?.value?.trim()||'',
        upiId:             document.getElementById('emp-upi')?.value?.trim()||'',
      },
      // Gov IDs
      govIds: {
        pan:      (document.getElementById('emp-pan')?.value?.trim()||'').toUpperCase(),
        aadhaar:  document.getElementById('emp-aadhaar')?.value?.trim()||'',
        pfUan:    document.getElementById('emp-pf-uan')?.value?.trim()||'',
        esi:      document.getElementById('emp-esi')?.value?.trim()||'',
        dl:       document.getElementById('emp-dl')?.value?.trim()||'',
        passport: document.getElementById('emp-passport')?.value?.trim()||'',
      },
      // Documents
      documents: [..._pendingDocs],
      // Meta
      companyId: AuthState.company?.id||null,
    };

    try {
      if (id) {
        await dbUpdate(COLLECTIONS.EMPLOYEES, id, data);
        Toast.success('Updated', `${data.name} profile updated.`);
      } else {
        await dbCreate(COLLECTIONS.EMPLOYEES, data);
        Toast.success('Added', `${data.name} added to the team.`);
      }
      closeModal('employee-modal');
      _pendingDocs = [];
    } catch(e) {
      Toast.error('Failed', e.message);
    } finally {
      setLoading(btn, false);
    }
  };

  // Edit
  window.editEmployee = (id) => {
    const e = _employees.find(x => x.id === id);
    if (!e) return;

    _pendingDocs = [...(e.documents||[])];
    _activeTab = 'profile';
    document.getElementById('emp-modal-title').textContent = 'Edit Employee';
    document.getElementById('emp-id').value = e.id;

    // Profile
    _setVal('emp-name',     e.name);
    _setVal('emp-alias',    e.alias);
    _setVal('emp-email',    e.email);
    _setVal('emp-phone',    e.phone);
    _setVal('emp-dob',      e.dob);
    _setSel('emp-gender',   e.gender);
    _setSel('emp-blood',    e.blood);
    _setSel('emp-marital',  e.marital);
    _setVal('emp-address',  e.address);
    _setVal('emp-photo',    e.photo);
    _setVal('emp-ec-name',  e.emergencyContact?.name);
    _setSel('emp-ec-rel',   e.emergencyContact?.relation);
    _setVal('emp-ec-phone', e.emergencyContact?.phone);
    _setVal('emp-ec-email', e.emergencyContact?.email);
    _setVal('emp-notes',    e.notes);
    // Photo preview
    const prev = document.getElementById('emp-photo-preview');
    if (prev && e.photo) {
      prev.innerHTML = `<img src="${e.photo}" style="width:100%;height:100%;object-fit:cover;">`;
    }
    // Job
    _setVal('emp-emp-id',       e.empId);
    _setVal('emp-designation',  e.designation);
    // Dept
    const deptSel = document.getElementById('emp-dept');
    if (deptSel) {
      const found = DEPARTMENTS.includes(e.department);
      deptSel.value = found ? e.department : (e.department ? '__other__' : '');
      const wrap = document.getElementById('emp-dept-other-wrap');
      if (!found && e.department) {
        if (wrap) { wrap.style.display=''; }
        _setVal('emp-dept-other', e.department);
      } else {
        if (wrap) wrap.style.display='none';
      }
    }
    _setSel('emp-role',       e.role);
    _setSel('emp-emp-type',   e.empType);
    _setVal('emp-joining',    e.joiningDate);
    _setVal('emp-contract-end',e.contractEndDate);
    _setVal('emp-location',   e.workLocation);
    _setSel('emp-shift',      e.shift);
    _setSel('emp-status',     e.status||'active');
    _setVal('emp-skills',     e.skills);
    _setVal('emp-qualifications', e.qualifications);
    // Manager dropdown
    _populateManagerDropdown(e.id);
    const mgSel = document.getElementById('emp-manager');
    if (mgSel && e.managerId) mgSel.value = e.managerId;
    // Salary
    _setVal('emp-salary',  e.salary);
    _setVal('emp-hra',     e.hra);
    _setVal('emp-conv',    e.convAllowance);
    _setVal('emp-med',     e.medAllowance);
    _setVal('emp-special', e.specialAllowance);
    _setVal('emp-bonus',   e.bonus);
    _setSel('emp-pay-mode', e.paymentMode||'bank_transfer');
    _setSel('emp-pay-cycle',e.paymentCycle||'monthly');
    // Bank
    _setVal('emp-bank-name',   e.bankDetails?.accountHolderName);
    _setVal('emp-bank-acc',    e.bankDetails?.accountNumber);
    _setVal('emp-bank-ifsc',   e.bankDetails?.ifsc);
    _setVal('emp-bank-branch', e.bankDetails?.bankName);
    _setVal('emp-upi',         e.bankDetails?.upiId);
    // Gov IDs
    _setVal('emp-pan',      e.govIds?.pan);
    _setVal('emp-aadhaar',  e.govIds?.aadhaar);
    _setVal('emp-pf-uan',   e.govIds?.pfUan);
    _setVal('emp-esi',      e.govIds?.esi);
    _setVal('emp-dl',       e.govIds?.dl);
    _setVal('emp-passport', e.govIds?.passport);
    // Documents
    _renderDocsPreview(_pendingDocs);
    switchEmpTab('profile');
    calcCTC();
    openModal('employee-modal');
  };

  // View profile
  window.viewEmployee = (id) => {
    const e = _employees.find(x => x.id === id);
    if (!e) return;
    document.getElementById('emp-view-title').textContent = `${e.name||'Employee'} — Profile`;
    document.getElementById('emp-view-content').innerHTML = _renderProfileView(e);
    const editBtn = document.getElementById('emp-view-edit-btn');
    if (editBtn) { editBtn.onclick = () => { closeModal('emp-view-modal'); editEmployee(id); }; }
    openModal('emp-view-modal');
  };

  // View salary (shortcut to salary tab)
  window.viewSalary = (id) => {
    editEmployee(id);
    setTimeout(() => switchEmpTab('salary'), 150);
  };

  // Delete
  window.deleteEmployee = async (id) => {
    const e = _employees.find(x => x.id === id);
    if (!confirm(`Delete employee "${e?.name}"? This cannot be undone.`)) return;
    try {
      await dbDelete(COLLECTIONS.EMPLOYEES, id);
      Toast.success('Deleted', 'Employee removed from system.');
    } catch (err) {
      Toast.error('Failed', err.message);
    }
  };

  // Photo capture
  window._captureEmpPhoto = async () => {
    if (!window.LAMCamera) {
      Toast.info('Camera', 'Camera module not loaded. Enter a URL manually or use a base64 image.');
      return;
    }
    try {
      const result = await window.LAMCamera.capture({ facing:'user', allowGallery:true });
      if (!result) return;
      document.getElementById('emp-photo').value = result.thumb||result.base64||'';
      const wrap = document.getElementById('emp-photo-preview');
      if (wrap) wrap.innerHTML = `<img src="${result.thumb||result.base64}" style="width:100%;height:100%;object-fit:cover;">`;
    } catch(e) { console.warn('Photo capture:', e); }
  };

  // Export
  window.exportEmployees = () => {
    if (window.LAMEXCEL) {
      window.LAMEXCEL.employees(_filtered, AuthState.company||{});
      return;
    }
    const headers = ['EmpID','Name','Email','Phone','Designation','Department','Role','EmpType','Shift','Status','Joining Date','Salary','PAN','Aadhaar','PF UAN','Manager'];
    const rows = _filtered.map(e => [
      e.empId||'', e.name||'', e.email||'', e.phone||'',
      e.designation||'', e.department||'', e.role||'', e.empType||'', e.shift||'',
      e.status||'active', e.joiningDate||'',
      e.salary||0, e.govIds?.pan||'', e.govIds?.aadhaar||'',
      e.govIds?.pfUan||'', e.managerName||'',
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(','))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = 'employees_export.csv';
    a.click();
    Toast.success('Exported', `${_filtered.length} employees exported to CSV.`);
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined && val !== null) el.value = String(val);
}
function _setSel(id, val) {
  const el = document.getElementById(id);
  if (el && val) el.value = String(val);
}
function _ctcRow(label, val, bold=false, neg=false, color='') {
  const display = `${neg&&val<0?'-':val<0?'-':''}₹${Math.abs(val).toLocaleString('en-IN')}`;
  return `<tr>
    <td style="padding:4px 0;font-size:12px;${bold?'font-weight:700;':''}">${label}</td>
    <td style="padding:4px 0;text-align:right;font-family:var(--font-mono);font-size:12px;${bold?'font-weight:700;':''}${neg?'color:var(--brand-danger);':''}${color?`color:${color};`:''}">${display}</td>
  </tr>`;
}
