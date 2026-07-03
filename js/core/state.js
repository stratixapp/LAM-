// ============================================================
// LAM — State Management
// ============================================================

export const State = {
  _store: {},
  _listeners: {},

  set(key, value) {
    this._store[key] = value;
    (this._listeners[key] || []).forEach(fn => fn(value));
  },

  get(key) { return this._store[key]; },

  subscribe(key, fn) {
    if (!this._listeners[key]) this._listeners[key] = [];
    this._listeners[key].push(fn);
    return () => { this._listeners[key] = this._listeners[key].filter(f => f !== fn); };
  },
};
