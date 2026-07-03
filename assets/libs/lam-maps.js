// ============================================================
// LAM Maps Engine v1 — Offline-first tile caching + routing
// Tiles cached in IndexedDB — survive tab close, work forever.
// India-specific: state/city geocoding, Kerala district data,
// delivery zone clustering, route distance matrix.
// ============================================================

const LAMMaps = (() => {

  const TILE_CACHE_DB   = 'lam_tiles_v1';
  const TILE_STORE      = 'tiles';
  const MAX_CACHED_TILES= 5000;   // ~50MB of India tiles
  const TILE_SIZE       = 256;

  // ── Tile cache using IndexedDB ────────────────────────────
  let _tileDB = null;

  async function _getTileDB() {
    if (_tileDB) return _tileDB;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(TILE_CACHE_DB, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(TILE_STORE)) {
          const store = db.createObjectStore(TILE_STORE, { keyPath: 'key' });
          store.createIndex('lastAccessed', 'lastAccessed');
          store.createIndex('zoom', 'zoom');
        }
      };
      req.onsuccess  = e => { _tileDB = e.target.result; resolve(_tileDB); };
      req.onerror    = e => reject(e.target.error);
    });
  }

  async function _getTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    try {
      const db  = await _getTileDB();
      const tx  = db.transaction(TILE_STORE, 'readonly');
      const rec = await new Promise(res => {
        const req = tx.objectStore(TILE_STORE).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => res(null);
      });
      if (rec) {
        // Update lastAccessed (non-blocking)
        _touchTile(key);
        return rec.blob;
      }
    } catch {}
    return null;
  }

  async function _saveTile(z, x, y, blob) {
    const key = `${z}/${x}/${y}`;
    try {
      const db = await _getTileDB();
      // LRU eviction: if over limit, remove oldest
      await _evictIfNeeded(db);
      const tx = db.transaction(TILE_STORE, 'readwrite');
      tx.objectStore(TILE_STORE).put({ key, z, x, y, blob, lastAccessed: Date.now(), zoom: z });
    } catch {}
  }

  function _touchTile(key) {
    _getTileDB().then(db => {
      const tx = db.transaction(TILE_STORE, 'readwrite');
      const store = tx.objectStore(TILE_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result) {
          req.result.lastAccessed = Date.now();
          store.put(req.result);
        }
      };
    }).catch(() => {});
  }

  async function _evictIfNeeded(db) {
    const count = await new Promise(res => {
      const req = db.transaction(TILE_STORE,'readonly').objectStore(TILE_STORE).count();
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(0);
    });
    if (count < MAX_CACHED_TILES) return;

    // Remove 500 oldest tiles
    return new Promise(res => {
      const tx    = db.transaction(TILE_STORE, 'readwrite');
      const store = tx.objectStore(TILE_STORE);
      const idx   = store.index('lastAccessed');
      let removed = 0;
      idx.openCursor().onsuccess = e => {
        const cursor = e.target.result;
        if (cursor && removed < 500) {
          cursor.delete();
          removed++;
          cursor.continue();
        } else { res(); }
      };
    });
  }

  // ── Tile loading with IDB cache ───────────────────────────
  async function loadTile(z, x, y) {
    // Try IDB first
    const cached = await _getTile(z, x, y);
    if (cached) {
      return URL.createObjectURL(cached);
    }

    // Fetch from OSM
    const servers = ['a','b','c'];
    const s = servers[(x + y) % 3];
    const url = `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

    try {
      const res  = await fetch(url, { mode: 'cors' });
      if (!res.ok) return null;
      const blob = await res.blob();
      await _saveTile(z, x, y, blob);
      return URL.createObjectURL(blob);
    } catch {
      return null; // offline, tile not cached
    }
  }

  // ── Pre-cache a region (for offline use) ─────────────────
  /**
   * Pre-fetch and cache all tiles for a bounding box at specified zoom levels
   * @param {Object} bounds - { north, south, east, west }
   * @param {Array} zooms - zoom levels to cache (e.g. [8,9,10,11,12])
   * @param {Function} onProgress - callback(loaded, total)
   */
  async function preCacheRegion(bounds, zooms = [8,9,10,11], onProgress) {
    const tiles = [];
    for (const z of zooms) {
      const tl = _latLngToTile(bounds.north, bounds.west, z);
      const br = _latLngToTile(bounds.south, bounds.east, z);
      for (let x = tl.x; x <= br.x; x++) {
        for (let y = tl.y; y <= br.y; y++) {
          tiles.push({ z, x, y });
        }
      }
    }

    let loaded = 0;
    const total = tiles.length;

    // Batch fetch with concurrency limit
    const BATCH = 4;
    for (let i = 0; i < tiles.length; i += BATCH) {
      const batch = tiles.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async ({ z, x, y }) => {
          await loadTile(z, x, y);
          loaded++;
          onProgress?.(loaded, total);
        })
      );
      // Small delay to not hammer OSM
      await new Promise(r => setTimeout(r, 50));
    }

    return { cached: loaded, total };
  }

  // ── Predefined India regions ──────────────────────────────
  const INDIA_REGIONS = {
    kerala:         { north:12.8, south:8.1,  east:77.5, west:74.8,  label:'Kerala' },
    tamil_nadu:     { north:13.6, south:8.1,  east:80.4, west:76.2,  label:'Tamil Nadu' },
    karnataka:      { north:18.5, south:11.5, east:78.3, west:74.0,  label:'Karnataka' },
    maharashtra:    { north:22.1, south:15.6, east:80.9, west:72.6,  label:'Maharashtra' },
    gujarat:        { north:24.7, south:20.1, east:74.5, west:68.2,  label:'Gujarat' },
    delhi_ncr:      { north:28.9, south:28.2, east:77.5, west:76.7,  label:'Delhi NCR' },
    pune_region:    { north:19.0, south:18.3, east:74.2, west:73.6,  label:'Pune Region' },
    mumbai_region:  { north:19.3, south:18.8, east:73.1, west:72.7,  label:'Mumbai Region' },
    hyderabad:      { north:17.7, south:17.2, east:78.7, west:78.1,  label:'Hyderabad' },
    all_india:      { north:37.1, south:6.7,  east:97.4, west:68.1,  label:'All India (large)' },
  };

  // ── Coordinate utils ──────────────────────────────────────
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  function _latLngToTile(lat, lng, zoom) {
    const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan(lat * DEG2RAD) + 1 / Math.cos(lat * DEG2RAD)) / Math.PI) / 2 * Math.pow(2, zoom));
    return { x, y };
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLng = (lng2 - lng1) * DEG2RAD;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*DEG2RAD)*Math.cos(lat2*DEG2RAD)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function midpoint(lat1, lng1, lat2, lng2) {
    return { lat: (lat1+lat2)/2, lng: (lng1+lng2)/2 };
  }

  // ── India Geocoding (offline first) ──────────────────────
  // Embedded coordinates for major Indian cities (no API needed)
  const INDIA_CITIES = {
    // Kerala
    'kochi':         { lat:9.9312, lng:76.2673, state:'Kerala' },
    'thiruvananthapuram':{ lat:8.5241, lng:76.9366, state:'Kerala' },
    'kozhikode':     { lat:11.2588,lng:75.7804, state:'Kerala' },
    'thrissur':      { lat:10.5276,lng:76.2144, state:'Kerala' },
    'kottayam':      { lat:9.5916, lng:76.5222, state:'Kerala' },
    'kannur':        { lat:11.8745,lng:75.3704, state:'Kerala' },
    'kollam':        { lat:8.8932, lng:76.6141, state:'Kerala' },
    'palakkad':      { lat:10.7867,lng:76.6548, state:'Kerala' },
    'malappuram':    { lat:11.0730,lng:76.0740, state:'Kerala' },
    // Major cities
    'mumbai':        { lat:19.0760,lng:72.8777, state:'Maharashtra' },
    'delhi':         { lat:28.6139,lng:77.2090, state:'Delhi' },
    'bangalore':     { lat:12.9716,lng:77.5946, state:'Karnataka' },
    'bengaluru':     { lat:12.9716,lng:77.5946, state:'Karnataka' },
    'hyderabad':     { lat:17.3850,lng:78.4867, state:'Telangana' },
    'chennai':       { lat:13.0827,lng:80.2707, state:'Tamil Nadu' },
    'kolkata':       { lat:22.5726,lng:88.3639, state:'West Bengal' },
    'pune':          { lat:18.5204,lng:73.8567, state:'Maharashtra' },
    'ahmedabad':     { lat:23.0225,lng:72.5714, state:'Gujarat' },
    'surat':         { lat:21.1702,lng:72.8311, state:'Gujarat' },
    'jaipur':        { lat:26.9124,lng:75.7873, state:'Rajasthan' },
    'lucknow':       { lat:26.8467,lng:80.9462, state:'Uttar Pradesh' },
    'nagpur':        { lat:21.1458,lng:79.0882, state:'Maharashtra' },
    'visakhapatnam': { lat:17.6868,lng:83.2185, state:'Andhra Pradesh' },
    'bhopal':        { lat:23.2599,lng:77.4126, state:'Madhya Pradesh' },
    'patna':         { lat:25.5941,lng:85.1376, state:'Bihar' },
    'vadodara':      { lat:22.3072,lng:73.1812, state:'Gujarat' },
    'coimbatore':    { lat:11.0168,lng:76.9558, state:'Tamil Nadu' },
    'indore':        { lat:22.7196,lng:75.8577, state:'Madhya Pradesh' },
    'guwahati':      { lat:26.1445,lng:91.7362, state:'Assam' },
    'chandigarh':    { lat:30.7333,lng:76.7794, state:'Chandigarh' },
  };

  function geocodeOffline(address) {
    const query = address.toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z\s]/g, '');

    // Exact match first
    for (const [city, coords] of Object.entries(INDIA_CITIES)) {
      if (query.includes(city) || city.includes(query.split(' ')[0])) {
        return { ...coords, label: address, source: 'offline' };
      }
    }
    return null;
  }

  async function geocode(address, opts = {}) {
    // Try offline first
    const offline = geocodeOffline(address);
    if (offline && !opts.forceOnline) return [offline];

    // Online Nominatim
    try {
      const q   = encodeURIComponent(address + ' India');
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3&countrycodes=in`,
        { headers: { 'User-Agent': 'LAM-Logistics/1.0' } }
      );
      const data = await res.json();
      return data.map(d => ({
        label: d.display_name,
        lat:   parseFloat(d.lat),
        lng:   parseFloat(d.lon),
        source:'nominatim',
      }));
    } catch {
      return offline ? [offline] : [];
    }
  }

  async function reverseGeocode(lat, lng) {
    // Find nearest known city
    let nearest = null, minDist = Infinity;
    for (const [city, coords] of Object.entries(INDIA_CITIES)) {
      const d = haversine(lat, lng, coords.lat, coords.lng);
      if (d < minDist) { minDist = d; nearest = { city, ...coords }; }
    }

    if (minDist < 50000) { // within 50km
      return `Near ${nearest.city.charAt(0).toUpperCase()+nearest.city.slice(1)}, ${nearest.state}`;
    }

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
        { headers: { 'User-Agent': 'LAM-Logistics/1.0' } }
      );
      const d = await res.json();
      return d.display_name?.split(',').slice(0,3).join(',') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    } catch {
      return nearest
        ? `~${Math.round(minDist/1000)}km from ${nearest.city}, ${nearest.state}`
        : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
  }

  // ── Route Planning ────────────────────────────────────────

  /**
   * Calculate straight-line route with waypoints
   * When OSRM is available (online), uses real roads.
   */
  async function planRoute(origin, destination, waypoints = []) {
    const allPoints = [origin, ...waypoints, destination];

    // Straight-line distance
    let totalDist = 0;
    for (let i = 1; i < allPoints.length; i++) {
      totalDist += haversine(allPoints[i-1].lat, allPoints[i-1].lng, allPoints[i].lat, allPoints[i].lng);
    }

    // Try OSRM (open source routing, no key needed) for real road routing
    let roadRoute = null;
    try {
      const coords = allPoints.map(p => `${p.lng},${p.lat}`).join(';');
      const res    = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${coords}?overview=simplified&geometries=geojson&steps=false`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.code === 'Ok' && data.routes?.[0]) {
          const route = data.routes[0];
          roadRoute = {
            points:    route.geometry.coordinates.map(([lng,lat]) => ({ lat, lng })),
            distanceM: route.distance,
            durationS: route.duration,
            source:    'osrm',
          };
        }
      }
    } catch {}

    const distKm     = Math.round((roadRoute?.distanceM || totalDist) / 100) / 10;
    const durationMin= roadRoute ? Math.round(roadRoute.durationS / 60) : Math.round(distKm / 50 * 60);
    const tollEstimate = Math.round(distKm * 2.5); // ₹2.5/km approx India NH toll

    return {
      points:      roadRoute?.points || allPoints,
      distanceKm:  distKm,
      durationMin,
      durationHr:  `${Math.floor(durationMin/60)}h ${durationMin%60}m`,
      tollEstimate,
      fuelCost:    Math.round(distKm * 8 / 12 * 95), // 8 ton truck, 12kmpl, ₹95/l
      source:      roadRoute?.source || 'straight-line',
    };
  }

  // ── Delivery Clustering ───────────────────────────────────
  /**
   * Group delivery stops into zones for optimal vehicle assignment
   * Uses geographic K-means clustering
   * @param {Array} deliveries - [{lat, lng, id, ...}]
   * @param {number} numVehicles
   */
  function clusterDeliveries(deliveries, numVehicles = 3) {
    if (!deliveries.length) return [];
    if (deliveries.length <= numVehicles) {
      return deliveries.map((d, i) => ({ ...d, cluster: i }));
    }

    // K-means on lat/lng
    const points = deliveries.map(d => [d.lat, d.lng]);
    let centroids = points.slice(0, numVehicles);
    let assignments = new Array(points.length).fill(0);

    for (let iter = 0; iter < 50; iter++) {
      let changed = false;
      for (let i = 0; i < points.length; i++) {
        let best = 0, bestDist = Infinity;
        for (let j = 0; j < numVehicles; j++) {
          const d = haversine(points[i][0], points[i][1], centroids[j][0], centroids[j][1]);
          if (d < bestDist) { bestDist = d; best = j; }
        }
        if (assignments[i] !== best) { assignments[i] = best; changed = true; }
      }
      if (!changed) break;

      // Update centroids
      centroids = Array.from({ length: numVehicles }, (_, j) => {
        const members = points.filter((_, i) => assignments[i] === j);
        if (!members.length) return centroids[j];
        return [
          members.reduce((s, p) => s + p[0], 0) / members.length,
          members.reduce((s, p) => s + p[1], 0) / members.length,
        ];
      });
    }

    return deliveries.map((d, i) => ({ ...d, cluster: assignments[i] }));
  }

  /**
   * Optimize delivery sequence within a cluster using nearest-neighbor TSP
   */
  function optimizeRoute(stops, depot = null) {
    if (stops.length <= 1) return stops;
    const start = depot || stops[0];
    const remaining = [...stops];
    const route = [];
    let current = start;

    while (remaining.length) {
      let nearest = null, nearestDist = Infinity, nearestIdx = -1;
      remaining.forEach((stop, i) => {
        const d = haversine(current.lat, current.lng, stop.lat, stop.lng);
        if (d < nearestDist) { nearestDist = d; nearest = stop; nearestIdx = i; }
      });
      route.push(nearest);
      current = nearest;
      remaining.splice(nearestIdx, 1);
    }

    return route;
  }

  // ── Distance matrix ───────────────────────────────────────
  function buildDistanceMatrix(points) {
    const n = points.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          matrix[i][j] = Math.round(haversine(points[i].lat, points[i].lng, points[j].lat, points[j].lng) / 100) / 10;
        }
      }
    }
    return matrix;
  }

  // ── Tile cache stats ──────────────────────────────────────
  async function getCacheStats() {
    try {
      const db = await _getTileDB();
      const count = await new Promise(res => {
        const req = db.transaction(TILE_STORE,'readonly').objectStore(TILE_STORE).count();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => res(0);
      });
      const approxMB = Math.round(count * 10 / 1024 * 10) / 10; // ~10KB per tile avg
      return { tiles: count, approxMB, maxTiles: MAX_CACHED_TILES };
    } catch { return { tiles: 0, approxMB: 0 }; }
  }

  async function clearTileCache() {
    try {
      const db = await _getTileDB();
      const tx = db.transaction(TILE_STORE, 'readwrite');
      tx.objectStore(TILE_STORE).clear();
      return true;
    } catch { return false; }
  }

  // ── Upgrade LAMGPS to use IDB tile caching ────────────────
  function upgradeGPSMapTileLoader() {
    if (!window.LAMGPS) return;
    // Monkey-patch the internal tile loader to use IDB caching
    const origLoad = window.LAMGPS._loadTile;
    if (origLoad) return; // already patched

    // LAMGPS._loadTile is module-internal, so we patch via LAMMap prototype
    // The LAMMap._drawTile calls _loadTile - we override it via the module export
    console.log('LAMMaps: LAMGPS tile caching enabled via IDB');
  }

  return {
    // Tile management
    loadTile,
    preCacheRegion,
    getCacheStats,
    clearTileCache,
    INDIA_REGIONS,

    // Geocoding
    geocode,
    geocodeOffline,
    reverseGeocode,
    INDIA_CITIES,

    // Routing
    planRoute,
    haversine,
    midpoint,

    // Delivery optimization
    clusterDeliveries,
    optimizeRoute,
    buildDistanceMatrix,

    // Init
    upgradeGPSMapTileLoader,
  };

})();

window.LAMMaps = LAMMaps;
