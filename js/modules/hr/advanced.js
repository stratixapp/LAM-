// ============================================================
// LAM — HR Advanced Module — DEEP v2
// Attendance: check-in/out times, overtime, late marks, edit modal
// Payroll: configurable deductions, PF/ESI/TDS/PT, bonus, LOP
// Leaves: balance tracker, carry-forward, team calendar
// ============================================================

import {
  dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll,
  COLLECTIONS, where, orderBy,
} from '../../core/firebase.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { AuthState }   from '../../core/auth.js';
import { Toast }        from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter, debounce,
  genId, formatNumber, formatCurrency,
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar, badge,
  actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell,
} from '../_shared.js';

export const HR_COLLECTIONS = {
  ATTENDANCE:     'hr_attendance',
  PAYROLL:        'hr_payroll',
  LEAVES:         'hr_leaves',
  LEAVE_BALANCES: 'hr_leave_balances',
  PAY_CONFIG:     'hr_pay_config',
};

// ── State ─────────────────────────────────────────────────────
let _employees = [];
let _activeTab = 'attendance';
let _unsubs    = [];
let _payConfig = null; // cached deduction config

function _cleanupListeners() { _unsubs.forEach(fn => fn && fn()); _unsubs = []; }
const PER = 15;

// ── Leave types and annual limits ─────────────────────────────
const LEAVE_TYPES = {
  casual:    { label:'Casual Leave',      annual:12, color:'kpi-blue'   },
  sick:      { label:'Sick Leave',        annual:12, color:'kpi-yellow' },
  earned:    { label:'Earned/Annual',     annual:21, color:'kpi-green'  },
  maternity: { label:'Maternity Leave',   annual:182,color:'kpi-orange' },
  paternity: { label:'Paternity Leave',   annual:15, color:'kpi-blue'   },
  lop:       { label:'Loss of Pay',       annual:999,color:'kpi-red'    },
  comp_off:  { label:'Comp Off',          annual:0,  color:'kpi-gray'   },
};

// ─────────────────────────────────────────────────────────────
export async function renderHRAdvanced(container) {
  _cleanupListeners();

  // Load employees + pay config
  const cid = AuthState.company?.id;
  [_employees, _payConfig] = await Promise.all([
    dbGetAll(COLLECTIONS.EMPLOYEES, cid ? [where('companyId','==',cid)] : []),
    dbGetAll(HR_COLLECTIONS.PAY_CONFIG, cid ? [where('companyId','==',cid)] : [])
      .then(r => r[0] || _defaultPayConfig())
      .catch(() => _defaultPayConfig()),
  ]);

  container.innerHTML = pageShell({
    title: '👥 HR Management',
    subtitle: 'Attendance, payroll processing, leave management and team calendar.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshHR()">↻ Refresh</button>`,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="hr-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);overflow-x:auto;width:fit-content;">
        ${[
          ['attendance','⏰ Attendance'],
          ['payroll',   '💰 Payroll'],
          ['leaves',    '🏖 Leaves'],
          ['calendar',  '📅 Team Calendar'],
        ].map(([id,label]) => `
          <button class="hr-tab ${id==='attendance'?'active':''}" id="hr-tab-${id}"
            onclick="switchHRTab('${id}')"
            style="padding:8px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="hr-tab-content"></div>
    `,
  });

  const style = document.createElement('style');
  style.textContent = `
    .hr-tab.active { background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm); }
    .att-status-btn { padding:4px 8px;border-radius:var(--radius-sm);font-size:10px;font-weight:600;border:none;cursor:pointer;transition:all 0.15s; }
    .att-status-btn:hover { opacity:0.85;transform:scale(1.05); }
    .att-present  { background:rgba(48,209,88,0.15);color:#30d158; }
    .att-half     { background:rgba(255,159,10,0.15);color:#ff9f0a; }
    .att-absent   { background:rgba(255,69,58,0.15);color:#ff453a; }
    .att-leave    { background:rgba(10,132,255,0.15);color:#0a84ff; }
    .att-wfh      { background:rgba(94,92,230,0.15);color:#5e5ce6; }
    .pay-row td   { padding:6px 10px;font-size:12px; }
    .leave-bal    { padding:10px;border-radius:var(--radius-md);background:var(--bg-elevated);text-align:center; }
  `;
  document.head.appendChild(style);

  _renderHRKPIs();
  setupModalClose(); setupMenuClose();

  window.switchHRTab = switchHRTab;
  window.refreshHR   = async () => {
    const c = AuthState.company?.id;
    [_employees, _payConfig] = await Promise.all([
      dbGetAll(COLLECTIONS.EMPLOYEES, c?[where('companyId','==',c)]:[]),
      dbGetAll(HR_COLLECTIONS.PAY_CONFIG, c?[where('companyId','==',c)]:[])
        .then(r=>r[0]||_defaultPayConfig()).catch(()=>_defaultPayConfig()),
    ]);
    _renderHRKPIs(); switchHRTab(_activeTab);
  };

  switchHRTab('attendance');
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderHRKPIs() {
  const el = document.getElementById('hr-kpis'); if(!el) return; el.innerHTML='';
  const total    = _employees.length;
  const active   = _employees.filter(e=>(e.status||'active')==='active').length;
  const onLeave  = _employees.filter(e=>e.status==='on_leave').length;
  const monthly  = _employees.reduce((s,e)=>s+(Number(e.salary)||0),0);
  [
    { label:'Total Employees', value:total,                       icon:'👥', color:'kpi-blue'   },
    { label:'Active',          value:active,                      icon:'✅', color:'kpi-green'  },
    { label:'On Leave',        value:onLeave,                     icon:'🏖', color:'kpi-yellow' },
    { label:'Monthly Payroll', value:formatCurrency(monthly,true),icon:'💰', color:'kpi-orange' },
  ].forEach((k,i) => {
    el.innerHTML += `<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}">
      <div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
    </div>`;
  });
}

function switchHRTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.hr-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`hr-tab-${tab}`)?.classList.add('active');
  const c = document.getElementById('hr-tab-content'); if(!c) return;
  _cleanupListeners();
  switch(tab) {
    case 'attendance': renderAttendanceTab(c); break;
    case 'payroll':    renderPayrollTab(c);    break;
    case 'leaves':     renderLeavesTab(c);     break;
    case 'calendar':   renderTeamCalendar(c);  break;
  }
}

// ══════════════════════════════════════════════════════════════
// ATTENDANCE TAB — with edit modal, overtime, late marks
// ══════════════════════════════════════════════════════════════
let _attendance=[], _filtAtt=[], _pageAtt=1;
let _attEditDoc = null; // doc being edited

function renderAttendanceTab(container) {
  const today = new Date().toISOString().slice(0,10);
  const todayLabel = new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'});

  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);margin-bottom:var(--space-5);">
      <!-- Today card -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📅 Mark Attendance — Today</div>
          <span style="font-size:11px;color:var(--text-muted);">${todayLabel}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;" id="att-today-list">
          ${_buildTodayList(today)}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" style="flex:1;" onclick="markAllPresent('${today}')">✅ All Present</button>
          <button class="btn btn-secondary btn-sm" onclick="openCheckinModal('${today}')">⏱ Detailed Check-in</button>
          <button class="btn btn-secondary btn-sm" onclick="exportAttendance()">⬇ Export</button>
        </div>
      </div>

      <!-- Monthly summary -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📊 Monthly Summary</div>
          <select id="att-month-select" class="form-select" style="width:auto;" onchange="loadAttSummary(this.value)">
            ${Array.from({length:6},(_,i)=>{
              const d=new Date(); d.setMonth(d.getMonth()-i);
              const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
              return `<option value="${val}">${d.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</option>`;
            }).join('')}
          </select>
        </div>
        <div id="att-summary-content">
          <div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>
        </div>
      </div>
    </div>

    <!-- Attendance log table -->
    ${searchBar({
      id:'att',
      placeholder:'Search employee name or date…',
      filters:[
        {key:'status',label:'All Status',options:[
          {value:'present',label:'Present'},
          {value:'absent',label:'Absent'},
          {value:'half-day',label:'Half Day'},
          {value:'leave',label:'Leave'},
          {value:'wfh',label:'WFH'},
          {value:'late',label:'Late'},
        ]},
        {key:'date',label:'Today only',options:[{value:today,label:"Today's records only"}]},
      ],
      onSearch:'attSearch', onFilter:'attFilter',
    })}
    <div id="att-table-wrap"></div>
    <div id="att-pagination"></div>
  `;

  // Build attendance edit modal (once)
  document.getElementById('att-edit-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildAttEditModal());
  document.getElementById('checkin-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildCheckinModal(today));

  // Listener
  const cid = AuthState.company?.id;
  _unsubs.push(dbListen(
    HR_COLLECTIONS.ATTENDANCE,
    cid ? [where('companyId','==',cid), orderBy('date','desc')] : [orderBy('date','desc')],
    data => {
      _attendance = data; _filtAtt = [...data];
      _renderAttTable();
      _refreshTodayList(today); // Refresh today's marks live
    }
  ));

  window.attSearch  = debounce((q) => {
    _filtAtt = _attendance.filter(a => {
      const e = _employees.find(x=>x.id===a.employeeId);
      return (e?.name||'').toLowerCase().includes(q.toLowerCase()) || (a.date||'').includes(q);
    });
    _pageAtt=1; _renderAttTable();
  }, 250);
  window.attFilter  = (k,v) => { _filtAtt=v?_attendance.filter(a=>a[k]===v):[..._attendance]; _pageAtt=1; _renderAttTable(); };
  window.setAttPage = (p) => { _pageAtt=p; _renderAttTable(); };

  loadAttSummary(new Date().toISOString().slice(0,7));
}

function _buildTodayList(today) {
  const active = _employees.filter(e=>(e.status||'active')!=='inactive');
  if (!active.length) return `<div style="text-align:center;padding:30px;color:var(--text-muted);">No active employees</div>`;
  return active.map(emp => {
    const rec = _attendance.find(a=>a.employeeId===emp.id&&a.date===today);
    const st  = rec?.status||'';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);" id="att-today-${emp.id}">
      <div style="width:30px;height:30px;border-radius:8px;background:rgba(10,132,255,0.12);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--brand-primary);flex-shrink:0;">
        ${(emp.name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(emp.name||'—')}</div>
        <div style="font-size:10px;color:var(--text-muted);">${escHtml(emp.designation||emp.department||'—')}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="att-status-btn att-present ${st==='present'?'ring':''}" onclick="markAttendance('${emp.id}','present','${today}')" title="Present">P</button>
        <button class="att-status-btn att-half   ${st==='half-day'?'ring':''}" onclick="markAttendance('${emp.id}','half-day','${today}')" title="Half Day">½</button>
        <button class="att-status-btn att-wfh    ${st==='wfh'?'ring':''}" onclick="markAttendance('${emp.id}','wfh','${today}')" title="WFH">WFH</button>
        <button class="att-status-btn att-leave  ${st==='leave'?'ring':''}" onclick="markAttendance('${emp.id}','leave','${today}')" title="Leave">L</button>
        <button class="att-status-btn att-absent ${st==='absent'?'ring':''}" onclick="markAttendance('${emp.id}','absent','${today}')" title="Absent">A</button>
      </div>
      ${rec?`<span style="font-size:10px;color:var(--text-muted);flex-shrink:0;">${rec.checkIn||''}${rec.checkOut?'→'+rec.checkOut:''}</span>`:''}
    </div>`;
  }).join('');
}

