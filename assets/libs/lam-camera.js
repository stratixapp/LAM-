// ============================================================
// LAM Camera Engine v1 — Zero dependency document capture
// Photo capture, damage reports, signature pad, file compress
// All stored as compressed base64 in localStorage
// ============================================================

const LAMCamera = (() => {

  // ── Constants ─────────────────────────────────────────────
  const MAX_PHOTO_DIM  = 1280;   // px — max dimension before compress
  const PHOTO_QUALITY  = 0.82;   // JPEG quality
  const THUMB_DIM      = 200;    // thumbnail dimension
  const MAX_STORAGE_MB = 4;      // max MB per photo record

  // ── Photo Capture ─────────────────────────────────────────

  /**
   * Open camera or file picker, return compressed base64 image
   * @param {Object} opts
   * @param {string} opts.facing - 'environment' (back camera) | 'user'
   * @param {boolean} opts.allowGallery - allow gallery/file picker too
   * @param {Function} opts.onCapture - callback({ base64, thumb, width, height, size, timestamp, gps })
   * @param {Function} opts.onError
   */
  async function capture(opts = {}) {
    const { facing = 'environment', allowGallery = true, onCapture, onError } = opts;

    return new Promise((resolve, reject) => {
      // Create hidden input for mobile file capture
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = 'image/*';
      if (!allowGallery) input.capture = facing;

      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const result = await processImageFile(file);
          onCapture?.(result);
          resolve(result);
        } catch (e) {
          onError?.(e.message);
          reject(e);
        }
      };

      input.click();
    });
  }

  /**
   * Open live camera viewfinder in a container element
   * @param {HTMLElement} container
   * @param {Object} opts
   */
  async function openViewfinder(container, opts = {}) {
    const { facing = 'environment', onCapture, onError, onClose } = opts;

    let stream = null;

    container.innerHTML = `
      <div id="lam-vf-wrap" style="position:relative;background:#000;border-radius:12px;overflow:hidden;max-width:100%;">
        <video id="lam-vf-video" autoplay playsinline muted style="width:100%;display:block;max-height:320px;object-fit:cover;"></video>
        <canvas id="lam-vf-canvas" style="display:none;"></canvas>

        <!-- Viewfinder overlay -->
        <div style="position:absolute;inset:0;pointer-events:none;">
          <!-- Corner markers -->
          <div style="position:absolute;top:16px;left:16px;width:24px;height:24px;border-top:3px solid #fff;border-left:3px solid #fff;border-radius:3px 0 0 0;opacity:0.8;"></div>
          <div style="position:absolute;top:16px;right:16px;width:24px;height:24px;border-top:3px solid #fff;border-right:3px solid #fff;border-radius:0 3px 0 0;opacity:0.8;"></div>
          <div style="position:absolute;bottom:16px;left:16px;width:24px;height:24px;border-bottom:3px solid #fff;border-left:3px solid #fff;border-radius:0 0 0 3px;opacity:0.8;"></div>
          <div style="position:absolute;bottom:16px;right:16px;width:24px;height:24px;border-bottom:3px solid #fff;border-right:3px solid #fff;border-radius:0 0 3px 0;opacity:0.8;"></div>
        </div>

        <!-- GPS badge -->
        <div id="lam-vf-gps" style="position:absolute;top:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.5);color:#fff;font-size:10px;padding:3px 8px;border-radius:12px;display:none;">📍 Getting location…</div>

        <!-- Controls -->
        <div style="position:absolute;bottom:0;left:0;right:0;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(transparent,rgba(0,0,0,0.7));">
          <button id="lam-vf-close" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:40px;height:40px;border-radius:50%;font-size:18px;cursor:pointer;" title="Close">✕</button>
          <button id="lam-vf-snap" style="background:#fff;border:none;width:60px;height:60px;border-radius:50%;cursor:pointer;box-shadow:0 0 0 4px rgba(255,255,255,0.3);font-size:24px;" title="Capture">📷</button>
          <button id="lam-vf-flip" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:40px;height:40px;border-radius:50%;font-size:18px;cursor:pointer;" title="Flip camera">🔄</button>
        </div>
      </div>
    `;

    const video   = container.querySelector('#lam-vf-video');
    const canvas  = container.querySelector('#lam-vf-canvas');
    const gpsEl   = container.querySelector('#lam-vf-gps');
    let currentFacing = facing;
    let gpsCoords = null;

    // Start GPS
    if ('geolocation' in navigator) {
      gpsEl.style.display = 'block';
      navigator.geolocation.getCurrentPosition(
        pos => {
          gpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
          gpsEl.textContent = `📍 ${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`;
        },
        () => { gpsEl.style.display = 'none'; },
        { timeout: 8000, maximumAge: 30000 }
      );
    }

    const startStream = async (fc) => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: fc }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        video.srcObject = stream;
        await video.play();
      } catch (e) {
        onError?.(e.name === 'NotAllowedError' ? 'Camera permission denied.' : `Camera: ${e.message}`);
      }
    };

    await startStream(currentFacing);

    container.querySelector('#lam-vf-snap').onclick = async () => {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', PHOTO_QUALITY));
      const result = await processImageFile(blob, gpsCoords);
      onCapture?.(result);
    };

    container.querySelector('#lam-vf-flip').onclick = async () => {
      currentFacing = currentFacing === 'environment' ? 'user' : 'environment';
      await startStream(currentFacing);
    };

    container.querySelector('#lam-vf-close').onclick = () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      container.innerHTML = '';
      onClose?.();
    };

    // Return stop function
    return () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }

  /**
   * Process an image file/blob → compressed base64 + thumbnail + metadata
   */
  async function processImageFile(file, gpsCoords = null) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const { w, h } = _fitDimensions(img.width, img.height, MAX_PHOTO_DIM);

          // Full size canvas
          const canvas = document.createElement('canvas');
          canvas.width  = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);

          // Stamp GPS + timestamp on photo
          if (gpsCoords) {
            const stamp = `${gpsCoords.lat.toFixed(5)},${gpsCoords.lng.toFixed(5)} • ${new Date().toLocaleString('en-IN')}`;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, h - 22, w, 22);
            ctx.fillStyle = '#fff';
            ctx.font = '11px Arial';
            ctx.fillText(`📍 ${stamp}`, 8, h - 7);
          }

          const base64 = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);

          // Thumbnail
          const { w: tw, h: th } = _fitDimensions(w, h, THUMB_DIM);
          const tCanvas = document.createElement('canvas');
          tCanvas.width  = tw;
          tCanvas.height = th;
          tCanvas.getContext('2d').drawImage(canvas, 0, 0, tw, th);
          const thumb = tCanvas.toDataURL('image/jpeg', 0.7);

          const size = Math.round(base64.length * 0.75 / 1024); // KB approx

          resolve({
            base64,
            thumb,
            width:     w,
            height:    h,
            sizeKB:    size,
            timestamp: new Date().toISOString(),
            gps:       gpsCoords,
          });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });
  }

  function _fitDimensions(w, h, max) {
    if (w <= max && h <= max) return { w, h };
    const ratio = w > h ? max / w : max / h;
    return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
  }

  // ── Signature Pad ─────────────────────────────────────────

  /**
   * Render a signature pad into a container element
   * @param {HTMLElement} container
   * @param {Object} opts - { width, height, penColor, bgColor, onSign }
   * @returns {{ getSignature, clear, isEmpty }}
   */
  function createSignaturePad(container, opts = {}) {
    const {
      width    = container.clientWidth || 400,
      height   = 160,
      penColor = '#1E293B',
      bgColor  = '#FFFFFF',
      onSign,
    } = opts;

    container.innerHTML = `
      <div style="position:relative;border:2px dashed #CBD5E1;border-radius:8px;background:${bgColor};touch-action:none;user-select:none;">
        <canvas id="sig-canvas" width="${width}" height="${height}" style="display:block;width:100%;cursor:crosshair;border-radius:6px;"></canvas>
        <div style="position:absolute;bottom:6px;left:50%;transform:translateX(-50%);color:#94A3B8;font-size:10px;pointer-events:none;letter-spacing:1px;">SIGN HERE</div>
        <button id="sig-clear" style="position:absolute;top:6px;right:8px;background:rgba(0,0,0,0.1);border:none;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;color:#64748B;">Clear</button>
      </div>
    `;

    const canvas = container.querySelector('#sig-canvas');
    const ctx    = canvas.getContext('2d');
    ctx.strokeStyle = penColor;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    let drawing  = false;
    let lastX    = 0;
    let lastY    = 0;
    let _isEmpty = true;
    let points   = [];

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width  / rect.width;
      const scaleY = canvas.height / rect.height;
      const src = e.touches ? e.touches[0] : e;
      return {
        x: (src.clientX - rect.left) * scaleX,
        y: (src.clientY - rect.top)  * scaleY,
      };
    };

    const startDraw = (e) => {
      e.preventDefault();
      drawing = true;
      const { x, y } = getPos(e);
      lastX = x; lastY = y;
      ctx.beginPath();
      ctx.moveTo(x, y);
    };

    const draw = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = getPos(e);

      // Smooth with quadratic curve
      const midX = (lastX + x) / 2;
      const midY = (lastY + y) / 2;
      ctx.quadraticCurveTo(lastX, lastY, midX, midY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(midX, midY);

      lastX = x; lastY = y;
      _isEmpty = false;
      points.push({ x, y });
    };

    const endDraw = (e) => {
      if (!drawing) return;
      e.preventDefault();
      drawing = false;
      if (!_isEmpty) onSign?.();
    };

    canvas.addEventListener('mousedown',  startDraw);
    canvas.addEventListener('mousemove',  draw);
    canvas.addEventListener('mouseup',    endDraw);
    canvas.addEventListener('mouseleave', endDraw);
    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove',  draw,      { passive: false });
    canvas.addEventListener('touchend',   endDraw);

    container.querySelector('#sig-clear').onclick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      _isEmpty = true;
      points   = [];
    };

    return {
      getSignature(quality = 0.9) {
        if (_isEmpty) return null;
        return canvas.toDataURL('image/png', quality);
      },
      getSignatureJpeg(quality = 0.85) {
        if (_isEmpty) return null;
        // Flatten on white background first
        const flat = document.createElement('canvas');
        flat.width  = canvas.width;
        flat.height = canvas.height;
        const fCtx  = flat.getContext('2d');
        fCtx.fillStyle = '#fff';
        fCtx.fillRect(0, 0, flat.width, flat.height);
        fCtx.drawImage(canvas, 0, 0);
        return flat.toDataURL('image/jpeg', quality);
      },
      clear() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        _isEmpty = true;
        points   = [];
      },
      isEmpty() { return _isEmpty; },
      getPoints() { return [...points]; },
    };
  }

  // ── Photo Gallery ─────────────────────────────────────────

  /**
   * Render a photo gallery/viewer for a record's photos
   * @param {HTMLElement} container
   * @param {Array} photos - array of { base64, thumb, timestamp, gps }
   * @param {Object} opts - { editable, onAdd, onDelete }
   */
  function renderPhotoGallery(container, photos = [], opts = {}) {
    const { editable = true, onAdd, onDelete, label = 'Photos' } = opts;

    const renderGrid = () => {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:11px;font-weight:600;color:var(--text-muted,#64748B);text-transform:uppercase;letter-spacing:0.5px;">${label} (${photos.length})</span>
            ${editable ? `<button id="lam-add-photo" style="background:var(--brand-primary,#0A84FF);border:none;color:#fff;padding:4px 12px;border-radius:6px;font-size:11px;cursor:pointer;">+ Add Photo</button>` : ''}
          </div>
          ${photos.length ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;">
              ${photos.map((p, i) => `
                <div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f1f5f9;cursor:pointer;" onclick="window._LAMCamView(${i})">
                  <img src="${p.thumb || p.base64}" style="width:100%;height:100%;object-fit:cover;" loading="lazy"/>
                  ${editable ? `<button onclick="event.stopPropagation();window._LAMCamDel(${i})" style="position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.6);border:none;color:#fff;width:18px;height:18px;border-radius:50%;font-size:9px;cursor:pointer;line-height:18px;text-align:center;">✕</button>` : ''}
                  ${p.gps ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.5);color:#fff;font-size:8px;padding:2px 4px;">📍</div>` : ''}
                </div>
              `).join('')}
              ${editable ? `
                <div id="lam-vf-container" style="aspect-ratio:1;border:2px dashed #CBD5E1;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;color:#94A3B8;background:#F8FAFC;" onclick="document.getElementById('lam-add-photo').click()">+</div>
              ` : ''}
            </div>
          ` : `
            <div style="padding:24px;text-align:center;color:#94A3B8;font-size:12px;background:#F8FAFC;border-radius:8px;border:2px dashed #E2E8F0;">
              No photos yet.<br>Tap "+ Add Photo" to capture or upload.
            </div>
          `}
        </div>
      `;

      if (editable) {
        container.querySelector('#lam-add-photo')?.addEventListener('click', async () => {
          const result = await capture({ onCapture: null });
          if (result) { photos.push(result); onAdd?.(result, photos); renderGrid(); }
        });
      }

      // Lightbox viewer
      window._LAMCamView = (idx) => _showLightbox(photos, idx);
      window._LAMCamDel  = (idx) => {
        photos.splice(idx, 1);
        onDelete?.(idx, photos);
        renderGrid();
      };
    };

    renderGrid();
  }

  // ── Lightbox ──────────────────────────────────────────────
  function _showLightbox(photos, startIdx) {
    let current = startIdx;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;';

    const render = () => {
      const p = photos[current];
      overlay.innerHTML = `
        <div style="position:relative;max-width:90vw;max-height:85vh;">
          <img src="${p.base64}" style="max-width:90vw;max-height:80vh;object-fit:contain;border-radius:8px;"/>
          <button onclick="this.closest('div').parentElement.parentElement.remove()" style="position:fixed;top:16px;right:16px;background:rgba(255,255,255,0.15);border:none;color:#fff;width:36px;height:36px;border-radius:50%;font-size:18px;cursor:pointer;">✕</button>
          ${current > 0 ? `<button id="lb-prev" style="position:absolute;left:-48px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.15);border:none;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:18px;">‹</button>` : ''}
          ${current < photos.length-1 ? `<button id="lb-next" style="position:absolute;right:-48px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.15);border:none;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:18px;">›</button>` : ''}
        </div>
        <div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:12px;">
          ${current+1} / ${photos.length}
          ${p.timestamp ? ` • ${new Date(p.timestamp).toLocaleString('en-IN')}` : ''}
          ${p.gps ? ` • 📍 ${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}` : ''}
        </div>
      `;
      overlay.querySelector('#lb-prev')?.addEventListener('click', () => { current--; render(); });
      overlay.querySelector('#lb-next')?.addEventListener('click', () => { current++; render(); });
    };

    render();
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Damage Report Builder ─────────────────────────────────

  /**
   * Render a damage report form with photo capture
   * @param {HTMLElement} container
   * @param {Object} opts - { recordId, recordType, onSave }
   */
  function renderDamageReport(container, opts = {}) {
    const { recordId, recordType = 'delivery', onSave } = opts;
    const photos = [];

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="form-group">
          <label class="form-label">Damage Type</label>
          <select id="dmg-type" class="form-select">
            <option value="">Select type…</option>
            <option value="physical">Physical Damage</option>
            <option value="shortage">Shortage / Missing Items</option>
            <option value="wet">Water / Moisture Damage</option>
            <option value="tampered">Tampered / Seal Broken</option>
            <option value="expired">Expired / Near Expiry</option>
            <option value="wrong">Wrong Item Delivered</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Severity</label>
          <div style="display:flex;gap:8px;">
            ${['Minor','Moderate','Severe'].map(s => `
              <label style="flex:1;text-align:center;padding:8px;border:2px solid #E2E8F0;border-radius:8px;cursor:pointer;font-size:12px;">
                <input type="radio" name="dmg-severity" value="${s.toLowerCase()}" style="display:none;">
                ${s}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea id="dmg-desc" class="form-textarea" rows="2" placeholder="Describe the damage in detail…"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Photo Evidence</label>
          <div id="dmg-photos"></div>
        </div>
        <button id="dmg-save" class="btn btn-primary" style="width:100%;">Save Damage Report</button>
      </div>
    `;

    // Severity radio style
    container.querySelectorAll('input[name="dmg-severity"]').forEach(radio => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('label').forEach(l => {
          l.style.borderColor = '#E2E8F0';
          l.style.background  = '';
          l.style.color       = '';
        });
        const lbl = radio.closest('label');
        lbl.style.borderColor = '#FF453A';
        lbl.style.background  = 'rgba(255,69,58,0.1)';
        lbl.style.color       = '#FF453A';
      });
    });

    renderPhotoGallery(
      container.querySelector('#dmg-photos'),
      photos,
      {
        editable: true,
        label: 'Damage Photos',
        onAdd: (photo) => photos.push(photo),
      }
    );

    container.querySelector('#dmg-save').onclick = () => {
      const type     = container.querySelector('#dmg-type').value;
      const severity = container.querySelector('input[name="dmg-severity"]:checked')?.value;
      const desc     = container.querySelector('#dmg-desc').value.trim();

      if (!type) { alert('Please select damage type.'); return; }
      if (!severity) { alert('Please select severity.'); return; }

      onSave?.({
        recordId,
        recordType,
        type,
        severity,
        description: desc,
        photos:      photos.map(p => ({ thumb: p.thumb, gps: p.gps, timestamp: p.timestamp, sizeKB: p.sizeKB, base64: p.base64 })),
        reportedAt:  new Date().toISOString(),
      });
    };
  }

  // ── Document Scanner (straighten + enhance) ──────────────

  /**
   * Capture a document photo and enhance it:
   * - Auto-straighten (perspective correction attempt)
   * - Contrast enhance
   * - Convert to near-greyscale for readability
   */
  async function captureDocument(opts = {}) {
    const { onCapture, onError } = opts;

    const result = await capture({ facing: 'environment', allowGallery: true, onError });
    if (!result) return;

    // Enhance for document readability
    const enhanced = _enhanceDocument(result.base64);
    onCapture?.({ ...result, base64: enhanced, type: 'document' });
    return { ...result, base64: enhanced };
  }

  function _enhanceDocument(base64) {
    const img    = new Image();
    const canvas = document.createElement('canvas');
    img.src      = base64;

    // Synchronous since we have the data already
    if (!img.complete) return base64;

    canvas.width  = img.width;
    canvas.height = img.height;
    const ctx     = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Enhance contrast for document scanning
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data      = imageData.data;

    // Calculate histogram for auto-levels
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = (data[i] + data[i+1] + data[i+2]) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }

    const range = max - min || 1;

    // Apply auto-levels + slight sharpening
    for (let i = 0; i < data.length; i += 4) {
      const enhance = (v) => Math.min(255, Math.max(0, Math.round((v - min) / range * 255)));
      data[i]   = enhance(data[i]);
      data[i+1] = enhance(data[i+1]);
      data[i+2] = enhance(data[i+2]);
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  // Public API
  return {
    capture,
    openViewfinder,
    processImageFile,
    createSignaturePad,
    renderPhotoGallery,
    renderDamageReport,
    captureDocument,
  };

})();

window.LAMCamera = LAMCamera;
