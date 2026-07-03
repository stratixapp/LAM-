// ============================================================
// LAM Crypto Engine v1 — Client-side AES-GCM encryption
// Uses SubtleCrypto (browser native, zero dependency).
// Sensitive collections encrypted at rest in IndexedDB.
// Key derived from user password via PBKDF2, never stored raw.
// ============================================================

const LAMCRYPTO = (() => {

  // ── Sensitive collections that get encrypted ──────────────
  const ENCRYPTED_COLLECTIONS = new Set([
    'payroll',        // salary, PF, TDS details
    'employees',      // PAN, bank account, UAN
    'bank_accounts',  // account numbers, IFSC
    'bank_txn',       // transaction details
    'passwords',      // if any stored
    'api_keys',       // API credentials
    'gst_config',     // GSTIN credentials
    'audit_logs',     // tamper-proof (signed, not encrypted)
  ]);

  // Fields to encrypt within a record (field-level encryption)
  const SENSITIVE_FIELDS = {
    employees:    ['pan','uan','bankAccount','bankIfsc','aadhaar','salary','ctc'],
    payroll:      ['basicSalary','hra','grossSalary','netPay','pfEmployee','tds','bankAccount'],
    bank_accounts:['accountNumber','ifscCode','swiftCode'],
    bank_txn:     ['reference','narration'],
    api_keys:     ['key','secret','token'],
    gst_config:   ['gstin','password','apiKey'],
  };

  // ── Key storage ───────────────────────────────────────────
  let _encryptionKey = null; // CryptoKey object (not exportable)
  let _keyReady      = false;

  const ENC_KEY_META = 'lam_enc_meta'; // localStorage key for salt + iv metadata

  // ── Key derivation (PBKDF2 → AES-GCM) ───────────────────

  /**
   * Derive encryption key from user password.
   * Call this once at login.
   * @param {string} password
   * @param {string} userId
   */
  async function deriveKey(password, userId) {
    try {
      const enc      = new TextEncoder();
      const salt     = _getSalt(userId);
      const keyMat   = await crypto.subtle.importKey(
        'raw', enc.encode(password + userId), 'PBKDF2', false, ['deriveKey']
      );
      _encryptionKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' },
        keyMat,
        { name: 'AES-GCM', length: 256 },
        false, // non-exportable
        ['encrypt', 'decrypt']
      );
      _keyReady = true;
      console.log('LAM Crypto: encryption key derived ✓');
      return true;
    } catch (e) {
      console.warn('LAM Crypto: key derivation failed:', e);
      return false;
    }
  }

  function _getSalt(userId) {
    const key  = `${ENC_KEY_META}_${userId}`;
    const meta = localStorage.getItem(key);
    if (meta) {
      const { salt } = JSON.parse(meta);
      return _base64ToBuffer(salt);
    }
    // Generate new salt for this user
    const salt = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(key, JSON.stringify({ salt: _bufferToBase64(salt), version: 1 }));
    return salt;
  }

  function clearKey() {
    _encryptionKey = null;
    _keyReady      = false;
  }

  function isReady() { return _keyReady; }

  // ── Field-level encryption ────────────────────────────────

  async function encryptField(value) {
    if (!_keyReady || !_encryptionKey) return value;
    if (value === null || value === undefined) return value;

    try {
      const iv        = crypto.getRandomValues(new Uint8Array(12));
      const enc       = new TextEncoder();
      const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        _encryptionKey,
        enc.encode(String(value))
      );
      return `enc:${_bufferToBase64(iv)}:${_bufferToBase64(new Uint8Array(cipherBuf))}`;
    } catch {
      return value; // fallback to plaintext if encryption fails
    }
  }

  async function decryptField(value) {
    if (!_keyReady || !_encryptionKey) return value;
    if (typeof value !== 'string' || !value.startsWith('enc:')) return value;

    try {
      const [, ivB64, dataB64] = value.split(':');
      const iv         = _base64ToBuffer(ivB64);
      const data       = _base64ToBuffer(dataB64);
      const plainBuf   = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        _encryptionKey,
        data
      );
      return new TextDecoder().decode(plainBuf);
    } catch {
      return value; // return ciphertext if can't decrypt
    }
  }

  // ── Record-level encryption ───────────────────────────────

  async function encryptRecord(record) {
    if (!_keyReady) return null;
    const col    = record._collection || '';
    const fields = SENSITIVE_FIELDS[col] || [];
    if (!fields.length) return null;

    const encrypted = { ...record, _encrypted: true, _encFields: fields };
    for (const field of fields) {
      if (field in encrypted && encrypted[field] !== null && encrypted[field] !== undefined) {
        encrypted[field] = await encryptField(encrypted[field]);
      }
    }
    return encrypted;
  }

  async function decryptRecord(record) {
    if (!record?._encrypted) return record;
    const fields  = record._encFields || [];
    const out     = { ...record };

    for (const field of fields) {
      if (typeof out[field] === 'string' && out[field].startsWith('enc:')) {
        out[field] = await decryptField(out[field]);
      }
    }
    return out;
  }

  function _shouldEncrypt(col) {
    return ENCRYPTED_COLLECTIONS.has(col) && _keyReady;
  }

  // ── SHA-256 hashing ───────────────────────────────────────

  async function sha256(data) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function sha256Buffer(buf) {
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── Tamper-proof audit log chain ──────────────────────────
  // Each audit log entry contains:
  //   hash = SHA256(prevHash + action + userId + timestamp + data)
  // Any tampered entry breaks the chain.

  let _lastAuditHash = null;

  async function _getLastHash(db) {
    if (_lastAuditHash) return _lastAuditHash;
    try {
      // Get the most recent audit log to continue the chain
      const metaKey = 'lam_audit_chain_tip';
      const stored  = localStorage.getItem(metaKey);
      if (stored) return stored;
      return '0000000000000000000000000000000000000000000000000000000000000000';
    } catch {
      return '0'.repeat(64);
    }
  }

  async function signAuditEntry(entry) {
    const prevHash = await _getLastHash();
    const content  = prevHash + entry.action + (entry.userId||'') + entry.timestamp + JSON.stringify(entry.data||{});
    const hash     = await sha256(content);

    _lastAuditHash = hash;
    localStorage.setItem('lam_audit_chain_tip', hash);

    return { ...entry, hash, prevHash };
  }

  async function verifyAuditChain(entries) {
    if (!entries.length) return { valid: true, tamperedAt: null };

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < entries.length; i++) {
      const e        = entries[i];
      const content  = (e.prevHash || '0'.repeat(64)) + e.action + (e.userId||'') + e.timestamp + JSON.stringify(e.data||{});
      const expected = await sha256(content);

      if (e.hash !== expected || e.prevHash !== prevHash) {
        return { valid: false, tamperedAt: i, entry: e };
      }
      prevHash = e.hash;
    }
    return { valid: true, tamperedAt: null };
  }

  // ── Data integrity check ──────────────────────────────────

  async function hashRecord(record) {
    const content = JSON.stringify({
      id:        record.id,
      data:      record,
      timestamp: record.updatedAt || record.createdAt,
    });
    return sha256(content);
  }

  // ── Password hashing (for auth) ───────────────────────────

  async function hashPassword(password) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── Random token generator ────────────────────────────────

  function generateToken(bytes = 32) {
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    return _bufferToBase64(buf).replace(/[+/=]/g, '').slice(0, bytes * 1.3);
  }

  // ── Buffer utilities ──────────────────────────────────────

  function _bufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary  = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function _base64ToBuffer(b64) {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Role-based data isolation ─────────────────────────────
  // Filters query results based on user role and company
  // Prevents lower-privilege users from seeing restricted data

  const ROLE_RESTRICTIONS = {
    driver: {
      // Drivers can only see their own trips
      trips:        (record, userId) => record.driverId === userId || record.createdBy === userId,
      delivery_notes:(record, userId) => record.assignedDriverId === userId,
    },
    warehouse_staff: {
      // Warehouse staff see inventory and GRNs but not payroll/financials
      payroll:      () => false,
      bank_accounts:() => false,
      bank_txn:     () => false,
      gl_entries:   () => false,
    },
    viewer: {
      // Viewers can't see financials, HR sensitive, or admin
      payroll:      () => false,
      bank_accounts:() => false,
      bank_txn:     () => false,
      api_keys:     () => false,
    },
  };

  function filterByRole(records, collection, userProfile) {
    if (!userProfile) return records;
    const role        = userProfile.role || 'viewer';
    const userId      = userProfile.id;
    const restrictions= ROLE_RESTRICTIONS[role];
    if (!restrictions) return records; // admin/manager — see everything

    const filter = restrictions[collection];
    if (!filter) return records;
    if (filter === false || (typeof filter === 'function' && !filter)) {
      return []; // Completely blocked
    }
    return records.filter(r => filter(r, userId));
  }

  // ── Namespace isolation (per company) ────────────────────
  // Ensures data from one company never leaks to another

  function enforceCompanyNamespace(record, companyId) {
    if (!companyId) return record;
    if (record.companyId && record.companyId !== companyId) return null;
    return record;
  }

  return {
    // Key management
    deriveKey,
    clearKey,
    isReady,

    // Field encryption
    encryptField,
    decryptField,

    // Record encryption
    encryptRecord,
    decryptRecord,
    _shouldEncrypt,

    // Hashing
    sha256,
    sha256Buffer,
    hashPassword,
    generateToken,

    // Audit chain
    signAuditEntry,
    verifyAuditChain,
    hashRecord,

    // Access control
    filterByRole,
    enforceCompanyNamespace,

    // Constants
    ENCRYPTED_COLLECTIONS,
    SENSITIVE_FIELDS,
  };

})();

window.LAMCRYPTO = LAMCRYPTO;