function _refreshTodayList(today) {
  const list = document.getElementById('att-today-list');
  if (list) list.innerHTML = _buildTodayList(today);
}

function _buildAttEditModal() {
  return buildModal({
    id:'att-edit-modal', title:'Edit Attendance Record',
    body:`
      <input type="hidden" id="att-edit-id">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Employee</label>
          <select id="att-edit-emp" class="form-select">
            ${_employees.filter(e=>(e.status||'active')!=='inactive').map(e=>`<option value="${e.id}">${escHtml(e.name||'—')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="att-edit-date" class="form-input">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Status <span class="required">*</span></label>
          <select id="att-edit-status" class="form-select" onchange="calcAttHours()">
            <option value="present">Present</option>
            <option value="half-day">Half Day</option>
            <option value="absent">Absent</option>
            <option value="leave">Leave</option>
            <option value="wfh">WFH</option>
            <option value="late">Late</option>
            <option value="holiday">Holiday</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Check-in Time</label>
          <input type="time" id="att-edit-checkin" class="form-input" oninput="calcAttHours()">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Check-out Time</label>
          <input type="time" id="att-edit-checkout" class="form-input" oninput="calcAttHours()">
        </div>
        <div class="form-group">
          <label class="form-label">Break (minutes)</label>
          <input type="number" id="att-edit-break" class="form-input" placeholder="30" min="0" max="120" oninput="calcAttHours()">
        </div>
      </div>
      <div class="form-grid-3" id="att-hours-summary" style="margin-bottom:var(--space-3);background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;"></div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input type="text" id="att-edit-notes" class="form-input" placeholder="Late by traffic, doctor visit…">
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('att-edit-modal')">Cancel</button>
      <button class="btn btn-primary" id="att-edit-save-btn" onclick="saveAttEdit()">Save Record</button>
    `,
  });
}

function _buildCheckinModal(today) {
  const empOpts = _employees.filter(e=>(e.status||'active')!=='inactive')
    .map(e=>`<option value="${e.id}">${escHtml(e.name||'—')} — ${escHtml(e.designation||e.department||'')}</option>`).join('');
  return buildModal({
    id:'checkin-modal', title:'⏱ Detailed Check-in / Check-out',
    body:`
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Employee <span class="required">*</span></label>
          <select id="ci-emp" class="form-select"><option value="">Select…</option>${empOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input type="date" id="ci-date" class="form-input" value="${today}">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Check-in Time <span class="required">*</span></label>
          <input type="time" id="ci-in" class="form-input" value="${new Date().toTimeString().slice(0,5)}" oninput="calcCheckinHours()">
        </div>
        <div class="form-group">
          <label class="form-label">Check-out Time</label>
          <input type="time" id="ci-out" class="form-input" oninput="calcCheckinHours()">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Break (minutes)</label>
          <input type="number" id="ci-break" class="form-input" placeholder="30" value="30" oninput="calcCheckinHours()">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="ci-status" class="form-select">
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="half-day">Half Day</option>
            <option value="wfh">WFH</option>
          </select>
        </div>
      </div>
      <div id="ci-hours-display" style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;margin-bottom:var(--space-3);font-size:12px;color:var(--text-muted);">Hours will appear once check-in and check-out are set.</div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input type="text" id="ci-notes" class="form-input" placeholder="Visited client site, working from home…">
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('checkin-modal')">Cancel</button>
      <button class="btn btn-primary" id="ci-save-btn" onclick="saveCheckin()">Save Check-in</button>
    `,
  });
}

function _renderAttTable() {
  const wrap = document.getElementById('att-table-wrap'); if(!wrap) return;
  const cnt  = document.getElementById('att-count'); if(cnt) cnt.textContent=`${_filtAtt.length} record${_filtAtt.length!==1?'s':''}`;
  const start= (_pageAtt-1)*PER;
  wrap.innerHTML = buildTable({
    id:'att-table',
    columns:[
      { key:'employeeId',label:'Employee',  render:r=>{const e=_employees.find(x=>x.id===r.employeeId)||{}; return avatarCell(e.name||'—',e.department||'','var(--brand-warning)','rgba(255,159,10,0.12)');} },
      { key:'date',      label:'Date',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.date||'—'}</span>` },
      { key:'checkIn',   label:'In',        render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">${r.checkIn||'—'}</span>` },
      { key:'checkOut',  label:'Out',       render:r=>`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-danger);">${r.checkOut||'—'}</span>` },
      { key:'hours',     label:'Hours',     render:r=>r.hours?_hoursCell(r):'—' },
      { key:'overtime',  label:'OT',        render:r=>r.overtime>0?`<span style="font-family:var(--font-mono);font-size:11px;color:var(--brand-warning);">+${r.overtime}h</span>`:'—' },
      { key:'status',    label:'Status',    render:r=>badge(r.status||'present') },
      { key:'notes',     label:'Notes',     render:r=>`<span style="font-size:11px;color:var(--text-muted);">${escHtml((r.notes||'').slice(0,40))}</span>` },
      { key:'actions',   label:'',sortable:false, render:r=>actionsMenu(r.id,[
          {icon:'✏️',label:'Edit',  action:`editAttRecord('${r.id}')`},
          {icon:'🗑',label:'Delete',action:`deleteAtt('${r.id}')`,danger:true},
        ])
      },
    ],
    rows: _filtAtt.slice(start, start+PER),
    emptyMsg: 'No attendance records',
  });
  document.getElementById('att-pagination').innerHTML = buildPagination({
    id:'att', total:_filtAtt.length, page:_pageAtt, perPage:PER, onChange:'setAttPage',
  });
}

function _hoursCell(r) {
  const h = Number(r.hours)||0;
  const color = h>=9?'var(--brand-secondary)':h>=8?'var(--text-primary)':'var(--brand-warning)';
  return `<span style="font-family:var(--font-mono);font-size:12px;color:${color};font-weight:600;">${h}h</span>`;
}

// Mark attendance (quick buttons)
window.markAttendance = async (empId, status, date) => {
  const existing = _attendance.find(a=>a.employeeId===empId&&a.date===date);
  const checkIn  = (status==='present'||status==='wfh'||status==='late')?'09:00':(status==='half-day'?'09:00':'');
  const checkOut = status==='present'||status==='wfh'?'18:00':status==='half-day'?'13:00':'';
  const hours    = status==='present'||status==='wfh'?9:status==='half-day'?4.5:status==='late'?8:0;
  const overtime = 0;
  const data = {
    employeeId:empId, date, status,
    checkIn, checkOut, hours, overtime,
    break:30,
    companyId:AuthState.company?.id||null,
  };
  try {
    if (existing) { await dbUpdate(HR_COLLECTIONS.ATTENDANCE, existing.id, data); }
    else          { await dbCreate(HR_COLLECTIONS.ATTENDANCE, data); }
    const emp = _employees.find(e=>e.id===empId);
    Toast.success('Marked', `${emp?.name||'Employee'} — ${status}`);
  } catch(e) { Toast.error('Failed', e.message); }
};

window.markAllPresent = async (date) => {
  const active = _employees.filter(e=>(e.status||'active')!=='inactive');
  if (!confirm(`Mark all ${active.length} active employees as Present for ${date}?`)) return;
  await Promise.all(active.map(emp=>window.markAttendance(emp.id,'present',date)));
  Toast.success('Done',`All ${active.length} marked Present.`);
};

window.deleteAtt = async (id) => {
  if (!confirm('Delete this attendance record?')) return;
  try { await dbDelete(HR_COLLECTIONS.ATTENDANCE, id); Toast.success('Deleted','Record removed.'); }
  catch(e) { Toast.error('Failed', e.message); }
};

window.editAttRecord = (id) => {
  const r = _attendance.find(x=>x.id===id); if(!r) return;
  _attEditDoc = r;
  document.getElementById('att-edit-id').value = r.id;
  const empSel = document.getElementById('att-edit-emp');
  if (empSel) empSel.value = r.employeeId||'';
  document.getElementById('att-edit-date').value    = r.date||'';
  document.getElementById('att-edit-status').value  = r.status||'present';
  document.getElementById('att-edit-checkin').value = r.checkIn||'';
  document.getElementById('att-edit-checkout').value= r.checkOut||'';
  document.getElementById('att-edit-break').value   = r.break||30;
  document.getElementById('att-edit-notes').value   = r.notes||'';
  calcAttHours();
  openModal('att-edit-modal');
};

window.calcAttHours = () => {
  const inT  = document.getElementById('att-edit-checkin')?.value;
  const outT = document.getElementById('att-edit-checkout')?.value;
  const brk  = Number(document.getElementById('att-edit-break')?.value)||0;
  const el   = document.getElementById('att-hours-summary');
  if (!el) return;
  if (!inT||!outT) { el.innerHTML=''; return; }
  const [ih,im] = inT.split(':').map(Number);
  const [oh,om] = outT.split(':').map(Number);
  const totalMins = (oh*60+om)-(ih*60+im)-brk;
  if (totalMins<=0) { el.innerHTML='<div style="color:var(--brand-danger);font-size:12px;">⚠ Check-out must be after check-in + break</div>'; return; }
  const hrs      = +(totalMins/60).toFixed(2);
  const stdHrs   = 8;
  const overtime = Math.max(0,+(hrs-stdHrs).toFixed(2));
  const lateBy   = (ih*60+im)>9*60?`${ih*60+im-540} min late`:'On time';
  el.innerHTML = `
    <div class="leave-bal" style="text-align:left;">
      <div style="font-size:10px;color:var(--text-muted);">Working Hours</div>
      <div style="font-size:16px;font-weight:700;color:var(--brand-secondary);">${hrs}h</div>
    </div>
    <div class="leave-bal" style="text-align:left;">
      <div style="font-size:10px;color:var(--text-muted);">Overtime</div>
      <div style="font-size:16px;font-weight:700;color:var(--brand-warning);">${overtime>0?'+'+overtime+'h':'—'}</div>
    </div>
    <div class="leave-bal" style="text-align:left;">
      <div style="font-size:10px;color:var(--text-muted);">Punctuality</div>
      <div style="font-size:13px;font-weight:600;color:${overtime>=0&&lateBy==='On time'?'var(--brand-secondary)':'var(--brand-warning)'};">${lateBy}</div>
    </div>
  `;
  // Store computed values for save
  el.dataset.hours    = hrs;
  el.dataset.overtime = overtime;
};

window.saveAttEdit = async () => {
  const id     = document.getElementById('att-edit-id').value;
  const empId  = document.getElementById('att-edit-emp')?.value;
  const date   = document.getElementById('att-edit-date')?.value;
  if (!empId||!date) { Toast.warning('Missing','Select employee and date.'); return; }
  const btn    = document.getElementById('att-edit-save-btn');
  setLoading(btn,true);
  const summary= document.getElementById('att-hours-summary');
  const data = {
    employeeId: empId,
    date,
    status:   document.getElementById('att-edit-status')?.value||'present',
    checkIn:  document.getElementById('att-edit-checkin')?.value||'',
    checkOut: document.getElementById('att-edit-checkout')?.value||'',
    break:    Number(document.getElementById('att-edit-break')?.value)||30,
    hours:    Number(summary?.dataset.hours)||0,
    overtime: Number(summary?.dataset.overtime)||0,
    notes:    document.getElementById('att-edit-notes')?.value?.trim()||'',
    companyId:AuthState.company?.id||null,
  };
  try {
    if (id) { await dbUpdate(HR_COLLECTIONS.ATTENDANCE, id, data); Toast.success('Updated','Attendance record updated.'); }
    else    { await dbCreate(HR_COLLECTIONS.ATTENDANCE, data);      Toast.success('Added','Attendance record added.'); }
    closeModal('att-edit-modal');
  } catch(e) { Toast.error('Failed',e.message); }
  finally    { setLoading(btn,false); }
};

window.openCheckinModal = (date) => {
  document.getElementById('ci-date').value = date;
  const now = new Date().toTimeString().slice(0,5);
  document.getElementById('ci-in').value  = now;
  document.getElementById('ci-out').value = '';
  document.getElementById('ci-hours-display').textContent='Hours will appear once check-in and check-out are set.';
  openModal('checkin-modal');
};

window.calcCheckinHours = () => {
  const inT  = document.getElementById('ci-in')?.value;
  const outT = document.getElementById('ci-out')?.value;
  const brk  = Number(document.getElementById('ci-break')?.value)||30;
  const el   = document.getElementById('ci-hours-display');
  if (!el||!inT||!outT) return;
  const [ih,im]=[...inT.split(':').map(Number)];
  const [oh,om]=[...outT.split(':').map(Number)];
  const mins  = (oh*60+om)-(ih*60+im)-brk;
  if (mins<=0) { el.textContent='⚠ Invalid time range'; return; }
  const hrs   = +(mins/60).toFixed(2);
  const ot    = Math.max(0,+(hrs-8).toFixed(2));
  el.innerHTML=`<span style="font-weight:600;color:var(--brand-secondary);">${hrs}h worked</span> ${ot>0?`<span style="color:var(--brand-warning);"> · +${ot}h overtime</span>`:''}`;
  el.dataset.hours=hrs; el.dataset.overtime=ot;
};

window.saveCheckin = async () => {
  const empId = document.getElementById('ci-emp')?.value;
  const date  = document.getElementById('ci-date')?.value;
  if (!empId||!date) { Toast.warning('Missing','Select employee and date.'); return; }
  const btn   = document.getElementById('ci-save-btn');
  setLoading(btn,true);
  const hel   = document.getElementById('ci-hours-display');
  const existing = _attendance.find(a=>a.employeeId===empId&&a.date===date);
  const data  = {
    employeeId:empId, date,
    status:   document.getElementById('ci-status')?.value||'present',
    checkIn:  document.getElementById('ci-in')?.value||'',
    checkOut: document.getElementById('ci-out')?.value||'',
    break:    Number(document.getElementById('ci-break')?.value)||30,
    hours:    Number(hel?.dataset.hours)||0,
    overtime: Number(hel?.dataset.overtime)||0,
    notes:    document.getElementById('ci-notes')?.value?.trim()||'',
    companyId:AuthState.company?.id||null,
  };
  try {
    if (existing) { await dbUpdate(HR_COLLECTIONS.ATTENDANCE,existing.id,data); }
    else          { await dbCreate(HR_COLLECTIONS.ATTENDANCE,data); }
    Toast.success('Saved','Check-in recorded.');
    closeModal('checkin-modal');
  } catch(e) { Toast.error('Failed',e.message); }
  finally    { setLoading(btn,false); }
};

window.exportAttendance = async () => {
  if (window.LAMPrint) {
    const emps = await dbGetAll(COLLECTIONS.EMPLOYEES,[where('companyId','==',AuthState.company?.id||'')]).catch(()=>[]);
    window.LAMPrint.attendanceSheet(_attendance,emps,{company:AuthState.company||{},month:new Date().toISOString().slice(0,7)});
  } else if (window.LAMEXCEL) {
    window.LAMEXCEL.exportTable(_attendance,{title:'Attendance',filename:'Attendance.xlsx'});
  } else {
    // Fallback CSV
    const rows = _filtAtt.map(a => {
      const e = _employees.find(x=>x.id===a.employeeId)||{};
      return [e.name||'—', a.date||'', a.status||'', a.checkIn||'', a.checkOut||'', a.hours||0, a.overtime||0, a.notes||''];
    });
    const csv = [['Employee','Date','Status','Check-in','Check-out','Hours','Overtime','Notes'],...rows]
      .map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='attendance_export.csv'; a.click();
    Toast.success('Exported',`${_filtAtt.length} records exported.`);
  }
};

async function loadAttSummary(month) {
  const el = document.getElementById('att-summary-content'); if(!el) return;
  el.innerHTML = '<div style="display:flex;justify-content:center;padding:20px;"><div class="spinner"></div></div>';
  try {
    const [year,mo] = month.split('-');
    const records   = await dbGetAll(HR_COLLECTIONS.ATTENDANCE,[
      ...(AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
      where('date','>=',`${month}-01`),
      where('date','<=',`${month}-31`),
    ]);
    const daysInMonth = new Date(Number(year),Number(mo),0).getDate();
    const summary = _employees.map(emp=>{
      const recs    = records.filter(r=>r.employeeId===emp.id);
      const present = recs.filter(r=>r.status==='present').length;
      const half    = recs.filter(r=>r.status==='half-day').length;
      const wfh     = recs.filter(r=>r.status==='wfh').length;
      const absent  = recs.filter(r=>r.status==='absent').length;
      const leave   = recs.filter(r=>r.status==='leave').length;
      const late    = recs.filter(r=>r.status==='late').length;
      const ot      = recs.reduce((s,r)=>s+(Number(r.overtime)||0),0);
      const worked  = present+half*0.5+wfh;
      const pct     = daysInMonth?Math.round((worked/daysInMonth)*100):0;
      return {name:emp.name,designation:emp.designation||emp.role,present,half,wfh,absent,leave,late,ot,pct};
    });
    const totalOT = summary.reduce((s,r)=>s+r.ot,0);
    el.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;">
        <span>Working days in month: ${daysInMonth}</span>
        <span>Total OT: ${totalOT.toFixed(1)}h</span>
      </div>
      <div class="table-container" style="max-height:260px;overflow-y:auto;">
        <table class="table">
          <thead><tr><th>Employee</th><th>P</th><th>½</th><th>WFH</th><th>A</th><th>L</th><th>OT</th><th style="min-width:60px;">%</th></tr></thead>
          <tbody>
            ${summary.map(s=>`<tr>
              <td>
                <div style="font-size:12px;font-weight:500;">${escHtml(s.name||'—')}</div>
                <div style="font-size:10px;color:var(--text-muted);">${escHtml(s.designation||'')}</div>
              </td>
              <td style="font-family:var(--font-mono);color:var(--brand-secondary);">${s.present}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-warning);">${s.half}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-primary);">${s.wfh}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-danger);">${s.absent}</td>
              <td style="font-family:var(--font-mono);">${s.leave}</td>
              <td style="font-family:var(--font-mono);color:var(--brand-warning);">${s.ot>0?'+'+s.ot.toFixed(1):'—'}</td>
              <td>
                <div style="display:flex;align-items:center;gap:6px;">
                  <div style="flex:1;height:4px;background:var(--border-subtle);border-radius:2px;overflow:hidden;">
                    <div style="width:${s.pct}%;height:100%;background:${s.pct>=90?'var(--brand-secondary)':s.pct>=75?'var(--brand-warning)':'var(--brand-danger)'};transition:width 0.4s;"></div>
                  </div>
                  <span style="font-size:11px;font-weight:700;color:${s.pct>=90?'var(--brand-secondary)':s.pct>=75?'var(--brand-warning)':'var(--brand-danger)'};">${s.pct}%</span>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(e) {
    el.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">Could not load attendance summary</div>`;
  }
}
window.loadAttSummary = loadAttSummary;

// ══════════════════════════════════════════════════════════════
// PAYROLL TAB — configurable deductions, LOP, overtime pay
// ══════════════════════════════════════════════════════════════
let _payrollRuns=[], _filtPayroll=[], _pagePayroll=1;

function _defaultPayConfig() {
  return {
    pf_rate:       12,    // % of basic
    esi_rate_emp:  0.75,  // % of gross (if ≤21000)
    esi_rate_er:   3.25,
    tds_threshold: 50000, // per month basic threshold
    tds_rate:      10,
    pt_enabled:    true,
    ot_rate:       1.5,   // overtime multiplier
    std_hours:     8,
  };
}

function renderPayrollTab(container) {
  const config = _payConfig || _defaultPayConfig();
  container.innerHTML = `
    <div class="grid-2" style="align-items:start;gap:var(--space-5);margin-bottom:var(--space-5);">
      <!-- Run payroll -->
      <div class="card">
        <div class="card-header"><div class="card-title">⚡ Run Payroll</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Month <span class="required">*</span></label>
              <select id="pr-month" class="form-select" onchange="refreshPayrollPreview()">
                ${Array.from({length:12},(_,i)=>{
                  const d=new Date(); d.setMonth(d.getMonth()-i);
                  const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                  return `<option value="${val}">${d.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</option>`;
                }).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Payment Date</label>
              <input type="date" id="pr-pay-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Payroll Preview</div>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">
              <input type="checkbox" id="pr-include-ot" onchange="refreshPayrollPreview()"> Include OT Pay
            </label>
          </div>
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);overflow:hidden;max-height:300px;overflow-y:auto;" id="pr-preview-wrap">
            <div style="display:flex;justify-content:center;padding:30px;"><div class="spinner"></div></div>
          </div>

          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="refreshPayrollPreview()">↻ Refresh Preview</button>
            <button class="btn btn-primary" style="flex:1;" id="run-payroll-btn" onclick="runPayroll()">🚀 Process Payroll</button>
          </div>
        </div>
      </div>

      <!-- Config -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚙️ Deduction Configuration</div>
          <button class="btn btn-secondary btn-sm" onclick="savePayConfig()">💾 Save Config</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;max-height:360px;overflow-y:auto;">
          ${[
            {id:'pc-pf',       label:'PF Rate (Employee & Employer)',  val:config.pf_rate,      unit:'%',   note:'Of Basic Salary'},
            {id:'pc-esi-emp',  label:'ESI (Employee)',                  val:config.esi_rate_emp, unit:'%',   note:'If gross ≤ ₹21,000'},
            {id:'pc-esi-er',   label:'ESI (Employer)',                  val:config.esi_rate_er,  unit:'%',   note:'If gross ≤ ₹21,000'},
            {id:'pc-tds-thr',  label:'TDS Threshold',                   val:config.tds_threshold,unit:'₹',   note:'Monthly basic above which TDS applies'},
            {id:'pc-tds-rate', label:'TDS Rate',                        val:config.tds_rate,     unit:'%',   note:'On amount above threshold'},
            {id:'pc-ot',       label:'Overtime Multiplier',             val:config.ot_rate,      unit:'×',   note:'e.g. 1.5 = 1.5× hourly rate'},
            {id:'pc-std-hrs',  label:'Standard Work Hours/Day',         val:config.std_hours,    unit:'hrs', note:'For overtime calculation'},
          ].map(c=>`
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:500;">${c.label}</div>
                <div style="font-size:10px;color:var(--text-muted);">${c.note}</div>
              </div>
              <input type="number" id="${c.id}" class="form-input" style="width:80px;text-align:right;" value="${c.val}" step="0.01" onchange="refreshPayrollPreview()">
              <span style="font-size:12px;color:var(--text-muted);min-width:20px;">${c.unit}</span>
            </div>`).join('')}
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:500;">Professional Tax</div>
              <div style="font-size:10px;color:var(--text-muted);">Kerala PT slab (up to ₹200/month)</div>
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;">
              <input type="checkbox" id="pc-pt" ${config.pt_enabled?'checked':''}> Enabled
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Payroll history -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📜 Payroll History</div>
        <button class="btn btn-secondary btn-sm" onclick="exportPayrollHistory()">⬇ Export</button>
      </div>
      <div id="payroll-history-list">
        <div style="display:flex;justify-content:center;padding:30px;"><div class="spinner"></div></div>
      </div>
    </div>
  `;

  loadPayrollHistory();
  setTimeout(refreshPayrollPreview, 300);

  window.savePayConfig = async () => {
    const cfg = _readPayConfig();
    const cid = AuthState.company?.id;
    try {
      if (_payConfig?.id) {
        await dbUpdate(HR_COLLECTIONS.PAY_CONFIG, _payConfig.id, {...cfg, companyId:cid});
      } else {
        await dbCreate(HR_COLLECTIONS.PAY_CONFIG, {...cfg, companyId:cid});
      }
      _payConfig = {...cfg, id:_payConfig?.id};
      Toast.success('Saved','Pay config updated.');
    } catch(e) { Toast.error('Failed',e.message); }
  };

  window.refreshPayrollPreview = async () => {
    const wrap   = document.getElementById('pr-preview-wrap'); if(!wrap) return;
    const month  = document.getElementById('pr-month')?.value||'';
    const cfg    = _readPayConfig();
    const incOT  = document.getElementById('pr-include-ot')?.checked||false;

    // Load attendance for LOP calculation
    let attRecs = [];
    try {
      attRecs = await dbGetAll(HR_COLLECTIONS.ATTENDANCE,[
        ...(AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
        where('date','>=',`${month}-01`), where('date','<=',`${month}-31`),
      ]);
    } catch {}

    const [year,mo] = (month||'-').split('-').map(Number);
    const daysInMonth = month?new Date(year,mo,0).getDate():26;
    const active = _employees.filter(e=>(e.status||'active')!=='inactive');
    const rows   = active.map(emp=>_calcSlip(emp,attRecs,cfg,daysInMonth,incOT));
    const totGross = rows.reduce((s,r)=>s+r.gross,0);
    const totDed   = rows.reduce((s,r)=>s+r.totalDed,0);
    const totNet   = rows.reduce((s,r)=>s+r.net,0);

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr style="background:var(--bg-overlay);">
          <th style="padding:8px 10px;text-align:left;color:var(--text-muted);font-size:10px;text-transform:uppercase;">Employee</th>
          <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:10px;">Basic</th>
          <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:10px;">Gross</th>
          <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:10px;">Deductions</th>
          <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:10px;">LOP</th>
          <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:10px;">Net Pay</th>
        </tr></thead>
        <tbody>
          ${rows.map(r=>`<tr style="border-bottom:1px solid var(--border-subtle);">
            <td style="padding:8px 10px;">
              <div style="font-size:12px;font-weight:500;">${escHtml(r.name)}</div>
              <div style="font-size:10px;color:var(--text-muted);">${escHtml(r.designation||'')}</div>
            </td>
            <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);">₹${r.basic.toLocaleString('en-IN')}</td>
            <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);">₹${r.gross.toLocaleString('en-IN')}</td>
            <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);color:var(--brand-danger);">-₹${r.totalDed.toLocaleString('en-IN')}</td>
            <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);color:var(--brand-warning);">${r.lopDays>0?'-'+r.lopDays+'d':'—'}</td>
            <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${r.net.toLocaleString('en-IN')}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="background:var(--bg-overlay);font-weight:700;">
          <td style="padding:8px 10px;">TOTAL (${rows.length} employees)</td>
          <td></td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);">₹${totGross.toLocaleString('en-IN')}</td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);color:var(--brand-danger);">-₹${totDed.toLocaleString('en-IN')}</td>
          <td></td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);color:var(--brand-secondary);">₹${totNet.toLocaleString('en-IN')}</td>
        </tr></tfoot>
      </table>
    `;
  };

  window.runPayroll = async () => {
    const month   = document.getElementById('pr-month')?.value;
    const payDate = document.getElementById('pr-pay-date')?.value;
    if (!month) { Toast.warning('Missing','Select payroll month.'); return; }
    if (!confirm(`Process payroll for ${month}? This will create payslips for all active employees.`)) return;
    const btn = document.getElementById('run-payroll-btn');
    setLoading(btn,true);
    try {
      const cfg  = _readPayConfig();
      const incOT= document.getElementById('pr-include-ot')?.checked||false;
      let attRecs=[];
      try {
        attRecs = await dbGetAll(HR_COLLECTIONS.ATTENDANCE,[
          ...(AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
          where('date','>=',`${month}-01`), where('date','<=',`${month}-31`),
        ]);
      } catch {}
      const [year,mo]  = month.split('-').map(Number);
      const daysInMonth= new Date(year,mo,0).getDate();
      const active     = _employees.filter(e=>(e.status||'active')!=='inactive');
      const slips      = active.map(emp=>({..._calcSlip(emp,attRecs,cfg,daysInMonth,incOT),employeeId:emp.id,employeeName:emp.name,paymentDate:payDate,status:'paid'}));
      await dbCreate(HR_COLLECTIONS.PAYROLL,{
        month, paymentDate:payDate,
        slips,
        totalGross:slips.reduce((s,sl)=>s+sl.gross,0),
        totalNet:  slips.reduce((s,sl)=>s+sl.net,0),
        totalDeductions:slips.reduce((s,sl)=>s+sl.totalDed,0),
        employeeCount:active.length,
        processedBy:AuthState.profile?.name||'Admin',
        config:cfg,
        companyId:AuthState.company?.id||null,
      });
      Toast.success('Payroll Processed!',`${active.length} employees paid for ${month}.`);
      loadPayrollHistory();
    } catch(e) { Toast.error('Failed',e.message); }
    finally { setLoading(btn,false); }
  };

  window.exportPayrollHistory = async () => {
    if (window.LAMPrint) {
      window.LAMPrint.payrollRegister(_payrollRuns||[],_employees,{company:AuthState.company||{}});
    } else if (window.LAMEXCEL) {
      window.LAMEXCEL.exportTable(_payrollRuns||[],{title:'Payroll',filename:'Payroll.xlsx'});
    } else Toast.info('Export','Payroll exported.');
  };
}

function _readPayConfig() {
  return {
    pf_rate:       Number(document.getElementById('pc-pf')?.value)||12,
    esi_rate_emp:  Number(document.getElementById('pc-esi-emp')?.value)||0.75,
    esi_rate_er:   Number(document.getElementById('pc-esi-er')?.value)||3.25,
    tds_threshold: Number(document.getElementById('pc-tds-thr')?.value)||50000,
    tds_rate:      Number(document.getElementById('pc-tds-rate')?.value)||10,
    pt_enabled:    document.getElementById('pc-pt')?.checked??true,
    ot_rate:       Number(document.getElementById('pc-ot')?.value)||1.5,
    std_hours:     Number(document.getElementById('pc-std-hrs')?.value)||8,
  };
}

function _calcSlip(emp, attRecs, cfg, daysInMonth, incOT=false) {
  const empRecs     = attRecs.filter(a=>a.employeeId===emp.id);
  const lopDays     = empRecs.filter(a=>a.status==='absent'||a.status==='lop').length;
  const otHours     = empRecs.reduce((s,a)=>s+(Number(a.overtime)||0),0);

  const basic       = Number(emp.salary)||0;
  const hra         = Number(emp.hra)||Math.round(basic*0.4);
  const conv        = Number(emp.convAllowance)||1600;
  const med         = Number(emp.medAllowance)||1250;
  const special     = Number(emp.specialAllowance)||0;
  const grossBase   = basic+hra+conv+med+special;

  // LOP deduction
  const perDay      = daysInMonth>0?grossBase/daysInMonth:0;
  const lopDeduction= Math.round(perDay*lopDays);

  // OT pay
  const hourlyRate  = daysInMonth>0?basic/(daysInMonth*cfg.std_hours):0;
  const otPay       = incOT?Math.round(hourlyRate*otHours*cfg.ot_rate):0;

  const gross       = grossBase - lopDeduction + otPay;

  // Statutory deductions
  const pfEmp       = Math.round(basic*cfg.pf_rate/100);
  const pfEr        = Math.round(basic*cfg.pf_rate/100);
  const esiEmp      = basic<=21000?Math.round(gross*cfg.esi_rate_emp/100):0;
  const esiEr       = basic<=21000?Math.round(gross*cfg.esi_rate_er/100):0;
  const tds         = basic>cfg.tds_threshold?Math.round((basic-cfg.tds_threshold)*cfg.tds_rate/100/12):0;
  const pt          = cfg.pt_enabled?_getPT(gross):0;
  const totalDed    = pfEmp+esiEmp+tds+pt;
  const net         = Math.max(0,gross-totalDed);
  const ctc         = gross+pfEr+esiEr;

  return {
    name:emp.name||'—', designation:emp.designation||emp.role||'',
    basic, hra, conv, med, special, grossBase,
    lopDays, lopDeduction, otHours, otPay, gross,
    pfEmp, pfEr, esiEmp, esiEr, tds, pt, totalDed,
    net, ctc,
  };
}

function _getPT(grossMonthly) {
  // Kerala professional tax slabs (per month)
  if (grossMonthly > 20000) return 200;
  if (grossMonthly > 15000) return 150;
  if (grossMonthly > 10000) return 110;
  if (grossMonthly > 7500)  return 75;
  return 0;
}

async function loadPayrollHistory() {
  const el = document.getElementById('payroll-history-list'); if(!el) return;
  try {
    const cid  = AuthState.company?.id;
    _payrollRuns = await dbGetAll(HR_COLLECTIONS.PAYROLL, cid?[where('companyId','==',cid),orderBy('month','desc')]:[orderBy('month','desc')]);
    if (!_payrollRuns.length) {
      el.innerHTML=`<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:12px;">No payroll runs yet.</div>`;
      return;
    }
    el.innerHTML = `<div class="table-container">
      <table class="table">
        <thead><tr><th>Month</th><th>Employees</th><th>Gross</th><th>Deductions</th><th>Net Paid</th><th>Pay Date</th><th>By</th><th>Actions</th></tr></thead>
        <tbody>
          ${_payrollRuns.map(r=>`<tr>
            <td style="font-family:var(--font-mono);font-size:12px;font-weight:600;">${r.month||'—'}</td>
            <td style="font-family:var(--font-mono);">${r.employeeCount||0}</td>
            <td style="font-family:var(--font-mono);">₹${Number(r.totalGross||0).toLocaleString('en-IN')}</td>
            <td style="font-family:var(--font-mono);color:var(--brand-danger);">-₹${Number(r.totalDeductions||0).toLocaleString('en-IN')}</td>
            <td style="font-family:var(--font-mono);font-weight:700;color:var(--brand-secondary);">₹${Number(r.totalNet||0).toLocaleString('en-IN')}</td>
            <td style="font-size:11px;color:var(--text-muted);">${r.paymentDate||'—'}</td>
            <td style="font-size:12px;">${escHtml(r.processedBy||'—')}</td>
            <td>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-secondary btn-sm" onclick="viewPayslips('${r.id}')">Payslips</button>
                <button class="btn btn-danger btn-sm" onclick="deletePayrollRun('${r.id}')">🗑</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  } catch(e) { el.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-muted);">Could not load payroll history</div>`; }
}

window.viewPayslips = async (id) => {
  const run = _payrollRuns.find(r=>r.id===id); if(!run) return;
  Toast.info('Generating…',`Building payslips for ${run.month}…`);
  setTimeout(async()=>{
    if (window.LAMPrint) window.LAMPrint.payrollRegister([run],_employees,{company:AuthState.company||{},month:run.month});
    else Toast.success('Ready',`${run.employeeCount} payslips for ${run.month}`);
  },200);
};

window.deletePayrollRun = async (id) => {
  if (!confirm('Delete this payroll run? This cannot be undone.')) return;
  try { await dbDelete(HR_COLLECTIONS.PAYROLL, id); Toast.success('Deleted','Payroll run removed.'); loadPayrollHistory(); }
  catch(e) { Toast.error('Failed',e.message); }
};

// ══════════════════════════════════════════════════════════════
// LEAVES TAB — balance tracker, carry-forward, types
// ══════════════════════════════════════════════════════════════
let _leaves=[], _filtLeaves=[], _pageLeaves=1;
let _leaveBalances=[];

function renderLeavesTab(container) {
  container.innerHTML = `
    <!-- KPIs -->
    <div class="grid-4" style="margin-bottom:var(--space-4);">
      ${['pending','approved','rejected','on_leave'].map(s=>{
        const count = s==='on_leave'?_employees.filter(e=>e.status==='on_leave').length:_leaves.filter(l=>l.status===s).length;
        const colors={pending:'kpi-yellow',approved:'kpi-green',rejected:'kpi-red',on_leave:'kpi-orange'};
        const icons={pending:'⏳',approved:'✅',rejected:'❌',on_leave:'🏖'};
        return `<div class="kpi-card ${colors[s]}"><div class="kpi-top"><div class="kpi-icon">${icons[s]}</div></div><div class="kpi-value">${count}</div><div class="kpi-label">${s.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}</div></div>`;
      }).join('')}
    </div>

    <!-- Leave balance summary -->
    <div class="card" style="margin-bottom:var(--space-4);">
      <div class="card-header">
        <div class="card-title">📊 Leave Balance Summary</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="lb-emp-filter" class="form-select" style="width:auto;" onchange="loadLeaveBalances(this.value)">
            <option value="">All Employees</option>
            ${_employees.filter(e=>(e.status||'active')!=='inactive').map(e=>`<option value="${e.id}">${escHtml(e.name||'—')}</option>`).join('')}
          </select>
          <button class="btn btn-secondary btn-sm" onclick="initLeaveBalances()">↻ Reset Balances</button>
        </div>
      </div>
      <div id="lb-content" style="overflow-x:auto;">
        <div style="display:flex;justify-content:center;padding:20px;"><div class="spinner"></div></div>
      </div>
    </div>

    <!-- Leave log -->
    ${searchBar({
      id:'leaves',
      placeholder:'Search employee or leave type…',
      filters:[
        {key:'status',label:'All Status',options:[{value:'pending',label:'Pending'},{value:'approved',label:'Approved'},{value:'rejected',label:'Rejected'}]},
        {key:'type',label:'All Types',options:Object.entries(LEAVE_TYPES).map(([v,{label}])=>({value:v,label}))},
      ],
      onSearch:'leavesSearch', onFilter:'leavesFilter',
    })}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary" onclick="openModal('leave-modal')">+ Apply Leave</button>
    </div>
    <div id="leaves-table-wrap"></div>
    <div id="leaves-pagination"></div>
  `;

  // Build leave modal
  document.getElementById('leave-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', _buildLeaveModal());

  // Listener
  const cid = AuthState.company?.id;
  _unsubs.push(dbListen(
    HR_COLLECTIONS.LEAVES,
    cid?[where('companyId','==',cid),orderBy('createdAt','desc')]:[orderBy('createdAt','desc')],
    data => { _leaves=data; _filtLeaves=[...data]; _renderLeavesTable(); }
  ));

  window.leavesSearch = debounce((q) => {
    _filtLeaves = _leaves.filter(l=>{
      const e = _employees.find(x=>x.id===l.employeeId);
      return (e?.name||'').toLowerCase().includes(q.toLowerCase())||
             (l.type||'').toLowerCase().includes(q.toLowerCase());
    }); _pageLeaves=1; _renderLeavesTable();
  },250);
  window.leavesFilter  = (k,v) => { _filtLeaves=v?_leaves.filter(l=>l[k]===v):[..._leaves]; _pageLeaves=1; _renderLeavesTable(); };
  window.setLeavesPage = (p)   => { _pageLeaves=p; _renderLeavesTable(); };

  loadLeaveBalances('');
}

function _buildLeaveModal() {
  const empOpts = _employees.filter(e=>(e.status||'active')!=='inactive')
    .map(e=>`<option value="${e.id}">${escHtml(e.name||'—')}</option>`).join('');
  const typeOpts = Object.entries(LEAVE_TYPES)
    .map(([v,{label}])=>`<option value="${v}">${label}</option>`).join('');
  return buildModal({
    id:'leave-modal', title:'Apply for Leave',
    body:`
      <input type="hidden" id="lv-id">
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">Employee <span class="required">*</span></label>
          <select id="lv-emp" class="form-select"><option value="">Select…</option>${empOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Leave Type <span class="required">*</span></label>
          <select id="lv-type" class="form-select">${typeOpts}</select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label">From Date <span class="required">*</span></label>
          <input type="date" id="lv-from" class="form-input" oninput="calcLeaveDays()">
        </div>
        <div class="form-group">
          <label class="form-label">To Date <span class="required">*</span></label>
          <input type="date" id="lv-to" class="form-input" oninput="calcLeaveDays()">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label">Days</label>
          <input type="text" id="lv-days" class="form-input" readonly style="background:var(--bg-overlay);" value="—">
        </div>
        <div class="form-group">
          <label class="form-label">Half-day leave?</label>
          <select id="lv-half" class="form-select" onchange="calcLeaveDays()">
            <option value="">No</option>
            <option value="first">First half</option>
            <option value="second">Second half</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select id="lv-status" class="form-select">
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Reason <span class="required">*</span></label>
        <textarea id="lv-reason" class="form-textarea" rows="2" placeholder="Reason for leave…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Approved / Remarks</label>
        <input type="text" id="lv-remarks" class="form-input" placeholder="Manager remarks (optional)">
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('leave-modal')">Cancel</button>
      <button class="btn btn-primary" id="leave-save-btn" onclick="saveLeave()">Submit Leave</button>
    `,
  });
}

function _renderLeavesTable() {
  const wrap = document.getElementById('leaves-table-wrap'); if(!wrap) return;
  const cnt  = document.getElementById('leaves-count');
  if (cnt) cnt.textContent=`${_filtLeaves.length} leave${_filtLeaves.length!==1?'s':''}`;
  const start= (_pageLeaves-1)*PER;
  wrap.innerHTML = buildTable({
    id:'leaves-table',
    columns:[
      { key:'employeeId',label:'Employee',  render:r=>{const e=_employees.find(x=>x.id===r.employeeId)||{};return avatarCell(e.name||'—',e.department||'','var(--brand-warning)','rgba(255,159,10,0.12)');} },
      { key:'type',      label:'Type',      render:r=>`<span class="badge badge-blue">${LEAVE_TYPES[r.type]?.label||escHtml(r.type||'—')}</span>` },
      { key:'fromDate',  label:'From',      render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.fromDate||'—'}</span>` },
      { key:'toDate',    label:'To',        render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.toDate||'—'}</span>` },
      { key:'days',      label:'Days',      render:r=>`<span style="font-family:var(--font-mono);font-weight:700;">${r.days||'—'}</span>` },
      { key:'reason',    label:'Reason',    render:r=>`<span style="font-size:11px;color:var(--text-secondary);">${escHtml((r.reason||'').slice(0,40))}${(r.reason||'').length>40?'…':''}</span>` },
      { key:'status',    label:'Status',    render:r=>badge(r.status||'pending') },
      { key:'actions',   label:'',sortable:false, render:r=>actionsMenu(r.id,[
          {icon:'✅',label:'Approve',  action:`approveLeave('${r.id}')`},
          {icon:'❌',label:'Reject',   action:`rejectLeave('${r.id}')`},
          {icon:'✏️',label:'Edit',     action:`editLeave('${r.id}')`},
          {icon:'🗑',label:'Delete',   action:`deleteLeave('${r.id}')`,danger:true},
        ])
      },
    ],
    rows: _filtLeaves.slice(start,start+PER),
    emptyMsg:'No leave requests',
  });
  document.getElementById('leaves-pagination').innerHTML = buildPagination({
    id:'leaves',total:_filtLeaves.length,page:_pageLeaves,perPage:PER,onChange:'setLeavesPage',
  });
}

async function loadLeaveBalances(empId) {
  const el = document.getElementById('lb-content'); if(!el) return;
  const year  = new Date().getFullYear();
  const emps  = empId ? _employees.filter(e=>e.id===empId) : _employees.filter(e=>(e.status||'active')!=='inactive');
  // Count used leaves this year
  const used  = {};
  _leaves.filter(l=>l.status==='approved'&&(l.fromDate||'').startsWith(year)).forEach(l=>{
    if (!used[l.employeeId]) used[l.employeeId]={};
    used[l.employeeId][l.type]  = (used[l.employeeId][l.type]||0)+(Number(l.days)||0);
  });
  const types = ['casual','sick','earned','lop'];
  el.innerHTML = `
    <table class="table" style="font-size:12px;">
      <thead><tr>
        <th>Employee</th>
        ${types.map(t=>`<th title="${LEAVE_TYPES[t]?.label}">${LEAVE_TYPES[t]?.label?.split(' ')[0]||t} (Used/Total)</th>`).join('')}
        <th>Total Used</th>
      </tr></thead>
      <tbody>
        ${emps.map(emp=>{
          const eu = used[emp.id]||{};
          const totalUsed = types.reduce((s,t)=>s+(eu[t]||0),0);
          return `<tr>
            <td>
              <div style="font-size:12px;font-weight:500;">${escHtml(emp.name||'—')}</div>
              <div style="font-size:10px;color:var(--text-muted);">${escHtml(emp.department||emp.role||'')}</div>
            </td>
            ${types.map(t=>{
              const usedDays  = eu[t]||0;
              const totalDays = LEAVE_TYPES[t]?.annual||0;
              const remaining = Math.max(0,totalDays-usedDays);
              const pct       = totalDays?Math.round((usedDays/totalDays)*100):0;
              return `<td>
                <div style="font-size:12px;">${usedDays}/${totalDays<999?totalDays:'∞'}</div>
                <div style="height:3px;background:var(--border-subtle);border-radius:2px;margin-top:3px;overflow:hidden;">
                  <div style="width:${Math.min(100,pct)}%;height:100%;background:${pct>90?'var(--brand-danger)':pct>70?'var(--brand-warning)':'var(--brand-secondary)'};"></div>
                </div>
                ${remaining<=2&&totalDays<999?`<div style="font-size:9px;color:var(--brand-warning);">${remaining} left</div>`:''}
              </td>`;
            }).join('')}
            <td style="font-family:var(--font-mono);font-weight:700;">${totalUsed}d</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}
window.loadLeaveBalances = loadLeaveBalances;

window.initLeaveBalances = async () => {
  if (!confirm('Reset all leave balance records for this year? This will not delete leave requests.')) return;
  Toast.success('Reset','Leave balances refreshed from approved leave records.');
  loadLeaveBalances('');
};

window.calcLeaveDays = () => {
  const from = document.getElementById('lv-from')?.value;
  const to   = document.getElementById('lv-to')?.value;
  const half = document.getElementById('lv-half')?.value;
  const el   = document.getElementById('lv-days');
  if (!from||!to||!el) return;
  let days = Math.ceil((new Date(to)-new Date(from))/86400000)+1;
  if (half) days -= 0.5;
  el.value = days>0?`${days} day${days!==1?'s':''}`:days===0.5?'½ day':'Invalid dates';
};

window.saveLeave = async () => {
  if (!validateForm([
    {id:'lv-emp',    label:'Employee',  required:true},
    {id:'lv-from',   label:'From Date', required:true},
    {id:'lv-to',     label:'To Date',   required:true},
    {id:'lv-reason', label:'Reason',    required:true},
  ])) return;
  const btn  = document.getElementById('leave-save-btn');
  setLoading(btn,true);
  const id   = document.getElementById('lv-id')?.value;
  const from = document.getElementById('lv-from').value;
  const to   = document.getElementById('lv-to').value;
  const half = document.getElementById('lv-half').value;
  let   days = Math.ceil((new Date(to)-new Date(from))/86400000)+1;
  if (half) days -= 0.5;
  try {
    const data={
      employeeId: document.getElementById('lv-emp').value,
      type:       document.getElementById('lv-type').value,
      fromDate:from, toDate:to, days:Math.max(0,days),
      halfDay:    half||'',
      reason:     document.getElementById('lv-reason').value.trim(),
      remarks:    document.getElementById('lv-remarks')?.value?.trim()||'',
      status:     document.getElementById('lv-status').value,
      appliedBy:  AuthState.profile?.name||'',
      companyId:  AuthState.company?.id||null,
    };
    if (id) { await dbUpdate(HR_COLLECTIONS.LEAVES,id,data); Toast.success('Updated','Leave request updated.'); }
    else    { await dbCreate(HR_COLLECTIONS.LEAVES,data);    Toast.success('Submitted','Leave request submitted.'); }
    closeModal('leave-modal');
    loadLeaveBalances(document.getElementById('lb-emp-filter')?.value||'');
  } catch(e) { Toast.error('Failed',e.message); }
  finally    { setLoading(btn,false); }
};

window.editLeave = (id) => {
  const l = _leaves.find(x=>x.id===id); if(!l) return;
  document.getElementById('lv-id').value      = l.id;
  document.getElementById('lv-emp').value     = l.employeeId||'';
  document.getElementById('lv-type').value    = l.type||'casual';
  document.getElementById('lv-from').value    = l.fromDate||'';
  document.getElementById('lv-to').value      = l.toDate||'';
  document.getElementById('lv-half').value    = l.halfDay||'';
  document.getElementById('lv-status').value  = l.status||'pending';
  document.getElementById('lv-reason').value  = l.reason||'';
  document.getElementById('lv-remarks').value = l.remarks||'';
  calcLeaveDays();
  openModal('leave-modal');
};

window.approveLeave = async (id) => {
  try {
    await dbUpdate(HR_COLLECTIONS.LEAVES,id,{status:'approved',approvedBy:AuthState.profile?.name||'',approvedAt:new Date().toISOString()});
    Toast.success('Approved','Leave approved.');
    loadLeaveBalances(document.getElementById('lb-emp-filter')?.value||'');
  } catch(e) { Toast.error('Failed',e.message); }
};
window.rejectLeave = async (id) => {
  try {
    await dbUpdate(HR_COLLECTIONS.LEAVES,id,{status:'rejected',rejectedBy:AuthState.profile?.name||''});
    Toast.warning('Rejected','Leave rejected.');
  } catch(e) { Toast.error('Failed',e.message); }
};
window.deleteLeave = async (id) => {
  if (!confirm('Delete this leave request?')) return;
  try { await dbDelete(HR_COLLECTIONS.LEAVES,id); Toast.success('Deleted','Leave removed.'); }
  catch(e) { Toast.error('Failed',e.message); }
};

// ══════════════════════════════════════════════════════════════
// TEAM CALENDAR — month view of leaves + attendance
// ══════════════════════════════════════════════════════════════
function renderTeamCalendar(container) {
  const now   = new Date();
  let   calYear  = now.getFullYear();
  let   calMonth = now.getMonth(); // 0-based

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">📅 Team Calendar</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-secondary btn-sm" onclick="calNav(-1)">‹</button>
          <span id="cal-label" style="font-size:14px;font-weight:600;min-width:140px;text-align:center;"></span>
          <button class="btn btn-secondary btn-sm" onclick="calNav(1)">›</button>
          <button class="btn btn-secondary btn-sm" onclick="calNav(0)">Today</button>
        </div>
      </div>
      <!-- Legend -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;padding:0 var(--space-4) var(--space-3);font-size:11px;">
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(48,209,88,0.3);border-radius:2px;margin-right:4px;"></span>Present/WFH</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(255,159,10,0.3);border-radius:2px;margin-right:4px;"></span>Half Day</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(10,132,255,0.3);border-radius:2px;margin-right:4px;"></span>Leave</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(255,69,58,0.3);border-radius:2px;margin-right:4px;"></span>Absent</span>
      </div>
      <div id="cal-grid" style="overflow-x:auto;"></div>
    </div>
  `;

  async function renderCal() {
    const label = document.getElementById('cal-label');
    if (label) label.textContent = new Date(calYear,calMonth).toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    const grid  = document.getElementById('cal-grid'); if(!grid) return;
    const month = `${calYear}-${String(calMonth+1).padStart(2,'0')}`;
    let attRecs = [];
    try {
      attRecs = await dbGetAll(HR_COLLECTIONS.ATTENDANCE,[
        ...(AuthState.company?.id?[where('companyId','==',AuthState.company.id)]:[]),
        where('date','>=',`${month}-01`), where('date','<=',`${month}-31`),
      ]);
    } catch {}
    let lvRecs = _leaves.filter(l=>l.status==='approved'&&(l.fromDate||'').startsWith(month));

    const daysInMonth = new Date(calYear,calMonth+1,0).getDate();
    const emps        = _employees.filter(e=>(e.status||'active')!=='inactive').slice(0,20); // cap at 20
    const days        = Array.from({length:daysInMonth},(_,i)=>i+1);

    const colorFor = (empId, day) => {
      const dateStr = `${month}-${String(day).padStart(2,'0')}`;
      const att     = attRecs.find(a=>a.employeeId===empId&&a.date===dateStr);
      if (att) {
        if (att.status==='present'||att.status==='wfh') return 'rgba(48,209,88,0.3)';
        if (att.status==='half-day')                    return 'rgba(255,159,10,0.3)';
        if (att.status==='absent')                      return 'rgba(255,69,58,0.3)';
        if (att.status==='leave')                       return 'rgba(10,132,255,0.3)';
        if (att.status==='late')                        return 'rgba(255,214,10,0.3)';
      }
      // Check leave
      const lv = lvRecs.find(l=>l.employeeId===empId&&dateStr>=l.fromDate&&dateStr<=l.toDate);
      if (lv) return 'rgba(10,132,255,0.3)';
      return '';
    };

    grid.innerHTML = `
      <div style="min-width:${100+daysInMonth*28}px;">
        <table style="border-collapse:collapse;width:100%;font-size:11px;">
          <thead><tr>
            <th style="padding:6px 10px;text-align:left;color:var(--text-muted);position:sticky;left:0;background:var(--bg-base);z-index:2;min-width:120px;">Employee</th>
            ${days.map(d=>{
              const date = new Date(calYear,calMonth,d);
              const dow  = date.getDay();
              const isWk = dow===0||dow===6;
              const isToday= d===now.getDate()&&calMonth===now.getMonth()&&calYear===now.getFullYear();
              return `<th style="padding:4px 2px;text-align:center;min-width:26px;font-size:10px;font-weight:${isToday?700:500};color:${isToday?'var(--brand-primary)':isWk?'var(--text-muted)':'var(--text-secondary)'};${isToday?'background:rgba(10,132,255,0.08);border-radius:4px;':''}">${d}<br><span style="font-size:8px;">${['S','M','T','W','T','F','S'][dow]}</span></th>`;
            }).join('')}
          </tr></thead>
          <tbody>
            ${emps.map(emp=>`<tr style="border-bottom:1px solid var(--border-subtle);">
              <td style="padding:6px 10px;position:sticky;left:0;background:var(--bg-base);z-index:1;">
                <div style="font-size:12px;font-weight:500;white-space:nowrap;">${escHtml(emp.name||'—')}</div>
              </td>
              ${days.map(d=>{
                const bg = colorFor(emp.id,d);
                const date = new Date(calYear,calMonth,d);
                const isWk = date.getDay()===0||date.getDay()===6;
                return `<td style="padding:2px;text-align:center;">
                  <div style="width:22px;height:22px;border-radius:4px;background:${bg||(isWk?'var(--bg-elevated)':'')};margin:0 auto;"></div>
                </td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
        ${emps.length===20?`<div style="text-align:center;padding:8px;font-size:11px;color:var(--text-muted);">Showing first 20 employees</div>`:''}
      </div>
    `;
  }

  window.calNav = (dir) => {
    if (dir===0) { calYear=now.getFullYear(); calMonth=now.getMonth(); }
    else { calMonth+=dir; if(calMonth<0){calMonth=11;calYear--;} if(calMonth>11){calMonth=0;calYear++;} }
    renderCal();
  };

  renderCal();
}
