// ============================================================
// LAM — Project Management Module
// Project budgeting, milestones, tasks, team allocation,
// time tracking, profitability, Gantt-style timeline
// Interconnects: Customers → Projects → Invoices → HR → Finance
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, searchFilter,
  debounce, genId, formatNumber, formatCurrency, timeAgo
} from '../../core/utils.js';
import {
  pageShell, buildTable, buildModal, searchBar,
  badge, actionsMenu, buildPagination, validateForm,
  openModal, closeModal, setupModalClose, setupMenuClose, avatarCell
} from '../_shared.js';

export const PROJ_COLLECTIONS = {
  PROJECTS:   'proj_projects',
  MILESTONES: 'proj_milestones',
  TASKS:      'proj_tasks',
  TIMESHEETS: 'proj_timesheets',
  EXPENSES:   'proj_expenses',
};

const PROJECT_STATUSES = ['planning','active','on-hold','completed','cancelled'];
const TASK_STATUSES    = ['todo','in-progress','review','done','blocked'];
const PRIORITY_COLORS  = {critical:'var(--brand-danger)',high:'var(--brand-warning)',medium:'var(--brand-primary)',low:'var(--text-muted)'};

let _projects=[], _milestones=[], _tasks=[], _timesheets=[];
let _customers=[], _employees=[], _invoices=[];
let _activeTab='overview';
let _selectedProjectId=null;
const PER=15;

