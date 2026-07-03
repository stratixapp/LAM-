// ============================================================
// LAM — Locked Module Renderer
// Shown for features requiring a higher plan
// ============================================================

export function renderLocked(container, params = {}) {
  // routeId injected by Router when calling renderLocked
  if (!params.route && window.LAM?.Router?.getCurrent) {
    params.route = window.LAM.Router.getCurrent();
  }
  const routeLabels = {
    transport:   { icon: '🚛', name: 'Transport & Fleet Management', plan: 'Enterprise', features: ['Live GPS Tracking', 'Route Optimization', 'Driver Management', 'Fuel Tracking', 'Proof of Delivery'] },
    finance:     { icon: '💰', name: 'Finance & Billing',            plan: 'Enterprise', features: ['Auto Invoice Generation', 'GST/VAT Calculator', 'Aging Reports', 'P&L Summary', 'Multi-Currency'] },
    assets:      { icon: '🔧', name: 'Asset Management',             plan: 'Enterprise', features: ['Asset Registration', 'Depreciation Tracker', 'Maintenance Schedule', 'Asset Audit', 'Disposal Tracking'] },
    analytics:   { icon: '🤖', name: 'AI & Advanced Analytics',      plan: 'Enterprise', features: ['Demand Forecasting (AI)', 'Delivery Delay Predictor', 'Custom Report Builder', 'Cost Analysis Dashboard', 'Driver Performance AI'] },
    grn:         { icon: '📥', name: 'Goods Receipt (GRN)',           plan: 'Growth', features: ['Goods Received Notes', 'PO-based Receiving', 'Batch & Expiry Tracking', 'Multi-Warehouse GRN', 'Discrepancy Reports'] },
    dispatch:    { icon: '📤', name: 'Dispatch / Stock Issue',        plan: 'Growth', features: ['Stock Issue Orders', 'Delivery Note Generation', 'Barcode Scanning', 'Pick & Pack Engine', 'Transfer Tracking'] },
    orders:      { icon: '🛒', name: 'Order Management (OMS)',        plan: 'Growth', features: ['Sales Order Lifecycle', 'Order Picking & Packing', 'Backorder Management', 'Return & Refund Flow', 'Bulk Order Processing'] },
    procurement: { icon: '🔄', name: 'Procurement & Purchase Orders', plan: 'Growth', features: ['PO Creation & Approval', 'Multi-level Workflows', '3-Way Invoice Matching', 'Supplier Scorecards', 'Budget Controls'] },
  };

  const current = params.route || (window.LAM?.Router ? window.LAM.Router.getCurrent() : '') || '';
  const info = routeLabels[current] || { icon: '🔒', name: 'This Feature', plan: 'Higher', features: [] };
  const isGrowth = info.plan === 'Growth';

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:65vh;text-align:center;padding:var(--space-6);gap:var(--space-5);animation:fadeInUp 0.4s ease forwards;">

      <!-- Icon -->
      <div style="width:80px;height:80px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-xl);display:flex;align-items:center;justify-content:center;font-size:36px;">
        ${info.icon}
      </div>

      <!-- Heading -->
      <div>
        <h2 style="font-family:var(--font-display);font-size:26px;font-weight:700;letter-spacing:-0.5px;margin-bottom:8px;">${info.name}</h2>
        <p style="color:var(--text-secondary);font-size:14px;max-width:420px;line-height:1.7;margin:0 auto;">
          Upgrade to <strong style="color:${isGrowth?'var(--brand-warning)':'var(--brand-secondary)'};">${info.plan}</strong> to unlock this module and get access to powerful ${info.name.toLowerCase()} tools.
        </p>
      </div>

      <!-- Feature List -->
      ${info.features.length ? `
        <div style="display:flex;flex-direction:column;gap:8px;max-width:360px;width:100%;text-align:left;">
          ${info.features.map(f => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-md);font-size:13px;color:var(--text-secondary);">
              <span style="color:var(--brand-secondary);flex-shrink:0;">✓</span>
              ${f}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- Plan Cards -->
      <div style="display:grid;grid-template-columns:${isGrowth?'1fr 1fr':'1fr'};gap:12px;max-width:${isGrowth?'460px':'260px'};width:100%;">

        ${isGrowth ? `
          <div style="background:linear-gradient(145deg,rgba(255,159,10,0.1),rgba(255,159,10,0.05));border:1px solid rgba(255,159,10,0.3);border-radius:var(--radius-lg);padding:20px;text-align:left;">
            <div style="font-weight:800;font-family:var(--font-display);color:var(--brand-warning);margin-bottom:6px;">Growth</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">25 users · Phase 1–3 · 30 tools</div>
            <div style="font-size:26px;font-weight:800;font-family:var(--font-display);color:var(--brand-warning);">₹1,499<span style="font-size:12px;font-weight:400;color:var(--text-muted)">/mo</span></div>
          </div>
        ` : ''}

        <div style="background:linear-gradient(145deg,rgba(0,200,150,0.1),rgba(0,200,150,0.05));border:1px solid rgba(0,200,150,0.3);border-radius:var(--radius-lg);padding:20px;text-align:left;">
          <div style="font-weight:800;font-family:var(--font-display);color:var(--brand-secondary);margin-bottom:6px;">Enterprise</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">Unlimited users · All 70 tools · AI</div>
          <div style="font-size:26px;font-weight:800;font-family:var(--font-display);color:var(--brand-secondary);">₹1,999<span style="font-size:12px;font-weight:400;color:var(--text-muted)">/mo</span></div>
        </div>
      </div>

      <!-- CTA -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
        <button class="btn btn-primary btn-lg" onclick="LAM.showUpgradeModal()">
          🚀 Upgrade Now
        </button>
        <button class="btn btn-secondary" onclick="LAM.Router.navigate('dashboard')">
          ← Back to Dashboard
        </button>
      </div>

      <!-- SAP comparison note -->
      <p style="font-size:11px;color:var(--text-muted);max-width:340px;line-height:1.6;">
        💡 SAP charges ₹7,500/user/month for similar functionality. LAM gives you everything for a flat ₹1,999/mo — unlimited users.
      </p>
    </div>
  `;
}
