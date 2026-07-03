// ============================================================
// LAM — Products / Item Master Module
// ============================================================

import { dbCreate, dbUpdate, dbDelete, dbListen, COLLECTIONS, where, orderBy } from '../../core/firebase.js';
import { AuthState } from '../../core/auth.js';
import { Toast } from '../../core/notifications.js';
import { formatDate, formatCurrency, escHtml, setLoading, searchFilter, debounce, genId } from '../../core/utils.js';
import { pageShell, buildTable, buildModal, searchBar, avatarCell, badge, actionsMenu, buildPagination, validateForm, openModal, closeModal, setupModalClose, setupMenuClose } from '../_shared.js';

let _products  = [];
let _filtered  = [];
let _page      = 1;
const PER_PAGE  = 15;
let _unsub = null;

export async function renderProducts(container) {
  container.innerHTML = pageShell({
    title: 'Products / Item Master',
    subtitle: 'Manage your complete product catalog.',
    actions: `
      <button class="btn btn-secondary btn-sm" onclick="exportProducts()">⬇ Export</button>
      <button class="btn btn-primary" onclick="openModal('product-modal')">+ Add Product</button>
    `,
    content: `
      ${searchBar({
        id: 'products',
        placeholder: 'Search by name, SKU, category…',
        filters: [
          { key: 'status', label: 'All Status', options: [{value:'active',label:'Active'},{value:'inactive',label:'Inactive'}] },
          { key: 'category', label: 'All Categories', options: [] },
        ],
        onSearch: 'productSearch',
        onFilter: 'productFilter',
      })}
      <div id="products-table-wrap"></div>
      <div id="products-pagination"></div>
    `,
  });

  document.body.insertAdjacentHTML('beforeend', productModal());
  setupModalClose();
  setupMenuClose();
  registerProductGlobals();

  if (_unsub) _unsub();
  const companyId = AuthState.company?.id;
  const constraints = companyId ? [where('companyId','==',companyId), orderBy('createdAt','desc')] : [orderBy('createdAt','desc')];
  _unsub = dbListen(COLLECTIONS.PRODUCTS, constraints, (data) => {
    _products = data;
    _filtered = [...data];
    renderProductTable();
  });
}

function renderProductTable() {
  const start    = (_page-1)*PER_PAGE;
  const pageData = _filtered.slice(start, start+PER_PAGE);
  const wrap     = document.getElementById('products-table-wrap');
  const pg       = document.getElementById('products-pagination');
  if (!wrap) return;
  document.getElementById('products-count').textContent = `${_filtered.length} product${_filtered.length!==1?'s':''}`;

  wrap.innerHTML = buildTable({
    id: 'products-table',
    columns: [
      { key:'name',        label:'Product',  render: r => avatarCell(r.name, `SKU: ${r.sku||'—'}`, 'var(--brand-accent)','rgba(255,107,53,0.12)') },
      { key:'category',    label:'Category', render: r => `<span style="color:var(--text-secondary)">${escHtml(r.category||'—')}</span>` },
      { key:'unit',        label:'Unit',     render: r => `<span class="badge badge-gray">${escHtml(r.unit||'pcs')}</span>` },
      { key:'sellingPrice',label:'Price',    render: r => `<span style="font-family:var(--font-mono);font-size:12px;">₹${Number(r.sellingPrice||0).toLocaleString('en-IN')}</span>` },
      { key:'costPrice',   label:'Cost',     render: r => `<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">₹${Number(r.costPrice||0).toLocaleString('en-IN')}</span>` },
      { key:'hsn',         label:'HSN/SAC',  render: r => `<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(r.hsn||'—')}</span>` },
      { key:'gstRate',     label:'GST%',     render: r => `<span class="badge badge-blue">${r.gstRate||0}%</span>` },
      { key:'status',      label:'Status',   render: r => badge(r.status||'active') },
      { key:'actions', label:'', sortable:false, render: r => actionsMenu(r.id,[
          {icon:'✏️',label:'Edit',  action:`editProduct('${r.id}')`},
          {icon:'🗑',label:'Delete',action:`deleteProduct('${r.id}')`,danger:true},
        ])
      },
    ],
    rows: pageData,
    emptyMsg: 'No products yet',
  });
  pg.innerHTML = buildPagination({id:'products',total:_filtered.length,page:_page,perPage:PER_PAGE,onChange:'setProductPage'});
}