export async function renderProjects(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_projects, _milestones, _tasks, _timesheets, _customers, _employees, _invoices] = await Promise.all([
    dbGetAll(PROJ_COLLECTIONS.PROJECTS,   [...c, orderBy('createdAt','desc')]),
    dbGetAll(PROJ_COLLECTIONS.MILESTONES, [...c, orderBy('dueDate','asc')]),
    dbGetAll(PROJ_COLLECTIONS.TASKS,      [...c, orderBy('createdAt','desc')]),
    dbGetAll(PROJ_COLLECTIONS.TIMESHEETS, [...c, orderBy('date','desc')]),
    dbGetAll(COLLECTIONS.CUSTOMERS,       [...c]),
    dbGetAll(COLLECTIONS.EMPLOYEES,       [...c]),
    dbGetAll(FIN_COLLECTIONS.INVOICES,    [...c]),
  ]);

  container.innerHTML = pageShell({
    title: '📁 Project Management',
    subtitle: 'Plan, execute and track projects from kickoff to delivery.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="refreshProjects()">↻ Refresh</button>
      <button class="btn btn-primary" onclick="openModal('project-modal')">+ New Project</button>
    `,
    content: `
      <!-- KPIs -->
      <div class="grid-5" style="margin-bottom:var(--space-5);" id="proj-kpis"></div>

      <!-- Sub-tabs -->
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['overview',   '📊 Overview'],
          ['projects',   '📁 All Projects'],
          ['tasks',      '✅ Tasks'],
          ['timeline',   '📅 Timeline'],
          ['timesheet',  '⏱ Timesheets'],
          ['profitability','💰 Profitability'],
        ].map(([id,label]) => `
          <button class="proj-tab ${id==='overview'?'active':''}" id="proj-tab-${id}"
            onclick="switchProjTab('${id}')"
            style="padding:7px 12px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="proj-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.proj-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderProjKPIs();
  setupModalClose(); setupMenuClose();

  document.body.insertAdjacentHTML('beforeend', projectModal());
  document.body.insertAdjacentHTML('beforeend', taskModal());
  document.body.insertAdjacentHTML('beforeend', milestoneModal());
  document.body.insertAdjacentHTML('beforeend', timesheetModal());

  window.switchProjTab = switchProjTab;
  window.refreshProjects = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_projects,_milestones,_tasks,_timesheets]=await Promise.all([
      dbGetAll(PROJ_COLLECTIONS.PROJECTS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(PROJ_COLLECTIONS.MILESTONES,[...c,orderBy('dueDate','asc')]),
      dbGetAll(PROJ_COLLECTIONS.TASKS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(PROJ_COLLECTIONS.TIMESHEETS,[...c,orderBy('date','desc')]),
    ]);
    renderProjKPIs(); switchProjTab(_activeTab);
  };
  switchProjTab('overview');
}

// ── KPIs ──────────────────────────────────────────────────────
function renderProjKPIs() {
  const el=document.getElementById('proj-kpis'); if(!el) return; el.innerHTML='';
  const active    = _projects.filter(p=>p.status==='active').length;
  const overdue   = _tasks.filter(t=>t.dueDate&&new Date(t.dueDate)<new Date()&&t.status!=='done').length;
  const totalBudget= _projects.reduce((s,p)=>s+(Number(p.budget)||0),0);
  const totalSpent = _projects.reduce((s,p)=>s+(Number(p.actualCost)||0),0);
  const hoursLogged= _timesheets.reduce((s,t)=>s+(Number(t.hours)||0),0);

  [
    {label:'Active Projects',  value:active,                       icon:'📁',color:'kpi-blue'},
    {label:'Total Budget',     value:formatCurrency(totalBudget,true),icon:'💰',color:'kpi-green'},
    {label:'Spent So Far',     value:formatCurrency(totalSpent,true), icon:'💸',color:totalSpent>totalBudget?'kpi-red':'kpi-orange'},
    {label:'Overdue Tasks',    value:overdue,                      icon:'⚠️',color:overdue>0?'kpi-red':'kpi-green'},
    {label:'Hours Logged',     value:formatNumber(hoursLogged)+'h',icon:'⏱',color:'kpi-blue'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchProjTab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.proj-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`proj-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('proj-tab-content'); if(!c) return;
  switch(tab) {
    case 'overview':      renderProjOverview(c);      break;
    case 'projects':      renderProjectsTab(c);       break;
    case 'tasks':         renderTasksTab(c);           break;
    case 'timeline':      renderTimelineTab(c);        break;
    case 'timesheet':     renderTimesheetTab(c);       break;
    case 'profitability': renderProfitabilityTab(c);   break;
  }
}

// ══════════════════════════════════════════════════════════════
// OVERVIEW — Dashboard of all projects
// ══════════════════════════════════════════════════════════════
function renderProjOverview(container) {
  const active=_projects.filter(p=>p.status==='active');
  const now   =Date.now();

  container.innerHTML=`
    <!-- Project status summary -->
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${PROJECT_STATUSES.filter(s=>s!=='cancelled').map(s=>{
        const cnt=_projects.filter(p=>p.status===s).length;
        const colors={planning:'kpi-blue',active:'kpi-green','on-hold':'kpi-yellow',completed:'kpi-orange'};
        const icons={planning:'📋',active:'▶️','on-hold':'⏸️',completed:'✅'};
        return `<div class="kpi-card ${colors[s]||'kpi-blue'}"><div class="kpi-top"><div class="kpi-icon">${icons[s]||'📁'}</div></div><div class="kpi-value">${cnt}</div><div class="kpi-label" style="text-transform:capitalize;">${s}</div></div>`;
      }).join('')}
    </div>

    <!-- Active project cards -->
    <div style="margin-bottom:var(--space-4);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
        <h3 style="font-size:15px;font-weight:700;">Active Projects</h3>
        <button class="btn btn-secondary btn-sm" onclick="switchProjTab('projects')">View All</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:var(--space-4);">
        ${active.length ? active.map(p=>projectCard(p)).join('') :
          `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">No active projects. Create one to get started.</div>`}
      </div>
    </div>

    <!-- Upcoming milestones -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🏁 Upcoming Milestones</div>
        <span class="badge badge-blue">${_milestones.filter(m=>m.status!=='done'&&m.dueDate&&new Date(m.dueDate)>=new Date()).length} pending</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${_milestones.filter(m=>m.status!=='done').sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate)).slice(0,8).map(m=>{
          const proj=_projects.find(x=>x.id===m.projectId)||{};
          const d=m.dueDate?Math.ceil((new Date(m.dueDate)-now)/86400000):null;
          const isOverdue=d!==null&&d<0;
          return `
            <div style="display:flex;align-items:center;gap:14px;padding:12px 14px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${isOverdue?'var(--brand-danger)':d<=7?'var(--brand-warning)':'var(--border-default)'};">
              <div style="width:36px;height:36px;border-radius:var(--radius-md);background:rgba(10,132,255,0.1);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏁</div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(m.title||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${escHtml(proj.name||'—')}</div>
              </div>
              <div style="text-align:right;flex-shrink:0;">
                <div style="font-size:12px;font-weight:700;color:${isOverdue?'var(--brand-danger)':d<=7?'var(--brand-warning)':'var(--text-secondary)'};">${isOverdue?`${Math.abs(d)}d overdue`:d===0?'Today':d===1?'Tomorrow':`${d}d`}</div>
                <div style="font-size:10px;color:var(--text-muted);">${m.dueDate||'—'}</div>
              </div>
              ${badge(m.status||'pending')}
            </div>`;
        }).join('') || `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">No upcoming milestones</div>`}
      </div>
    </div>
  `;
}

function projectCard(p) {
  const cust   = _customers.find(c=>c.id===p.customerId)||{};
  const projTasks= _tasks.filter(t=>t.projectId===p.id);
  const doneTasks= projTasks.filter(t=>t.status==='done').length;
  const pct    = projTasks.length?Math.round((doneTasks/projTasks.length)*100):0;
  const budget = Number(p.budget)||0;
  const spent  = Number(p.actualCost)||0;
  const budgetPct= budget?Math.round((spent/budget)*100):0;
  const now    = Date.now();
  const daysLeft= p.endDate?Math.ceil((new Date(p.endDate)-now)/86400000):null;

  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);overflow:hidden;cursor:pointer;transition:all 0.2s;"
         onclick="openProjectDetail('${p.id}')"
         onmouseenter="this.style.borderColor='var(--border-strong)';this.style.boxShadow='var(--shadow-md)'"
         onmouseleave="this.style.borderColor='var(--border-subtle)';this.style.boxShadow='none'">
      <!-- Header -->
      <div style="padding:16px 18px;background:linear-gradient(135deg,rgba(10,132,255,0.08),rgba(0,200,150,0.04));border-bottom:1px solid var(--border-subtle);">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:14px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;">${escHtml(p.name||'—')}</div>
          ${badge(p.status||'active')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);">${escHtml(cust.name||p.clientName||'Internal')}</div>
      </div>

      <div style="padding:14px 18px;">
        <!-- Task progress -->
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
            <span style="font-size:11px;color:var(--text-muted);">Tasks: ${doneTasks}/${projTasks.length}</span>
            <span style="font-size:11px;font-weight:700;color:${pct>=100?'var(--brand-secondary)':pct>=60?'var(--brand-primary)':'var(--text-secondary)'};">${pct}%</span>
          </div>
          <div style="background:var(--bg-overlay);border-radius:4px;height:6px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${pct>=100?'var(--brand-secondary)':pct>=60?'var(--brand-primary)':'var(--brand-warning)'};border-radius:4px;transition:width 0.8s;"></div>
          </div>
        </div>

        <!-- Budget -->
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
            <span style="font-size:11px;color:var(--text-muted);">Budget: ₹${(budget/1000).toFixed(0)}K</span>
            <span style="font-size:11px;font-weight:700;color:${budgetPct>100?'var(--brand-danger)':budgetPct>80?'var(--brand-warning)':'var(--text-secondary)'};">${budgetPct}% used</span>
          </div>
          <div style="background:var(--bg-overlay);border-radius:4px;height:6px;overflow:hidden;">
            <div style="height:100%;width:${Math.min(budgetPct,100)}%;background:${budgetPct>100?'var(--brand-danger)':budgetPct>80?'var(--brand-warning)':'var(--brand-primary)'};border-radius:4px;"></div>
          </div>
        </div>

        <!-- Footer info -->
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <!-- Team avatars -->
          <div style="display:flex;gap:-4px;">
            ${(p.team||[]).slice(0,4).map(member=>`
              <div style="width:24px;height:24px;border-radius:50%;background:rgba(10,132,255,0.15);border:2px solid var(--bg-surface);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--brand-primary);margin-left:-4px;" title="${escHtml(member)}">
                ${(member||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
              </div>`).join('')}
            ${(p.team||[]).length>4?`<div style="width:24px;height:24px;border-radius:50%;background:var(--bg-overlay);border:2px solid var(--bg-surface);display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text-muted);margin-left:-4px;">+${(p.team||[]).length-4}</div>`:''}
          </div>
          <div style="font-size:11px;color:${daysLeft!==null&&daysLeft<0?'var(--brand-danger)':daysLeft!==null&&daysLeft<=7?'var(--brand-warning)':'var(--text-muted)'};">
            ${daysLeft===null?'No deadline':daysLeft<0?`${Math.abs(daysLeft)}d overdue`:daysLeft===0?'Due today':`${daysLeft}d left`}
          </div>
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// ALL PROJECTS TAB
// ══════════════════════════════════════════════════════════════
let _filtProjects=[], _pageProjects=1;

function renderProjectsTab(container) {
  _filtProjects=[..._projects];
  container.innerHTML=`
    ${searchBar({id:'projects',placeholder:'Search project, client…',
      filters:[
        {key:'status',label:'All Status',options:PROJECT_STATUSES.map(s=>({value:s,label:s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}))},
        {key:'type',label:'All Types',options:[{value:'fixed-price',label:'Fixed Price'},{value:'time-material',label:'Time & Material'},{value:'retainer',label:'Retainer'},{value:'internal',label:'Internal'}]},
      ],onSearch:'projectsSearch',onFilter:'projectsFilter'})}
    <div id="projects-table-wrap"></div>
    <div id="projects-pagination"></div>
    <div id="project-detail-panel"></div>
  `;
  renderProjectsTable();
  window.projectsSearch=debounce((q)=>{_filtProjects=searchFilter(_projects,q,['name','clientName','description']);_pageProjects=1;renderProjectsTable();},250);
  window.projectsFilter=(k,v)=>{_filtProjects=v?_projects.filter(p=>p[k]===v):[..._projects];_pageProjects=1;renderProjectsTable();};
  window.setProjectsPage=(p)=>{_pageProjects=p;renderProjectsTable();};
}

function renderProjectsTable() {
  const wrap=document.getElementById('projects-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('projects-count'); if(cnt) cnt.textContent=`${_filtProjects.length} project${_filtProjects.length!==1?'s':''}`;
  const start=(_pageProjects-1)*PER;
  wrap.innerHTML=buildTable({id:'projects-table',
    columns:[
      {key:'name',        label:'Project',     render:r=>avatarCell(r.name||'—',r.clientName||'Internal','var(--brand-primary)','rgba(10,132,255,0.12)')},
      {key:'type',        label:'Type',        render:r=>`<span class="badge badge-blue">${escHtml(r.type||'—')}</span>`},
      {key:'progress',    label:'Progress',    render:r=>{
        const pt=_tasks.filter(t=>t.projectId===r.id);
        const done=pt.filter(t=>t.status==='done').length;
        const pct=pt.length?Math.round((done/pt.length)*100):0;
        return `<div style="display:flex;align-items:center;gap:8px;"><div style="background:var(--bg-overlay);border-radius:4px;height:6px;width:80px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--brand-primary);border-radius:4px;"></div></div><span style="font-size:11px;">${pct}%</span></div>`;
      }},
      {key:'budget',      label:'Budget',      render:r=>`<span style="font-family:var(--font-mono);">₹${Number(r.budget||0).toLocaleString('en-IN')}</span>`},
      {key:'actualCost',  label:'Spent',       render:r=>{const b=Number(r.budget)||0;const s=Number(r.actualCost)||0;const over=s>b;return `<span style="font-family:var(--font-mono);color:${over?'var(--brand-danger)':'var(--text-primary)'};">₹${s.toLocaleString('en-IN')}</span>`}},
      {key:'startDate',   label:'Start',       render:r=>`<span style="font-size:11px;color:var(--text-muted);">${r.startDate||'—'}</span>`},
      {key:'endDate',     label:'End',         render:r=>{
        if(!r.endDate) return '—';
        const d=Math.ceil((new Date(r.endDate)-Date.now())/86400000);
        const over=d<0&&r.status==='active';
        return `<span style="font-size:11px;color:${over?'var(--brand-danger)':'var(--text-muted)'};">${r.endDate}${over?` (${Math.abs(d)}d over)`:''}`;
      }},
      {key:'status',      label:'Status',      render:r=>badge(r.status||'planning')},
      {key:'actions',     label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'👁',label:'View Detail',    action:`openProjectDetail('${r.id}')`},
          {icon:'✅',label:'Add Task',       action:`openTaskForProject('${r.id}')`},
          {icon:'🏁',label:'Add Milestone',  action:`openMilestoneForProject('${r.id}')`},
          {icon:'⏱',label:'Log Time',       action:`openTimesheetForProject('${r.id}')`},
          {icon:'✏️',label:'Edit',           action:`editProject('${r.id}')`},
          {icon:'✅',label:'Complete',       action:`completeProject('${r.id}')`},
          {icon:'🗑',label:'Delete',         action:`deleteProject('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtProjects.slice(start,start+PER),emptyMsg:'No projects yet',
  });
  document.getElementById('projects-pagination').innerHTML=buildPagination({id:'projects',total:_filtProjects.length,page:_pageProjects,perPage:PER,onChange:'setProjectsPage'});
}

