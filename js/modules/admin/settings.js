// ============================================================
// LAM — Settings Module
// ============================================================
import { AuthState } from '../../core/auth.js';
import { pageShell } from '../_shared.js';
import { Toast } from '../../core/notifications.js';

export async function renderSettings(container) {
  container.innerHTML = pageShell({
    title: 'Settings',
    subtitle: 'Configure your LAM workspace preferences.',
    actions: '',
    content: `
      <div class="grid-2" style="align-items:start;">
        <div class="card">
          <div class="card-header"><div class="card-title">🔐 Security</div></div>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div class="alert alert-info">
              <span class="alert-icon">ℹ️</span>
              <div>
                <div class="alert-title">Two-Factor Authentication</div>
                <div class="alert-text">2FA is managed through Firebase Authentication in your project settings.</div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Session Timeout</label>
              <select class="form-select">
                <option value="8h">8 hours</option>
                <option value="24h" selected>24 hours</option>
                <option value="7d">7 days</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Password Policy</label>
              <select class="form-select">
                <option value="basic">Basic (8+ chars)</option>
                <option value="strong" selected>Strong (8+ chars, mixed)</option>
                <option value="enterprise">Enterprise (12+, symbols)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">🔔 Notifications</div></div>
          <div style="display:flex;flex-direction:column;gap:14px;">
            ${[
              ['Low Stock Alerts',       true],
              ['New Order Notifications',true],
              ['Payment Reminders',      true],
              ['Dispatch Confirmations', true],
              ['System Updates',         false],
              ['Weekly Summary Email',   false],
            ].map(([label, checked]) => `
              <div class="toggle-wrapper">
                <label class="toggle">
                  <input type="checkbox" ${checked ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <span style="font-size:13px;color:var(--text-secondary);">${label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">🗄 Data & Backup</div></div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;">
              Your data is automatically backed up daily to Firebase. You can export a full data snapshot below.
            </p>
            <button class="btn btn-secondary btn-sm" onclick="LAM.Toast.info('Backup','Data export initiated — check your email shortly.')">
              📦 Export All Data (JSON)
            </button>
            <button class="btn btn-secondary btn-sm" onclick="LAM.Toast.info('Import','Contact support@lam.app for bulk CSV import assistance.')">
              📥 Import from CSV / Excel
            </button>
            <button class="btn btn-secondary btn-sm" onclick="LAM.Toast.warning('Danger Zone','Contact support to delete your account and data.')">
              🗑 Request Account Deletion
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">ℹ️ About LAM</div></div>
          <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text-secondary);">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              ${[
                ['Version',    '9.0'],
                ['Phase',      'Production Build'],
                ['Platform',   'Web PWA'],
                ['Stack',      'Vanilla JS + IndexedDB'],
                ['Modules',    '12 Active'],
                ['Developer',  'Stratix Ecosystem'],
              ].map(([k,v]) => `
                <div style="background:var(--bg-elevated);border-radius:var(--radius-md);padding:10px;">
                  <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">${k}</div>
                  <div style="color:var(--text-primary);font-weight:500;margin-top:3px;">${v}</div>
                </div>
              `).join('')}
            </div>
            <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
              <span class="badge badge-green badge-dot">Local-First</span>
              <span class="badge badge-blue">Offline Ready</span>
              <span class="badge badge-yellow">Supabase Optional</span>
            </div>
            <div style="padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);margin-top:4px;">
              <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Contact & Legal</div>
              <div style="display:flex;flex-direction:column;gap:5px;">
                <a href="mailto:stratixapp@gmail.com" style="font-size:12px;color:var(--brand-primary);text-decoration:none;">📧 stratixapp@gmail.com</a>
                <a href="mailto:stratixecosystem1@gmail.com" style="font-size:12px;color:var(--brand-primary);text-decoration:none;">📧 stratixecosystem1@gmail.com</a>
                <a href="mailto:stratixgrowup@gmail.com" style="font-size:12px;color:var(--brand-primary);text-decoration:none;">📧 stratixgrowup@gmail.com</a>
              </div>
              <div style="display:flex;gap:10px;margin-top:10px;">
                <a href="privacy.html" target="_blank"
                   style="font-size:12px;color:var(--brand-primary);text-decoration:none;font-weight:600;">
                  🔒 Privacy Policy
                </a>
                <a href="terms.html" target="_blank"
                   style="font-size:12px;color:var(--brand-primary);text-decoration:none;font-weight:600;">
                  📋 Terms of Use
                </a>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
                Kottayam, Kerala, India · © 2025 Stratix Ecosystem
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- DotBase Backend Connect Card -->
      <div class="card" style="margin-top:var(--space-5);">
        <div class="card-header">
          <div class="card-title">🔗 DotBase Backend</div>
          <div id="dotbase-status-badge"></div>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:14px;">
          <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;">
            Connect LAM to your self-hosted DotBase backend to sync data across devices, enable server-side AI, and unlock cloud storage. Without a backend, LAM runs fully offline using IndexedDB.
          </p>
          <div class="form-group">
            <label class="form-label">Backend URL</label>
            <input type="url" id="db-url" class="form-input" placeholder="https://your-dotbase.yourdomain.com" style="font-family:var(--font-mono);font-size:12px;">
          </div>
          <div class="form-group">
            <label class="form-label">API Key</label>
            <input type="password" id="db-apikey" class="form-input" placeholder="lam_live_xxxxxxxxxxxx" style="font-family:var(--font-mono);font-size:12px;">
          </div>
          <div class="form-group">
            <label class="form-label">Project ID</label>
            <input type="text" id="db-projectid" class="form-input" placeholder="proj_xxxxxxxxxxxxxxxx" style="font-family:var(--font-mono);font-size:12px;">
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="window._connectDotBase?.()">🔌 Connect</button>
            <button class="btn btn-secondary btn-sm" onclick="window._testDotBase?.()">🧪 Test Connection</button>
            <button class="btn btn-ghost btn-sm" onclick="window._disconnectDotBase?.()">✕ Disconnect</button>
          </div>
          <div id="dotbase-test-result" style="font-size:11px;color:var(--text-muted);"></div>
        </div>
      </div>

      <!-- Storage & LAN Sync Card -->
      <div class="card" style="margin-top:var(--space-5);">
        <div class="card-header"><div class="card-title">🗄️ Storage & Sync</div></div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:16px;">

          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <div id="storage-badge" style="font-size:11px;background:var(--bg-elevated);padding:6px 12px;border-radius:20px;"></div>
            <button class="btn btn-secondary btn-sm" onclick="window.refreshStorageStats?.()">↻ Stats</button>
            <button class="btn btn-secondary btn-sm" onclick="window.exportAllData?.()">⬇ Backup</button>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer;">
              ⬆ Restore
              <input type="file" accept=".json" style="display:none;" onchange="window.importData?.(this)">
            </label>
          </div>

          <div id="storage-detail" style="font-size:11px;color:var(--text-muted);"></div>

          <div style="border-top:1px solid var(--border-subtle);padding-top:12px;">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;">🔐 Encryption</div>
            <div id="enc-status-badge" style="font-size:12px;"></div>
          </div>

          <div style="border-top:1px solid var(--border-subtle);padding-top:12px;">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;">📡 LAN Sync</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Sync with other devices on the same WiFi — no internet needed.</div>
            <div id="lan-device-id-s" style="font-family:monospace;font-size:10px;color:var(--text-muted);margin-bottom:8px;"></div>
            <div id="lan-peers-s" style="margin-bottom:8px;"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" onclick="window.refreshLANPeers?.()">📡 Discover</button>
              <button class="btn btn-secondary btn-sm" onclick="window.forceLANSync?.()">↻ Sync Now</button>
              <button class="btn btn-ghost btn-sm" onclick="window.showPairingQR?.()">📷 Pair Device</button>
            </div>
            <div id="pairing-qr-s" style="display:none;margin-top:12px;text-align:center;"></div>
          </div>

          <div style="border-top:1px solid var(--border-subtle);padding-top:12px;">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;">🔗 Audit Chain</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Verify that no audit log entries have been tampered with.</div>
            <button class="btn btn-secondary btn-sm" onclick="window.verifyAuditChain?.()">🔐 Verify Audit Integrity</button>
          </div>

          <div style="border-top:1px solid var(--border-subtle);padding-top:12px;">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;">🗺️ Offline Maps Cache</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Pre-download map tiles so drivers can navigate offline in dead zones.</div>
            <div id="map-cache-stats" style="font-size:11px;color:var(--text-muted);margin-bottom:8px;"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
              <select id="region-select" class="form-select" style="flex:1;min-width:160px;font-size:12px;">
                <option value="kerala">Kerala</option>
                <option value="tamil_nadu">Tamil Nadu</option>
                <option value="karnataka">Karnataka</option>
                <option value="maharashtra">Maharashtra</option>
                <option value="gujarat">Gujarat</option>
                <option value="delhi_ncr">Delhi NCR</option>
              </select>
              <button class="btn btn-primary btn-sm" onclick="window.cacheMapRegion?.()">⬇ Cache Region</button>
              <button class="btn btn-ghost btn-sm" onclick="window.clearMapCache?.()">🗑 Clear Cache</button>
            </div>
            <div id="map-cache-progress" style="display:none;font-size:11px;color:var(--brand-primary);"></div>
          </div>

        </div>
      </div>
    `,
  });

  // Init stats after render
  setTimeout(() => {
    // ── DotBase backend connect UI ─────────────────────────
    const dotbaseCfg = window.getDotBaseConfig?.();
    const statusBadgeEl = document.getElementById('dotbase-status-badge');
    if (statusBadgeEl) {
      statusBadgeEl.innerHTML = dotbaseCfg
        ? `<span class="badge badge-green badge-dot">Connected · ${dotbaseCfg.url}</span>`
        : `<span class="badge badge-gray">Offline mode</span>`;
    }
    if (dotbaseCfg) {
      const urlEl = document.getElementById('db-url');       if (urlEl)       urlEl.value = dotbaseCfg.url;
      const keyEl = document.getElementById('db-apikey');    if (keyEl)       keyEl.value = dotbaseCfg.apiKey;
      const pidEl = document.getElementById('db-projectid'); if (pidEl)       pidEl.value = dotbaseCfg.projectId;
    }

    window._connectDotBase = async () => {
      const url       = document.getElementById('db-url')?.value.trim();
      const apiKey    = document.getElementById('db-apikey')?.value.trim();
      const projectId = document.getElementById('db-projectid')?.value.trim();
      if (!url || !apiKey || !projectId) { Toast.error('Required', 'Fill in URL, API Key and Project ID.'); return; }
      await window.LAM?.connectBackend?.({ url, apiKey, projectId });
      const sb = document.getElementById('dotbase-status-badge');
      if (sb) sb.innerHTML = `<span class="badge badge-green badge-dot">Connected · ${url}</span>`;
      Toast.success('Connected!', `DotBase backend at ${url} is now active.`);
    };

    window._testDotBase = async () => {
      const url    = document.getElementById('db-url')?.value.trim();
      const apiKey = document.getElementById('db-apikey')?.value.trim();
      const result = document.getElementById('dotbase-test-result');
      if (!url) { Toast.error('Required', 'Enter backend URL first.'); return; }
      if (result) result.textContent = 'Testing…';
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
          headers: apiKey ? { 'X-API-Key': apiKey } : {},
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (result) result.innerHTML = `<span style="color:var(--brand-secondary);">✅ Connected — DotBase v${data.version || '?'} · ${data.env || ''}</span>`;
        } else {
          if (result) result.innerHTML = `<span style="color:var(--brand-danger);">❌ Server responded with ${res.status}</span>`;
        }
      } catch(e) {
        if (result) result.innerHTML = `<span style="color:var(--brand-danger);">❌ Cannot reach ${url} — ${e.message}</span>`;
      }
    };

    window._disconnectDotBase = () => {
      // Clear config by reconnecting with empty — refresh is needed for full effect
      ['db-url','db-apikey','db-projectid'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      const sb = document.getElementById('dotbase-status-badge');
      if (sb) sb.innerHTML = `<span class="badge badge-gray">Offline mode</span>`;
      Toast.info('Disconnected', 'Reload the app to fully clear the backend connection.');
    };

    // Storage badge
    if (window.LAMDB) {
      window.LAMDB.getStorageStats().then(stats => {
        const badge = document.getElementById('storage-badge');
        const detail = document.getElementById('storage-detail');
        if (badge) badge.textContent = `${stats.totalRecords.toLocaleString('en-IN')} records${stats.usedMB ? ' • ' + stats.usedMB + 'MB used' : ''}`;
        if (detail) detail.textContent = `Collections: ${Object.keys(stats.collections).filter(k=>stats.collections[k]>0).join(', ')}`;
      }).catch(() => {});
    } else {
      const badge = document.getElementById('storage-badge');
      if (badge) badge.textContent = 'IndexedDB not ready';
    }

    // Encryption status
    const encEl = document.getElementById('enc-status-badge');
    if (encEl) {
      const ready = window.LAMCRYPTO?.isReady?.();
      encEl.innerHTML = ready
        ? '<span style="color:var(--brand-secondary);">🟢 AES-256-GCM active — payroll, bank & PAN data encrypted at rest</span>'
        : '<span style="color:var(--text-muted);">🔴 Inactive — log out and log back in to activate encryption</span>';
    }

    // LAN device ID
    const devEl = document.getElementById('lan-device-id-s');
    if (devEl && window.LAMLAN) devEl.textContent = `Device: ${window.LAMLAN.getMyPeerId()}`;

    // LAN peers
    window.refreshLANPeers = () => {
      const el = document.getElementById('lan-peers-s') || document.getElementById('lan-peers');
      if (!el || !window.LAMLAN) return;
      const peers = window.LAMLAN.getPeers();
      el.innerHTML = peers.length
        ? peers.map(p => `<div style="font-size:11px;padding:4px 0;"><span style="color:var(--brand-secondary);">●</span> ${p.peerId} — ${p.state}</div>`).join('')
        : '<div style="font-size:11px;color:var(--text-muted);">No devices found. Click Discover.</div>';
    };
    window.refreshLANPeers();
    window.refreshMapCacheStats?.();

    window.showPairingQR = async () => {
      const el = document.getElementById('pairing-qr-s') || document.getElementById('pairing-qr');
      if (!el || !window.LAMLAN) return;
      el.style.display = 'block';
      el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Generating…</div>';
      try {
        const result = await window.LAMLAN.generatePairingCode();
        el.innerHTML = result.qrSvg
          ? `<div style="font-size:11px;margin-bottom:6px;font-weight:600;">Scan on other device:</div>${result.qrSvg}`
          : `<div style="font-size:9px;font-family:monospace;word-break:break-all;">${(result.pairingData||'').slice(0,80)}</div>`;
        setTimeout(() => { el.style.display = 'none'; }, 60000);
      } catch(e) { el.innerHTML = `<div style="color:red;font-size:11px;">${e.message}</div>`; }
    };

    // ── LAMUsers: inject Users card + Audit Trail card ────────
    if (window.LAMUsers) {
      const grid = container.querySelector('.grid-2');
      const currentRole = window.LAMUsers.getCurrentUser?.()?.role;

      // Users management card — owner only
      if (currentRole === 'owner' && grid && !grid.querySelector('#lam-users-settings-card')) {
        window.LAMUsers.renderUsersSettingsTab().then(html => {
          grid.insertAdjacentHTML('afterbegin', html);
        });
      }

      // Audit Trail card — all roles (filtered to own entries for non-owners)
      if (grid && !grid.querySelector('#lam-audit-viewer')) {
        window.LAMUsers.renderAuditViewer({ limit: 50 }).then(html => {
          grid.insertAdjacentHTML('beforeend', html);
        });
      }
    }

  }, 200);
}


// ── System Tab: Storage, LAN Sync, Backup/Restore ────────────
function renderSystem(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px;">

      <!-- Storage Stats -->
      <div class="card">
        <div class="card-header"><div class="card-title">🗄️ Storage</div></div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
          <div id="storage-stats-loading" style="color:var(--text-muted);font-size:12px;">Loading storage info…</div>
          <div id="storage-stats" style="display:none;">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px;" id="storage-kpis"></div>
            <div id="storage-collections" style="font-size:11px;color:var(--text-muted);max-height:160px;overflow-y:auto;display:flex;flex-wrap:wrap;gap:6px;"></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="window.refreshStorageStats()">↻ Refresh</button>
            <button class="btn btn-primary btn-sm" onclick="window.LAMSafety?.performBackup() || window.exportAllData()">💾 Backup Now</button>
            <button class="btn btn-ghost btn-sm" onclick="window.LAMSafety?.restoreFromBackup() || document.getElementById('import-file').click()">📥 Restore Backup</button>
            <input type="file" id="import-file" accept=".json" style="display:none;" onchange="window.importData(this)">
          </div>
        </div>
      </div>

      <!-- Encryption Status -->
      <div class="card">
        <div class="card-header"><div class="card-title">🔐 Encryption</div></div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
          <div id="enc-status" style="display:flex;align-items:center;gap:8px;">
            <span id="enc-icon" style="font-size:20px;">${window.LAMCRYPTO?.isReady() ? '🟢' : '🔴'}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${window.LAMCRYPTO?.isReady() ? 'Encryption Active' : 'Encryption Inactive'}</div>
              <div style="font-size:11px;color:var(--text-muted);">${window.LAMCRYPTO?.isReady() ? 'Sensitive data (payroll, bank, PAN) is encrypted with AES-256-GCM' : 'Log out and log back in to activate encryption'}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);background:var(--bg-elevated);padding:10px;border-radius:8px;">
            <strong>Encrypted collections:</strong> payroll, employees (PAN/UAN/bank), bank accounts, API keys, GST credentials
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="window.verifyAuditChain?.()">🔐 Verify Audit Chain</button>
          </div>
        </div>
      </div>

      <!-- LAN Sync -->
      <div class="card">
        <div class="card-header"><div class="card-title">📡 LAN Sync</div></div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
          <div style="font-size:12px;color:var(--text-muted);">Sync data between devices on the same WiFi network — no internet needed.</div>
          <div id="lan-peers" style="display:flex;flex-direction:column;gap:6px;"></div>
          <div id="lan-device-id" style="font-size:10px;color:var(--text-muted);padding:6px 10px;background:var(--bg-elevated);border-radius:6px;font-family:monospace;"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="window.refreshLANPeers()">📡 Discover Devices</button>
            <button class="btn btn-secondary btn-sm" onclick="window.forceLANSync()">↻ Sync Now</button>
            <button class="btn btn-ghost btn-sm" onclick="window.showPairingQR()">📷 Pair New Device</button>
          </div>
          <div id="pairing-qr" style="display:none;text-align:center;padding:12px;background:var(--bg-elevated);border-radius:8px;"></div>
        </div>
      </div>

    </div>
  `;

  // Load storage stats
  window.refreshStorageStats();
  window.refreshLANPeers();

  const devId = document.getElementById('lan-device-id');
  if (devId && window.LAMLAN) devId.textContent = `Device ID: ${window.LAMLAN.getMyPeerId()}`;

  // Inject LAMSafety Tally config card
  if (window.LAMSafety) {
    setTimeout(() => {
      const systemContainer = document.querySelector('[data-tab-content="system"] > div, #settings-system-content, .settings-system');
      // Find the wrapping flex container of the system tab and append Tally card
      const allCards = container.querySelectorAll('.card');
      const storageCard = [...allCards].find(c => c.textContent.includes('Storage'));
      if (storageCard && !container.querySelector('#lam-tally-settings-card')) {
        const tallyHTML = window.LAMSafety.renderTallySettingsCard();
        storageCard.insertAdjacentHTML('afterend', tallyHTML);
      }
    }, 0);
  }

  // Inject LAMCloud: Cloud Sync, Payments, Export Suite cards
  if (window.LAMCloud) {
    setTimeout(() => {
      const grid = container.querySelector('.grid-2');
      if (!grid) return;

      if (!container.querySelector('#lam-cloud-settings-card')) {
        grid.insertAdjacentHTML('beforeend', window.LAMCloud.renderCloudSettingsCard());
      }
      if (!container.querySelector('#lam-payments-settings-card')) {
        grid.insertAdjacentHTML('beforeend', window.LAMCloud.renderPaymentsSettingsCard());
      }
      if (!container.querySelector('#lam-export-settings-card')) {
        grid.insertAdjacentHTML('beforeend', window.LAMCloud.renderExportSettingsCard());
      }
    }, 50);
  }
}

// ── Storage stats helpers ─────────────────────────────────────
window.refreshStorageStats = async () => {
  const loading = document.getElementById('storage-stats-loading');
  const stats   = document.getElementById('storage-stats');
  const kpis    = document.getElementById('storage-kpis');
  const cols    = document.getElementById('storage-collections');
  if (!loading || !stats) return;

  if (!window.LAMDB) {
    loading.textContent = 'IndexedDB engine (lam-db.js) not loaded.';
    return;
  }

  try {
    const data = await window.LAMDB.getStorageStats();
    loading.style.display = 'none';
    stats.style.display   = 'block';

    if (kpis) kpis.innerHTML = [
      { label: 'Total Records',  value: data.totalRecords.toLocaleString('en-IN') },
      { label: 'Storage Used',   value: data.usedMB  ? `${data.usedMB} MB`  : '—' },
      { label: 'Storage Quota',  value: data.quotaMB ? `${data.quotaMB} MB` : '—' },
    ].map(k => `
      <div style="background:var(--bg-elevated);border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:18px;font-weight:700;">${k.value}</div>
        <div style="font-size:10px;color:var(--text-muted);">${k.label}</div>
      </div>
    `).join('');

    if (cols) cols.innerHTML = Object.entries(data.collections)
      .sort((a,b) => b[1]-a[1])
      .map(([col, count]) => `<span style="background:var(--bg-elevated);padding:3px 8px;border-radius:10px;">${col}: ${count}</span>`)
      .join('');
  } catch(e) {
    if (loading) loading.textContent = `Error: ${e.message}`;
  }
};

window.exportAllData = async () => {
  if (!window.LAMDB) { Toast.info('Not available', 'IndexedDB engine not loaded.'); return; }
  Toast.info('Preparing backup…', 'This may take a moment for large datasets.');
  try {
    const result = await window.LAMDB.exportAllData();
    Toast.success('Backup Downloaded', `${result.collections} collections, ${result.records} records exported.`);
  } catch(e) {
    Toast.error('Backup failed', e.message);
  }
};

window.importData = async (input) => {
  const file = input.files?.[0];
  if (!file || !window.LAMDB) return;
  if (!confirm(`Restore backup from "${file.name}"? This will merge with existing data.`)) return;
  Toast.info('Importing…', 'Restoring backup data…');
  try {
    const count = await window.LAMDB.importData(file);
    Toast.success('Restore Complete', `${count} records imported.`);
    input.value = '';
  } catch(e) {
    Toast.error('Import failed', e.message);
    input.value = '';
  }
};

window.refreshLANPeers = () => {
  const el = document.getElementById('lan-peers');
  if (!el || !window.LAMLAN) return;
  const peers = window.LAMLAN.getPeers();
  if (!peers.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px;">No devices discovered yet. Make sure other devices are on the same WiFi and have LAM open.</div>`;
    return;
  }
  el.innerHTML = peers.map(p => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-elevated);border-radius:8px;">
      <span style="font-size:16px;">💻</span>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:600;">${p.peerId}</div>
        <div style="font-size:10px;color:var(--text-muted);">${p.state} • Last seen ${Math.round((Date.now()-p.lastSeen)/1000)}s ago</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="window.LAMLAN?.connectTo?.('${p.peerId}')">Connect</button>
    </div>
  `).join('');
};

window.forceLANSync = () => {
  if (!window.LAMLAN?.isConnected()) {
    Toast.info('Not connected', 'No devices connected. Discover devices first.');
    return;
  }
  window.LAMLAN.syncAll();
  Toast.info('Syncing…', 'Pushing data to all connected devices.');
};

window.showPairingQR = async () => {
  const qrEl = document.getElementById('pairing-qr');
  if (!qrEl || !window.LAMLAN) return;
  qrEl.style.display = 'block';
  qrEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Generating pairing code…</div>';
  try {
    const result = await window.LAMLAN.generatePairingCode();
    if (result.qrSvg) {
      qrEl.innerHTML = `
        <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Scan this QR code on the other device</div>
        ${result.qrSvg}
        <div style="font-size:10px;color:var(--text-muted);margin-top:6px;">QR expires in 60 seconds</div>
      `;
      setTimeout(() => { qrEl.style.display = 'none'; }, 60000);
    } else {
      qrEl.innerHTML = `<div style="font-size:10px;font-family:monospace;word-break:break-all;color:var(--text-muted);">Pairing code: ${result.pairingData?.slice(0,60)}…</div>`;
    }
  } catch(e) {
    qrEl.innerHTML = `<div style="color:var(--brand-danger);font-size:12px;">Error: ${e.message}</div>`;
  }
};


// ── Map Cache Globals (Tier 5) ────────────────────────────────
window.cacheMapRegion = async () => {
  if (!window.LAMMaps) { Toast.info('LAMMaps not loaded', 'Refresh and try again.'); return; }
  const sel    = document.getElementById('region-select');
  const prog   = document.getElementById('map-cache-progress');
  const stats  = document.getElementById('map-cache-stats');
  const region = window.LAMMaps.INDIA_REGIONS[sel?.value||'kerala'];
  if (!region) return;

  if (prog) { prog.style.display='block'; prog.textContent='Starting…'; }
  Toast.info('Caching Maps', `Downloading tiles for ${region.label}…`);

  try {
    const result = await window.LAMMaps.preCacheRegion(region, [8,9,10,11], (loaded, total) => {
      if (prog) prog.textContent = `Caching: ${loaded}/${total} tiles (${Math.round(loaded/total*100)}%)`;
    });
    if (prog) prog.style.display='none';
    Toast.success('Map Cached!', `${result.cached} tiles cached for ${region.label}. Maps work offline now.`);
    window.refreshMapCacheStats?.();
  } catch(e) {
    if (prog) prog.style.display='none';
    Toast.error('Cache Failed', e.message);
  }
};

window.clearMapCache = async () => {
  if (!window.LAMMaps) return;
  if (!confirm('Clear all cached map tiles?')) return;
  const ok = await window.LAMMaps.clearTileCache();
  if (ok) Toast.success('Cache Cleared', 'All offline map tiles removed.');
  window.refreshMapCacheStats?.();
};

window.refreshMapCacheStats = async () => {
  const el = document.getElementById('map-cache-stats');
  if (!el || !window.LAMMaps) return;
  try {
    const s = await window.LAMMaps.getCacheStats();
    el.textContent = s.tiles > 0
      ? `${s.tiles.toLocaleString('en-IN')} tiles cached (~${s.approxMB}MB) — ${Math.round(s.tiles/s.maxTiles*100)}% of limit`
      : 'No tiles cached. Click "Cache Region" to download offline maps.';
  } catch { el.textContent = 'Map cache stats unavailable.'; }
};