function productModal() {
  return buildModal({
    id:'product-modal', title:'<span id="product-modal-title">Add Product</span>', size:'lg',
    body:`
      <input type="hidden" id="product-id">
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Product Name <span class="required">*</span></label><input type="text" id="p-name" class="form-input" placeholder="Product name"></div>
        <div class="form-group"><label class="form-label">SKU / Item Code</label>
          <div class="input-wrapper">
            <input type="text" id="p-sku" class="form-input has-icon-right" placeholder="AUTO-GENERATED" style="text-transform:uppercase;">
            <span class="input-icon-right" style="font-size:11px;cursor:pointer;pointer-events:all;" onclick="document.getElementById('p-sku').value='SKU-'+Math.random().toString(36).slice(2,8).toUpperCase()">↺</span>
          </div>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Category</label><input type="text" id="p-category" class="form-input" placeholder="Electronics, FMCG…"></div>
        <div class="form-group"><label class="form-label">Unit of Measure</label>
          <select id="p-unit" class="form-select">
            <option value="pcs">Pieces (pcs)</option><option value="kg">Kilograms (kg)</option><option value="g">Grams (g)</option>
            <option value="l">Litres (l)</option><option value="ml">Millilitres (ml)</option><option value="m">Metres (m)</option>
            <option value="cm">Centimetres (cm)</option><option value="box">Box</option><option value="carton">Carton</option>
            <option value="dozen">Dozen</option><option value="pair">Pair</option><option value="set">Set</option>
          </select>
        </div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">Selling Price (₹) <span class="required">*</span></label><input type="number" id="p-selling" class="form-input" placeholder="0.00" min="0" step="0.01"></div>
        <div class="form-group"><label class="form-label">Cost Price (₹)</label><input type="number" id="p-cost" class="form-input" placeholder="0.00" min="0" step="0.01"></div>
        <div class="form-group"><label class="form-label">MRP (₹)</label><input type="number" id="p-mrp" class="form-input" placeholder="0.00" min="0" step="0.01"></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label class="form-label">HSN / SAC Code</label><input type="text" id="p-hsn" class="form-input" placeholder="1234" maxlength="8"></div>
        <div class="form-group"><label class="form-label">GST Rate (%)</label>
          <select id="p-gst" class="form-select">
            <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option>
            <option value="18" selected>18%</option><option value="28">28%</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Min Reorder Qty</label><input type="number" id="p-reorder" class="form-input" placeholder="10" min="0"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Brand</label><input type="text" id="p-brand" class="form-input" placeholder="Brand name"></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select id="p-status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Barcode</label>
                <div style="display:flex;gap:6px;">
                  <input type="text" id="p-barcode" class="form-input" placeholder="EAN/UPC barcode" style="flex:1;">
                  <button type="button" class="btn btn-ghost btn-sm" onclick="window.scanBarcodeIntoField?.('p-barcode')" title="Scan barcode" style="padding:0 10px;">📷</button>
                </div>
              </div>
              <div class="form-group"><label class="form-label">Product Photo <span style="font-size:10px;font-weight:400;color:var(--text-muted);">Optional</span></label><div id="product-photo-container"></div></div>
        <div class="form-group"><label class="form-label">Track Expiry?</label>
          <select id="p-expiry" class="form-select"><option value="no">No</option><option value="yes">Yes (perishable)</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Description</label><textarea id="p-desc" class="form-textarea" rows="2" placeholder="Product description…"></textarea></div>
    `,
    footer:`<button class="btn btn-secondary" onclick="closeModal('product-modal')">Cancel</button><button class="btn btn-primary" id="product-save-btn" onclick="saveProduct()">Save Product</button>`,
  });
}

