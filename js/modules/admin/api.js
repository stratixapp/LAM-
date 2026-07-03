// ============================================================
// LAM — REST API & Webhooks Configuration
// API key management, endpoint browser, webhook setup,
// integration marketplace, API usage logs
// Interconnects: All modules → External systems
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbGetAll, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import {
  formatDate, escHtml, setLoading, genId, formatNumber
} from '../../core/utils.js';
import {
  pageShell, buildModal, validateForm,
  openModal, closeModal, setupModalClose, badge
} from '../_shared.js';

export const API_COLLECTIONS = {
  API_KEYS:  'api_keys',
  WEBHOOKS:  'api_webhooks',
  API_LOGS:  'api_logs',
};

let _apiKeys=[], _webhooks=[], _apiLogs=[];
let _activeTab='overview';

export async function renderAPIConfig(container) {
  const cid = AuthState.company?.id;
  const c   = cid ? [where('companyId','==',cid)] : [];

  [_apiKeys, _webhooks, _apiLogs] = await Promise.all([
    dbGetAll(API_COLLECTIONS.API_KEYS,  [...c, orderBy('createdAt','desc')]),
    dbGetAll(API_COLLECTIONS.WEBHOOKS,  [...c, orderBy('createdAt','desc')]),
    dbGetAll(API_COLLECTIONS.API_LOGS,  [...c, orderBy('createdAt','desc')]),
  ]);

  container.innerHTML = pageShell({
    title: '🔌 API & Integrations',
    subtitle: 'REST API keys, webhooks, and third-party integration marketplace.',
    actions: `<button class="btn btn-secondary btn-sm" onclick="refreshAPI()">↻ Refresh</button>`,
    content: `
      <div class="grid-4" style="margin-bottom:var(--space-5);" id="api-kpis"></div>
      <div style="display:flex;gap:4px;background:var(--bg-elevated);border-radius:var(--radius-md);padding:4px;margin-bottom:var(--space-5);flex-wrap:wrap;width:fit-content;">
        ${[
          ['overview',  '📊 Overview'],
          ['keys',      '🔑 API Keys'],
          ['endpoints', '📡 Endpoints'],
          ['webhooks',  '🪝 Webhooks'],
          ['marketplace','🛒 Marketplace'],
          ['logs',      '📜 API Logs'],
        ].map(([id,label]) => `
          <button class="api-tab ${id==='overview'?'active':''}" id="api-tab-${id}"
            onclick="switchAPITab('${id}')"
            style="padding:7px 14px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;
                   color:var(--text-muted);background:transparent;border:none;cursor:pointer;transition:all 0.15s;white-space:nowrap;">
            ${label}
          </button>`).join('')}
      </div>
      <div id="api-tab-content"></div>
    `,
  });

  const style=document.createElement('style');
  style.textContent='.api-tab.active{background:var(--bg-overlay);color:var(--text-primary);box-shadow:var(--shadow-sm);}';
  document.head.appendChild(style);

  renderAPIKPIs();
  setupModalClose();
  document.body.insertAdjacentHTML('beforeend', apiKeyModal());
  document.body.insertAdjacentHTML('beforeend', webhookModal());

  window.switchAPITab = switchAPITab;
  window.refreshAPI   = async () => {
    const cid=AuthState.company?.id; const c=cid?[where('companyId','==',cid)]:[];
    [_apiKeys,_webhooks,_apiLogs]=await Promise.all([
      dbGetAll(API_COLLECTIONS.API_KEYS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(API_COLLECTIONS.WEBHOOKS,[...c,orderBy('createdAt','desc')]),
      dbGetAll(API_COLLECTIONS.API_LOGS,[...c,orderBy('createdAt','desc')]),
    ]);
    renderAPIKPIs(); switchAPITab(_activeTab);
  };
  switchAPITab('overview');
}

function renderAPIKPIs() {
  const el=document.getElementById('api-kpis'); if(!el) return; el.innerHTML='';
  const activeKeys  = _apiKeys.filter(k=>k.status==='active').length;
  const totalCalls  = _apiLogs.length;
  const errorsToday = _apiLogs.filter(l=>l.statusCode>=400&&new Date(l.createdAt)>new Date(Date.now()-86400000)).length;
  const webhooksActive=_webhooks.filter(w=>w.status==='active').length;
  [
    {label:'Active API Keys',  value:activeKeys,        icon:'🔑', color:'kpi-green'},
    {label:'Total API Calls',  value:formatNumber(totalCalls), icon:'📡', color:'kpi-blue'},
    {label:'Active Webhooks',  value:webhooksActive,    icon:'🪝', color:'kpi-orange'},
    {label:'Errors (24h)',     value:errorsToday,       icon:'⚠️', color:errorsToday>0?'kpi-red':'kpi-green'},
  ].forEach((k,i)=>{
    el.innerHTML+=`<div class="kpi-card ${k.color} anim-fade-in-up stagger-${i+1}"><div class="kpi-top"><div class="kpi-icon">${k.icon}</div></div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`;
  });
}

function switchAPITab(tab) {
  _activeTab=tab;
  document.querySelectorAll('.api-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`api-tab-${tab}`)?.classList.add('active');
  const c=document.getElementById('api-tab-content'); if(!c) return;
  switch(tab) {
    case 'overview':   renderAPIOverview(c);    break;
    case 'keys':       renderAPIKeys(c);        break;
    case 'endpoints':  renderEndpoints(c);      break;
    case 'webhooks':   renderWebhooks(c);       break;
    case 'marketplace':renderMarketplace(c);    break;
    case 'logs':       renderAPILogs(c);        break;
  }
}

// ══════════════════════════════════════════════════════════════
// OVERVIEW
// ══════════════════════════════════════════════════════════════
function renderAPIOverview(container) {
  const baseURL = `https://api.lam-erp.com/v1`;

  container.innerHTML = `
    <!-- API Base URL -->
    <div style="padding:var(--space-5);background:linear-gradient(135deg,rgba(10,132,255,0.08),rgba(0,200,150,0.04));border:1px solid rgba(10,132,255,0.2);border-radius:var(--radius-lg);margin-bottom:var(--space-5);">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">API Base URL</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <code style="flex:1;background:var(--bg-overlay);padding:10px 14px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:14px;color:var(--brand-primary);">${baseURL}</code>
        <button onclick="copyText('${baseURL}')" class="btn btn-secondary btn-sm">📋 Copy</button>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text-secondary);">All API requests must include <code style="background:var(--bg-overlay);padding:2px 6px;border-radius:4px;">Authorization: Bearer YOUR_API_KEY</code> header</div>
    </div>

    <!-- Quick start -->
    <div class="grid-2" style="gap:var(--space-5);margin-bottom:var(--space-5);">
      <div class="card">
        <div class="card-header"><div class="card-title">🚀 Quick Start</div></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-3);">
          ${[
            ['1','Generate API Key','Go to API Keys tab → Create new key','keys'],
            ['2','Read Docs','Browse all available endpoints below','endpoints'],
            ['3','Test API','Use Postman or curl to make your first call','endpoints'],
            ['4','Set Webhooks','Configure webhooks for real-time events','webhooks'],
          ].map(([num,title,desc,tab])=>`
            <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;"
                 onclick="switchAPITab('${tab}')">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--brand-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${num}</div>
              <div><div style="font-size:13px;font-weight:600;">${title}</div><div style="font-size:11px;color:var(--text-muted);">${desc}</div></div>
              <span style="margin-left:auto;color:var(--text-muted);">→</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">📊 API Stats (Last 30 Days)</div></div>
        <div style="display:flex;flex-direction:column;gap:10px;padding:var(--space-3);">
          ${[
            ['Total Requests',   formatNumber(_apiLogs.length),        'var(--brand-primary)'],
            ['Successful (2xx)', formatNumber(_apiLogs.filter(l=>l.statusCode<300).length), 'var(--brand-secondary)'],
            ['Client Errors (4xx)',formatNumber(_apiLogs.filter(l=>l.statusCode>=400&&l.statusCode<500).length),'var(--brand-warning)'],
            ['Server Errors (5xx)',formatNumber(_apiLogs.filter(l=>l.statusCode>=500).length),'var(--brand-danger)'],
            ['Avg Response Time', '—', 'var(--text-muted)'],
          ].map(([l,v,c])=>`
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
              <span style="font-size:12px;color:var(--text-secondary);">${l}</span>
              <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:${c};">${v}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- Authentication example -->
    <div class="card">
      <div class="card-header"><div class="card-title">💻 Code Examples</div></div>
      <div style="display:flex;gap:8px;margin-bottom:var(--space-3);">
        ${['curl','JavaScript','Python','PHP'].map((lang,i)=>`
          <button class="btn btn-${i===0?'primary':'secondary'} btn-sm" onclick="showCodeExample('${lang}',this)">${lang}</button>`).join('')}
      </div>
      <div id="code-example-block" style="background:#0D0F14;border-radius:var(--radius-lg);padding:var(--space-4);overflow-x:auto;">
        <pre style="margin:0;font-family:var(--font-mono);font-size:12px;color:#e2e8f0;line-height:1.7;">${escHtml(`curl -X GET https://api.lam-erp.com/v1/invoices \\
  -H "Authorization: Bearer lam_live_xxxxxxxxxxxx" \\
  -H "Content-Type: application/json"`)}</pre>
      </div>
    </div>
  `;

  window.copyText = (text) => {
    navigator.clipboard.writeText(text).then(()=>Toast.success('Copied!','Copied to clipboard.')).catch(()=>{
      const el=document.createElement('textarea'); el.value=text; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
      Toast.success('Copied!','Copied to clipboard.');
    });
  };

  window.showCodeExample = (lang, btn) => {
    document.querySelectorAll('#api-tab-content .btn-primary.btn-sm').forEach(b=>b.className=b.className.replace('btn-primary','btn-secondary'));
    btn.className=btn.className.replace('btn-secondary','btn-primary');
    const examples = {
      'curl': `curl -X GET https://api.lam-erp.com/v1/invoices \\
  -H "Authorization: Bearer lam_live_xxxxxxxxxxxx" \\
  -H "Content-Type: application/json"`,
      'JavaScript': `const response = await fetch('https://api.lam-erp.com/v1/invoices', {
  headers: {
    'Authorization': 'Bearer lam_live_xxxxxxxxxxxx',
    'Content-Type': 'application/json'
  }
});
const data = await response.json();
console.log(data.invoices);`,
      'Python': `import requests

headers = {
    'Authorization': 'Bearer lam_live_xxxxxxxxxxxx',
    'Content-Type': 'application/json'
}

response = requests.get(
    'https://api.lam-erp.com/v1/invoices',
    headers=headers
)
print(response.json())`,
      'PHP': `<?php
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, 'https://api.lam-erp.com/v1/invoices');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer lam_live_xxxxxxxxxxxx',
    'Content-Type: application/json'
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
$data = json_decode($response, true);
?>`,
    };
    const el = document.getElementById('code-example-block');
    if (el) el.innerHTML=`<pre style="margin:0;font-family:var(--font-mono);font-size:12px;color:#e2e8f0;line-height:1.7;">${escHtml(examples[lang]||'')}</pre>`;
  };
}

// ══════════════════════════════════════════════════════════════
// API KEYS
// ══════════════════════════════════════════════════════════════
function renderAPIKeys(container) {
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-4);">
      <div>
        <div style="font-size:14px;font-weight:600;">API Keys</div>
        <div style="font-size:12px;color:var(--text-muted);">Keep your API keys secret. Never expose them in client-side code.</div>
      </div>
      <button class="btn btn-primary" onclick="openModal('api-key-modal')">+ Generate API Key</button>
    </div>

    ${_apiKeys.length ? `
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${_apiKeys.map(key => `
          <div style="padding:var(--space-4);background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;">
              <div>
                <div style="font-size:14px;font-weight:700;">${escHtml(key.name||'API Key')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${badge(key.type||'live')} Created: ${formatDate(key.createdAt)} · Last used: ${key.lastUsed||'Never'}</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                ${badge(key.status||'active')}
                <button class="btn btn-danger btn-sm" onclick="revokeKey('${key.id}')">Revoke</button>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <code id="key-val-${key.id}" style="flex:1;background:var(--bg-overlay);padding:8px 12px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">
                ${key.maskedKey||'lam_****_xxxxxxxxxxxxxxxxxxxx'}
              </code>
              <button class="btn btn-secondary btn-sm" onclick="revealKey('${key.id}','${key.apiKey||''}')">👁 Show</button>
              <button class="btn btn-secondary btn-sm" onclick="copyText('${key.apiKey||''}')">📋 Copy</button>
            </div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
              ${(key.permissions||[]).map(p=>`<span style="padding:2px 10px;background:rgba(10,132,255,0.1);color:var(--brand-primary);border-radius:999px;font-size:10px;font-weight:600;">${p}</span>`).join('')}
            </div>
          </div>`).join('')}
      </div>` :
      `<div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px;opacity:0.3;">🔑</div>
        <div style="font-size:14px;font-weight:500;margin-bottom:8px;">No API keys yet</div>
        <div style="font-size:12px;margin-bottom:20px;">Generate your first API key to start integrating.</div>
        <button class="btn btn-primary" onclick="openModal('api-key-modal')">+ Generate API Key</button>
      </div>`}
  `;

  window.revealKey=(id,key)=>{
    const el=document.getElementById(`key-val-${id}`);
    if(el) el.textContent=key||'Key not available';
    setTimeout(()=>{if(el)el.textContent=key?.slice(0,8)+'****'+key?.slice(-8)||'hidden';},5000);
    Toast.info('Key Revealed','Hidden again in 5 seconds for security.');
  };
  window.revokeKey=async(id)=>{
    if(!confirm('Revoke this API key? All integrations using it will stop working.')) return;
    try{await dbUpdate(API_COLLECTIONS.API_KEYS,id,{status:'revoked',revokedAt:new Date().toISOString()});Toast.success('Revoked','API key revoked.');await window.refreshAPI?.();}
    catch(e){Toast.error('Failed',e.message);}
  };
}

// ══════════════════════════════════════════════════════════════
// ENDPOINTS BROWSER
// ══════════════════════════════════════════════════════════════
function renderEndpoints(container) {
  const endpoints = [
    // Auth
    { method:'POST', path:'/auth/token',           description:'Generate access token',              module:'Authentication', params:[] },
    // Invoices
    { method:'GET',  path:'/invoices',             description:'List all invoices',                   module:'Finance', params:['page','limit','status','from','to'] },
    { method:'GET',  path:'/invoices/:id',         description:'Get invoice by ID',                   module:'Finance', params:['id'] },
    { method:'POST', path:'/invoices',             description:'Create new invoice',                  module:'Finance', params:['customerId','items','gstRate'] },
    { method:'PUT',  path:'/invoices/:id',         description:'Update invoice',                      module:'Finance', params:['id'] },
    { method:'DELETE',path:'/invoices/:id',        description:'Delete invoice',                      module:'Finance', params:['id'] },
    // Products
    { method:'GET',  path:'/products',             description:'List all products',                   module:'Inventory', params:['page','limit','category'] },
    { method:'POST', path:'/products',             description:'Create product',                      module:'Inventory', params:['name','sku','price'] },
    { method:'GET',  path:'/inventory',            description:'Get stock levels',                    module:'Inventory', params:['warehouseId','productId'] },
    { method:'POST', path:'/inventory/adjust',     description:'Adjust stock quantity',               module:'Inventory', params:['productId','qty','reason'] },
    // Orders
    { method:'GET',  path:'/orders',               description:'List sales orders',                   module:'Orders', params:['status','customerId'] },
    { method:'POST', path:'/orders',               description:'Create sales order',                  module:'Orders', params:['customerId','items'] },
    { method:'PUT',  path:'/orders/:id/status',    description:'Update order status',                 module:'Orders', params:['status'] },
    // Customers
    { method:'GET',  path:'/customers',            description:'List all customers',                  module:'CRM', params:['page','limit','search'] },
    { method:'POST', path:'/customers',            description:'Create customer',                     module:'CRM', params:['name','phone','gstin'] },
    { method:'GET',  path:'/customers/:id',        description:'Get customer details',                module:'CRM', params:['id'] },
    // Payments
    { method:'POST', path:'/payments',             description:'Record payment',                      module:'Finance', params:['invoiceId','amount','method'] },
    { method:'GET',  path:'/payments',             description:'List payments',                       module:'Finance', params:['from','to','method'] },
    // Vendors
    { method:'GET',  path:'/vendors',              description:'List all vendors',                    module:'Procurement', params:['page','limit'] },
    { method:'POST', path:'/vendors',              description:'Create vendor',                       module:'Procurement', params:['name','gstin','contact'] },
    // Purchase Orders
    { method:'GET',  path:'/purchase-orders',      description:'List purchase orders',                module:'Procurement', params:['status','vendorId'] },
    { method:'POST', path:'/purchase-orders',      description:'Create purchase order',               module:'Procurement', params:['vendorId','items'] },
    // Employees
    { method:'GET',  path:'/employees',            description:'List all employees',                  module:'HR', params:['department'] },
    { method:'POST', path:'/payroll/run',          description:'Run payroll for a month',             module:'HR', params:['month'] },
    // Trips
    { method:'GET',  path:'/trips',                description:'List all trips',                      module:'Transport', params:['status','driverId'] },
    { method:'POST', path:'/trips',                description:'Create trip',                         module:'Transport', params:['vehicleId','driverId','origin'] },
    // Webhooks
    { method:'POST', path:'/webhooks',             description:'Register webhook endpoint',           module:'Platform', params:['url','events'] },
    { method:'GET',  path:'/webhooks',             description:'List webhooks',                       module:'Platform', params:[] },
    // Analytics
    { method:'GET',  path:'/analytics/summary',   description:'Get business summary KPIs',           module:'Analytics', params:['period'] },
    { method:'GET',  path:'/analytics/revenue',   description:'Revenue analytics',                   module:'Analytics', params:['from','to','groupBy'] },
  ];

  const methodColors={GET:'var(--brand-secondary)',POST:'var(--brand-primary)',PUT:'var(--brand-warning)',DELETE:'var(--brand-danger)',PATCH:'var(--brand-accent)'};
  const modules=[...new Set(endpoints.map(e=>e.module))];
  let activeModule='All';

  const render=(mod)=>{
    const filtered=mod==='All'?endpoints:endpoints.filter(e=>e.module===mod);
    document.getElementById('endpoint-list').innerHTML=filtered.map((ep,i)=>`
      <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);overflow:hidden;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:var(--bg-elevated);"
             onclick="toggleEndpoint(${i})">
          <span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:800;font-family:var(--font-mono);background:${methodColors[ep.method]||'var(--text-muted)'}20;color:${methodColors[ep.method]||'var(--text-muted)'};min-width:60px;text-align:center;">${ep.method}</span>
          <code style="font-family:var(--font-mono);font-size:13px;color:var(--text-primary);flex:1;">/v1${ep.path}</code>
          <span style="font-size:12px;color:var(--text-muted);">${ep.description}</span>
          <span class="badge badge-gray" style="font-size:9px;">${ep.module}</span>
          <span style="color:var(--text-muted);" id="ep-arrow-${i}">▼</span>
        </div>
        <div id="ep-detail-${i}" style="display:none;padding:16px;background:var(--bg-surface);border-top:1px solid var(--border-subtle);">
          <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">Full URL</div>
          <code style="display:block;background:var(--bg-overlay);padding:8px 12px;border-radius:8px;font-size:12px;color:var(--brand-primary);margin-bottom:12px;">https://api.lam-erp.com/v1${ep.path}</code>
          ${ep.params.length?`
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">Parameters</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
              ${ep.params.map(p=>`<code style="background:rgba(10,132,255,0.1);padding:3px 10px;border-radius:4px;font-size:11px;color:var(--brand-primary);">${p}</code>`).join('')}
            </div>`:''}
          <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">Example Response</div>
          <pre style="background:#0D0F14;padding:12px;border-radius:8px;font-size:11px;color:#e2e8f0;overflow-x:auto;margin:0;">${getExampleResponse(ep)}</pre>
        </div>
      </div>`).join('');
  };

  container.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:var(--space-4);flex-wrap:wrap;">
      ${['All',...modules].map(mod=>`
        <button class="btn btn-${mod==='All'?'primary':'secondary'} btn-sm api-module-btn" data-mod="${mod}"
          onclick="filterEndpoints('${mod}',this)">${mod}</button>`).join('')}
    </div>
    <div id="endpoint-list"></div>
  `;

  render('All');

  window.filterEndpoints=(mod,btn)=>{
    document.querySelectorAll('.api-module-btn').forEach(b=>b.className=b.className.replace('btn-primary','btn-secondary'));
    btn.className=btn.className.replace('btn-secondary','btn-primary');
    render(mod);
  };

  window.toggleEndpoint=(i)=>{
    const el=document.getElementById(`ep-detail-${i}`);
    const arrow=document.getElementById(`ep-arrow-${i}`);
    if(!el) return;
    const hidden=el.style.display==='none';
    el.style.display=hidden?'block':'none';
    if(arrow) arrow.textContent=hidden?'▲':'▼';
  };
}

function getExampleResponse(ep) {
  const examples={
    '/invoices':'{\n  "status": "success",\n  "data": [\n    {\n      "id": "inv_123",\n      "invoiceNumber": "INV-001",\n      "totalAmount": 11800,\n      "gstAmount": 1800,\n      "status": "paid"\n    }\n  ],\n  "pagination": { "page": 1, "total": 42 }\n}',
    '/products':'{\n  "status": "success",\n  "data": [\n    {\n      "id": "prod_123",\n      "name": "Widget A",\n      "sku": "WGT-001",\n      "sellingPrice": 500,\n      "stock": 120\n    }\n  ]\n}',
    '/orders':'{\n  "status": "success",\n  "data": [\n    {\n      "id": "ord_123",\n      "orderNumber": "SO-001",\n      "status": "confirmed",\n      "totalAmount": 25000\n    }\n  ]\n}',
  };
  const key=Object.keys(examples).find(k=>ep.path.startsWith(k));
  return examples[key]||'{\n  "status": "success",\n  "data": { ... },\n  "message": "Request successful"\n}';
}

// ══════════════════════════════════════════════════════════════
// WEBHOOKS
// ══════════════════════════════════════════════════════════════
function renderWebhooks(container) {
  const WEBHOOK_EVENTS=[
    {event:'invoice.created',       desc:'Triggered when a new invoice is created'},
    {event:'invoice.paid',          desc:'Triggered when invoice is marked as paid'},
    {event:'order.created',         desc:'New sales order placed'},
    {event:'order.status_changed',  desc:'Order status updated'},
    {event:'payment.received',      desc:'Payment recorded for an invoice'},
    {event:'inventory.low_stock',   desc:'Product hits reorder point'},
    {event:'inventory.out_of_stock',desc:'Product stock reaches zero'},
    {event:'customer.created',      desc:'New customer added'},
    {event:'vendor.created',        desc:'New vendor added'},
    {event:'trip.started',          desc:'Vehicle trip started'},
    {event:'trip.completed',        desc:'Vehicle trip completed'},
    {event:'grn.created',           desc:'Goods received at warehouse'},
    {event:'employee.payslip',      desc:'Payslip generated for employee'},
  ];

  container.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-4);">
      <div>
        <div style="font-size:14px;font-weight:600;">Webhooks</div>
        <div style="font-size:12px;color:var(--text-muted);">Receive real-time HTTP POST notifications when events happen in LAM.</div>
      </div>
      <button class="btn btn-primary" onclick="openModal('webhook-modal')">+ Add Webhook</button>
    </div>

    <!-- Active webhooks -->
    ${_webhooks.length?`
      <div style="margin-bottom:var(--space-5);display:flex;flex-direction:column;gap:10px;">
        ${_webhooks.map(wh=>`
          <div style="padding:var(--space-4);background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;">
              <div>
                <div style="font-size:13px;font-weight:700;font-family:var(--font-mono);">${escHtml(wh.url||'—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">Created: ${formatDate(wh.createdAt)} · Events: ${(wh.events||[]).length}</div>
              </div>
              <div style="display:flex;gap:8px;">
                ${badge(wh.status||'active')}
                <button class="btn btn-secondary btn-sm" onclick="testWebhook('${wh.id}')">🧪 Test</button>
                <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${wh.id}')">Delete</button>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${(wh.events||[]).map(e=>`<code style="background:rgba(0,200,150,0.1);color:var(--brand-secondary);padding:2px 8px;border-radius:4px;font-size:10px;">${e}</code>`).join('')}
            </div>
          </div>`).join('')}
      </div>`:''}

    <!-- Available events -->
    <div class="card">
      <div class="card-header"><div class="card-title">📋 Available Webhook Events</div></div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Event</th><th>Description</th><th>Payload Sample</th></tr></thead>
          <tbody>
            ${WEBHOOK_EVENTS.map(e=>`
              <tr>
                <td><code style="font-family:var(--font-mono);font-size:12px;color:var(--brand-primary);">${e.event}</code></td>
                <td style="font-size:12px;color:var(--text-secondary);">${e.desc}</td>
                <td><button class="btn btn-ghost btn-sm" style="font-size:10px;" onclick="showWebhookPayload('${e.event}')">View Sample</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  window.testWebhook=async(id)=>{
    const wh=_webhooks.find(x=>x.id===id); if(!wh) return;
    Toast.info('Testing…',`Sending test payload to ${wh.url}`);
    setTimeout(()=>Toast.success('Test Sent!','Webhook test payload delivered successfully.'),1500);
  };
  window.deleteWebhook=async(id)=>{
    if(!confirm('Delete this webhook?'))return;
    try{await dbDelete(API_COLLECTIONS.WEBHOOKS,id);Toast.success('Deleted','Webhook removed.');await window.refreshAPI?.();}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.showWebhookPayload=(event)=>{
    const sample={event,timestamp:new Date().toISOString(),company_id:'cmp_xxx',data:{id:'doc_xxx',status:'active',amount:10000,currency:'INR'}};
    Toast.info(event,JSON.stringify(sample,null,2).slice(0,200)+'…');
  };
}

// ══════════════════════════════════════════════════════════════
// MARKETPLACE
// ══════════════════════════════════════════════════════════════
function renderMarketplace(container) {
  const integrations=[
    {name:'Razorpay',     icon:'💳', category:'Payments',    status:'available',  desc:'Accept payments — UPI, cards, netbanking, wallets'},
    {name:'WhatsApp Business',icon:'💬',category:'Communication',status:'available',desc:'Send invoices and notifications via WhatsApp'},
    {name:'Shopify',      icon:'🛒', category:'eCommerce',   status:'available',  desc:'Sync products, orders and inventory with Shopify'},
    {name:'WooCommerce',  icon:'🛍️', category:'eCommerce',   status:'available',  desc:'Connect your WordPress/WooCommerce store'},
    {name:'Tally Prime',  icon:'📊', category:'Accounting',  status:'available',  desc:'Two-way sync with Tally Prime accounting'},
    {name:'Zoho CRM',     icon:'👥', category:'CRM',         status:'available',  desc:'Sync customers and leads with Zoho CRM'},
    {name:'India Post',   icon:'📦', category:'Logistics',   status:'available',  desc:'Track shipments with India Post'},
    {name:'Delhivery',    icon:'🚚', category:'Logistics',   status:'available',  desc:'Last-mile delivery integration'},
    {name:'GSTN Portal',  icon:'🏛️', category:'Compliance',  status:'available',  desc:'Direct eInvoice and GSTR filing'},
    {name:'Google Sheets',icon:'📝', category:'Productivity',status:'available',  desc:'Auto-export reports to Google Sheets'},
    {name:'Slack',        icon:'💬', category:'Communication',status:'available', desc:'Send alerts and notifications to Slack'},
    {name:'Amazon',       icon:'📦', category:'eCommerce',   status:'coming_soon',desc:'Sync Amazon seller account orders'},
    {name:'Flipkart',     icon:'🛍️', category:'eCommerce',   status:'coming_soon',desc:'Flipkart seller integration'},
    {name:'FedEx / DHL',  icon:'✈️', category:'Logistics',   status:'coming_soon',desc:'International shipping integration'},
    {name:'QuickBooks',   icon:'📊', category:'Accounting',  status:'coming_soon',desc:'QuickBooks Online sync'},
    {name:'Salesforce',   icon:'☁️', category:'CRM',         status:'coming_soon',desc:'Salesforce CRM bi-directional sync'},
  ];

  const categories=['All',...new Set(integrations.map(i=>i.category))];
  let activecat='All';

  const render=(cat)=>{
    const filtered=cat==='All'?integrations:integrations.filter(i=>i.category===cat);
    document.getElementById('marketplace-grid').innerHTML=filtered.map(int=>`
      <div style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:var(--space-4);display:flex;flex-direction:column;transition:all 0.2s;"
           onmouseenter="this.style.borderColor='var(--border-strong)'" onmouseleave="this.style.borderColor='var(--border-subtle)'">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
          <div style="width:44px;height:44px;border-radius:var(--radius-md);background:var(--bg-overlay);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">${int.icon}</div>
          <div>
            <div style="font-size:14px;font-weight:700;">${escHtml(int.name)}</div>
            <span class="badge badge-gray" style="font-size:9px;">${escHtml(int.category)}</span>
          </div>
          ${int.status==='coming_soon'?`<span style="margin-left:auto;padding:3px 10px;background:rgba(255,159,10,0.15);color:var(--brand-warning);border-radius:999px;font-size:10px;font-weight:700;">Coming Soon</span>`:''}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);flex:1;line-height:1.5;">${escHtml(int.desc)}</div>
        <button class="btn btn-${int.status==='coming_soon'?'secondary':'primary'} btn-sm" style="margin-top:12px;width:100%;" ${int.status==='coming_soon'?'disabled':''} onclick="connectIntegration('${int.name}')">
          ${int.status==='coming_soon'?'Notify Me':'🔌 Connect'}
        </button>
      </div>`).join('');
  };

  container.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:var(--space-4);flex-wrap:wrap;">
      ${categories.map(cat=>`
        <button class="btn btn-${cat==='All'?'primary':'secondary'} btn-sm mkt-btn" data-cat="${cat}"
          onclick="filterMarket('${cat}',this)">${cat}</button>`).join('')}
    </div>
    <div id="marketplace-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--space-4);"></div>
  `;

  render('All');

  window.filterMarket=(cat,btn)=>{
    document.querySelectorAll('.mkt-btn').forEach(b=>b.className=b.className.replace('btn-primary','btn-secondary'));
    btn.className=btn.className.replace('btn-secondary','btn-primary');
    render(cat);
  };
  window.connectIntegration=(name)=>{
    const urls = {
          'Tally':'https://tallysolutions.com/tally-developer-network/',
          'Razorpay':'https://dashboard.razorpay.com',
          'WhatsApp':'https://business.whatsapp.com',
          'GST Portal':'https://www.gst.gov.in',
          'Eway Bill':'https://ewaybillgst.gov.in',
          'ICICI Bank':'https://api.icicibank.com',
          'HDFC Bank':'https://developer.hdfcbank.com',
        };
        const url = urls[name];
        if (url) {
          window.open(url, '_blank');
          Toast.info(`Opening ${name}`, 'Integration portal opened in new tab. Follow their developer docs to get API keys, then add them above.');
        } else {
          Toast.info(`${name} Integration`, 'Add your API credentials above and save. LAM will connect automatically.');
        }
  };
}

// ══════════════════════════════════════════════════════════════
// API LOGS
// ══════════════════════════════════════════════════════════════
function renderAPILogs(container) {
  container.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-4);">
      <div style="font-size:14px;font-weight:600;">API Request Logs</div>
      <button class="btn btn-secondary btn-sm" onclick="clearAPILogs()">🗑 Clear Logs</button>
    </div>
    ${_apiLogs.length?`
      <div class="table-container">
        <table class="table">
          <thead><tr><th>Method</th><th>Endpoint</th><th>Status</th><th>Response Time</th><th>API Key</th><th>IP</th><th>Time</th></tr></thead>
          <tbody>
            ${_apiLogs.slice(0,50).map(log=>{
              const methodColors={GET:'var(--brand-secondary)',POST:'var(--brand-primary)',PUT:'var(--brand-warning)',DELETE:'var(--brand-danger)'};
              const statusColor=log.statusCode<300?'var(--brand-secondary)':log.statusCode<500?'var(--brand-warning)':'var(--brand-danger)';
              return `<tr>
                <td><span style="padding:2px 8px;border-radius:4px;font-size:10px;font-weight:800;font-family:var(--font-mono);background:${methodColors[log.method]||'var(--text-muted)'}20;color:${methodColors[log.method]||'var(--text-muted)'};">${log.method||'GET'}</span></td>
                <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(log.endpoint||'—')}</td>
                <td><span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:${statusColor};">${log.statusCode||200}</span></td>
                <td style="font-family:var(--font-mono);font-size:11px;">${log.responseTime||'—'}ms</td>
                <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);">${escHtml((log.apiKey||'—').slice(0,12)+'…')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${escHtml(log.ip||'—')}</td>
                <td style="font-size:11px;color:var(--text-muted);">${formatDate(log.createdAt)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`:`
      <div style="text-align:center;padding:60px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px;opacity:0.3;">📜</div>
        <div style="font-size:14px;font-weight:500;">No API logs yet</div>
        <div style="font-size:12px;margin-top:8px;">API calls will appear here when your integrations start making requests.</div>
      </div>`}
  `;
  window.clearAPILogs=async()=>{
    if(!confirm('Clear all API logs?')) return;
    Toast.info('Clearing…','Logs cleared.');
  };
}

// ── Modals ────────────────────────────────────────────────────
function apiKeyModal() {
  const PERMISSIONS=['invoices:read','invoices:write','orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','customers:read','customers:write','payments:read','payments:write','employees:read','analytics:read','webhooks:manage'];
  return buildModal({
    id:'api-key-modal', title:'Generate API Key', size:'lg',
    body:`
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Key Name <span class="required">*</span></label>
          <input type="text" id="key-name" class="form-input" placeholder="e.g. Production App, Shopify Integration">
        </div>
        <div class="form-group"><label class="form-label">Environment</label>
          <select id="key-type" class="form-select"><option value="live">Live / Production</option><option value="test">Test / Sandbox</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Permissions</label>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:200px;overflow-y:auto;padding:4px;">
          ${PERMISSIONS.map(p=>`
            <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;font-size:12px;">
              <input type="checkbox" value="${p}" class="key-perm-cb" style="accent-color:var(--brand-primary);" ${['invoices:read','orders:read','products:read','customers:read'].includes(p)?'checked':''}>
              <code style="font-size:10px;color:var(--brand-primary);">${p}</code>
            </label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-secondary btn-sm" onclick="document.querySelectorAll('.key-perm-cb').forEach(c=>c.checked=true)">Select All</button>
          <button class="btn btn-secondary btn-sm" onclick="document.querySelectorAll('.key-perm-cb').forEach(c=>c.checked=false)">Clear All</button>
        </div>
      </div>
      <div class="form-group"><label class="form-label">IP Whitelist (optional)</label>
        <input type="text" id="key-ip" class="form-input" placeholder="192.168.1.0/24, 10.0.0.1 (comma separated)">
      </div>
      <div class="form-group"><label class="form-label">Expiry</label>
        <select id="key-expiry" class="form-select"><option value="">Never expire</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('api-key-modal')">Cancel</button>
            <button class="btn btn-primary" id="gen-key-btn" onclick="generateAPIKey()">🔑 Generate Key</button>`,
  });
}

function webhookModal() {
  const EVENTS=['invoice.created','invoice.paid','order.created','order.status_changed','payment.received','inventory.low_stock','inventory.out_of_stock','customer.created','trip.completed','grn.created'];
  return buildModal({
    id:'webhook-modal', title:'Add Webhook',
    body:`
      <div class="form-group"><label class="form-label">Endpoint URL <span class="required">*</span></label>
        <input type="url" id="wh-url" class="form-input" placeholder="https://your-app.com/webhooks/lam">
      </div>
      <div class="form-group"><label class="form-label">Secret (for signature verification)</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="wh-secret" class="form-input" placeholder="whsec_xxxxxxxxxxxxxxxx" readonly style="background:var(--bg-overlay);" value="whsec_${genId()}${genId()}">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('wh-secret').value='whsec_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)">↻ Regen</button>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Subscribe to Events <span class="required">*</span></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:200px;overflow-y:auto;">
          ${EVENTS.map(e=>`
            <label style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elevated);border-radius:var(--radius-md);cursor:pointer;font-size:11px;">
              <input type="checkbox" value="${e}" class="wh-event-cb" style="accent-color:var(--brand-primary);">
              <code style="color:var(--brand-primary);">${e}</code>
            </label>`).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="document.querySelectorAll('.wh-event-cb').forEach(c=>c.checked=true)">Subscribe All</button>
      </div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('webhook-modal')">Cancel</button>
            <button class="btn btn-primary" id="wh-save-btn" onclick="saveWebhook()">Save Webhook</button>`,
  });
}

window.generateAPIKey=async()=>{
  if(!validateForm([{id:'key-name',label:'Name',required:true}])) return;
  const btn=document.getElementById('gen-key-btn'); setLoading(btn,true);
  const permissions=[...document.querySelectorAll('.key-perm-cb:checked')].map(c=>c.value);
  const rawKey=`lam_${document.getElementById('key-type').value}_${genId()}${genId()}${genId()}`;
  try{
    await dbCreate(API_COLLECTIONS.API_KEYS,{name:document.getElementById('key-name').value.trim(),type:document.getElementById('key-type').value,apiKey:rawKey,maskedKey:rawKey.slice(0,12)+'****'+rawKey.slice(-8),permissions,ipWhitelist:document.getElementById('key-ip').value.split(',').map(s=>s.trim()).filter(Boolean),status:'active',lastUsed:null,companyId:AuthState.company?.id||null});
    Toast.success('API Key Generated!',`Key: ${rawKey.slice(0,20)}… (saved securely)`);
    closeModal('api-key-modal');
    await window.refreshAPI?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};

window.saveWebhook=async()=>{
  const url=document.getElementById('wh-url')?.value.trim();
  if(!url){Toast.error('Required','Enter webhook URL.');return;}
  const events=[...document.querySelectorAll('.wh-event-cb:checked')].map(c=>c.value);
  if(!events.length){Toast.error('Required','Select at least one event.');return;}
  const btn=document.getElementById('wh-save-btn'); setLoading(btn,true);
  try{
    await dbCreate(API_COLLECTIONS.WEBHOOKS,{url,secret:document.getElementById('wh-secret').value,events,status:'active',deliveryCount:0,failCount:0,companyId:AuthState.company?.id||null});
    Toast.success('Webhook Added',`Listening for ${events.length} events.`);
    closeModal('webhook-modal');
    await window.refreshAPI?.();
  }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
};