// ══════════════════════════════════════════════════════════════
// TASKS TAB
// ══════════════════════════════════════════════════════════════
let _filtTasks=[], _pageTasks=1;

function renderTasksTab(container) {
  _filtTasks=[..._tasks];
  container.innerHTML=`
    <!-- Quick stats row -->
    <div style="display:flex;gap:10px;margin-bottom:var(--space-4);flex-wrap:wrap;">
      ${TASK_STATUSES.map(s=>{
        const cnt=_tasks.filter(t=>t.status===s).length;
        const colors={todo:'var(--text-muted)','in-progress':'var(--brand-primary)',review:'var(--brand-warning)',done:'var(--brand-secondary)',blocked:'var(--brand-danger)'};
        return `<div style="padding:8px 16px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${colors[s]||'var(--text-muted)'};cursor:pointer;" onclick="filterTasksByStatus('${s}')">
          <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:${colors[s]};">${cnt}</div>
          <div style="font-size:10px;color:var(--text-muted);text-transform:capitalize;">${s.replace('-',' ')}</div>
        </div>`;
      }).join('')}
    </div>

    ${searchBar({id:'tasks',placeholder:'Search tasks, assignee…',
      filters:[
        {key:'status',label:'All Status',options:TASK_STATUSES.map(s=>({value:s,label:s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}))},
        {key:'priority',label:'All Priority',options:['critical','high','medium','low'].map(p=>({value:p,label:p.charAt(0).toUpperCase()+p.slice(1)}))},
      ],onSearch:'tasksSearch',onFilter:'tasksFilter'})}
    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary btn-sm" onclick="openModal('task-modal')">+ Add Task</button>
    </div>
    <div id="tasks-table-wrap"></div>
    <div id="tasks-pagination"></div>
  `;
  renderTasksTable();
  window.tasksSearch=debounce((q)=>{_filtTasks=searchFilter(_tasks,q,['title','description','assignedTo']);_pageTasks=1;renderTasksTable();},250);
  window.tasksFilter=(k,v)=>{_filtTasks=v?_tasks.filter(t=>t[k]===v):[..._tasks];_pageTasks=1;renderTasksTable();};
  window.filterTasksByStatus=(s)=>{ _filtTasks=_tasks.filter(t=>t.status===s); _pageTasks=1; renderTasksTable(); };
  window.setTasksPage=(p)=>{_pageTasks=p;renderTasksTable();};
}

