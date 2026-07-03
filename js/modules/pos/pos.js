// ============================================================
// LAM — Point of Sale (POS) Module
// Full retail POS — barcode scan, cart management,
// cash/UPI/card payments, receipts, shift management,
// day-end report, loyalty points
// Interconnects: Products → Inventory → Finance → Accounting
// ============================================================

import { dbCreate, dbUpdate, dbGetAll, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { FIN_COLLECTIONS } from '../finance/invoice.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  escHtml, setLoading, genId, formatNumber, formatCurrency, debounce
} from '../../core/utils.js';
import { pageShell, buildModal, openModal, closeModal, setupModalClose } from '../_shared.js';

export const POS_COLLECTIONS = {
  SESSIONS: 'pos_sessions',
  SALES:    'pos_sales',
  SHIFTS:   'pos_shifts',
};

let _products=[], _inventory=[], _cart=[], _session=null, _customer=null;
let _filteredProducts=[], _activeCategory='all';
const GST_RATE_DEFAULT = 18;

export async function renderPOS(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_products, _inventory] = await Promise.all([
    dbGetAll(COLLECTIONS.PRODUCTS,  [...c]),
    dbGetAll(COLLECTIONS.INVENTORY, [...c]),
  ]);

  _filteredProducts = [..._products];

  // Check for active session
  try {
    const sessions = await dbGetAll(POS_COLLECTIONS.SESSIONS, [...c, where('status','==','open'), orderBy('openedAt','desc')]);
    _session = sessions[0] || null;
  } catch(e) { _session = null; }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 140px);background:var(--bg-surface);">

      <!-- POS Top Bar -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:16px;">
          <div style="font-family:var(--font-display);font-size:18px;font-weight:800;color:var(--brand-primary);">🛒 LAM POS</div>
          <div style="font-size:12px;color:var(--text-muted);">${new Date().toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</div>
          ${_session ? `<span class="badge badge-green badge-dot">Session Open — ${_session.cashier||'Cashier'}</span>` : `<span class="badge badge-yellow badge-dot">No Active Session</span>`}
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="openPOSReports()">📊 Reports</button>
          <button class="btn btn-secondary btn-sm" onclick="openShiftManager()">⏱ Shift</button>
          ${!_session ? `<button class="btn btn-primary btn-sm" onclick="openSession()">▶ Open Session</button>` :
                        `<button class="btn btn-danger btn-sm" onclick="closeSession()">■ Close Session</button>`}
        </div>
      </div>

      <!-- Main POS Layout -->
      <div style="display:grid;grid-template-columns:1fr 380px;flex:1;overflow:hidden;">

        <!-- LEFT: Product Grid -->
        <div style="display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border-subtle);">

          <!-- Search + Category bar -->
          <div style="padding:12px 16px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;">
            <div style="position:relative;margin-bottom:10px;">
              <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:16px;">🔍</span>
              <input type="text" id="pos-search" placeholder="Search product or scan barcode…"
                style="width:100%;padding:10px 10px 10px 40px;background:var(--bg-overlay);border:1px solid var(--border-default);border-radius:var(--radius-md);color:var(--text-primary);font-size:13px;"
                oninput="posSearch(this.value)" onkeydown="if(event.key==='Enter')posScanBarcode(this.value)">
            </div>
            <!-- Category pills -->
            <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;" id="pos-categories">
              ${buildCategoryPills()}
            </div>
          </div>

          <!-- Product grid -->
          <div id="pos-product-grid" style="flex:1;overflow-y:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;align-content:start;">
            ${buildProductGrid(_products)}
          </div>
        </div>

        <!-- RIGHT: Cart -->
        <div style="display:flex;flex-direction:column;background:var(--bg-elevated);">

          <!-- Customer selector -->
          <div style="padding:12px 16px;border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="font-size:16px;">👤</span>
              <input type="text" id="pos-customer" placeholder="Walk-in customer"
                style="flex:1;padding:8px;background:var(--bg-overlay);border:1px solid var(--border-default);border-radius:var(--radius-md);color:var(--text-primary);font-size:12px;">
              <button onclick="clearCart()" title="Clear cart"
                style="padding:6px 10px;background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.3);border-radius:var(--radius-sm);color:var(--brand-danger);cursor:pointer;font-size:12px;">🗑</button>
            </div>
          </div>

          <!-- Cart items -->
          <div id="pos-cart" style="flex:1;overflow-y:auto;padding:8px 12px;">
            <div id="pos-empty-cart" style="text-align:center;padding:40px 16px;color:var(--text-muted);">
              <div style="font-size:32px;margin-bottom:8px;opacity:0.3;">🛒</div>
              <div style="font-size:13px;">Cart is empty</div>
              <div style="font-size:11px;margin-top:4px;">Click products or scan barcode</div>
            </div>
          </div>

          <!-- Cart totals -->
          <div id="pos-totals" style="padding:12px 16px;border-top:1px solid var(--border-subtle);border-bottom:1px solid var(--border-subtle);background:var(--bg-overlay);">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);">
                <span>Subtotal</span><span id="pos-subtotal">₹0.00</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);">
                <span>Discount</span>
                <div style="display:flex;align-items:center;gap:6px;">
                  <input type="number" id="pos-discount" value="0" min="0" max="100"
                    style="width:50px;padding:2px 6px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:4px;color:var(--text-primary);font-size:11px;text-align:right;"
                    oninput="recalcCart()"> %
                  <span id="pos-discount-amt" style="color:var(--brand-secondary);">-₹0.00</span>
                </div>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);">
                <span>GST (${GST_RATE_DEFAULT}%)</span><span id="pos-gst">₹0.00</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-top:8px;padding-top:8px;border-top:2px solid var(--border-default);">
                <span style="color:var(--text-primary);">TOTAL</span>
                <span id="pos-total" style="color:var(--brand-secondary);font-family:var(--font-display);">₹0.00</span>
              </div>
            </div>
          </div>

          <!-- Payment buttons -->
          <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <button onclick="processPayment('cash')"
                style="padding:12px;background:rgba(0,200,150,0.12);border:2px solid rgba(0,200,150,0.3);border-radius:var(--radius-md);color:var(--brand-secondary);font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
                onmouseenter="this.style.background='rgba(0,200,150,0.2)'" onmouseleave="this.style.background='rgba(0,200,150,0.12)'">
                💵 Cash
              </button>
              <button onclick="processPayment('upi')"
                style="padding:12px;background:rgba(10,132,255,0.12);border:2px solid rgba(10,132,255,0.3);border-radius:var(--radius-md);color:var(--brand-primary);font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
                onmouseenter="this.style.background='rgba(10,132,255,0.2)'" onmouseleave="this.style.background='rgba(10,132,255,0.12)'">
                📱 UPI
              </button>
              <button onclick="processPayment('card')"
                style="padding:12px;background:rgba(255,159,10,0.12);border:2px solid rgba(255,159,10,0.3);border-radius:var(--radius-md);color:var(--brand-warning);font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
                onmouseenter="this.style.background='rgba(255,159,10,0.2)'" onmouseleave="this.style.background='rgba(255,159,10,0.12)'">
                💳 Card
              </button>
            </div>
            <button onclick="processPayment('split')"
              style="padding:12px;background:rgba(255,107,53,0.12);border:2px solid rgba(255,107,53,0.3);border-radius:var(--radius-md);color:var(--brand-accent);font-size:12px;font-weight:700;cursor:pointer;width:100%;">
              ⚡ Split Payment
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modals area -->
    <div id="pos-modal-area"></div>
  `;

  setupModalClose();

  // Register all POS functions
  window.posSearch = debounce((q) => {
    _filteredProducts = q ?
      _products.filter(p => p.name?.toLowerCase().includes(q.toLowerCase()) || (p.sku||'').toLowerCase().includes(q.toLowerCase()) || (p.barcode||'').includes(q)) :
      filterByCategory(_activeCategory);
    renderProductGrid();
  }, 200);

  window.posScanBarcode = (val) => {
    if (!val) return;
    const p = _products.find(x => x.sku===val || x.barcode===val || x.id===val);
    if (p) { addToCart(p.id); document.getElementById('pos-search').value=''; }
    else Toast.error('Not Found', `No product found for: ${val}`);
  };

  window.filterCategory = (cat) => {
    _activeCategory = cat;
    _filteredProducts = filterByCategory(cat);
    document.querySelectorAll('.pos-cat-pill').forEach(el => {
      el.style.background = el.dataset.cat===cat ? 'var(--brand-primary)' : 'var(--bg-overlay)';
      el.style.color = el.dataset.cat===cat ? '#fff' : 'var(--text-secondary)';
    });
    renderProductGrid();
  };

  window.addToCart = (productId) => {
    if (!_session) { Toast.error('No Session','Open a POS session first.'); return; }
    const p = _products.find(x=>x.id===productId); if(!p) return;
    const inv = _inventory.filter(i=>i.productId===productId).reduce((s,i)=>s+(Number(i.quantity)||0),0);
    const existing = _cart.find(c=>c.productId===productId);
    if (existing) {
      if (existing.qty >= inv) { Toast.error('Out of Stock',`Only ${inv} units available.`); return; }
      existing.qty++;
    } else {
      if (inv <= 0) { Toast.error('Out of Stock',`${p.name} is out of stock.`); return; }
      _cart.push({ productId, name:p.name, sku:p.sku||'', price:Number(p.sellingPrice||0), qty:1, unit:p.unit||'pcs', gstRate:Number(p.gstRate||GST_RATE_DEFAULT), hsn:p.hsn||'', available:inv });
    }
    renderCart();
    // Flash product card
    const card = document.getElementById(`pos-prod-${productId}`);
    if (card) { card.style.transform='scale(0.95)'; setTimeout(()=>card.style.transform='',150); }
  };

  window.updateCartQty = (productId, qty) => {
    const item = _cart.find(c=>c.productId===productId); if(!item) return;
    const n = Number(qty);
    if (n <= 0) { _cart = _cart.filter(c=>c.productId!==productId); }
    else { item.qty = Math.min(n, item.available); }
    renderCart();
  };

  window.removeFromCart = (productId) => {
    _cart = _cart.filter(c=>c.productId!==productId);
    renderCart();
  };

  window.clearCart = () => { _cart=[]; renderCart(); };

  window.recalcCart = () => renderCartTotals();

  window.processPayment = async (method) => {
    if (!_cart.length) { Toast.error('Empty Cart','Add items to cart first.'); return; }
    if (!_session)     { Toast.error('No Session','Open a POS session first.'); return; }

    const totals = getCartTotals();

    if (method === 'cash') {
      // Cash payment modal with change calculator
      document.getElementById('pos-modal-area').innerHTML = buildCashModal(totals);
      openModal('cash-modal');
      document.getElementById('cash-tendered')?.focus();
    } else if (method === 'split') {
      document.getElementById('pos-modal-area').innerHTML = buildSplitModal(totals);
      openModal('split-modal');
    } else {
      await completeSale(method, totals.total, totals);
    }
  };

  window.completeCashPayment = async () => {
    const tendered = Number(document.getElementById('cash-tendered')?.value)||0;
    const totals   = getCartTotals();
    if (tendered < totals.total) { Toast.error('Insufficient','Cash tendered is less than total.'); return; }
    await completeSale('cash', totals.total, totals, { tendered, change: tendered - totals.total });
    closeModal('cash-modal');
  };

  window.completeSplitPayment = async () => {
    const cashAmt = Number(document.getElementById('split-cash')?.value)||0;
    const upiAmt  = Number(document.getElementById('split-upi')?.value)||0;
    const cardAmt = Number(document.getElementById('split-card')?.value)||0;
    const totals  = getCartTotals();
    const collected = cashAmt + upiAmt + cardAmt;
    if (Math.abs(collected - totals.total) > 0.01) { Toast.error('Mismatch',`Payment ₹${collected.toFixed(2)} ≠ Total ₹${totals.total.toFixed(2)}`); return; }
    await completeSale('split', totals.total, totals, { cash:cashAmt, upi:upiAmt, card:cardAmt });
    closeModal('split-modal');
  };

  window.openSession = async () => {
    const openingCash = prompt('Enter opening cash balance (₹):');
    if (openingCash===null) return;
    try {
      const session = await dbCreate(POS_COLLECTIONS.SESSIONS, {
        cashier: AuthState.profile?.name||'Cashier',
        openingCash: Number(openingCash)||0,
        openedAt: new Date().toISOString(),
        status: 'open',
        salesCount: 0, totalSales: 0,
        companyId: AuthState.company?.id||null,
      });
      _session = { ...session, cashier: AuthState.profile?.name||'Cashier', openingCash: Number(openingCash)||0 };
      Toast.success('Session Opened!', `POS session started with ₹${Number(openingCash).toLocaleString('en-IN')} opening cash.`);
      window.renderPOS?.(document.getElementById('page-content') || document.body);
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.closeSession = async () => {
    if (!_session) return;
    const closingCash = prompt('Enter closing cash balance (₹):');
    if (closingCash===null) return;
    try {
      const cid = AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
      const sales = await dbGetAll(POS_COLLECTIONS.SALES, [...c, where('sessionId','==',_session.id)]);
      const totalSales = sales.reduce((s,sale)=>s+(Number(sale.total)||0),0);
      await dbUpdate(POS_COLLECTIONS.SESSIONS, _session.id, {
        status:'closed', closedAt: new Date().toISOString(),
        closingCash: Number(closingCash)||0, totalSales,
        salesCount: sales.length,
      });
      document.getElementById('pos-modal-area').innerHTML = buildSessionReport(_session, sales, Number(closingCash)||0);
      openModal('session-report-modal');
      _session = null;
    } catch(e) { Toast.error('Failed', e.message); }
  };

  window.openPOSReports = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    const today=new Date().toISOString().slice(0,10);
    const sales=await dbGetAll(POS_COLLECTIONS.SALES,[...c, where('date','==',today), orderBy('createdAt','desc')]);
    document.getElementById('pos-modal-area').innerHTML = buildDayReport(sales);
    openModal('day-report-modal');
  };

  window.openShiftManager = async () => {
    if (window.LAMPrint && _session) {
      const sessionSales = await dbGetAll(POS_COLLECTIONS.SALES, [where('sessionId','==',_session.id)]).catch(()=>[]);
      window.LAMPrint.sessionReport(_session, sessionSales, { company: AuthState.company||{} });
    } else {
      Toast.info('No Session','Open a POS session first to view shift report.');
    }
  };

  window.updateCashChange = () => {
    const totals = getCartTotals();
    const tendered = Number(document.getElementById('cash-tendered')?.value)||0;
    const change = tendered - totals.total;
    const changeEl = document.getElementById('cash-change');
    if (changeEl) {
      changeEl.textContent = `₹${Math.max(0,change).toLocaleString('en-IN',{minimumFractionDigits:2})}`;
      changeEl.style.color = change < 0 ? 'var(--brand-danger)' : 'var(--brand-secondary)';
    }
  };
}

// ── Cart rendering ────────────────────────────────────────────
function renderCart() {
  const cartEl   = document.getElementById('pos-cart');
  const emptyEl  = document.getElementById('pos-empty-cart');
  if (!cartEl) return;

  if (!_cart.length) {
    if (emptyEl) emptyEl.style.display = '';
    renderCartTotals();
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  cartEl.innerHTML = _cart.map(item => `
    <div style="padding:10px;background:var(--bg-overlay);border-radius:var(--radius-md);margin-bottom:8px;border:1px solid var(--border-subtle);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(item.name)}</div>
          <div style="font-size:10px;color:var(--text-muted);">${escHtml(item.sku)} · ₹${item.price.toLocaleString('en-IN')} / ${item.unit}</div>
        </div>
        <button onclick="removeFromCart('${item.productId}')" style="background:none;border:none;cursor:pointer;color:var(--brand-danger);font-size:14px;padding:2px;margin-left:8px;">✕</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <!-- Qty stepper -->
        <div style="display:flex;align-items:center;gap:0;border:1px solid var(--border-default);border-radius:var(--radius-sm);overflow:hidden;">
          <button onclick="updateCartQty('${item.productId}',${item.qty-1})"
            style="width:28px;height:28px;background:var(--bg-elevated);border:none;cursor:pointer;color:var(--text-primary);font-size:14px;display:flex;align-items:center;justify-content:center;">−</button>
          <input type="number" value="${item.qty}" min="0" max="${item.available}"
            style="width:40px;height:28px;text-align:center;background:var(--bg-surface);border:none;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);"
            onchange="updateCartQty('${item.productId}',this.value)">
          <button onclick="updateCartQty('${item.productId}',${item.qty+1})"
            style="width:28px;height:28px;background:var(--bg-elevated);border:none;cursor:pointer;color:var(--text-primary);font-size:14px;display:flex;align-items:center;justify-content:center;">+</button>
        </div>
        <!-- Line total -->
        <div style="text-align:right;">
          <div style="font-family:var(--font-display);font-size:14px;font-weight:700;color:var(--brand-secondary);">₹${(item.price*item.qty).toLocaleString('en-IN')}</div>
          <div style="font-size:10px;color:var(--text-muted);">incl. GST ${item.gstRate}%</div>
        </div>
      </div>
    </div>`).join('');

  if (!emptyEl || emptyEl.style.display==='none') cartEl.prepend(document.getElementById('pos-empty-cart') || document.createElement('div'));
  renderCartTotals();
}

function getCartTotals() {
  const discount = Number(document.getElementById('pos-discount')?.value)||0;
  const subtotalBeforeDiscount = _cart.reduce((s,i)=>s+(i.price*i.qty),0);
  const discountAmt = subtotalBeforeDiscount * discount/100;
  const subtotal    = subtotalBeforeDiscount - discountAmt;
  const gstAmt      = _cart.reduce((s,i)=>s+(i.price*i.qty*(1-discount/100)*(i.gstRate/100)),0);
  const total       = subtotal + gstAmt;
  return { subtotalBeforeDiscount, discountAmt, subtotal, gstAmt, total, discount };
}

function renderCartTotals() {
  const t = getCartTotals();
  const f = (n) => `₹${n.toLocaleString('en-IN',{minimumFractionDigits:2})}`;
  const s=document.getElementById('pos-subtotal'); if(s) s.textContent=f(t.subtotalBeforeDiscount);
  const d=document.getElementById('pos-discount-amt'); if(d) d.textContent=`-${f(t.discountAmt)}`;
  const g=document.getElementById('pos-gst'); if(g) g.textContent=f(t.gstAmt);
  const tot=document.getElementById('pos-total'); if(tot) tot.textContent=f(t.total);
}

// ── Product Grid ──────────────────────────────────────────────
function buildCategoryPills() {
  const cats = ['all', ...new Set(_products.map(p=>p.category||'Other').filter(Boolean))];
  return cats.map(cat=>`
    <button class="pos-cat-pill" data-cat="${cat}" onclick="filterCategory('${cat}')"
      style="padding:5px 14px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer;border:1px solid var(--border-default);transition:all 0.15s;
             background:${cat==='all'?'var(--brand-primary)':'var(--bg-overlay)'};color:${cat==='all'?'#fff':'var(--text-secondary)'};">
      ${cat.charAt(0).toUpperCase()+cat.slice(1)}
    </button>`).join('');
}

function filterByCategory(cat) {
  return cat==='all' ? [..._products] : _products.filter(p=>(p.category||'Other')===cat);
}

function buildProductGrid(products) {
  return products.map(p => {
    const inv = _inventory.filter(i=>i.productId===p.id).reduce((s,i)=>s+(Number(i.quantity)||0),0);
    const inCart = _cart.find(c=>c.productId===p.id);
    return `
      <div id="pos-prod-${p.id}"
           onclick="addToCart('${p.id}')"
           style="background:var(--bg-elevated);border:2px solid ${inCart?'var(--brand-primary)':'var(--border-subtle)'};border-radius:var(--radius-lg);
                  padding:12px;cursor:pointer;transition:all 0.15s;position:relative;
                  ${inv<=0?'opacity:0.5;':''}"
           onmouseenter="this.style.borderColor='var(--brand-primary)';this.style.transform='translateY(-1px)'"
           onmouseleave="this.style.borderColor='${inCart?'var(--brand-primary)':'var(--border-subtle)'}'
