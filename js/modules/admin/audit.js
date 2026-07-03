// ============================================================
// LAM — Audit Logs Module
// ============================================================

import { dbGetAll, COLLECTIONS, where, orderBy, limit } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { formatDateTime, escHtml } from '../../core/utils.js';
import { pageShell } from '../_shared.js';

export async function renderAudit(container) {
  container.innerHTML = pageShell({
    title: 'Audit Logs',
    subtitle: 'Full trail of every action performed in your workspace.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="exportAuditLog()">⬇ Export</button>`,
    content: `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:var(--space-4);flex-wrap:wrap;">
        <div class="input-wrapper" style="flex:1;max-width:300px;">
          <span class="input-icon-left" style="font-size:13px;">🔍</span>
          <input type="text" id="audit-search" class="form-input has-icon-left" placeholder="Search action, user, module…" oninput="filterAuditLogs(this.value)">
        </div>
        <select id="audit-filter-action" class="form-select" style="width:auto;" onchange="filterAuditByAction(this.value)">
          <option value="">All Actions</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="delete">Delete</option>
          <option value="login">Login</option>
        </select>
        <div id="audit-count" style="font-size:12px;color:var(--text-muted);"></div>
      </div>
      <div id="audit-content">
        <div style="display:flex;justify-content:center;padding:60px;">
          <div class="spinner"></div>
        </div>
      </div>
    `,
  });

  await loadAuditLogs();

  window.verifyAuditChain = async () => {
    if (!window.LAMCRYPTO) { Toast.info('Not available', 'Crypto engine not loaded.'); return; }
    Toast.info('Verifying…', 'Checking audit log integrity chain…');
    try {
      const entries = await dbGetAll(COLLECTIONS.AUDIT_LOGS, []);
      const sorted  = entries.sort((a,b) => (a.timestamp||'') > (b.timestamp||'') ? 1 : -1);
      const result  = await window.LAMCRYPTO.verifyAuditChain(sorted);
      if (result.valid) {
        Toast.success('✅ Chain Valid', `All ${sorted.length} audit entries are untampered.`);
      } else {
        Toast.error('🔴 Chain Broken', `Tampering detected at entry ${result.tamperedAt + 1}: ${result.entry?.action || '—'}`);
      }
    } catch(e) {
      Toast.error('Verify failed', e.message);
    }
  };

  window.exportAuditLog = () => {
    LAM.Toast.info('Exporting', 'Audit log export started…');
  };
}

let _allLogs = [];

async function loadAuditLogs() {
  try {
    const cid = AuthState.company?.id;
    const constraints = [
      ...(cid ? [where('companyId', '==', cid)] : []),
      orderBy('createdAt', 'desc'),
      limit(200),
    ];
    _allLogs = await dbGetAll(COLLECTIONS.AUDIT_LOGS, constraints);

    // Also pull from LAMUsers audit log (lam_audit_log) and merge + dedupe
    if (window.LAMDB) {
      try {
        const userLogs = await window.LAMDB.dbGetAll('lam_audit_log').catch(() => []);
        // Convert to the same shape as old audit logs for renderAuditTable
        const converted = userLogs.map(l => ({
          id:         l.id,
          action:     l.action,
          module:     l.entity || '—',
          user:       l.userName || 'System',
          role:       l.userRole,
          details:    l.detail || '',
          createdAt:  l.createdAt,
          humanTime:  l.humanTime,
          _lam_users: true,
        }));
        // Merge and sort newest first
        _allLogs = [..._allLogs, ...converted]
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
          .slice(0, 300);
      } catch {}
    }

    renderAuditTable(_allLogs);
  } catch(e) {
    document.getElementById('audit-content').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:12px;color:var(--text-muted);">
        <div style="font-size:40px;opacity:0.3;">📜</div>
        <div style="font-size:14px;font-weight:500;color:var(--text-secondary);">No audit logs yet</div>
        <div style="font-size:12px;text-align:center;max-width:300px;line-height:1.7;">
          Every create, update, and delete action will appear here as your team works in LAM.
        </div>
      </div>
    `;
  }
}

function renderAuditTable(logs) {
  const el = document.getElementById('audit-content');
  const count = document.getElementById('audit-count');
  if (!el) return;
  if (count) count.textContent = `${logs.length} record${logs.length !== 1 ? 's' : ''}`;

  if (!logs.length) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:12px;color:var(--text-muted);">
        <div style="font-size:40px;opacity:0.3;">📜</div>
        <div style="font-size:14px;font-weight:500;color:var(--text-secondary);">No matching logs</div>
      </div>`;
    return;
  }

  const actionBadge = (a) => {
    const map = { create:'green', update:'yellow', delete:'red', login:'blue' };
    return `<span class="badge badge-${map[a]||'gray'}">${escHtml(a||'—')}</span>`;
  };

  el.innerHTML = `
    <div class="table-container">
      <table class="table">
        <thead>
          <tr>
            <th>Action</th>
            <th>User</th>
            <th>Module</th>
            <th>Details</th>
            <th>Record ID</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(l => `
            <tr>
              <td>${actionBadge(l.action)}</td>
              <td>
                <div style="font-size:12px;font-weight:500;">${escHtml(l.userName || l.user || '—')}</div>
                <div style="font-size:10px;color:var(--text-muted);">${escHtml(l.role || l.userEmail || l.userId || '')}</div>
              </td>
              <td><span class="badge badge-gray">${escHtml(l.module || l.entity || '—')}</span></td>
              <td style="font-size:12px;color:var(--text-secondary);max-width:240px;white-space:normal;">
                ${l._lam_users
                  ? `<span title="${escHtml(l.details)}">${escHtml(l.details || '—')}</span>`
                  : escHtml(l.details || '—')
                }
              </td>
              <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);">${escHtml(l.recordId || l.entityId || '—')}</td>
              <td style="font-size:11px;color:var(--text-muted);white-space:nowrap;">
                ${l.humanTime || formatDateTime(l.createdAt)}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

window.filterAuditLogs = async (q) => {
  const lower = q.toLowerCase();
  const filtered = _allLogs.filter(l =>
    (l.action||'').toLowerCase().includes(lower) ||
    (l.userName||'').toLowerCase().includes(lower) ||
    (l.module||'').toLowerCase().includes(lower) ||
    (l.details||'').toLowerCase().includes(lower)
  );
  renderAuditTable(filtered);
};

window.filterAuditByAction = (action) => {
  const filtered = action ? _allLogs.filter(l => l.action === action) : _allLogs;
  renderAuditTable(filtered);
};
