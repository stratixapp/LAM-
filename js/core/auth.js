// ============================================================
// LAM — Auth Module (LocalStorage edition)
// No Firebase dependency. Sessions stored in localStorage.
// ============================================================

import { dbCreate, dbSet, dbGet, dbGetAll, COLLECTIONS, where } from './firebase.js';
import { Toast } from './notifications.js';
import { State } from './state.js';

// ── Role Definitions ─────────────────────────────────────────
export const ROLES = {
  SUPER_ADMIN:     'super_admin',
  ADMIN:           'admin',
  MANAGER:         'manager',
  WAREHOUSE_STAFF: 'warehouse_staff',
  DRIVER:          'driver',
  FINANCE:         'finance',
  HR:              'hr',
  VIEWER:          'viewer',
};

export const ROLE_LABELS = {
  super_admin:     'Super Admin',
  admin:           'Administrator',
  manager:         'Manager',
  warehouse_staff: 'Warehouse Staff',
  driver:          'Driver',
  finance:         'Finance',
  hr:              'HR',
  viewer:          'Viewer',
};

// ── Plan Definitions ─────────────────────────────────────────
export const PLANS = {
  STARTER:    'starter',
  GROWTH:     'growth',
  ENTERPRISE: 'enterprise',
};

export const PLAN_FEATURES = {
  starter: {
    label: 'Starter', price: 999, maxUsers: 5,
    modules: ['dashboard','company','employees','vendors','customers','products','warehouse','inventory'],
  },
  growth: {
    label: 'Growth', price: 1499, maxUsers: 25,
    modules: ['dashboard','company','employees','vendors','customers','products','warehouse','inventory',
              'grn','dispatch','transfer','barcode','cyclecount','orders','procurement'],
  },
  enterprise: {
    label: 'Enterprise', price: 1999, maxUsers: -1,
    modules: ['*'],
  },
};

// ── Session Storage ──────────────────────────────────────────
const SESSION_KEY = 'lam_session';

function saveSession(user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch {}
}

function loadSession() {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; }
  catch { return null; }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ── Auth State ────────────────────────────────────────────────
export const AuthState = {
  user:        null,
  profile:     null,
  company:     null,
  initialized: false,

  async init() {
    if (this.initialized) return this.user;
    const session = loadSession();
    if (session) {
      try {
        const profile = await dbGet(COLLECTIONS.USERS, session.uid);
        if (profile && profile.status !== 'inactive') {
          this.user    = session;
          this.profile = profile;
          if (profile.companyId) {
            this.company = await dbGet(COLLECTIONS.COMPANIES, profile.companyId);
          }
          State.set('auth', { user: this.user, profile: this.profile, company: this.company });
        } else {
          clearSession();
        }
      } catch(e) {
        console.error('Auth init error:', e);
        clearSession();
      }
    }
    this.initialized = true;
    return this.user;
  },

  isLoggedIn() { return !!this.user; },

  hasRole(role) {
    if (!this.profile) return false;
    if (this.profile.role === ROLES.SUPER_ADMIN) return true;
    return this.profile.role === role;
  },

  hasAnyRole(roles) { return roles.some(r => this.hasRole(r)); },

  canAccess(module) {
    if (!this.profile || !this.company) return false;
    const plan     = this.company.plan || PLANS.STARTER;
    const features = PLAN_FEATURES[plan];
    if (!features) return false;
    if (features.modules.includes('*')) return true;
    return features.modules.includes(module);
  },

  get plan() { return this.company?.plan || PLANS.STARTER; },
};

// ── Password hashing (simple, client-side) ───────────────────
// NOTE: this is demo-grade. When you connect your real backend,
// replace with proper server-side hashing.
async function hashPassword(pw) {
  // Use Web Crypto if available (HTTPS or localhost secure context)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  // Fallback: pure-JS SHA-256 (works on HTTP/non-secure context during dev)
  return _sha256(pw);
}