;this.style.transform=''">

        <!-- Stock badge -->
        <div style="position:absolute;top:6px;right:6px;font-size:9px;padding:2px 6px;border-radius:999px;background:${inv<=0?'rgba(255,59,48,0.15)':inv<=5?'rgba(255,159,10,0.15)':'rgba(0,200,150,0.1)'};color:${inv<=0?'var(--brand-danger)':inv<=5?'var(--brand-warning)':'var(--brand-secondary)'};">${inv<=0?'Out':inv}</div>

        <!-- Product emoji/icon -->
        <div style="font-size:28px;margin-bottom:8px;text-align:center;">
          ${getCategoryEmoji(p.category)}
        </div>

        <div style="font-size:12px;font-weight:600;line-height:1.3;margin-bottom:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escHtml(p.name||'—')}</div>

        ${p.sku?`<div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">${escHtml(p.sku)}</div>`:''}

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
          <div style="font-family:var(--font-display);font-size:14px;font-weight:800;color:var(--brand-secondary);">₹${Number(p.sellingPrice||0).toLocaleString('en-IN')}</div>
          ${inCart?`<div style="background:var(--brand-primary);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${inCart.qty}</div>`:''}
        </div>
      </div>`;
  }).join('');
}

function renderProductGrid() {
  const el = document.getElementById('pos-product-grid'); if(!el) return;
  el.innerHTML = _filteredProducts.length ? buildProductGrid(_filteredProducts) :
    `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">No products found</div>`;
}

