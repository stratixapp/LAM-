// ============================================================
// LAM — SPA Router
// ============================================================

export const Router = {
  _routes: {},
  _current: null,
  _beforeEach: null,

  define(routes) {
    this._routes = routes;
    return this;
  },

  beforeEach(fn) {
    this._beforeEach = fn;
    return this;
  },

  async navigate(routeId, params = {}) {
    const route = this._routes[routeId];
    if (!route) { console.warn(`Route "${routeId}" not found`); return; }

    if (this._beforeEach) {
      const allowed = await this._beforeEach(routeId, params);
      if (!allowed) return;
    }

    this._current = routeId;

    // Update URL hash
    window.location.hash = routeId + (Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '');

    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.route === routeId);
    });

    // Update breadcrumb
    const bc = document.getElementById('breadcrumb-current');
    if (bc) bc.textContent = route.label || routeId;

    // Render route
    const container = document.getElementById('page-content');
    if (container && typeof route.render === 'function') {
      container.innerHTML = '';
      container.style.animation = 'none';
      requestAnimationFrame(() => {
        container.style.animation = 'fadeInUp 0.3s ease forwards';
        route.render(container, params);
      });
    }
  },

  init() {
    // Handle hash changes
    window.addEventListener('hashchange', () => {
      const [routeId, search] = window.location.hash.slice(1).split('?');
      const params = search ? Object.fromEntries(new URLSearchParams(search)) : {};
      if (routeId && this._routes[routeId]) this.navigate(routeId, params);
    });

    // Handle sidebar nav clicks
    document.addEventListener('click', e => {
      const navItem = e.target.closest('.nav-item[data-route]');
      if (navItem) {
        e.preventDefault();
        if (navItem.classList.contains('locked')) return;
        this.navigate(navItem.dataset.route);
      }
    });

    // Init from current hash
    const hash = window.location.hash.slice(1).split('?')[0];
    if (hash && this._routes[hash]) this.navigate(hash);
    else {
      const defaultRoute = Object.keys(this._routes)[0];
      if (defaultRoute) this.navigate(defaultRoute);
    }
  },

  getCurrent() { return this._current; },
};