function renderTasksTable() {
  const wrap=document.getElementById('tasks-table-wrap'); if(!wrap) return;
  const cnt=document.getElementById('tasks-count'); if(cnt) cnt.textContent=`${_filtTasks.length} task${_filtTasks.length!==1?'s':''}`;
  const start=(_pageTasks-1)*PER;
  wrap.innerHTML=buildTable({id:'tasks-table',
    columns:[
      {key:'title',      label:'Task',      render:r=>`<div style="font-size:13px;font-weight:500;">${escHtml(r.title||'—')}</div><div style="font-size:10px;color:var(--text-muted);">${escHtml((_projects.find(p=>p.id===r.projectId)||{}).name||'—')}</div>`},
      {key:'assignedTo', label:'Assignee',  render:r=>`<span style="font-size:12px;">${escHtml(r.assignedTo||'Unassigned')}</span>`},
      {key:'priority',   label:'Priority',  render:r=>{const c=PRIORITY_COLORS[r.priority]||'var(--text-muted)';return `<span style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${c}20;color:${c};text-transform:uppercase;">${r.priority||'medium'}</span>`}},
      {key:'estimatedHours',label:'Est.',   render:r=>r.estimatedHours?`<span style="font-family:var(--font-mono);font-size:12px;">${r.estimatedHours}h</span>`:'—'},
      {key:'loggedHours',label:'Logged',    render:r=>{const logged=_timesheets.filter(t=>t.taskId===r.id).reduce((s,t)=>s+(Number(t.hours)||0),0);return logged?`<span style="font-family:var(--font-mono);font-size:12px;color:var(--brand-secondary);">${logged}h</span>`:'—'}},
      {key:'dueDate',    label:'Due',       render:r=>{if(!r.dueDate)return'—';const d=Math.ceil((new Date(r.dueDate)-Date.now())/86400000);const over=d<0&&r.status!=='done';return `<span style="font-size:11px;color:${over?'var(--brand-danger)':d<=3?'var(--brand-warning)':'var(--text-muted)'};">${r.dueDate}${over?` ⚠`:''}</span>`}},
      {key:'status',     label:'Status',    render:r=>{const colors={todo:'gray','in-progress':'blue',review:'yellow',done:'green',blocked:'red'};return `<select class="form-select" style="font-size:11px;padding:4px 8px;width:auto;" onchange="updateTaskStatus('${r.id}',this.value)">${TASK_STATUSES.map(s=>`<option value="${s}" ${s===r.status?'selected':''}>${s.replace('-',' ')}</option>`).join('')}</select>`}},
      {key:'actions',    label:'',sortable:false,render:r=>actionsMenu(r.id,[
          {icon:'⏱',label:'Log Time',  action:`openTimesheetForTask('${r.id}')`},
          {icon:'✅',label:'Mark Done', action:`updateTaskStatus('${r.id}','done')`},
          {icon:'🗑',label:'Delete',   action:`deleteTask('${r.id}')`,danger:true},
        ])},
    ],
    rows:_filtTasks.slice(start,start+PER),emptyMsg:'No tasks yet',
  });
  document.getElementById('tasks-pagination').innerHTML=buildPagination({id:'tasks',total:_filtTasks.length,page:_pageTasks,perPage:PER,onChange:'setTasksPage'});
}