function getCategoryEmoji(cat) {
  const emojis={food:'🍱',beverage:'🧃',electronics:'📱',clothing:'👕',hardware:'🔧',chemicals:'🧪',medicine:'💊',cosmetics:'💄',stationery:'📝',furniture:'🪑',automotive:'🚗',other:'📦'};
  return emojis[(cat||'').toLowerCase()]||'📦';
}

// ── Sale completion ───────────────────────────────────────────
async function completeSale(method, total, totals, paymentDetails={}) {
  const receiptNo = `RCP-${genId()}`;
  const customer  = document.getElementById('pos-customer')?.value.trim() || 'Walk-in';
  const saleData  = {
    receiptNo, sessionId: _session?.id||null,
    cashier: _session?.cashier || AuthState.profile?.name||'Cashier',
    customer,
    items: _cart.map(i=>({...i})),
    subtotal: totals.subtotalBeforeDiscount,
    discountPct: totals.discount,
    discountAmt: totals.discountAmt,
    gstAmt: totals.gstAmt,
    total, paymentMethod: method,
    paymentDetails,
    date: new Date().toISOString().slice(0,10),
    companyId: AuthState.company?.id||null,
  };

  try {
    await dbCreate(POS_COLLECTIONS.SALES, saleData);

    // Deduct inventory
    for (const item of _cart) {
      const invRecords = _inventory.filter(i=>i.productId===item.productId);
      let remaining = item.qty;
      for (const inv of invRecords) {
        if (remaining <= 0) break;
        const deduct = Math.min(remaining, Number(inv.quantity)||0);
        await dbUpdate(COLLECTIONS.INVENTORY, inv.id, { quantity: Number(inv.quantity)-deduct });
        remaining -= deduct;
      }
    }

    // Show receipt
    document.getElementById('pos-modal-area').innerHTML = buildReceipt(saleData);
    openModal('receipt-modal');

    // Clear cart
    _cart = [];
    renderCart();
    if (document.getElementById('pos-customer')) document.getElementById('pos-customer').value='';

    Toast.success('Sale Complete! 🎉', `Receipt ${receiptNo} · ₹${total.toLocaleString('en-IN')}`);
  } catch(e) {
    Toast.error('Sale Failed', e.message);
  }
}

