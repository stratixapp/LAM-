// ============================================================
// LAM Assistant v2 — Conversational AI powered by DotBase AI Proxy
// Calls DotBase /v1/projects/:projectId/ai/chat instead of
// hitting Anthropic directly. API key stays server-side.
// Falls back to direct Anthropic call only if _dotbase not set
// (useful during local dev without a DotBase backend).
// ============================================================

const LAMAssistant = (() => {

  // ── State ─────────────────────────────────────────────────
  let _history   = [];       // conversation history
  let _context   = null;     // company data snapshot
  let _container = null;     // mounted UI container
  let _isOpen    = false;
  let _isTyping  = false;

  // ── Quick action suggestions ──────────────────────────────
  const QUICK_ACTIONS = [
    { icon:'📊', label:'Business summary',       prompt:'Give me a quick business summary — revenue, costs, and top concerns this month.' },
    { icon:'⚠️', label:'What needs attention?',  prompt:'What are the most urgent issues I should address today?' },
    { icon:'📦', label:'Inventory status',        prompt:'Which products are critically low on stock and need immediate reordering?' },
    { icon:'🚛', label:'Fleet status',            prompt:'Give me a status update on all active trips and any delay risks.' },
    { icon:'💰', label:'Cash flow check',         prompt:'What is my current cash position? Any overdue invoices I should chase?' },
    { icon:'📈', label:'Top customers',           prompt:'Who are my top 5 customers by revenue and what is each spending?' },
    { icon:'✉️', label:'Draft payment reminder',  prompt:'Draft a polite but firm payment reminder email for overdue invoices.' },
    { icon:'📉', label:'Cost reduction ideas',    prompt:'Based on my expense patterns, suggest 3 specific ways to reduce costs.' },
  ];

  // ── Build data context from IndexedDB ────────────────────
  async function _buildContext() {
    const snap = {};
    const collections = ['invoices','employees','products','inventory','trips','fleet',
                         'drivers','expenses','customers','vendors','payments','attendance'];

    if (window.LAMDB) {
      await Promise.all(collections.map(async col => {
        try { snap[col] = await window.LAMDB.dbGetAll(col).catch(()=>[]); }
        catch { snap[col] = []; }
      }));
    } else {
      // localStorage fallback
      collections.forEach(col => {
        try {
          const raw = localStorage.getItem(`lam_db_${col}`);
          snap[col] = raw ? Object.values(JSON.parse(raw)) : [];
        } catch { snap[col] = []; }
      });
    }

    // Company info
    try {
      const companies = window.LAMDB
        ? await window.LAMDB.dbGetAll('companies')
        : Object.values(JSON.parse(localStorage.getItem('lam_db_companies')||'{}'));
      snap.company = companies[0] || {};
    } catch { snap.company = {}; }

    // Compute summary stats
    const today = new Date();
    const thisMonth = today.toISOString().slice(0,7);

    const paidInvoices = snap.invoices.filter(i=>i.paymentStatus==='paid');
    const overdueInvoices = snap.invoices.filter(i=>
      i.paymentStatus!=='paid' && i.dueDate && new Date(i.dueDate) < today
    );
    const activeTrips = snap.trips.filter(t=>['in-transit','loading','assigned'].includes(t.status));
    const lowStock    = snap.products.filter(p=>{
      const inv = snap.inventory.filter(i=>i.productId===p.id);
      const qty = inv.reduce((s,i)=>s+Number(i.quantity||0),0);
      return qty <= Number(p.reorderPoint||p.reorderQty||0) && qty >= 0;
    });

    const monthRevenue = paidInvoices
      .filter(i=>(i.invoiceDate||i.createdAt||'').startsWith(thisMonth))
      .reduce((s,i)=>s+Number(i.totalAmount||0),0);
    const monthExpenses = snap.expenses
      .filter(e=>(e.date||e.createdAt||'').startsWith(thisMonth))
      .reduce((s,e)=>s+Number(e.amount||0),0);

    _context = {
      company:   snap.company,
      summary: {
        totalEmployees:   snap.employees.length,
        totalCustomers:   snap.customers.length,
        totalVendors:     snap.vendors.length,
        totalProducts:    snap.products.length,
        totalFleet:       snap.fleet.length,
        totalDrivers:     snap.drivers.length,
        activeTrips:      activeTrips.length,
        overdueInvoices:  overdueInvoices.length,
        overdueAmount:    overdueInvoices.reduce((s,i)=>s+Number(i.totalAmount||0),0),
        lowStockProducts: lowStock.length,
        thisMonthRevenue: monthRevenue,
        thisMonthExpenses: monthExpenses,
        thisMonthProfit:  monthRevenue - monthExpenses,
        totalUnpaidInvoices: snap.invoices.filter(i=>i.paymentStatus!=='paid').length,
        totalUnpaidAmount: snap.invoices.filter(i=>i.paymentStatus!=='paid').reduce((s,i)=>s+Number(i.totalAmount||0),0),
      },
      // Samples (not full data to keep context manageable)
      recentInvoices: snap.invoices.slice(-10).map(i=>({
        number:i.invoiceNumber, amount:i.totalAmount, status:i.paymentStatus,
        customer:snap.customers.find(c=>c.id===i.customerId)?.name||i.customerId,
        date:i.invoiceDate, due:i.dueDate,
      })),
      topCustomers: snap.customers.slice(0,8).map(c=>({
        name:c.name, email:c.email, city:c.city, gstin:c.gstin,
        revenue: paidInvoices.filter(i=>i.customerId===c.id).reduce((s,i)=>s+Number(i.totalAmount||0),0),
      })).sort((a,b)=>b.revenue-a.revenue),
      overdueInvoices: overdueInvoices.slice(0,10).map(i=>({
        number:i.invoiceNumber, amount:i.totalAmount, dueDate:i.dueDate,
        daysPastDue: Math.floor((today-new Date(i.dueDate))/86400000),
        customer:snap.customers.find(c=>c.id===i.customerId)?.name||'—',
      })),
      lowStockProducts: lowStock.slice(0,10).map(p=>({
        name:p.name, sku:p.sku,
        qty: snap.inventory.filter(i=>i.productId===p.id).reduce((s,i)=>s+Number(i.quantity||0),0),
        reorderPoint: p.reorderPoint||p.reorderQty||0,
      })),
      activeTrips: activeTrips.slice(0,8).map(t=>({
        tripNumber:t.tripNumber, origin:t.origin, destination:t.destination,
        driver:snap.drivers.find(d=>d.id===t.driverId)?.name||'—',
        vehicle:snap.fleet.find(v=>v.id===t.vehicleId)?.vehicleNumber||'—',
        status:t.status, delayed:t.delayed,
      })),
      recentExpenses: snap.expenses.slice(-8).map(e=>({
        title:e.title, category:e.category, amount:e.amount, date:e.date,
      })),
    };

    return _context;
  }

  // ── System prompt ─────────────────────────────────────────
  function _buildSystemPrompt(ctx) {
    return `You are LAM Assistant, an expert business intelligence AI built into the LAM Logistics & Asset Management platform. You have access to the company's live data and help with business decisions, analysis, and tasks.

Company: ${ctx.company.name || 'Unknown'}
GSTIN: ${ctx.company.gstin || 'Not set'}
Plan: ${ctx.company.plan || 'starter'}

LIVE BUSINESS DATA (as of ${new Date().toLocaleDateString('en-IN')}):
${JSON.stringify(ctx.summary, null, 2)}

KEY ALERTS:
- Overdue invoices: ${ctx.summary.overdueInvoices} invoices totalling ₹${ctx.summary.overdueAmount?.toLocaleString('en-IN')}
- Low stock: ${ctx.summary.lowStockProducts} products need reordering
- Active trips: ${ctx.summary.activeTrips} trips in progress

RECENT DATA SAMPLES:
${JSON.stringify({
  overdueInvoices: ctx.overdueInvoices?.slice(0,5),
  lowStockProducts: ctx.lowStockProducts?.slice(0,5),
  activeTrips: ctx.activeTrips?.slice(0,5),
  topCustomers: ctx.topCustomers?.slice(0,5),
}, null, 2)}

INSTRUCTIONS:
- Respond concisely and actionably. Use Indian number formatting (lakhs/crores).
- When citing amounts, use ₹ and Indian format (e.g. ₹2.5L, ₹10Cr).
- Flag urgent issues clearly with emojis (🔴 critical, 🟡 warning, 🟢 good).
- For emails/letters, produce ready-to-send drafts.
- If asked to generate a report, explain what the report would contain (actual PDF generation happens via UI buttons).
- Keep responses focused. If data is unavailable, say so clearly.
- You are NOT a general chatbot — stay focused on business operations.`;
  }

  // ── API call ──────────────────────────────────────────────
  async function _callClaude(userMessage) {
    _history.push({ role: 'user', content: userMessage });

    const ctx = _context || await _buildContext();

    // ── Resolve endpoint ─────────────────────────────────
    // Prefer DotBase proxy so the Anthropic key stays server-side.
    // Falls back to direct Anthropic only in local dev (no backend).
    const dotbase = (typeof window !== 'undefined' && window.getDotBaseConfig)
      ? window.getDotBaseConfig()
      : null;

    let response;

    if (dotbase && dotbase.url && dotbase.projectId) {
      // ── DotBase AI Proxy path ────────────────────────
      const proxyUrl = `${dotbase.url}/v1/projects/${dotbase.projectId}/ai/chat`;
      response = await fetch(proxyUrl, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key':    dotbase.apiKey,
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system:     _buildSystemPrompt(ctx),
          messages:   _history,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: { message: 'AI proxy error' } }));
        throw new Error(err.error?.message || `DotBase AI proxy error ${response.status}`);
      }

      const data = await response.json();
      // DotBase proxy wraps in { success, data: { content, ... } }
      const payload = data.data || data;
      const reply = payload.content?.[0]?.text || 'No response';
      _history.push({ role: 'assistant', content: reply });
      if (_history.length > 20) _history = _history.slice(-20);
      return reply;

    } else {
      // ── Netlify proxy fallback (production-safe, no CORS) ──
      // Calls /api/ai which routes to netlify/functions/ai-proxy.js
      // No API key exposed in browser. Set ANTHROPIC_API_KEY in Netlify env vars.
      const proxyUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? null   // local dev: proxy not available, disable AI gracefully
        : '/api/ai';

      if (!proxyUrl) {
        console.info('[LAM Assistant] Running locally — AI assistant disabled. Deploy to Netlify to enable.');
        return '⚠️ AI assistant is only available on the deployed version. Run this app from your Netlify URL to use AI features.';
      }

      response = await fetch(proxyUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1000,
          system:     _buildSystemPrompt(ctx),
          messages:   _history,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: { message: 'Proxy error' } }));
        // If proxy returns 500 with config error, show helpful message
        if (err.error?.includes('ANTHROPIC_API_KEY')) {
          return '⚙️ AI not configured yet. Go to Netlify → Site settings → Environment variables and add your ANTHROPIC_API_KEY.';
        }
        throw new Error(err.error || `Proxy error ${response.status}`);
      }

      const data = await response.json();
      const reply = data.content?.[0]?.text || 'No response';
      _history.push({ role: 'assistant', content: reply });
      if (_history.length > 20) _history = _history.slice(-20);
      return reply;
    }
  }

  // ── UI rendering ──────────────────────────────────────────
  function _renderMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:3px;font-size:11px;">$1</code>')
      .replace(/^### (.+)$/gm, '<div style="font-weight:700;margin:10px 0 4px;font-size:13px;">$1</div>')
      .replace(/^## (.+)$/gm,  '<div style="font-weight:700;margin:12px 0 6px;font-size:14px;border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:4px;">$1</div>')
      .replace(/^- (.+)$/gm,   '<div style="padding:2px 0 2px 12px;border-left:2px solid rgba(255,255,255,0.2);margin:3px 0;">$1</div>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function _addMessage(role, text, isLoading = false) {
    const msgs = _container?.querySelector('#lam-ai-messages');
    if (!msgs) return null;

    const msgEl = document.createElement('div');
    msgEl.style.cssText = `display:flex;flex-direction:column;align-items:${role==='user'?'flex-end':'flex-start'};margin-bottom:14px;`;

    const bubble = document.createElement('div');
    bubble.style.cssText = role === 'user'
      ? 'max-width:82%;background:#0A84FF;color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:13px;line-height:1.5;'
      : 'max-width:90%;background:rgba(255,255,255,0.08);color:#F1F5F9;padding:10px 14px;border-radius:16px 16px 16px 4px;font-size:13px;line-height:1.6;';

    if (isLoading) {
      bubble.innerHTML = '<div style="display:flex;gap:4px;align-items:center;"><div class="lam-ai-dot"></div><div class="lam-ai-dot" style="animation-delay:0.15s;"></div><div class="lam-ai-dot" style="animation-delay:0.3s;"></div></div>';
    } else {
      bubble.innerHTML = role === 'user' ? text : _renderMarkdown(text);
    }

    msgEl.appendChild(bubble);
    msgs.appendChild(msgEl);
    msgs.scrollTop = msgs.scrollHeight;
    return bubble;
  }

  // ── Mount UI ──────────────────────────────────────────────
  function mount(opts = {}) {
    if (_container) return;

    // Add CSS
    if (!document.getElementById('lam-ai-styles')) {
      const style = document.createElement('style');
      style.id = 'lam-ai-styles';
      style.textContent = `
        #lam-ai-panel { font-family: Arial, sans-serif; }
        .lam-ai-dot { width:7px;height:7px;background:#94A3B8;border-radius:50%;animation:lam-ai-bounce 0.9s infinite; }
        @keyframes lam-ai-bounce { 0%,80%,100%{transform:scale(0);opacity:0.4} 40%{transform:scale(1);opacity:1} }
        #lam-ai-fab { transition:transform 0.2s; }
        #lam-ai-fab:hover { transform:scale(1.08); }
        #lam-ai-input:focus { outline:none; border-color:#0A84FF !important; }
        .lam-quick-btn:hover { background:rgba(255,255,255,0.15) !important; }
      `;
      document.head.appendChild(style);
    }

    // FAB button
    const fab = document.createElement('button');
    fab.id = 'lam-ai-fab';
    fab.style.cssText = `position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;
      background:linear-gradient(135deg,#0A84FF,#BF5AF2);border:none;cursor:pointer;
      color:#fff;font-size:24px;box-shadow:0 4px 20px rgba(10,132,255,0.4);z-index:9990;`;
    fab.textContent = '🤖';
    fab.title = 'LAM Assistant';
    fab.onclick = toggle;
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'lam-ai-panel';
    panel.style.cssText = `position:fixed;bottom:90px;right:24px;width:380px;height:580px;
      background:#0F172A;border:1px solid rgba(255,255,255,0.12);border-radius:20px;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);z-index:9991;display:none;
      flex-direction:column;overflow:hidden;`;
    panel.innerHTML = `
      <!-- Header -->
      <div style="padding:16px 18px;background:linear-gradient(135deg,rgba(10,132,255,0.2),rgba(191,90,242,0.2));border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;gap:10px;">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#0A84FF,#BF5AF2);display:flex;align-items:center;justify-content:center;font-size:18px;">🤖</div>
        <div style="flex:1;">
          <div style="font-weight:700;color:#F1F5F9;font-size:14px;">LAM Assistant</div>
          <div style="font-size:10px;color:#64748B;" id="lam-ai-status">Ready • Live data connected</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="window.LAMAssistant.clearHistory()" title="Clear chat"
            style="background:rgba(255,255,255,0.1);border:none;color:#94A3B8;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;">🗑</button>
          <button onclick="window.LAMAssistant.close()" title="Close"
            style="background:rgba(255,255,255,0.1);border:none;color:#94A3B8;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;">✕</button>
        </div>
      </div>

      <!-- Messages -->
      <div id="lam-ai-messages" style="flex:1;overflow-y:auto;padding:14px;scroll-behavior:smooth;"></div>

      <!-- Quick actions -->
      <div id="lam-ai-quick" style="padding:0 12px 8px;display:flex;gap:6px;flex-wrap:wrap;"></div>

      <!-- Input -->
      <div style="padding:12px 14px;border-top:1px solid rgba(255,255,255,0.08);">
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <textarea id="lam-ai-input" rows="1"
            placeholder="Ask anything about your business…"
            style="flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);
            border-radius:12px;color:#F1F5F9;font-size:13px;padding:9px 13px;resize:none;
            max-height:100px;font-family:Arial,sans-serif;line-height:1.5;"></textarea>
          <button id="lam-ai-send" onclick="window.LAMAssistant.sendFromInput()"
            style="width:38px;height:38px;border-radius:50%;background:#0A84FF;border:none;
            cursor:pointer;color:#fff;font-size:17px;flex-shrink:0;">↑</button>
        </div>
        <div style="font-size:10px;color:#334155;margin-top:6px;text-align:center;">
          Powered by DotBase AI • Data stays on device
        </div>
      </div>
    `;

    _container = panel;
    document.body.appendChild(panel);

    // Quick action buttons
    const quickEl = panel.querySelector('#lam-ai-quick');
    QUICK_ACTIONS.forEach(({ icon, label, prompt }) => {
      const btn = document.createElement('button');
      btn.className = 'lam-quick-btn';
      btn.style.cssText = 'background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);color:#94A3B8;padding:4px 10px;border-radius:20px;font-size:10px;cursor:pointer;white-space:nowrap;';
      btn.innerHTML = `${icon} ${label}`;
      btn.onclick = () => send(prompt);
      quickEl.appendChild(btn);
    });

    // Enter to send
    panel.querySelector('#lam-ai-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFromInput();
      }
    });

    // Auto-resize textarea
    panel.querySelector('#lam-ai-input').addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

    // Welcome message
    _addMessage('assistant', `👋 **Hi! I'm your LAM Assistant.**\n\nI have access to your live business data — invoices, inventory, trips, employees, and more. Ask me anything or tap a quick action below.`);

    // Load context in background
    _buildContext().then(() => {
      const status = panel.querySelector('#lam-ai-status');
      if (status && _context) {
        const s = _context.summary;
        status.textContent = `${s.totalEmployees} employees • ${s.activeTrips} active trips • Live`;
      }
    });
  }

  async function send(message) {
    if (!message?.trim() || _isTyping) return;
    _isTyping = true;

    _addMessage('user', message);
    const input = _container?.querySelector('#lam-ai-input');
    if (input) { input.value = ''; input.style.height = 'auto'; }

    // Show typing indicator
    const loadingBubble = _addMessage('assistant', '', true);

    try {
      const reply = await _callClaude(message);
      if (loadingBubble) loadingBubble.innerHTML = _renderMarkdown(reply);
    } catch (e) {
      if (loadingBubble) {
        loadingBubble.innerHTML = `<span style="color:#FF453A;">⚠️ ${e.message}</span>`;
      }
    } finally {
      _isTyping = false;
      const msgs = _container?.querySelector('#lam-ai-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
  }

  function sendFromInput() {
    const input = _container?.querySelector('#lam-ai-input');
    if (input?.value.trim()) send(input.value.trim());
  }

  function toggle() {
    if (!_container) mount();
    _isOpen = !_isOpen;
    if (_container) _container.style.display = _isOpen ? 'flex' : 'none';
  }

  function open() {
    if (!_container) mount();
    _isOpen = true;
    if (_container) _container.style.display = 'flex';
  }

  function close() {
    _isOpen = false;
    if (_container) _container.style.display = 'none';
  }

  function clearHistory() {
    _history = [];
    const msgs = _container?.querySelector('#lam-ai-messages');
    if (msgs) {
      msgs.innerHTML = '';
      _addMessage('assistant', '🗑 Conversation cleared. How can I help you?');
    }
  }

  return { mount, send, sendFromInput, toggle, open, close, clearHistory };

})();

window.LAMAssistant = LAMAssistant;
