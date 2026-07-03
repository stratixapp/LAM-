// ============================================================
// LAM — Utilities
// ============================================================

// Format currency in INR
export function formatCurrency(amount, compact = false) {
  if (amount == null) return '₹0';
  const num = Number(amount);
  if (compact) {
    if (num >= 1e7)  return `₹${(num / 1e7).toFixed(2)}Cr`;
    if (num >= 1e5)  return `₹${(num / 1e5).toFixed(1)}L`;
    if (num >= 1000) return `₹${(num / 1000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(num);
}

// Format date
export function formatDate(value, opts = {}) {
  if (!value) return '—';
  const d = value?.toDate ? value.toDate() : new Date(value);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...opts });
}

// Format datetime
export function formatDateTime(value) {
  if (!value) return '—';
  const d = value?.toDate ? value.toDate() : new Date(value);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Relative time
export function timeAgo(value) {
  if (!value) return '—';
  const d = value?.toDate ? value.toDate() : new Date(value);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7)  return `${days}d ago`;
  return formatDate(d);
}

// Generate ID
export function genId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10).toUpperCase();
}

// Get initials from name
export function getInitials(name = '') {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '??';
}

// Debounce
export function debounce(fn, delay = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// Throttle
export function throttle(fn, limit = 300) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= limit) { last = now; fn(...args); }
  };
}

// Deep clone
export function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// Escape HTML
export function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Number with commas (Indian format)
export function formatNumber(n) {
  return new Intl.NumberFormat('en-IN').format(Number(n) || 0);
}

// Validate email
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate phone (Indian)
export function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone.replace(/\D/g,''));
}

// Truncate string
export function truncate(str, len = 30) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// Search/filter array of objects
export function searchFilter(items, query, fields) {
  if (!query?.trim()) return items;
  // Use LAMSearch fuzzy engine if available (Tier 4)
  if (window.LAMSearch) return window.LAMSearch.searchFilter(items, query, fields);
  // Baseline substring match
  const q = query.toLowerCase();
  return items.filter(item =>
    fields.some(f => String(item[f] || '').toLowerCase().includes(q))
  );
}

// Async version — uses LAMWorker (Tier 6) for large datasets
export async function searchFilterAsync(items, query, fields, threshold = 0.3) {
  if (!query?.trim()) return items;
  if (items.length > 500 && window.LAMWorker) {
    try { return await window.LAMWorker.searchItems(items, query, fields, threshold); }
    catch {}
  }
  return searchFilter(items, query, fields);
}

// Sort array
export function sortBy(items, key, dir = 'asc') {
  return [...items].sort((a, b) => {
    const va = a[key]; const vb = b[key];
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// Show/hide element
export function show(el) { if (el) el.classList.remove('hidden'); }
export function hide(el) { if (el) el.classList.add('hidden'); }
export function toggle(el) { if (el) el.classList.toggle('hidden'); }

// Set loading state on button
export function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn._original = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = `<span class="spinner"></span>`;
  } else {
    btn.disabled  = false;
    btn.innerHTML = btn._original || btn.innerHTML;
  }
}

// Format file size
export function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Status color helper
export function statusBadge(status) {
  const map = {
    // General
    active:       'green',  inactive:    'gray',   pending:   'yellow',
    approved:     'green',  rejected:    'red',    draft:     'gray',
    cancelled:    'red',    closed:      'gray',   open:      'blue',
    // Finance
    paid:         'green',  unpaid:      'red',    partial:   'yellow',
    overdue:      'red',    credit:      'blue',
    // Logistics
    'in-transit': 'blue',   delivered:   'green',  loaded:    'orange',
    dispatched:   'blue',   returned:    'orange',
    // HR specific
    on_leave:     'yellow', terminated:  'red',    resigned:  'gray',
    probation:    'yellow', intern:      'blue',   contract:  'orange',
    // Attendance
    present:      'green',  absent:      'red',    'half-day':'yellow',
    leave:        'blue',   wfh:         'purple', late:      'orange',
    holiday:      'gray',
    // Leave types
    casual:       'blue',   sick:        'yellow', earned:    'green',
    maternity:    'orange', paternity:   'blue',   lop:       'red',
    comp_off:     'purple',
    // Employment
    full_time:    'green',  part_time:   'yellow', consultant:'purple',
  };
  return map[status?.toLowerCase()] || 'gray';
}
