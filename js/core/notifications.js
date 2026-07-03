// ============================================================
// LAM — Notifications (Toast System)
// ============================================================

export const Toast = {
  _container: null,

  _getContainer() {
    if (!this._container) {
      this._container = document.getElementById('toast-container');
      if (!this._container) {
        this._container = document.createElement('div');
        this._container.id = 'toast-container';
        document.body.appendChild(this._container);
      }
    }
    return this._container;
  },

  show({ type = 'info', title, message, duration = 4000 }) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const container = this._getContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${title}</div>` : ''}
        ${message ? `<div class="toast-text">${message}</div>` : ''}
      </div>
      <span class="toast-close" onclick="this.closest('.toast').remove()">✕</span>
    `;
    container.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }
  },

  success(title, message) { this.show({ type: 'success', title, message }); },
  error(title, message)   { this.show({ type: 'error',   title, message }); },
  warning(title, message) { this.show({ type: 'warning', title, message }); },
  info(title, message)    { this.show({ type: 'info',    title, message }); },
};
