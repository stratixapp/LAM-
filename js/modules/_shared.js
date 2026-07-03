// ============================================================
// LAM — Shared Module Helpers
// Reusable table, modal, form builders for all modules
// ============================================================

import { formatDate, timeAgo, escHtml, statusBadge, getInitials } from '../core/utils.js';

// ── Generic Page Shell ────────────────────────────────────────
export function pageShell({ title, subtitle, actions = '', content }) {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">${title}</h1>
        ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
      </div>
      <div class="flex gap-3 items-center">${actions}</div>
    </div>
    ${content}
  `;
}

// ── Data Table Builder ────────────────────────────────────────
export function buildTable({ id, columns, rows, emptyMsg = 'No records found', onRowClick }) {
  const colHeaders = columns.map(c => `
    <th class="${c.sortable !== false ? 'sortable' : ''}" 
        ${c.sortable !== false ? `onclick="sortTable('${id}','${c.key}')"` : ''}
        style="${c.width ? `width:${c.width}` : ''}">
      ${c.label}
      ${c.sortable !== false ? `<span class="sort-icon">↕</span>` : ''}
    </th>
  `).join('');

  const bodyRows = rows.length ? rows.map(row => `
    <tr style="cursor:${onRowClick?'pointer':'default'}" 
        ${onRowClick ? `onclick="${onRowClick}('${row.id}')"` : ''}>
      ${columns.map(c => `<td class="${c.class||''}">${c.render ? c.render(row) : escHtml(row[c.key] ?? '—')}</td>`).join('')}
    </tr>
  `).join('') : `
    <tr>
      <td colspan="${columns.length}">
        <div class="table-empty">
          <div class="empty-icon">📭</div>
          <div class="empty-title">${emptyMsg}</div>
          <div class="empty-text">Use the button above to add your first record.</div>
        </div>
      </td>
    </tr>
  `;

  return `
    <div class="table-container" id="${id}-container">
      <table class="table" id="${id}">
        <thead><tr>${colHeaders}</tr></thead>
        <tbody id="${id}-body">${bodyRows}</tbody>
      </table>
    </div>
  `;
}

// ── Modal Builder ─────────────────────────────────────────────
export function buildModal({ id, title, size = '', body, footer }) {
  return `
    <div class="modal-backdrop hidden" id="${id}">
      <div class="modal ${size ? 'modal-' + size : ''}">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="modal-close" onclick="closeModal('${id}')">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>
    </div>
  `;
}

// ── Search + Filter Bar ───────────────────────────────────────
export function searchBar({ id, placeholder = 'Search…', filters = [], onSearch, onFilter }) {
  return `
    <div class="flex gap-3 items-center" style="margin-bottom:var(--space-4);">
      <div class="input-wrapper" style="flex:1;max-width:320px;">
        <span class="input-icon-left" style="font-size:13px;">🔍</span>
        <input type="text" id="${id}-search" class="form-input has-icon-left" 
               placeholder="${placeholder}" 
               oninput="${onSearch || ''}(this.value)">
      </div>
      ${filters.map(f => `
        <select class="form-select" id="${id}-filter-${f.key}" 
                style="width:auto;padding-right:36px;" 
                onchange="${onFilter || ''}('${f.key}',this.value)">
          <option value="">${f.label}</option>
          ${f.options.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
      `).join('')}
      <div id="${id}-count" style="font-size:12px;color:var(--text-muted);white-space:nowrap;"></div>
    </div>
  `;
}

// ── Avatar Cell ───────────────────────────────────────────────
export function avatarCell(name, sub, color = 'var(--brand-primary)', bg = 'rgba(10,132,255,0.12)') {
  return `
    <div class="td-user">
      <div class="avatar" style="background:${bg};color:${color};">${getInitials(name)}</div>
      <div>
        <div class="user-name">${escHtml(name || '—')}</div>
        ${sub ? `<div class="user-email">${escHtml(sub)}</div>` : ''}
      </div>
    </div>
  `;
}

// ── Status Badge ──────────────────────────────────────────────
export function badge(status, customLabel) {
  const color = statusBadge(status);
  const label = customLabel || (status ? status.charAt(0).toUpperCase() + status.slice(1) : '—');
  return `<span class="badge badge-${color} badge-dot">${escHtml(label)}</span>`;
}

// ── Actions Dropdown ──────────────────────────────────────────
export function actionsMenu(id, items) {
  const menuId = `menu-${id}`;
  return `
    <div class="dropdown">
      <button class="btn btn-ghost btn-icon" onclick="toggleMenu('${menuId}')">⋯</button>
      <div class="dropdown-menu hidden" id="${menuId}">
        ${items.map(item => `
          <div class="dropdown-item ${item.danger ? 'danger' : ''}" 
               onclick="closeAllMenus();${item.action}">
            ${item.icon ? `<span>${item.icon}</span>` : ''}
            ${escHtml(item.label)}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ── Pagination ────────────────────────────────────────────────
export function buildPagination({ id, total, page, perPage, onChange }) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return '';
  const start = (page - 1) * perPage + 1;
  const end   = Math.min(page * perPage, total);

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      pages.push(i);
    } else if (pages[pages.length-1] !== '…') {
      pages.push('…');
    }
  }

  return `
    <div class="pagination">
      <div class="pagination-info">Showing ${start}–${end} of ${total} records</div>
      <div class="pagination-controls">
        <button class="page-btn" onclick="${onChange}(${page-1})" ${page<=1?'disabled':''}>‹</button>
        ${pages.map(p => p === '…'
          ? `<span class="page-btn" style="cursor:default;">…</span>`
          : `<button class="page-btn ${p===page?'active':''}" onclick="${onChange}(${p})">${p}</button>`
        ).join('')}
        <button class="page-btn" onclick="${onChange}(${page+1})" ${page>=totalPages?'disabled':''}>›</button>
      </div>
    </div>
  `;
}

// ── Form Validators ───────────────────────────────────────────
export function validateForm(fields) {
  let valid = true;
  fields.forEach(({ id, label, required, minLength, pattern, patternMsg }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value.trim();
    el.classList.remove('error');
    const hint = el.parentElement?.querySelector('.form-error');
    if (hint) hint.remove();

    const addError = (msg) => {
      valid = false;
      el.classList.add('error');
      const err = document.createElement('span');
      err.className = 'form-error';
      err.textContent = msg;
      el.parentElement.appendChild(err);
    };

    if (required && !val) { addError(`${label} is required.`); return; }
    if (minLength && val.length < minLength) { addError(`${label} must be at least ${minLength} characters.`); return; }
    if (pattern && !pattern.test(val)) { addError(patternMsg || `${label} is invalid.`); return; }
  });
  return valid;
}

// ── DOM Modal Helpers ─────────────────────────────────────────
export function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
export function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// Guards prevent duplicate listeners when modules re-render
let _modalCloseReady = false;
let _menuCloseReady  = false;

export function setupModalClose() {
  if (_modalCloseReady) return;
  _modalCloseReady = true;
  document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) {
      e.target.classList.add('hidden');
    }
  });
}

// ── Menu helpers ──────────────────────────────────────────────
export function setupMenuClose() {
  if (_menuCloseReady) return;
  _menuCloseReady = true;
  document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown')) closeAllMenus();
  });
}

window.toggleMenu = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const isOpen = !el.classList.contains('hidden');
  closeAllMenus();
  if (!isOpen) el.classList.remove('hidden');
};

window.closeAllMenus = () => {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
};

window.closeModal = closeModal;
window.openModal  = openModal;

// ── Sort table ────────────────────────────────────────────────
window.sortTable = (tableId, key) => {
  const table = document.getElementById(tableId);
  if (!table || !window[tableId + '_data']) return;
  const current = table.dataset.sortKey;
  const dir = current === key && table.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  table.dataset.sortKey = key;
  table.dataset.sortDir = dir;
  // Module must handle re-render via window[tableId+'_render']
  window[tableId + '_render']?.(key, dir);
};
