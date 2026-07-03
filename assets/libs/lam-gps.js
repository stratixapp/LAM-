// ============================================================
// LAM GPS Engine v1 — Zero dependency location & mapping
// Real-time driver tracking, route display, geofencing,
// delivery radius check — all using browser Geolocation API
// + Canvas-rendered map tiles (no Google Maps / Leaflet CDN)
// ============================================================

const LAMGPS = (() => {

  // ── Constants ─────────────────────────────────────────────
  const EARTH_R   = 6371000; // metres
  const TILE_SIZE = 256;

  // ── Coordinate math ───────────────────────────────────────
  const deg2rad = d => d * Math.PI / 180;
  const rad2deg = r => r * 180 / Math.PI;

  /** Haversine distance in metres */
  function distance(lat1, lng1, lat2, lng2) {
    const dLat = deg2rad(lat2 - lat1);
    const dLng = deg2rad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng/2)**2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(a));
  }

  /** Bearing from point A to B in degrees */
  function bearing(lat1, lng1, lat2, lng2) {
    const dLng = deg2rad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(deg2rad(lat2));
    const x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) - Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(dLng);
    return (rad2deg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Convert lat/lng to OSM tile x/y at zoom level */
  function latLngToTile(lat, lng, zoom) {
    const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan(deg2rad(lat)) + 1 / Math.cos(deg2rad(lat))) / Math.PI) / 2 * Math.pow(2, zoom));
    return { x, y };
  }

  /** Convert tile x/y to lat/lng (top-left corner) */
  function tileToLatLng(x, y, zoom) {
    const n = Math.pow(2, zoom);
    const lng = x / n * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    return { lat: rad2deg(latRad), lng };
  }

  /** Convert lat/lng to pixel position within a tile */
  function latLngToPixel(lat, lng, zoom) {
    const tile = latLngToTile(lat, lng, zoom);
    const tl   = tileToLatLng(tile.x, tile.y, zoom);
    const br   = tileToLatLng(tile.x+1, tile.y+1, zoom);
    const px   = Math.round((lng - tl.lng) / (br.lng - tl.lng) * TILE_SIZE);
    const py   = Math.round((lat - tl.lat) / (br.lat - tl.lat) * TILE_SIZE);
    return { tileX: tile.x, tileY: tile.y, px, py };
  }

  // ── OSM Tile cache ────────────────────────────────────────
  const _tileCache = new Map();

  async function _loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (_tileCache.has(key)) return _tileCache.get(key);

    const servers = ['a', 'b', 'c'];
    const s = servers[(x + y) % 3];
    const url = `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => { _tileCache.set(key, img); resolve(img); };
      img.onerror = () => resolve(null); // offline — tile won't load
      img.src = url;
    });
  }

  // ── Map Renderer ──────────────────────────────────────────

  /**
   * Render an interactive map into a canvas element
   */
  class LAMMap {
    constructor(canvas, opts = {}) {
      this.canvas  = canvas;
      this.ctx     = canvas.getContext('2d');
      this.zoom    = opts.zoom    || 13;
      this.center  = opts.center || { lat: 9.9312, lng: 76.2673 }; // Kochi default
      this.markers = [];
      this.routes  = [];
      this.circles = [];
      this._dragging = false;
      this._lastPos  = null;
      this._loading  = false;
      this._animFrame= null;

      this._bindEvents();
      this.render();
    }

    // ── Coordinate conversion ─────────────────────────────
    _worldToPixel(lat, lng) {
      const z  = this.zoom;
      const cw = this.canvas.width  / 2;
      const ch = this.canvas.height / 2;
      const cp = this._latLngToWorld(this.center.lat, this.center.lng, z);
      const pp = this._latLngToWorld(lat, lng, z);
      return {
        x: cw + (pp.x - cp.x),
        y: ch + (pp.y - cp.y),
      };
    }

    _pixelToLatLng(px, py) {
      const z  = this.zoom;
      const cw = this.canvas.width  / 2;
      const ch = this.canvas.height / 2;
      const cp = this._latLngToWorld(this.center.lat, this.center.lng, z);
      const wx = cp.x + (px - cw);
      const wy = cp.y + (py - ch);
      return this._worldToLatLng(wx, wy, z);
    }

    _latLngToWorld(lat, lng, zoom) {
      const scale = TILE_SIZE * Math.pow(2, zoom);
      const x = (lng + 180) / 360 * scale;
      const sinLat = Math.sin(deg2rad(lat));
      const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
      return { x, y };
    }

    _worldToLatLng(wx, wy, zoom) {
      const scale = TILE_SIZE * Math.pow(2, zoom);
      const lng = wx / scale * 360 - 180;
      const n   = Math.PI - 2 * Math.PI * wy / scale;
      const lat = rad2deg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
      return { lat, lng };
    }

    // ── Render ────────────────────────────────────────────
    async render() {
      const ctx = this.ctx;
      const W   = this.canvas.width;
      const H   = this.canvas.height;
      const z   = this.zoom;

      // Background
      ctx.fillStyle = '#E8EEF4';
      ctx.fillRect(0, 0, W, H);

      // Calculate tile range
      const topLeft     = this._pixelToLatLng(0, 0);
      const bottomRight = this._pixelToLatLng(W, H);
      const tl = latLngToTile(topLeft.lat, topLeft.lng, z);
      const br = latLngToTile(bottomRight.lat, bottomRight.lng, z);

      // Draw tiles
      const tilePromises = [];
      for (let tx = tl.x - 1; tx <= br.x + 1; tx++) {
        for (let ty = tl.y - 1; ty <= br.y + 1; ty++) {
          tilePromises.push(this._drawTile(tx, ty, z));
        }
      }
      await Promise.allSettled(tilePromises);

      // Draw routes
      this.routes.forEach(route => this._drawRoute(route));

      // Draw circles (geofences)
      this.circles.forEach(c => this._drawCircle(c));

      // Draw markers
      this.markers.forEach(m => this._drawMarker(m));

      // Attribution
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(0, H - 16, W, 16);
      ctx.fillStyle = '#666';
      ctx.font = '9px Arial';
      ctx.fillText('© OpenStreetMap contributors', 4, H - 4);

      // Zoom controls
      this._drawZoomControls();
    }

    async _drawTile(tx, ty, z) {
      // Use LAMMaps IDB cache if available (Tier 5)
      let img;
      if (window.LAMMaps) {
        const url = await window.LAMMaps.loadTile(z, tx, ty);
        if (url) {
          img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
          if (!img.complete || img.naturalWidth === 0) img = null;
        }
      } else {
        img = await _loadTile(z, tx, ty);
      }
      if (!img) return;

      const topLeftTile  = this._latLngToWorld(tileToLatLng(tx, ty, z).lat, tileToLatLng(tx, ty, z).lng, z);
      const center       = this._latLngToWorld(this.center.lat, this.center.lng, z);
      const x = this.canvas.width  / 2 + topLeftTile.x - center.x;
      const y = this.canvas.height / 2 + topLeftTile.y - center.y;

      this.ctx.drawImage(img, Math.round(x), Math.round(y), TILE_SIZE, TILE_SIZE);
    }

    _drawRoute(route) {
      if (!route.points?.length) return;
      const ctx = this.ctx;
      ctx.beginPath();
      route.points.forEach((p, i) => {
        const { x, y } = this._worldToPixel(p.lat, p.lng);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = route.color || '#0A84FF';
      ctx.lineWidth   = route.width || 3;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.setLineDash(route.dashed ? [8, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow at midpoint
      if (route.points.length >= 2 && route.arrow !== false) {
        const mid = Math.floor(route.points.length / 2);
        const p1  = route.points[mid-1];
        const p2  = route.points[mid];
        this._drawArrow(p1.lat, p1.lng, p2.lat, p2.lng, route.color || '#0A84FF');
      }
    }

    _drawArrow(lat1, lng1, lat2, lng2, color) {
      const ctx = this.ctx;
      const { x: x1, y: y1 } = this._worldToPixel(lat1, lng1);
      const { x: x2, y: y2 } = this._worldToPixel(lat2, lng2);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const len   = 8;
      ctx.save();
      ctx.translate(x2, y2);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-len, -len/2);
      ctx.lineTo(-len, len/2);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    _drawCircle(c) {
      const { x, y } = this._worldToPixel(c.lat, c.lng);
      // Calculate pixel radius from metres
      const scale = TILE_SIZE * Math.pow(2, this.zoom) / (2 * Math.PI * EARTH_R);
      const r     = c.radius * scale;

      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle   = c.fillColor   || 'rgba(10,132,255,0.1)';
      ctx.strokeStyle = c.strokeColor || 'rgba(10,132,255,0.5)';
      ctx.lineWidth   = 2;
      ctx.fill();
      ctx.stroke();
    }

    _drawMarker(m) {
      const { x, y } = this._worldToPixel(m.lat, m.lng);
      const ctx       = this.ctx;
      const type      = m.type || 'pin';

      if (type === 'dot') {
        ctx.beginPath();
        ctx.arc(x, y, m.radius || 6, 0, 2 * Math.PI);
        ctx.fillStyle   = m.color   || '#0A84FF';
        ctx.strokeStyle = m.stroke  || '#fff';
        ctx.lineWidth   = 2;
        ctx.fill();
        ctx.stroke();
      } else if (type === 'truck') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(deg2rad(m.bearing || 0));
        ctx.fillStyle = m.color || '#30D158';
        ctx.beginPath();
        ctx.roundRect(-10, -7, 20, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('▶', 0, 0);
        ctx.restore();
      } else {
        // Pin
        const pinH = m.size || 32;
        const pinW = pinH * 0.65;
        ctx.save();
        ctx.translate(x, y - pinH);

        // Drop shadow
        ctx.shadowColor   = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur    = 4;
        ctx.shadowOffsetY = 2;

        ctx.fillStyle = m.color || '#FF453A';
        ctx.beginPath();
        ctx.arc(0, 0, pinW/2, Math.PI, 2 * Math.PI);
        ctx.lineTo(pinW/2 * 0.4, pinH * 0.7);
        ctx.lineTo(0, pinH);
        ctx.lineTo(-pinW/2 * 0.4, pinH * 0.7);
        ctx.lineTo(-pinW/2, 0);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;

        // Inner dot
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, pinW * 0.22, 0, 2 * Math.PI);
        ctx.fill();

        if (m.label) {
          ctx.fillStyle   = '#fff';
          ctx.font        = `bold ${Math.round(pinW * 0.35)}px Arial`;
          ctx.textAlign   = 'center';
          ctx.textBaseline= 'middle';
          ctx.fillText(m.label[0], 0, 0);
        }
        ctx.restore();
      }

      // Tooltip label
      if (m.title) {
        ctx.save();
        ctx.font      = '11px Arial';
        const tw      = ctx.measureText(m.title).width;
        const lx      = x - tw/2 - 4;
        const ly      = y - (type === 'pin' ? 38 : 16) - 18;
        ctx.fillStyle = 'rgba(15,23,42,0.85)';
        ctx.roundRect?.(lx, ly, tw + 8, 16, 4);
        ctx.fill?.();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(m.title, x, ly + 11);
        ctx.restore();
      }
    }

    _drawZoomControls() {
      const ctx = this.ctx;
      const W   = this.canvas.width;
      [['+', 10], ['-', 42]].forEach(([label, y]) => {
        ctx.fillStyle   = 'rgba(255,255,255,0.9)';
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.roundRect?.(W - 36, y, 26, 26, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle    = '#333';
        ctx.font         = 'bold 16px Arial';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, W - 23, y + 13);
      });
    }

    // ── Interactions ──────────────────────────────────────
    _bindEvents() {
      const c = this.canvas;
      c.addEventListener('mousedown',  e => this._onDragStart(e));
      c.addEventListener('mousemove',  e => this._onDragMove(e));
      c.addEventListener('mouseup',    e => this._onDragEnd(e));
      c.addEventListener('mouseleave', e => this._onDragEnd(e));
      c.addEventListener('wheel',      e => { e.preventDefault(); this._onZoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
      c.addEventListener('click',      e => this._onClick(e));
      c.addEventListener('touchstart', e => { e.preventDefault(); this._onDragStart(e.touches[0]); }, { passive: false });
      c.addEventListener('touchmove',  e => { e.preventDefault(); this._onDragMove(e.touches[0]); }, { passive: false });
      c.addEventListener('touchend',   e => this._onDragEnd(e)); 
    }

    _onDragStart(e) {
      this._dragging = true;
      const rect = this.canvas.getBoundingClientRect();
      this._lastPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onDragMove(e) {
      if (!this._dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const x    = e.clientX - rect.left;
      const y    = e.clientY - rect.top;
      const dx   = x - this._lastPos.x;
      const dy   = y - this._lastPos.y;
      this._lastPos = { x, y };

      const scale = TILE_SIZE * Math.pow(2, this.zoom) / (2 * Math.PI * EARTH_R);
      const worldC = this._latLngToWorld(this.center.lat, this.center.lng, this.zoom);
      const newWorld = { x: worldC.x - dx, y: worldC.y - dy };
      this.center = this._worldToLatLng(newWorld.x, newWorld.y, this.zoom);

      cancelAnimationFrame(this._animFrame);
      this._animFrame = requestAnimationFrame(() => this.render());
    }

    _onDragEnd() { this._dragging = false; }

    _onClick(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x    = e.clientX - rect.left;
      const y    = e.clientY - rect.top;
      const W    = this.canvas.width;

      // Zoom buttons
      if (x > W - 36 && x < W - 10) {
        if (y > 10 && y < 36) this._onZoom(1);
        if (y > 42 && y < 68) this._onZoom(-1);
      }

      // Click on markers
      const latlng = this._pixelToLatLng(x, y);
      this.markers.forEach(m => {
        const d = distance(m.lat, m.lng, latlng.lat, latlng.lng);
        const scale = TILE_SIZE * Math.pow(2, this.zoom) / (2 * Math.PI * EARTH_R);
        if (d < 20 / scale) m.onClick?.({ lat: m.lat, lng: m.lng, data: m.data });
      });
    }

    _onZoom(delta) {
      this.zoom = Math.max(3, Math.min(18, this.zoom + delta));
      this.render();
    }

    // ── Public map API ────────────────────────────────────
    setCenter(lat, lng, zoom) {
      this.center = { lat, lng };
      if (zoom) this.zoom = zoom;
      this.render();
    }

    addMarker(opts) {
      this.markers.push(opts);
      this.render();
      return this;
    }

    clearMarkers() { this.markers = []; return this; }

    addRoute(opts) {
      this.routes.push(opts);
      this.render();
      return this;
    }

    clearRoutes() { this.routes = []; return this; }

    addCircle(opts) {
      this.circles.push(opts);
      this.render();
      return this;
    }

    clearCircles() { this.circles = []; return this; }

    fitBounds(points) {
      if (!points.length) return;
      const lats = points.map(p => p.lat);
      const lngs = points.map(p => p.lng);
      const lat = (Math.max(...lats) + Math.min(...lats)) / 2;
      const lng = (Math.max(...lngs) + Math.min(...lngs)) / 2;
      // Zoom level based on bounds spread
      const latSpan = Math.max(...lats) - Math.min(...lats);
      const lngSpan = Math.max(...lngs) - Math.min(...lngs);
      const span    = Math.max(latSpan, lngSpan);
      let zoom = 13;
      if (span > 5)    zoom = 7;
      else if (span > 2)    zoom = 9;
      else if (span > 0.5)  zoom = 11;
      else if (span > 0.1)  zoom = 13;
      else if (span > 0.02) zoom = 15;
      this.setCenter(lat, lng, zoom);
    }

    destroy() {
      cancelAnimationFrame(this._animFrame);
      this.canvas.replaceWith(this.canvas.cloneNode(false));
    }
  }

  // ── GPS Tracker ───────────────────────────────────────────

  class GPSTracker {
    constructor(opts = {}) {
      this.opts      = opts;
      this._watchId  = null;
      this._history  = [];
      this._current  = null;
      this._listeners= [];
      this._channel  = new BroadcastChannel('lam_gps');
    }

    start() {
      if (!navigator.geolocation) {
        this.opts.onError?.('Geolocation not supported');
        return;
      }
      this._watchId = navigator.geolocation.watchPosition(
        pos => this._onPosition(pos),
        err => this.opts.onError?.(err.message),
        {
          enableHighAccuracy: true,
          maximumAge:         5000,
          timeout:            15000,
        }
      );
    }

    stop() {
      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
    }

    _onPosition(pos) {
      const point = {
        lat:       pos.coords.latitude,
        lng:       pos.coords.longitude,
        accuracy:  pos.coords.accuracy,
        speed:     pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : null, // kmh
        heading:   pos.coords.heading,
        altitude:  pos.coords.altitude,
        timestamp: new Date().toISOString(),
      };

      // Calculate distance from last point
      if (this._current) {
        point.distFromLast = distance(this._current.lat, this._current.lng, point.lat, point.lng);
        point.bearing      = bearing(this._current.lat, this._current.lng, point.lat, point.lng);
      }

      this._current = point;
      this._history.push(point);

      // Keep history to last 1000 points
      if (this._history.length > 1000) this._history.shift();

      // Persist to localStorage
      this._saveHistory();

      // Broadcast to other tabs
      this._channel.postMessage({ type: 'GPS_UPDATE', point });

      // Notify listeners
      this._listeners.forEach(fn => fn(point, this._history));
      this.opts.onUpdate?.(point, this._history);
    }

    _saveHistory() {
      try {
        // Only keep last 200 points in storage to avoid bloat
        const toSave = this._history.slice(-200);
        localStorage.setItem('lam_gps_history', JSON.stringify(toSave));
      } catch {}
    }

    loadHistory() {
      try {
        const h = localStorage.getItem('lam_gps_history');
        if (h) this._history = JSON.parse(h);
      } catch {}
      return this._history;
    }

    subscribe(fn) {
      this._listeners.push(fn);
      return () => { this._listeners = this._listeners.filter(f => f !== fn); };
    }

    getCurrent()   { return this._current; }
    getHistory()   { return [...this._history]; }
    getTotalDistance() {
      return this._history.reduce((sum, p) => sum + (p.distFromLast || 0), 0);
    }

    /** Check if current position is within radius metres of target */
    isNear(targetLat, targetLng, radiusMetres = 500) {
      if (!this._current) return false;
      return distance(this._current.lat, this._current.lng, targetLat, targetLng) <= radiusMetres;
    }
  }

  // ── Geocoder (Nominatim — free, no key required) ──────────

  async function geocode(address) {
    try {
      const q = encodeURIComponent(address + ', India');
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3&countrycodes=in`, {
        headers: { 'User-Agent': 'LAM-App/1.0' }
      });
      const data = await r.json();
      return data.map(d => ({
        label: d.display_name,
        lat:   parseFloat(d.lat),
        lng:   parseFloat(d.lon),
      }));
    } catch {
      return [];
    }
  }

  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
        headers: { 'User-Agent': 'LAM-App/1.0' }
      });
      const d = await r.json();
      return d.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } catch {
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }

  /** Simple distance-only routing — straight line with intermediate waypoints */
  function buildStraightRoute(origin, destination, waypoints = []) {
    const allPoints = [origin, ...waypoints, destination];
    return {
      points:   allPoints,
      distance: allPoints.reduce((sum, p, i) => {
        if (i === 0) return 0;
        return sum + distance(allPoints[i-1].lat, allPoints[i-1].lng, p.lat, p.lng);
      }, 0),
      estimatedTime: null, // requires routing API
    };
  }

  /** Get current location as a one-shot promise */
  function getCurrentLocation(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
        err => reject(new Error(err.message)),
        { enableHighAccuracy: opts.highAccuracy || false, timeout: opts.timeout || 10000 }
      );
    });
  }

  // ── Geofence engine ───────────────────────────────────────

  class GeofenceMonitor {
    constructor() {
      this._zones    = [];
      this._inside   = new Set();
      this._tracker  = null;
    }

    addZone(zone) {
      // zone: { id, name, lat, lng, radius, onEnter, onExit }
      this._zones.push(zone);
      return this;
    }

    attachTracker(tracker) {
      this._tracker = tracker;
      tracker.subscribe((point) => this._check(point));
      return this;
    }

    _check(point) {
      this._zones.forEach(zone => {
        const d   = distance(point.lat, point.lng, zone.lat, zone.lng);
        const was = this._inside.has(zone.id);
        const now = d <= zone.radius;
        if (!was && now)  { this._inside.add(zone.id);    zone.onEnter?.(point, zone); }
        if (was  && !now) { this._inside.delete(zone.id); zone.onExit?.(point, zone);  }
      });
    }
  }

  // ── Multi-tab sync (BroadcastChannel) ────────────────────
  function createLocationChannel() {
    const channel   = new BroadcastChannel('lam_gps');
    const listeners = [];

    channel.onmessage = (e) => {
      if (e.data?.type === 'GPS_UPDATE') {
        listeners.forEach(fn => fn(e.data.point));
      }
    };

    return {
      onUpdate:  (fn) => listeners.push(fn),
      broadcast: (point) => channel.postMessage({ type: 'GPS_UPDATE', point }),
      close:     () => channel.close(),
    };
  }

  // ── Delivery Address Validator ────────────────────────────

  /**
   * Check if a delivery address is within acceptable range of a depot
   */
  async function validateDeliveryRange(deliveryAddress, depotLat, depotLng, maxRangeKm = 100) {
    const results = await geocode(deliveryAddress);
    if (!results.length) return { valid: false, error: 'Address not found' };

    const { lat, lng } = results[0];
    const dist = distance(lat, lng, depotLat, depotLng) / 1000; // km

    return {
      valid:    dist <= maxRangeKm,
      distance: Math.round(dist),
      lat, lng,
      label:    results[0].label,
      error:    dist > maxRangeKm ? `Address is ${Math.round(dist)}km away (max ${maxRangeKm}km)` : null,
    };
  }

  return {
    // Core math
    distance,
    bearing,

    // Map rendering
    LAMMap,

    // GPS tracking
    GPSTracker,
    getCurrentLocation,

    // Geocoding
    geocode,
    reverseGeocode,
    buildStraightRoute,

    // Geofencing
    GeofenceMonitor,

    // Multi-tab
    createLocationChannel,

    // Utilities
    validateDeliveryRange,
  };

})();

window.LAMGPS = LAMGPS;
