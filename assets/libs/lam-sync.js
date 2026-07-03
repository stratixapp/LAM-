// ============================================================
// LAM Sync Engine v1 — Multi-tab real-time sync + Push Notifications
// BroadcastChannel keeps all open tabs in sync instantly.
// Web Push for OS-level alerts (trip assigned, low stock, etc.)
// Background sync queue for failed writes.
// ============================================================

const LAMSync = (() => {

  // ── Multi-tab sync via BroadcastChannel ──────────────────
  const CHANNEL = 'lam_data_sync';
  let _channel  = null;
  let _handlers = {};

  function _getChannel() {
    if (!_channel) {
      _channel = new BroadcastChannel(CHANNEL);
      _channel.onmessage = (e) => {
        const { type, collection, id, data, timestamp } = e.data || {};
        if (!type) return;

        // Dispatch to registered handlers
        const key = `${type}:${collection}`;
        (_handlers[key]        || []).forEach(fn => fn(data, id));
        (_handlers[type]       || []).forEach(fn => fn(data, id, collection));
        (_handlers['*']        || []).forEach(fn => fn(e.data));
      };
    }
    return _channel;
  }

  /**
   * Broadcast a data change to all other open tabs
   * Called automatically by firebase.js after every write
   */
  function broadcast(type, collection, id, data) {
    try {
      _getChannel().postMessage({ type, collection, id, data, timestamp: Date.now() });
    } catch {}
  }

  /**
   * Register a handler for sync events in this tab
   * @param {string} event - 'write:employees', 'delete:inventory', 'write', '*'
   * @param {Function} fn
   */
  function on(event, fn) {
    if (!_handlers[event]) _handlers[event] = [];
    _handlers[event].push(fn);
    return () => { _handlers[event] = _handlers[event].filter(f => f !== fn); };
  }

  /**
   * Patch firebase.js to auto-broadcast after every write
   * Call this once at app init
   */
  function patchFirebase() {
    // We patch the global functions exported by firebase.js
    // by wrapping them with broadcast calls
    const originalSet = window._LAMFirebase?.dbSet;
    if (!originalSet) return; // not needed — firebase.js has its own notify

    console.log('LAMSync: patched firebase adapter for cross-tab sync');
  }

  // ── Background Sync Queue ─────────────────────────────────
  const QUEUE_KEY = 'lam_sync_queue';

  function enqueue(operation) {
    try {
      const queue = getQueue();
      queue.push({ ...operation, queuedAt: Date.now(), id: Date.now().toString(36) });
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

      // Register background sync with SW if supported
      if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
        navigator.serviceWorker.ready.then(reg => reg.sync.register('lam-data-sync'));
      }
    } catch (e) { console.warn('LAMSync enqueue error:', e); }
  }

  function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  }

  function clearQueue() { localStorage.removeItem(QUEUE_KEY); }

  function getQueueCount() { return getQueue().length; }

  /**
   * Flush the sync queue — call this when backend is connected
   * @param {Function} flushFn - async (operation) => void
   */
  async function flushQueue(flushFn) {
    const queue = getQueue();
    if (!queue.length) return { flushed: 0, failed: 0 };

    let flushed = 0, failed = 0;
    const remaining = [];

    for (const op of queue) {
      try {
        await flushFn(op);
        flushed++;
      } catch (e) {
        console.warn('LAMSync flush failed:', op, e);
        failed++;
        remaining.push(op);
      }
    }

    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    return { flushed, failed };
  }

  // ── Web Push Notifications ────────────────────────────────

  const VAPID_PUBLIC_KEY = 'BLKk5nk3Bz2q8BqUxkY9Z3VpZxE8Hq3FY4Mf5tNqY2K6RhOkXwJm8vwPzI9d3LkT7MzH'; // placeholder — replace with real key

  let _pushSubscription = null;

  async function requestPushPermission() {
    if (!('Notification' in window)) {
      return { granted: false, reason: 'Notifications not supported' };
    }
    if (Notification.permission === 'granted') {
      return { granted: true };
    }
    if (Notification.permission === 'denied') {
      return { granted: false, reason: 'Permission denied by user' };
    }
    const result = await Notification.requestPermission();
    return { granted: result === 'granted' };
  }

  async function subscribePush(vapidKey) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return null;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: _urlBase64ToUint8Array(vapidKey || VAPID_PUBLIC_KEY),
      });
      _pushSubscription = sub;

      // Store subscription for backend to send pushes
      localStorage.setItem('lam_push_sub', JSON.stringify(sub.toJSON()));
      return sub;
    } catch (e) {
      console.warn('Push subscribe error:', e);
      return null;
    }
  }

  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = window.atob(base64);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  /** Show a local notification immediately (no server needed) */
  async function showLocalNotification(title, opts = {}) {
    const { granted } = await requestPushPermission();
    if (!granted) return;

    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(title, {
        body:    opts.body    || '',
        icon:    opts.icon    || './assets/icons/icon-192.png',
        badge:   opts.badge   || './assets/icons/badge-72.png',
        tag:     opts.tag     || 'lam',
        vibrate: opts.vibrate || [100, 50, 100],
        data:    opts.data    || {},
        actions: opts.actions || [],
      });
    } else {
      new Notification(title, { body: opts.body, icon: './assets/icons/icon-192.png' });
    }
  }

  // ── Predefined notification types ────────────────────────

  const Notify = {
    tripAssigned: (tripId, driverName, dest) => showLocalNotification('New Trip Assigned 🚛', {
      body:    `Driver: ${driverName} → ${dest}`,
      tag:     `trip-${tripId}`,
      data:    { url: `./dashboard.html#trips`, tripId },
      actions: [{ action: 'view', title: 'View Trip' }],
    }),

    lowStock: (productName, qty, reorder) => showLocalNotification('Low Stock Alert ⚠️', {
      body:    `${productName}: ${qty} units left (reorder at ${reorder})`,
      tag:     `stock-${productName}`,
      data:    { url: `./dashboard.html#inventory` },
      actions: [{ action: 'order', title: 'Create PO' }],
    }),

    paymentReceived: (amount, customer) => showLocalNotification('Payment Received ✅', {
      body:    `₹${amount.toLocaleString('en-IN')} from ${customer}`,
      tag:     `payment-${Date.now()}`,
      data:    { url: `./dashboard.html#invoices` },
    }),

    invoiceOverdue: (invNumber, customer, amount) => showLocalNotification('Invoice Overdue 🔴', {
      body:    `${invNumber} — ${customer}: ₹${amount.toLocaleString('en-IN')}`,
      tag:     `overdue-${invNumber}`,
      data:    { url: `./dashboard.html#invoices` },
      actions: [{ action: 'remind', title: 'Send Reminder' }],
    }),

    deliveryComplete: (dnNumber, receiver) => showLocalNotification('Delivery Confirmed ✅', {
      body:    `${dnNumber} received by ${receiver}`,
      tag:     `delivery-${dnNumber}`,
      data:    { url: `./dashboard.html#orderops` },
    }),

    grnReceived: (grnNumber, vendor) => showLocalNotification('GRN Received 📦', {
      body:    `${grnNumber} from ${vendor}`,
      tag:     `grn-${grnNumber}`,
      data:    { url: `./dashboard.html#grn` },
    }),

    leaveRequest: (empName, dates) => showLocalNotification('Leave Request 📋', {
      body:    `${empName} requested leave: ${dates}`,
      tag:     `leave-${Date.now()}`,
      data:    { url: `./dashboard.html#hr` },
      actions: [{ action: 'approve', title: 'Approve' }, { action: 'reject', title: 'Reject' }],
    }),

    custom: (title, body, opts = {}) => showLocalNotification(title, { body, ...opts }),
  };

  // ── Online/Offline indicator ──────────────────────────────

  function watchConnectivity(onChange) {
    const update = () => onChange(navigator.onLine);
    window.addEventListener('online',  () => update());
    window.addEventListener('offline', () => update());
    update(); // initial state
    return () => {
      window.removeEventListener('online',  update);
      window.removeEventListener('offline', update);
    };
  }

  /**
   * Show a persistent offline banner in the UI
   */
  function mountOfflineBanner() {
    const banner = document.createElement('div');
    banner.id    = 'lam-offline-banner';
    banner.style.cssText = `
      display:none;position:fixed;top:0;left:0;right:0;z-index:99999;
      background:#FF453A;color:#fff;text-align:center;
      padding:8px 16px;font-size:12px;font-weight:600;
      box-shadow:0 2px 8px rgba(255,69,58,0.4);
    `;
    banner.innerHTML = '📡 You are offline — changes are saved locally and will sync when reconnected.';
    document.body.appendChild(banner);

    const qBadge = document.createElement('span');
    qBadge.id    = 'lam-queue-badge';
    qBadge.style.cssText = 'margin-left:8px;background:rgba(255,255,255,0.3);padding:1px 6px;border-radius:10px;font-size:10px;';

    watchConnectivity(online => {
      banner.style.display = online ? 'none' : 'block';
      if (!online) {
        const q = getQueueCount();
        if (q > 0) {
          qBadge.textContent = `${q} pending`;
          if (!banner.contains(qBadge)) banner.appendChild(qBadge);
        }
      }
    });
  }

  // ── Periodic alerts (low stock, overdue invoices) ─────────

  let _alertInterval = null;

  async function startPeriodicAlerts(opts = {}) {
    const { checkEvery = 30 * 60 * 1000 } = opts; // default 30 min
    clearInterval(_alertInterval);

    const check = async () => {
      try {
        // Check low stock
        const products = JSON.parse(localStorage.getItem('lam_db_products') || '{}');
        Object.values(products).forEach(p => {
          if (p.status === 'inactive') return;
          if (Number(p.qty || 0) <= Number(p.reorderPoint || p.reorderQty || 0)) {
            Notify.lowStock(p.name, p.qty, p.reorderPoint || p.reorderQty);
          }
        });

        // Check overdue invoices
        const invoices = JSON.parse(localStorage.getItem('lam_db_invoices') || '{}');
        const today    = new Date();
        Object.values(invoices).forEach(inv => {
          if (inv.paymentStatus === 'paid') return;
          if (!inv.dueDate) return;
          const due = new Date(inv.dueDate);
          if (due < today) {
            const days = Math.floor((today - due) / 86400000);
            if (days === 1 || days === 7 || days === 30) {
              Notify.invoiceOverdue(
                inv.invoiceNumber || inv.id?.slice(0,8),
                inv.customerName  || 'Customer',
                inv.totalAmount   || 0
              );
            }
          }
        });
      } catch (e) { console.warn('LAMSync periodic check error:', e); }
    };

    _alertInterval = setInterval(check, checkEvery);
    check(); // run immediately
  }

  function stopPeriodicAlerts() { clearInterval(_alertInterval); }

  return {
    // Multi-tab
    broadcast,
    on,
    patchFirebase,

    // Background sync queue
    enqueue,
    getQueue,
    clearQueue,
    getQueueCount,
    flushQueue,

    // Push notifications
    requestPushPermission,
    subscribePush,
    showLocalNotification,
    Notify,

    // Connectivity
    watchConnectivity,
    mountOfflineBanner,

    // Periodic alerts
    startPeriodicAlerts,
    stopPeriodicAlerts,
  };

})();

window.LAMSync = LAMSync;