// ══════════════════════════════════════════════════════════════
// TIMELINE (Gantt-style)
// ══════════════════════════════════════════════════════════════
function renderTimelineTab(container) {
  const today    = new Date();
  const monthStart= new Date(today.getFullYear(),today.getMonth(),1);
  const monthEnd  = new Date(today.getFullYear(),today.getMonth()+3,0); // 3 months view
  const totalDays = Math.ceil((monthEnd-monthStart)/86400000);

  // Generate day headers
  const months=[];
  let cur=new Date(monthStart);
  while(cur<=monthEnd){
    const monthKey=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`;
    const label=cur.toLocaleDateString('en-IN',{month:'short',year:'numeric'});
    const daysInMonth=new Date(cur.getFullYear(),cur.getMonth()+1,0).getDate();
    months.push({label,daysInMonth,key:monthKey});
    cur.setMonth(cur.getMonth()+1);
  }

  container.innerHTML=`
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <span class="alert-icon">📅</span>
      <div><div class="alert-title">Project Timeline — 3 Month View</div>
      <div class="alert-text">Visual timeline showing project spans. Drag to scroll horizontally.</div></div>
    </div>

    <div style="overflow-x:auto;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);">
      <div style="min-width:${Math.max(800,totalDays*12+200)}px;">
        <!-- Month headers -->
        <div style="display:grid;grid-template-columns:200px 1fr;background:var(--bg-elevated);border-bottom:1px solid var(--border-strong);">
          <div style="padding:10px 16px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">Project</div>
          <div style="display:flex;border-left:1px solid var(--border-subtle);">
            ${months.map(m=>`
              <div style="width:${(m.daysInMonth/totalDays)*100}%;padding:8px;font-size:11px;font-weight:600;color:var(--text-secondary);border-right:1px solid var(--border-subtle);text-align:center;">
                ${m.label}
              </div>`).join('')}
          </div>
        </div>

        <!-- Today marker reference -->
        <!-- Project bars -->
        ${_projects.filter(p=>p.startDate&&p.endDate).map(p=>{
          const pStart = new Date(p.startDate);
          const pEnd   = new Date(p.endDate);
          const barStart= Math.max(0,(pStart-monthStart)/86400000);
          const barEnd  = Math.min(totalDays,(pEnd-monthStart)/86400000);
          const barLeft = (barStart/totalDays)*100;
          const barWidth= Math.max(0.5,((barEnd-barStart)/totalDays)*100);
          const pct     = (() => { const pt=_tasks.filter(t=>t.projectId===p.id); const done=pt.filter(t=>t.status==='done').length; return pt.length?Math.round((done/pt.length)*100):0; })();
          const statusColors={active:'var(--brand-primary)',planning:'var(--brand-info)',completed:'var(--brand-secondary)','on-hold':'var(--brand-warning)',cancelled:'var(--brand-danger)'};
          const color=statusColors[p.status]||'var(--brand-primary)';
          return `
            <div style="display:grid;grid-template-columns:200px 1fr;border-bottom:1px solid var(--border-subtle);">
              <div style="padding:10px 16px;display:flex;align-items:center;gap:8px;">
                <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></div>
                <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(p.name||'—')}</div>
              </div>
              <div style="position:relative;border-left:1px solid var(--border-subtle);height:40px;">
                <!-- Today line -->
                <div style="position:absolute;top:0;bottom:0;left:${((today-monthStart)/86400000/totalDays)*100}%;width:2px;background:var(--brand-danger);opacity:0.5;z-index:2;"></div>
                ${barWidth>0?`
                  <div title="${escHtml(p.name)} (${p.startDate} → ${p.endDate}) — ${pct}% complete"
                       style="position:absolute;top:8px;height:24px;left:${barLeft}%;width:${barWidth}%;
                              background:linear-gradient(90deg,${color},${color}aa);border-radius:4px;
                              display:flex;align-items:center;padding:0 8px;overflow:hidden;cursor:pointer;
                              box-shadow:0 2px 4px rgba(0,0,0,0.2);z-index:1;"
                       onclick="openProjectDetail('${p.id}')">
                    <!-- Progress fill -->
                    <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:rgba(255,255,255,0.2);border-radius:4px;"></div>
                    <span style="font-size:10px;font-weight:700;color:#fff;position:relative;z-index:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.name)} (${pct}%)</span>
                  </div>`:''}
              </div>
            </div>`;
        }).join('') || `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">No projects with start/end dates set</div>`}
      </div>
    </div>

    <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;">
      ${[['Active','var(--brand-primary)'],['Completed','var(--brand-secondary)'],['On Hold','var(--brand-warning)'],['Planning','var(--brand-info)']].map(([l,c])=>`
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);">
          <div style="width:20px;height:6px;background:${c};border-radius:3px;"></div>${l}
        </div>`).join('')}
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);">
        <div style="width:2px;height:16px;background:var(--brand-danger);opacity:0.5;"></div>Today
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
// TIMESHEETS
// ══════════════════════════════════════════════════════════════
let _filtTS=[], _pageTS=1;

function renderTimesheetTab(container) {
  _filtTS=[..._timesheets];
  const totalHours=_timesheets.reduce((s,t)=>s+(Number(t.hours)||0),0);
  const thisWeek=_timesheets.filter(t=>{const d=new Date(t.date);const now=new Date();const weekAgo=new Date(now-7*86400000);return d>=weekAgo;}).reduce((s,t)=>s+(Number(t.hours)||0),0);

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Total Hours Logged', value:formatNumber(totalHours)+'h',        icon:'⏱', color:'kpi-blue'},
        {label:'This Week',          value:formatNumber(thisWeek)+'h',           icon:'📅', color:'kpi-green'},
        {label:'Team Members',       value:new Set(_timesheets.map(t=>t.loggedBy)).size, icon:'👥', color:'kpi-orange'},
        {label:'Projects Active',    value:new Set(_timesheets.map(t=>t.projectId).filter(Boolean)).size, icon:'📁', color:'kpi-yellow'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
      <button class="btn btn-primary btn-sm" onclick="openModal('timesheet-modal')">+ Log Time</button>
    </div>
    <div id="ts-table-wrap"></div>
    <div id="ts-pagination"></div>
  `;
  renderTSTable();
  window.setTSPage=(p)=>{_pageTS=p;renderTSTable();};
}

function renderTSTable() {
  const wrap=document.getElementById('ts-table-wrap'); if(!wrap) return;
  const start=(_pageTS-1)*PER;
  wrap.innerHTML=buildTable({id:'ts-table',
    columns:[
      {key:'date',      label:'Date',    render:r=>`<span style="font-family:var(--font-mono);font-size:12px;">${r.date||'—'}</span>`},
      {key:'projectId', label:'Project', render:r=>{const p=_projects.find(x=>x.id===r.projectId)||{};return `<span style="font-size:12px;">${escHtml(p.name||'—')}</span>`}},
      {key:'taskId',    label:'Task',    render:r=>{const t=_tasks.find(x=>x.id===r.taskId)||{};return `<span style="font-size:12px;color:var(--text-secondary);">${escHtml(t.title||'General')}</span>`}},
      {key:'hours',     label:'Hours',   render:r=>`<span style="font-family:var(--font-display);font-size:14px;font-weight:700;color:var(--brand-primary);">${r.hours}h</span>`},
      {key:'description',label:'Work Done',render:r=>`<span style="font-size:12px;color:var(--text-secondary);">${escHtml((r.description||'—').slice(0,60))}${(r.description||'').length>60?'…':''}</span>`},
      {key:'loggedBy',  label:'By',      render:r=>`<span style="font-size:12px;">${escHtml(r.loggedBy||'—')}</span>`},
      {key:'billable',  label:'Billable',render:r=>r.billable?`<span class="badge badge-green">✅ Yes</span>`:`<span class="badge badge-gray">No</span>`},
      {key:'actions',   label:'',sortable:false,render:r=>actionsMenu(r.id,[{icon:'🗑',label:'Delete',action:`deleteTimesheet('${r.id}')`,danger:true}])},
    ],
    rows:_filtTS.slice(start,start+PER),emptyMsg:'No time logged yet',
  });
  document.getElementById('ts-pagination').innerHTML=buildPagination({id:'ts',total:_filtTS.length,page:_pageTS,perPage:PER,onChange:'setTSPage'});
}

// ══════════════════════════════════════════════════════════════
// PROFITABILITY TAB
// ══════════════════════════════════════════════════════════════
function renderProfitabilityTab(container) {
  const projData=_projects.map(p=>{
    const revenue  = _invoices.filter(i=>i.projectId===p.id&&i.paymentStatus==='paid').reduce((s,i)=>s+(Number(i.totalAmount)||0),0) || Number(p.contractValue)||0;
    const labour   = _timesheets.filter(t=>t.projectId===p.id&&t.billable!==false).reduce((s,t)=>s+(Number(t.hours)||0),0) * (Number(p.hourlyRate)||0);
    const expenses = Number(p.actualCost)||0;
    const totalCost= labour+expenses;
    const profit   = revenue-totalCost;
    const margin   = revenue?Math.round((profit/revenue)*100):0;
    const tasks    = _tasks.filter(t=>t.projectId===p.id);
    const completion=tasks.length?Math.round((tasks.filter(t=>t.status==='done').length/tasks.length)*100):0;
    return {...p,revenue,labour,expenses,totalCost,profit,margin,completion};
  });

  const totalRev   =projData.reduce((s,p)=>s+p.revenue,0);
  const totalCost  =projData.reduce((s,p)=>s+p.totalCost,0);
  const totalProfit=projData.reduce((s,p)=>s+p.profit,0);
  const avgMargin  =projData.length?Math.round(projData.reduce((s,p)=>s+p.margin,0)/projData.length):0;

  container.innerHTML=`
    <div class="grid-4" style="margin-bottom:var(--space-5);">
      ${[
        {label:'Total Revenue',  value:formatCurrency(totalRev,true),    icon:'💰',color:'kpi-green'},
        {label:'Total Cost',     value:formatCurrency(totalCost,true),   icon:'💸',color:'kpi-orange'},
        {label:'Total Profit',   value:formatCurrency(totalProfit,true), icon:'📊',color:totalProfit>=0?'kpi-green':'kpi-red'},
        {label:'Avg Margin',     value:avgMargin+'%',                    icon:'🎯',color:avgMargin>=20?'kpi-green':avgMargin>=10?'kpi-yellow':'kpi-red'},
      ].map(k=>`<div class="kpi-card ${k.color}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">💰 Project Profitability Analysis</div>
        <button class="btn btn-secondary btn-sm" onclick="exportProfitability()">⬇ Export</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Project</th><th>Status</th><th>Completion</th><th style="text-align:right;">Revenue</th><th style="text-align:right;">Cost</th><th style="text-align:right;">Profit</th><th style="text-align:right;">Margin</th><th>Health</th></tr></thead>
          <tbody>
            ${projData.length ? projData.sort((a,b)=>b.margin-a.margin).map(p=>`
              <tr>
                <td>${avatarCell(p.name||'—',p.clientName||'Internal','var(--brand-primary)','rgba(10,132,255,0.12)')}</td>
                <td>${badge(p.status||'planning')}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <div style="background:var(--bg-overlay);border-radius:4px;height:6px;width:60px;overflow:hidden;">
                      <div style="height:100%;width:${p.completion}%;background:var(--brand-primary);border-radius:4px;"></div>
                    </div>
                    <span style="font-size:11px;">${p.completion}%</span>
                  </div>
                </td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${p.revenue.toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);">₹${p.totalCost.toLocaleString('en-IN')}</td>
                <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${p.profit>=0?'var(--brand-secondary)':'var(--brand-danger)'};">
                  ${p.profit>=0?'+':''}₹${Math.abs(p.profit).toLocaleString('en-IN')}
                </td>
                <td style="text-align:right;">
                  <span style="font-family:var(--font-mono);font-weight:700;color:${p.margin>=20?'var(--brand-secondary)':p.margin>=10?'var(--brand-warning)':'var(--brand-danger)'};">
                    ${p.margin}%
                  </span>
                </td>
                <td>
                  ${p.margin>=20?`<span class="badge badge-green">Profitable</span>`:
                    p.margin>=0?`<span class="badge badge-yellow">Break-even</span>`:
                    `<span class="badge badge-red">Loss</span>`}
                </td>
              </tr>`).join('') :
              `<tr><td colspan="8"><div class="table-empty"><div class="empty-icon">💰</div><div class="empty-title">No projects yet</div></div></td></tr>`}
          </tbody>
          <tfoot>
            <tr style="background:var(--bg-elevated);border-top:2px solid var(--border-strong);">
              <td colspan="3" style="font-weight:800;padding:12px 16px;font-family:var(--font-display);">TOTAL</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹${totalRev.toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;padding:12px 16px;">₹${totalCost.toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${totalProfit>=0?'var(--brand-secondary)':'var(--brand-danger)'};padding:12px 16px;">${totalProfit>=0?'+':''}₹${Math.abs(totalProfit).toLocaleString('en-IN')}</td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${avgMargin>=20?'var(--brand-secondary)':avgMargin>=10?'var(--brand-warning)':'var(--brand-danger)'};padding:12px 16px;">${avgMargin}%</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;

  window.exportProfitability=()=>{
    const csv=[['Project','Status','Revenue','Cost','Profit','Margin%'],
      ...projData.map(p=>[p.name,p.status,p.revenue,p.totalCost,p.profit,p.margin+'%'])
    ].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='project_profitability.csv'; a.click();
    Toast.success('Exported','Profitability report exported.');
  };
}

// ══════════════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════════════
function projectModal() {
  const custOpts=_customers.map(c=>`<option value="${c.id}">${escHtml(c.name||'—')}</option>`).join('');
  const empOpts=_employees.map(e=>`<option value="${e.name||e.id}">${escHtml(e.name||'—')}</option>`).join('');
  return buildModal({
    id:'project-modal',title:'<span id="project-modal-title">New Project</span>',size:'xl',
    body:`
      <input type="hidden" id="project-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Project Name <span class="required">*</span></label><input type="text" id="pj-name" class="form-input" placeholder="e.g. Warehouse Management Implementation"></div>
        <div class="form-group"><label class="form-label">Project Type</label>
          <select id="pj-type" class="form-select">
            <option value="fixed-price">Fixed Price</option><option value="time-material">Time & Material</option>
            <option value="retainer">Monthly Retainer</option><option value="internal">Internal Project</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Customer / Client</label>
          <select id="pj-customer" class="form-select"><option value="">Internal / No client</option>${custOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Project Manager</label>
          <input type="text" id="pj-pm" class="form-input" placeholder="Manager name" value="${escHtml(AuthState.profile?.name||'')}">
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Start Date <span class="required">*</span></label><input type="date" id="pj-start" class="form-input" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">End Date</label><input type="date" id="pj-end" class="form-input"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select id="pj-status" class="form-select">
            ${PROJECT_STATUSES.map(s=>`<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Budget (₹)</label><input type="number" id="pj-budget" class="form-input" placeholder="500000" min="0"></div>
        <div class="form-group"><label class="form-label">Contract Value (₹)</label><input type="number" id="pj-contract" class="form-input" placeholder="750000" min="0"></div>
        <div class="form-group"><label class="form-label">Hourly Rate (₹/hr)</label><input type="number" id="pj-rate" class="form-input" placeholder="1500" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Description / Scope</label>
        <textarea id="pj-desc" class="form-textarea" rows="3" placeholder="Project scope, deliverables, objectives…"></textarea>
      </div>
      <div class="form-group"><label class="form-label">Team Members</label>
        <div id="pj-team-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;">
          <select id="pj-team-add" class="form-select" style="flex:1;"><option value="">Add team member…</option>${empOpts}</select>
          <button class="btn btn-secondary btn-sm" onclick="addTeamMember()">+ Add</button>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('project-modal')">Cancel</button>
            <button class="btn btn-primary" id="project-save-btn" onclick="saveProject()">Save Project</button>`,
  });
}

function taskModal() {
  const projOpts=_projects.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  const empOpts=_employees.map(e=>`<option value="${e.name||e.id}">${escHtml(e.name||'—')}</option>`).join('');
  return buildModal({
    id:'task-modal',title:'Add Task',
    body:`
      <input type="hidden" id="task-project-id">
      <div class="form-group"><label class="form-label">Task Title <span class="required">*</span></label>
        <input type="text" id="tk-title" class="form-input" placeholder="What needs to be done?">
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Project <span class="required">*</span></label>
          <select id="tk-project" class="form-select"><option value="">Select project…</option>${projOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Assigned To</label>
          <select id="tk-assignee" class="form-select"><option value="">Unassigned</option>${empOpts}</select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Priority</label>
          <select id="tk-priority" class="form-select">
            <option value="low">Low</option><option value="medium" selected>Medium</option>
            <option value="high">High</option><option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Due Date</label><input type="date" id="tk-due" class="form-input"></div>
        <div class="form-group"><label class="form-label">Est. Hours</label><input type="number" id="tk-hours" class="form-input" placeholder="0" min="0" step="0.5"></div>
      </div>
      <div class="form-group"><label class="form-label">Description</label>
        <textarea id="tk-desc" class="form-textarea" rows="2" placeholder="Task details, acceptance criteria…"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('task-modal')">Cancel</button>
            <button class="btn btn-primary" id="task-save-btn" onclick="saveTask()">Add Task</button>`,
  });
}

function milestoneModal() {
  const projOpts=_projects.map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  return buildModal({
    id:'milestone-modal',title:'Add Milestone',
    body:`
      <input type="hidden" id="ms-project-id">
      <div class="form-group"><label class="form-label">Milestone Title <span class="required">*</span></label>
        <input type="text" id="ms-title" class="form-input" placeholder="e.g. Phase 1 Delivery, UAT Sign-off…">
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Project <span class="required">*</span></label>
          <select id="ms-project" class="form-select"><option value="">Select…</option>${projOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Due Date <span class="required">*</span></label>
          <input type="date" id="ms-due" class="form-input">
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description</label>
        <textarea id="ms-desc" class="form-textarea" rows="2" placeholder="What needs to be achieved by this milestone?"></textarea>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('milestone-modal')">Cancel</button>
            <button class="btn btn-primary" id="ms-save-btn" onclick="saveMilestone()">Add Milestone</button>`,
  });
}

function timesheetModal() {
  const projOpts=_projects.filter(p=>p.status==='active').map(p=>`<option value="${p.id}">${escHtml(p.name||'—')}</option>`).join('');
  return buildModal({
    id:'timesheet-modal',title:'Log Time',
    body:`
      <input type="hidden" id="ts-project-preset">
      <input type="hidden" id="ts-task-preset">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Date <span class="required">*</span></label>
          <input type="date" id="ts-date" class="form-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group"><label class="form-label">Hours <span class="required">*</span></label>
          <input type="number" id="ts-hours" class="form-input" placeholder="2.5" min="0.25" max="24" step="0.25">
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Project <span class="required">*</span></label>
          <select id="ts-project" class="form-select" onchange="loadTasksForTS(this.value)"><option value="">Select…</option>${projOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Task (optional)</label>
          <select id="ts-task" class="form-select"><option value="">General / No specific task</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Work Done <span class="required">*</span></label>
        <textarea id="ts-desc" class="form-textarea" rows="2" placeholder="Brief description of what was worked on…"></textarea>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Logged By</label>
          <input type="text" id="ts-by" class="form-input" value="${escHtml(AuthState.profile?.name||'')}" placeholder="Your name">
        </div>
        <div class="form-group"><label class="form-label">Billable?</label>
          <select id="ts-billable" class="form-select"><option value="true">Yes — Billable</option><option value="false">No — Non-billable</option></select>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('timesheet-modal')">Cancel</button>
            <button class="btn btn-primary" id="ts-save-btn" onclick="saveTimesheet()">Log Time</button>`,
  });
}

// ── All global window functions ───────────────────────────────
let _pjTeam=[];

window.addTeamMember=()=>{
  const sel=document.getElementById('pj-team-add'); if(!sel||!sel.value) return;
  const name=sel.value;
  if(!_pjTeam.includes(name)) _pjTeam.push(name);
  renderTeamList();
  sel.value='';
};

function renderTeamList(){
  const el=document.getElementById('pj-team-list'); if(!el) return;
  el.innerHTML=_pjTeam.map((m,i)=>`
    <div style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(10,132,255,0.1);border-radius:999px;">
      <span style="font-size:12px;">${escHtml(m)}</span>
      <button onclick="_pjTeam.splice(${i},1);renderTeamList()" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:12px;padding:0;line-height:1;">✕</button>
    </div>`).join('');
}

window.saveProject=async()=>{
  if(!validateForm([{id:'pj-name',label:'Name',required:true},{id:'pj-start',label:'Start Date',required:true}])) return;
  const btn=document.getElementById('project-save-btn'); setLoading(btn,true);
  const id=document.getElementById('project-id').value;
  const custId=document.getElementById('pj-customer').value;
  const cust=_customers.find(c=>c.id===custId)||{};
  const data={name:document.getElementById('pj-name').value.trim(),type:document.getElementById('pj-type').value,customerId:custId||null,clientName:cust.name||'',projectManager:document.getElementById('pj-pm').value.trim(),startDate:document.getElementById('pj-start').value,endDate:document.getElementById('pj-end').value||null,status:document.getElementById('pj-status').value,budget:Number(document.getElementById('pj-budget').value)||0,contractValue:Number(document.getElementById('pj-contract').value)||0,hourlyRate:Number(document.getElementById('pj-rate').value)||0,actualCost:0,description:document.getElementById('pj-desc').value.trim(),team:_pjTeam,companyId:AuthState.company?.id||null};
  try{
    if(id){await dbUpdate(PROJ_COLLECTIONS.PROJECTS,id,data);Toast.success('Updated',`${data.name} updated.`);}
    else{await dbCreate(PROJ_COLLECTIONS.PROJECTS,data);Toast.success('Created',`${data.name} created.`);}
    closeModal('project-modal'); _pjTeam=[];
    document.getElementById('project-id').value='';
    await window.refreshProjects?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.editProject=(id)=>{
  const p=_projects.find(x=>x.id===id); if(!p) return;
  document.getElementById('project-modal-title').textContent='Edit Project';
  document.getElementById('project-id').value=p.id;
  document.getElementById('pj-name').value=p.name||'';
  document.getElementById('pj-type').value=p.type||'fixed-price';
  document.getElementById('pj-customer').value=p.customerId||'';
  document.getElementById('pj-pm').value=p.projectManager||'';
  document.getElementById('pj-start').value=p.startDate||'';
  document.getElementById('pj-end').value=p.endDate||'';
  document.getElementById('pj-status').value=p.status||'planning';
  document.getElementById('pj-budget').value=p.budget||'';
  document.getElementById('pj-contract').value=p.contractValue||'';
  document.getElementById('pj-rate').value=p.hourlyRate||'';
  document.getElementById('pj-desc').value=p.description||'';
  _pjTeam=[...(p.team||[])]; renderTeamList();
  openModal('project-modal');
};

window.openProjectDetail=(id)=>{
  _selectedProjectId=id;
  const p=_projects.find(x=>x.id===id); if(!p) return;
  const projTasks=_tasks.filter(t=>t.projectId===id);
  const projMS=_milestones.filter(m=>m.projectId===id);
  const projTS=_timesheets.filter(t=>t.projectId===id);
  const totalHours=projTS.reduce((s,t)=>s+(Number(t.hours)||0),0);
  const done=projTasks.filter(t=>t.status==='done').length;
  const pct=projTasks.length?Math.round((done/projTasks.length)*100):0;

  document.getElementById('project-detail-panel').innerHTML=`
    <div class="card" style="margin-top:var(--space-5);border:2px solid var(--border-strong);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--border-subtle);">
        <div>
          <div style="font-family:var(--font-display);font-size:20px;font-weight:700;">${escHtml(p.name||'—')}</div>
          <div style="font-size:12px;color:var(--text-secondary);">${escHtml(p.clientName||'Internal')} · ${escHtml(p.type||'—')} · Manager: ${escHtml(p.projectManager||'—')}</div>
        </div>
        <div style="display:flex;gap:8px;">
          ${badge(p.status||'planning')}
          <button class="btn btn-secondary btn-sm" onclick="openTaskForProject('${p.id}')">+ Task</button>
          <button class="btn btn-secondary btn-sm" onclick="openMilestoneForProject('${p.id}')">+ Milestone</button>
          <button class="btn btn-primary btn-sm" onclick="openTimesheetForProject('${p.id}')">+ Time</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('project-detail-panel').innerHTML=''">✕</button>
        </div>
      </div>

      <div class="grid-4" style="padding:var(--space-4);gap:var(--space-3);">
        ${[['Budget','₹'+Number(p.budget||0).toLocaleString('en-IN'),'💰'],['Spent','₹'+Number(p.actualCost||0).toLocaleString('en-IN'),'💸'],['Hours',''+totalHours+'h','⏱'],['Progress',''+pct+'%','📊']].map(([l,v,i])=>`
          <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:12px;text-align:center;">
            <div style="font-size:20px;">${i}</div>
            <div style="font-family:var(--font-display);font-size:18px;font-weight:700;margin:4px 0;">${v}</div>
            <div style="font-size:11px;color:var(--text-muted);">${l}</div>
          </div>`).join('')}
      </div>

      <div class="grid-2" style="padding:0 var(--space-5) var(--space-5);gap:var(--space-4);">
        <!-- Tasks -->
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Tasks (${projTasks.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:250px;overflow-y:auto;">
            ${projTasks.length?projTasks.map(t=>{
              const colors={todo:'var(--text-muted)','in-progress':'var(--brand-primary)',review:'var(--brand-warning)',done:'var(--brand-secondary)',blocked:'var(--brand-danger)'};
              return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <div style="width:6px;height:6px;border-radius:50%;background:${colors[t.status]||'var(--text-muted)'};flex-shrink:0;"></div>
                <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.title||'—')}</span>
                <span style="font-size:10px;color:var(--text-muted);">${escHtml(t.assignedTo||'—')}</span>
                <select class="form-select" style="font-size:10px;padding:2px 6px;width:auto;" onchange="updateTaskStatus('${t.id}',this.value)">${TASK_STATUSES.map(s=>`<option value="${s}" ${s===t.status?'selected':''}>${s.replace('-',' ')}</option>`).join('')}</select>
              </div>`;
            }).join(''):`<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No tasks. Click + Task to add.</div>`}
          </div>
        </div>

        <!-- Milestones -->
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:10px;">Milestones (${projMS.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:250px;overflow-y:auto;">
            ${projMS.length?projMS.map(m=>{
              const d=m.dueDate?Math.ceil((new Date(m.dueDate)-Date.now())/86400000):null;
              return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);">
                <span style="font-size:16px;">🏁</span>
                <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(m.title||'—')}</span>
                <span style="font-size:10px;color:${d!==null&&d<0?'var(--brand-danger)':d!==null&&d<=7?'var(--brand-warning)':'var(--text-muted)'};">${m.dueDate||'—'}</span>
                ${badge(m.status||'pending')}
              </div>`;
            }).join(''):`<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No milestones yet.</div>`}
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('project-detail-panel').scrollIntoView({behavior:'smooth'});
};

window.openTaskForProject=(projId)=>{
  const el=document.getElementById('tk-project'); if(el) el.value=projId;
  document.getElementById('task-project-id').value=projId||'';
  openModal('task-modal');
};
window.openMilestoneForProject=(projId)=>{
  const el=document.getElementById('ms-project'); if(el) el.value=projId;
  document.getElementById('ms-project-id').value=projId||'';
  openModal('milestone-modal');
};
window.openTimesheetForProject=(projId)=>{
  const el=document.getElementById('ts-project'); if(el) el.value=projId;
  loadTasksForTS(projId);
  openModal('timesheet-modal');
};
window.openTimesheetForTask=(taskId)=>{
  const t=_tasks.find(x=>x.id===taskId); if(!t) return;
  const projEl=document.getElementById('ts-project'); if(projEl) projEl.value=t.projectId||'';
  loadTasksForTS(t.projectId||'');
  setTimeout(()=>{const taskEl=document.getElementById('ts-task');if(taskEl)taskEl.value=taskId;},300);
  openModal('timesheet-modal');
};

window.loadTasksForTS=(projId)=>{
  const el=document.getElementById('ts-task'); if(!el) return;
  const projTasks=_tasks.filter(t=>t.projectId===projId&&t.status!=='done');
  el.innerHTML=`<option value="">General / No specific task</option>`+projTasks.map(t=>`<option value="${t.id}">${escHtml(t.title||'—')}</option>`).join('');
};

window.saveTask=async()=>{
  if(!validateForm([{id:'tk-title',label:'Title',required:true},{id:'tk-project',label:'Project',required:true}])) return;
  const btn=document.getElementById('task-save-btn'); setLoading(btn,true);
  const projId=document.getElementById('tk-project').value;
  try{
    await dbCreate(PROJ_COLLECTIONS.TASKS,{title:document.getElementById('tk-title').value.trim(),projectId:projId,assignedTo:document.getElementById('tk-assignee').value||null,priority:document.getElementById('tk-priority').value,dueDate:document.getElementById('tk-due').value||null,estimatedHours:Number(document.getElementById('tk-hours').value)||0,description:document.getElementById('tk-desc').value.trim(),status:'todo',companyId:AuthState.company?.id||null});
    Toast.success('Task Added','Task created.');
    closeModal('task-modal');
    ['tk-title','tk-due','tk-hours','tk-desc'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    await window.refreshProjects?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveMilestone=async()=>{
  if(!validateForm([{id:'ms-title',label:'Title',required:true},{id:'ms-project',label:'Project',required:true},{id:'ms-due',label:'Due Date',required:true}])) return;
  const btn=document.getElementById('ms-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(PROJ_COLLECTIONS.MILESTONES,{title:document.getElementById('ms-title').value.trim(),projectId:document.getElementById('ms-project').value,dueDate:document.getElementById('ms-due').value,description:document.getElementById('ms-desc').value.trim(),status:'pending',companyId:AuthState.company?.id||null});
    Toast.success('Milestone Added','Milestone created.');
    closeModal('milestone-modal');
    await window.refreshProjects?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveTimesheet=async()=>{
  if(!validateForm([{id:'ts-project',label:'Project',required:true},{id:'ts-hours',label:'Hours',required:true},{id:'ts-desc',label:'Description',required:true}])) return;
  const btn=document.getElementById('ts-save-btn'); setLoading(btn,true);
  const projId=document.getElementById('ts-project').value;
  const hours=Number(document.getElementById('ts-hours').value)||0;
  const proj=_projects.find(p=>p.id===projId)||{};
  try{
    await dbCreate(PROJ_COLLECTIONS.TIMESHEETS,{date:document.getElementById('ts-date').value,projectId:projId,projectName:proj.name||'',taskId:document.getElementById('ts-task').value||null,hours,description:document.getElementById('ts-desc').value.trim(),loggedBy:document.getElementById('ts-by').value.trim()||AuthState.profile?.name||'',billable:document.getElementById('ts-billable').value==='true',companyId:AuthState.company?.id||null});
    // Update project actual cost
    const hourlyRate=Number(proj.hourlyRate)||0;
    if(hourlyRate>0){await dbUpdate(PROJ_COLLECTIONS.PROJECTS,projId,{actualCost:(Number(proj.actualCost)||0)+hours*hourlyRate});}
    Toast.success('Time Logged',`${hours}h logged.`);
    closeModal('timesheet-modal'); document.getElementById('ts-hours').value=''; document.getElementById('ts-desc').value='';
    await window.refreshProjects?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.updateTaskStatus=async(id,status)=>{
  try{
    await dbUpdate(PROJ_COLLECTIONS.TASKS,id,{status,updatedAt:new Date().toISOString()});
    if(status==='done') Toast.success('Done! ✅','Task completed.');
    const idx=_tasks.findIndex(t=>t.id===id); if(idx>=0) _tasks[idx].status=status;
  }catch(e){Toast.error('Failed',e.message);}
};

window.completeProject=async(id)=>{
  if(!confirm('Mark project as completed?'))return;
  try{await dbUpdate(PROJ_COLLECTIONS.PROJECTS,id,{status:'completed',completedAt:new Date().toISOString()});Toast.success('Completed! 🎉','Project marked as completed.');await window.refreshProjects?.();}
  catch(e){Toast.error('Failed',e.message);}
};

window.deleteProject=async(id)=>{
  if(!confirm('Delete project? All tasks, milestones and timesheets will remain but unlinked.'))return;
  try{await dbDelete(PROJ_COLLECTIONS.PROJECTS,id);Toast.success('Deleted','Project removed.');await window.refreshProjects?.();}
  catch(e){Toast.error('Failed',e.message);}
};

window.deleteTask=async(id)=>{if(!confirm('Delete task?'))return;try{await dbDelete(PROJ_COLLECTIONS.TASKS,id);await window.refreshProjects?.();Toast.success('Deleted','Task removed.');}catch(e){Toast.error('Failed',e.message);}};
window.deleteTimesheet=async(id)=>{if(!confirm('Delete timesheet entry?'))return;try{await dbDelete(PROJ_COLLECTIONS.TIMESHEETS,id);await window.refreshProjects?.();Toast.success('Deleted','Entry removed.');}catch(e){Toast.error('Failed',e.message);}};