// ── Modals ────────────────────────────────────────────────────
function buildCashModal(totals) {
  return buildModal({
    id:'cash-modal', title:'💵 Cash Payment',
    body:`
      <div style="text-align:center;margin-bottom:var(--space-4);">
        <div style="font-size:13px;color:var(--text-muted);">Amount to Collect</div>
        <div style="font-family:var(--font-display);font-size:40px;font-weight:800;color:var(--brand-secondary);">₹${totals.total.toLocaleString('en-IN',{minimumFractionDigits:2})}</div>
      </div>
      <div class="form-group"><label class="form-label">Cash Tendered (₹)</label>
        <input type="number" id="cash-tendered" class="form-input" placeholder="${Math.ceil(totals.total)}" style="font-size:20px;text-align:center;font-family:var(--font-display);" oninput="updateCashChange()" autofocus>
      </div>
      <!-- Quick cash buttons -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:var(--space-4);">
        ${[100,200,500,1000,2000,5000,Math.ceil(totals.total),Math.ceil(totals.total/100)*100].map(amt=>`
          <button onclick="document.getElementById('cash-tendered').value=${amt};updateCashChange()"
            style="padding:10px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-md);cursor:pointer;color:var(--text-primary);font-size:12px;font-weight:600;transition:all 0.15s;"
            onmouseenter="this.style.background='var(--bg-overlay)'" onmouseleave="this.style.background='var(--bg-elevated)'">
            ₹${amt.toLocaleString('en-IN')}
          </button>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;padding:16px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:4px solid var(--brand-secondary);">
        <span style="font-size:15px;font-weight:700;">Change to Return</span>
        <span id="cash-change" style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--brand-secondary);">₹0.00</span>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('cash-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="completeCashPayment()" style="font-size:14px;padding:12px 24px;">✅ Complete Sale</button>`,
  });
}