// Pure-JS SHA-256 fallback (RFC 6234 compliant)
function _sha256(str) {
  function rr(w,b){return(w>>>b)|(w<<(32-b));}
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes=[...new TextEncoder().encode(str)];
  bytes.push(0x80);
  while(bytes.length%64!==56)bytes.push(0);
  const len=str.length*8;
  for(let i=7;i>=0;i--)bytes.push((len/Math.pow(2,i*8))&0xff);
  for(let i=0;i<bytes.length;i+=64){
    const w=new Array(64);
    for(let j=0;j<16;j++)w[j]=(bytes[i+j*4]<<24)|(bytes[i+j*4+1]<<16)|(bytes[i+j*4+2]<<8)|bytes[i+j*4+3];
    for(let j=16;j<64;j++){const s0=rr(w[j-15],7)^rr(w[j-15],18)^(w[j-15]>>>3);const s1=rr(w[j-2],17)^rr(w[j-2],19)^(w[j-2]>>>10);w[j]=(w[j-16]+s0+w[j-7]+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=H;
    for(let j=0;j<64;j++){const S1=rr(e,6)^rr(e,11)^rr(e,25);const ch=(e&f)^(~e&g);const t1=(h+S1+ch+K[j]+w[j])>>>0;const S0=rr(a,2)^rr(a,13)^rr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  return H.map(v=>v.toString(16).padStart(8,'0')).join('');
}

// ── Login ─────────────────────────────────────────────────────
export async function login(email, password) {
  // Ensure LAMDB is initialized before any reads
  if (window.LAMDB) await window.LAMDB.init().catch(() => {});
  // ── Try DotBase backend first ───────────────────────────
  const dotbaseCfg = window.getDotBaseConfig?.() || null;
  if (dotbaseCfg) {
    try {
      const res = await fetch(
        `${dotbaseCfg.url}/v1/${dotbaseCfg.projectId}/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || 'Login failed');
      }
      const data    = await res.json();
      const profile = data.data?.user || data.user;
      const tokens  = data.data       || data;

      const session = {
        uid:          profile.id,
        email:        profile.email,
        name:         profile.name,
        accessToken:  tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt:    tokens.expiresAt,
        source:       'dotbase',
      };
      saveSession(session);

      AuthState.user    = session;
      AuthState.profile = { ...profile, companyId: profile.metadata?.companyId };
      State.set('auth', { user: session, profile: AuthState.profile, company: null });

      if (window.LAMCRYPTO) window.LAMCRYPTO.deriveKey(password, profile.id).catch(() => {});
      if (window.LAMDB)     window.LAMDB.init().then(() => window.LAMDB.requestPersistence?.()).catch(() => {});

      return { user: session, profile };
    } catch(e) {
      // If it's a credential error, don't fall through to local
      if (e.message.includes('Invalid') || e.message.includes('password') || e.message.includes('email')) {
        throw e;
      }
      console.warn('DotBase login failed, trying local:', e.message);
    }
  }

  // ── Local login ──────────────────────────────────────────
  const users = await dbGetAll(COLLECTIONS.USERS, [where('email','==', email.toLowerCase().trim())]);
  if (!users.length) throw new Error('No account found with this email address.');

  const profile = users[0];
  if (profile.status === 'inactive') throw new Error('Your account has been deactivated.');

  const hash = await hashPassword(password);
  if (profile.passwordHash !== hash) throw new Error('Incorrect password. Please try again.');

  const session = { uid: profile.id, email: profile.email, name: profile.name };
  saveSession(session);

  await dbSet(COLLECTIONS.USERS, profile.id, { lastLogin: new Date().toISOString() });

  if (window.LAMCRYPTO) window.LAMCRYPTO.deriveKey(password, profile.id).catch(() => {});
  if (window.LAMDB)     window.LAMDB.init().then(() => window.LAMDB.requestPersistence?.()).catch(() => {});

  return { user: session, profile };
}

// ── Logout ────────────────────────────────────────────────────
export async function logout() {
  clearSession();
  AuthState.user    = null;
  AuthState.profile = null;
  AuthState.company = null;
  AuthState.initialized = false;
  window.location.href = 'index.html';
}

// ── Register Company + Admin ──────────────────────────────────
export async function registerCompany({ companyName, adminName, email, password, plan = PLANS.STARTER }) {
  // Ensure LAMDB is initialized before any reads/writes
  if (window.LAMDB) await window.LAMDB.init().catch(() => {});
  // Check email not already taken
  const existing = await dbGetAll(COLLECTIONS.USERS, [where('email','==', email.toLowerCase().trim())]);
  if (existing.length) throw new Error('An account with this email already exists.');

  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  // Create company first
  const company = await dbCreate(COLLECTIONS.COMPANIES, {
    name:      companyName,
    plan:      plan,
    status:    'active',
    createdAt: now,
  });

  // Create admin user
  const user = await dbCreate(COLLECTIONS.USERS, {
    name:         adminName,
    email:        email.toLowerCase().trim(),
    passwordHash: hash,
    role:         ROLES.ADMIN,
    companyId:    company.id,
    status:       'active',
    createdAt:    now,
  });

  const session = { uid: user.id, email: user.email, name: user.name };
  saveSession(session);

  // Also register on DotBase if connected
  const dotbaseCfg2 = window.getDotBaseConfig?.();
  if (dotbaseCfg2) {
    fetch(`${dotbaseCfg2.url}/v1/${dotbaseCfg2.projectId}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password, name: adminName,
                             metadata: { companyId: company.id, role: ROLES.ADMIN } }),
    }).catch(() => {});
  }

  return { user: session, companyId: company.id };
}

// ── Password Reset (local demo mode) ─────────────────────────
export async function resetPassword(email) {
  // In local mode just verify the email exists — real reset needs a backend
  const users = await dbGetAll(COLLECTIONS.USERS, [where('email','==', email.toLowerCase().trim())]);
  if (!users.length) throw new Error('No account found with this email address.');
  // In production: call your backend to send reset email
  return true;
}


// ── Demo Account Seeder ───────────────────────────────────────
// Creates the demo admin@demo.com account on first run
async function seedDemoAccount() {
  // v2 seed key forces re-seed if old broken seed ran before IDB fix
  localStorage.removeItem('lam_demo_seeded'); // clear old flag
  if (localStorage.getItem('lam_demo_seeded_v2')) return;
  try {
    const existing = await dbGetAll(COLLECTIONS.USERS, [where('email','==','admin@demo.com')]);
    if (existing.length) { localStorage.setItem('lam_demo_seeded_v2','1'); return; }

    const hash = await hashPassword('demo1234');
    const now  = new Date().toISOString();

    const company = await dbCreate(COLLECTIONS.COMPANIES, {
      name:      'Demo Company Pvt Ltd',
      plan:      PLANS.ENTERPRISE,
      industry:  'Logistics',
      status:    'active',
      gstin:     '22AAAAA0000A1Z5',
      address:   '123 Demo Street, Kochi, Kerala 682001',
      phone:     '9876543210',
      email:     'info@democompany.com',
      createdAt: now,
    });

    await dbCreate(COLLECTIONS.USERS, {
      name:         'Demo Admin',
      email:        'admin@demo.com',
      passwordHash: hash,
      role:         ROLES.ADMIN,
      companyId:    company.id,
      status:       'active',
      createdAt:    now,
    });

    localStorage.setItem('lam_demo_seeded_v2', '1');
    console.log('LAM: Demo account seeded — admin@demo.com / demo1234');
  } catch(e) {
    console.error('Demo seed error:', e);
  }
}

// ── Route Guards ──────────────────────────────────────────────
export async function requireAuth(redirectTo = 'index.html') {
  // LAMDB.init() is awaited by dashboard.html BEFORE calling requireAuth().
  // We still guard here in case auth.js is used from other pages.
  if (window.LAMDB && !window.LAMDB.isReady) {
    await window.LAMDB.init().catch(() => {});
    await window.LAMDB.requestPersistence?.().catch(() => {});
  }
  await AuthState.init();
  // Always return true — LAMUsers handles the PIN login screen if no session
  return true;
}

export async function requireGuest(redirectTo = 'dashboard.html') {
  if (window.LAMDB && !window.LAMDB.isReady) {
    await window.LAMDB.init().catch(() => {});
    await window.LAMDB.requestPersistence?.().catch(() => {});
  }
  await AuthState.init();
  if (AuthState.isLoggedIn()) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}