function registerProductGlobals() {
  window.scanBarcodeIntoField = async (fieldId) => {
    if (!window.LAMScanner) {
      Toast.info('Scanner', 'Use the camera to scan a barcode and it will fill in automatically.');
      return;
    }
    // Use image scan (file picker) as fallback since modal doesn't have video
    const input = document.createElement('input');
    input.type  = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.onchange = async () => {
      if (!input.files?.[0]) return;
      Toast.info('Scanning…', 'Reading barcode from image…');
      window.LAMScanner.scanImage(
        input.files[0],
        (value) => {
          const field = document.getElementById(fieldId);
          if (field) { field.value = value; Toast.success('Scanned!', value); }
        },
        (err) => Toast.error('Scan failed', err)
      );
    };
    input.click();
  };

  // Init product photo gallery when modal opens
  const _initProductPhoto = () => {
    const el = document.getElementById('product-photo-container');
    if (!el || el._initialized || !window.LAMCamera) return;
    el._initialized = true;
    el._photos = [];
    window.LAMCamera.renderPhotoGallery(el, el._photos, {
      editable: true,
      label: 'Product Photo',
      onAdd: (p) => el._photos.push(p),
    });
  };

  window.productSearch = debounce(async (q)=>{
    if(_products.length>500&&window.LAMWorker){
      try{_filtered=await window.LAMWorker.searchItems(_products,q,['name','sku','category','brand','hsn','barcode'],0.3);}
      catch{_filtered=searchFilter(_products,q,['name','sku','category','brand','hsn','barcode']);}
    } else {
      _filtered=searchFilter(_products,q,['name','sku','category','brand','hsn','barcode']);
    }
    _page=1;renderProductTable();
  },250);
  window.productFilter = (key,val)=>{_filtered=val?_products.filter(p=>p[key]===val):[..._products];_page=1;renderProductTable();};
  window.setProductPage = (p)=>{_page=p;renderProductTable();};
  window.saveProduct = async()=>{
    if(!validateForm([{id:'p-name',label:'Product Name',required:true},{id:'p-selling',label:'Selling Price',required:true}])) return;
    const btn=document.getElementById('product-save-btn'); setLoading(btn,true);
    const id=document.getElementById('product-id').value;
    const data={
      name:document.getElementById('p-name').value.trim(),
      sku:document.getElementById('p-sku').value.trim().toUpperCase()||'SKU-'+genId(),
      category:document.getElementById('p-category').value.trim(),
      unit:document.getElementById('p-unit').value,
      sellingPrice:Number(document.getElementById('p-selling').value)||0,
      costPrice:Number(document.getElementById('p-cost').value)||0,
      mrp:Number(document.getElementById('p-mrp').value)||0,
      hsn:document.getElementById('p-hsn').value.trim(),
      gstRate:Number(document.getElementById('p-gst').value)||18,
      reorderPoint:Number(document.getElementById('p-reorder').value)||0,
      brand:document.getElementById('p-brand').value.trim(),
      status:document.getElementById('p-status').value,
      barcode:document.getElementById('p-barcode').value.trim(),
      trackExpiry:document.getElementById('p-expiry').value==='yes',
      description:document.getElementById('p-desc').value.trim(),
      companyId:AuthState.company?.id||null,
    };
    try{
      if(id){await dbUpdate(COLLECTIONS.PRODUCTS,id,data);Toast.success('Updated',`${data.name} updated.`);}
      else{await dbCreate(COLLECTIONS.PRODUCTS,data);Toast.success('Added',`${data.name} added.`);}
      closeModal('product-modal');
      ['product-id','p-name','p-sku','p-category','p-selling','p-cost','p-mrp','p-hsn','p-reorder','p-brand','p-barcode','p-desc'].forEach(x=>{const e=document.getElementById(x);if(e)e.value='';});
    }catch(e){Toast.error('Failed',e.message);}finally{setLoading(btn,false);}
  };
  window.editProduct=(id)=>{
    const p=_products.find(x=>x.id===id); if(!p) return;
    document.getElementById('product-modal-title').textContent='Edit Product';
    const map={['product-id']:'id',['p-name']:'name',['p-sku']:'sku',['p-category']:'category',['p-unit']:'unit',['p-selling']:'sellingPrice',['p-cost']:'costPrice',['p-mrp']:'mrp',['p-hsn']:'hsn',['p-gst']:'gstRate',['p-reorder']:'reorderPoint',['p-brand']:'brand',['p-barcode']:'barcode',['p-desc']:'description'};
    Object.entries(map).forEach(([elId,field])=>{const e=document.getElementById(elId);if(e)e.value=p[field]||'';});
    document.getElementById('p-status').value=p.status||'active';
    document.getElementById('p-expiry').value=p.trackExpiry?'yes':'no';
    openModal('product-modal');
  };
  window.deleteProduct=async(id)=>{
    const p=_products.find(x=>x.id===id);
    if(!confirm(`Delete "${p?.name}"? This cannot be undone.`)) return;
    try{await dbDelete(COLLECTIONS.PRODUCTS,id);Toast.success('Deleted','Product removed.');}
    catch(e){Toast.error('Failed',e.message);}
  };
  window.exportProducts=()=>{
    if (window.LAMEXCEL) { window.LAMEXCEL.inventory(_products, AuthState.company||{}); return; }
    // CSV fallback when LAMEXCEL not available
    const csv=[['Name','SKU','Category','Unit','Selling Price','Cost Price','HSN','GST%','Status'],..._filtered.map(p=>[p.name,p.sku,p.category,p.unit,p.sellingPrice,p.costPrice,p.hsn,p.gstRate,p.status])].map(r=>r.map(c=>`"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='products_export.csv'; a.click();
    Toast.success('Exported',`${_filtered.length} products exported.`);
  }


// ── Quick Barcode Scan for Inventory ─────────────────────────
window.openQuickScanModal = () => {
  if (!window.LAMScanner) {
    Toast.info('Scanner', 'Barcode scanner engine not loaded. Refresh and try again.');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'quick-scan-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-surface);border-radius:16px;width:100%;max-width:440px;overflow:hidden;">
      <div style="padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-subtle);">
        <div style="font-weight:700;">📷 Barcode Scanner</div>
        <button onclick="window._stopQuickScan?.()" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--text-muted);">✕</button>
      </div>
      <div style="position:relative;background:#000;">
        <video id="qs-video" autoplay playsinline muted style="width:100%;display:block;max-height:260px;object-fit:cover;"></video>
        <canvas id="qs-canvas" style="display:none;"></canvas>
        <!-- Scan line animation -->
        <div style="position:absolute;left:10%;right:10%;top:50%;height:2px;background:rgba(10,132,255,0.8);animation:scan-line 2s linear infinite;"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <div style="width:200px;height:120px;border:2px solid rgba(255,255,255,0.6);border-radius:8px;"></div>
        </div>
      </div>
      <div id="qs-result" style="padding:12px 20px;min-height:52px;">
        <div style="font-size:11px;color:var(--text-muted);text-align:center;">Point camera at barcode to scan</div>
      </div>
      <div style="padding:0 20px 16px;display:flex;gap:8px;">
        <input type="text" id="qs-manual" class="form-input" placeholder="Or type barcode manually…" style="flex:1;" onkeydown="if(event.key==='Enter')window._quickScanLookup?.(this.value)">
        <button class="btn btn-primary" onclick="window._quickScanLookup?.(document.getElementById('qs-manual').value)">Search</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) window._stopQuickScan?.(); });

  // Add scan line CSS
  if (!document.getElementById('scan-line-style')) {
    const style = document.createElement('style');
    style.id = 'scan-line-style';
    style.textContent = `@keyframes scan-line { 0%{top:20%} 50%{top:80%} 100%{top:20%} }`;
    document.head.appendChild(style);
  }

  const video  = modal.querySelector('#qs-video');
  const canvas = modal.querySelector('#qs-canvas');

  window._stopQuickScan = async () => {
    await window.LAMScanner.stopCamera();
    modal.remove();
  };

  window._quickScanLookup = (barcode) => {
    if (!barcode?.trim()) return;
    const code = barcode.trim();
    const found = _products.find(p => p.barcode === code || p.sku === code || p.id === code);
    const resultEl = document.getElementById('qs-result');
    if (!resultEl) return;

    if (found) {
      window.LAMScanner.stopCamera();
      modal.remove();
      Toast.success('Product Found', `${found.name} — Stock: ${found.qty ?? '—'} ${found.unit || ''}`);
      // Open edit modal for that product
      setTimeout(() => window.editProduct?.(found.id), 200);
    } else {
      resultEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg-elevated);border-radius:8px;">
          <span style="font-size:20px;">❓</span>
          <div>
            <div style="font-size:12px;font-weight:600;">Not found: ${code}</div>
            <div style="font-size:10px;color:var(--text-muted);">Add as new product?
              <a href="#" onclick="window._stopQuickScan?.();setTimeout(()=>{ openProductModal(); document.getElementById('p-barcode').value='${code}'; },200);return false;" style="color:var(--brand-primary);">Add</a>
            </div>
          </div>
        </div>`;
    }
  };

  window.LAMScanner.startCamera({
    video,
    canvas,
    facing: 'environment',
    onResult: (value, format) => {
      const resultEl = document.getElementById('qs-result');
      if (resultEl) {
        resultEl.innerHTML = `<div style="font-size:11px;color:var(--brand-secondary);text-align:center;margin-bottom:6px;">✅ Scanned: ${format?.toUpperCase()||'CODE'} — ${value}</div>`;
      }
      window._quickScanLookup(value);
    },
    onError: (err) => {
      const resultEl = document.getElementById('qs-result');
      if (resultEl) resultEl.innerHTML = `<div style="color:var(--brand-danger);font-size:11px;text-align:center;">${err}</div>`;
    },
  });
};
}