function buildSplitModal(totals) {
  return buildModal({
    id:'split-modal', title:'⚡ Split Payment',
    body:`
      <div style="text-align:center;margin-bottom:var(--space-4);">
        <div style="font-size:13px;color:var(--text-muted);">Total to Split</div>
        <div style="font-family:var(--font-display);font-size:32px;font-weight:800;color:var(--brand-secondary);">₹${totals.total.toLocaleString('en-IN',{minimumFractionDigits:2})}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${[['cash','💵 Cash','var(--brand-secondary)'],['upi','📱 UPI','var(--brand-primary)'],['card','💳 Card','var(--brand-warning)']].map(([id,label,color])=>`
          <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border-left:3px solid ${color};">
            <span style="font-size:14px;font-weight:700;width:90px;">${label}</span>
            <input type="number" id="split-${id}" placeholder="0" min="0"
              style="flex:1;padding:10px;background:var(--bg-overlay);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:14px;font-family:var(--font-display);"
              oninput="updateSplitTotal()">
          </div>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;padding:12px;margin-top:12px;background:var(--bg-elevated);border-radius:var(--radius-md);">
        <span style="font-size:13px;">Collected so far:</span>
        <span id="split-collected" style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--brand-secondary);">₹0.00</span>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('split-modal')">Cancel</button>
            <button class="btn btn-primary" onclick="completeSplitPayment()">✅ Complete Split Payment</button>`,
  });
}

window.updateSplitTotal=()=>{
  const total=['cash','upi','card'].reduce((s,id)=>s+(Number(document.getElementById(`split-${id}`)?.value)||0),0);
  const el=document.getElementById('split-collected');
  if(el) el.textContent=`₹${total.toLocaleString('en-IN',{minimumFractionDigits:2})}`;
};

function buildReceipt(sale) {
  const company = AuthState.company||{};
  return buildModal({
    id:'receipt-modal', title:'🧾 Receipt',
    body:`
      <div id="receipt-print-area" style="max-width:320px;margin:0 auto;font-family:monospace;font-size:12px;">
        <!-- Header -->
        <div style="text-align:center;padding-bottom:12px;border-bottom:1px dashed #ccc;margin-bottom:12px;">
          <div style="font-size:16px;font-weight:800;">${escHtml(company.name||'My Store')}</div>
          <div style="font-size:11px;opacity:0.7;">${escHtml(company.address||'')}</div>
          ${company.gstin?`<div style="font-size:10px;opacity:0.6;">GSTIN: ${escHtml(company.gstin)}</div>`:''}
          <div style="font-size:11px;margin-top:4px;">POS Receipt</div>
        </div>

        <!-- Receipt details -->
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;">
          <span>Receipt #</span><span style="font-weight:700;">${escHtml(sale.receiptNo)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;">
          <span>Date</span><span>${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:11px;">
          <span>Cashier</span><span>${escHtml(sale.cashier)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:11px;padding-bottom:8px;border-bottom:1px dashed #ccc;">
          <span>Customer</span><span>${escHtml(sale.customer)}</span>
        </div>

        <!-- Items -->
        ${sale.items.map(item=>`
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;">
            <div>
              <div>${escHtml(item.name)}</div>
              <div style="font-size:10px;opacity:0.6;">${item.qty} × ₹${Number(item.price).toLocaleString('en-IN')}</div>
            </div>
            <div style="font-weight:700;">₹${(item.qty*item.price).toLocaleString('en-IN')}</div>
          </div>`).join('')}

        <!-- Totals -->
        <div style="border-top:1px dashed #ccc;margin-top:8px;padding-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span>Subtotal</span><span>₹${sale.subtotal.toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>
          ${sale.discountAmt>0?`<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span>Discount (${sale.discountPct}%)</span><span>-₹${sale.discountAmt.toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>`:''}
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span>GST</span><span>₹${sale.gstAmt.toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:800;margin-top:6px;"><span>TOTAL</span><span>₹${sale.total.toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px;color:#666;"><span>Payment</span><span style="text-transform:capitalize;">${sale.paymentMethod}</span></div>
          ${sale.paymentDetails?.change?`<div style="display:flex;justify-content:space-between;font-size:11px;"><span>Change</span><span>₹${Number(sale.paymentDetails.change).toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>`:''}
        </div>

        <!-- Footer -->
        <div style="text-align:center;margin-top:16px;padding-top:12px;border-top:1px dashed #ccc;font-size:10px;opacity:0.6;">
          Thank you for your business!<br>Powered by LAM
        </div>
      </div>
    `,
    footer:`
      <button class="btn btn-secondary" onclick="closeModal('receipt-modal')">Close</button>
      <button class="btn btn-secondary" onclick="printReceipt()">🖨️ Print</button>
      <button class="btn btn-primary" onclick="closeModal('receipt-modal')">New Sale →</button>
    `,
  });
}

window.printReceipt=(saleId)=>{
  const sale = _lastSale || (_session?.sales||[]).slice(-1)[0] || {};
  if(window.LAMPrint) { window.LAMPrint.posReceipt({...sale, company:AuthState.company||{}},{ company:AuthState.company||{} }); return; }
  const _old=()=>{
  const content=document.getElementById('receipt-print-area'); if(!content) return;
  const win=window.open('','_blank');
  win.document.write(`<html><head><style>body{font-family:monospace;padding:10px;max-width:320px;}@media print{button{display:none;}}</style></head><body>${content.innerHTML}<script>window.print();</script></body></html>`);
  win.document.close();
};

function buildSessionReport(session, sales, closingCash) {
  const totalSales   = sales.reduce((s,sale)=>s+(Number(sale.total)||0),0);
  const cashSales    = sales.filter(s=>s.paymentMethod==='cash').reduce((s,sale)=>s+(Number(sale.total)||0),0);
  const upiSales     = sales.filter(s=>s.paymentMethod==='upi').reduce((s,sale)=>s+(Number(sale.total)||0),0);
  const cardSales    = sales.filter(s=>s.paymentMethod==='card').reduce((s,sale)=>s+(Number(sale.total)||0),0);
  const expectedCash = (session.openingCash||0) + cashSales;
  const cashVariance = closingCash - expectedCash;
  return buildModal({
    id:'session-report-modal', title:'📊 Session Report',
    body:`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-4);">
        ${[
          ['Total Sales',    '₹'+totalSales.toLocaleString('en-IN'),       'var(--brand-secondary)'],
          ['Transactions',   sales.length,                                    'var(--brand-primary)'],
          ['Cash Sales',     '₹'+cashSales.toLocaleString('en-IN'),        'var(--brand-secondary)'],
          ['UPI Sales',      '₹'+upiSales.toLocaleString('en-IN'),         'var(--brand-primary)'],
          ['Card Sales',     '₹'+cardSales.toLocaleString('en-IN'),        'var(--brand-warning)'],
          ['Avg Ticket',     '₹'+(sales.length?Math.round(totalSales/sales.length):0).toLocaleString('en-IN'),'var(--text-primary)'],
        ].map(([l,v,c])=>`
          <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);text-align:center;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${l}</div>
            <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:${c};">${v}</div>
          </div>`).join('')}
      </div>
      <div style="padding:14px;background:${Math.abs(cashVariance)<100?'rgba(0,200,150,0.1)':'rgba(255,59,48,0.1)'};border-radius:var(--radius-md);border-left:4px solid ${Math.abs(cashVariance)<100?'var(--brand-secondary)':'var(--brand-danger)'};">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">Cash Reconciliation</div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>Opening Cash:</span><span>₹${(session.openingCash||0).toLocaleString('en-IN')}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>Cash Sales:</span><span>₹${cashSales.toLocaleString('en-IN')}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>Expected Closing:</span><span>₹${expectedCash.toLocaleString('en-IN')}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>Actual Closing:</span><span>₹${closingCash.toLocaleString('en-IN')}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-top:6px;border-top:1px solid var(--border-subtle);padding-top:6px;">
          <span>Variance:</span>
          <span style="color:${Math.abs(cashVariance)<100?'var(--brand-secondary)':'var(--brand-danger)'};">${cashVariance>=0?'+':''}₹${Math.abs(cashVariance).toLocaleString('en-IN')}</span>
        </div>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('session-report-modal')">Close</button>
            <button class="btn btn-primary" onclick="printSessionReport()">🖨️ Print Report</button>`,
  });
}

function buildDayReport(sales) {
  const total = sales.reduce((s,sale)=>s+(Number(sale.total)||0),0);
  return buildModal({
    id:'day-report-modal', title:`📊 Today's Sales Report`,
    body:`
      <div class="grid-3" style="gap:var(--space-3);margin-bottom:var(--space-4);">
        ${[['Total Sales','₹'+total.toLocaleString('en-IN'),'var(--brand-secondary)'],['Transactions',sales.length,'var(--brand-primary)'],['Avg Ticket','₹'+(sales.length?Math.round(total/sales.length):0).toLocaleString('en-IN'),'var(--brand-warning)']].map(([l,v,c])=>`
          <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);text-align:center;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${l}</div>
            <div style="font-family:var(--font-display);font-size:20px;font-weight:800;color:${c};">${v}</div>
          </div>`).join('')}
      </div>
      ${sales.length?`
        <div class="table-container" style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="background:var(--bg-elevated);">${['Receipt','Customer','Items','Method','Total'].map(h=>`<th style="padding:8px;text-align:left;">${h}</th>`).join('')}</tr></thead>
            <tbody>
              ${sales.map(s=>`<tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:8px;font-family:var(--font-mono);font-size:11px;">${escHtml(s.receiptNo||'—')}</td>
                <td style="padding:8px;">${escHtml(s.customer||'Walk-in')}</td>
                <td style="padding:8px;">${s.items?.length||0}</td>
                <td style="padding:8px;text-transform:capitalize;">${escHtml(s.paymentMethod||'—')}</td>
                <td style="padding:8px;font-family:var(--font-mono);font-weight:700;">₹${Number(s.total||0).toLocaleString('en-IN')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`:`<div style="text-align:center;padding:30px;color:var(--text-muted);">No sales today</div>`}
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('day-report-modal')">Close</button>`,
  });
}

window.printSessionReport=async()=>{
  if(window.LAMPrint&&_session){
    const sales=await dbGetAll(POS_COLLECTIONS.SALES,[where('sessionId','==',_session.id)]).catch(()=>[]);
    window.LAMPrint.sessionReport(_session,sales,{company:AuthState.company||{}});
  } else { window.print(); }
};
}
