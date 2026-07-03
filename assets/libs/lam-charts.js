// ============================================================
// LAM Charts Engine v1 — Pure Canvas, zero dependency
// Line, Bar, Donut, Area, Sparkline, Heatmap, Gauge, Sankey
// Responsive, animated, interactive (hover tooltips, click)
// ============================================================

const LAMCharts = (() => {

  // ── Brand tokens ─────────────────────────────────────────
  const C = {
    primary:   '#0A84FF', secondary: '#30D158', warning:  '#FFD60A',
    danger:    '#FF453A', purple:    '#BF5AF2', teal:     '#64D2FF',
    orange:    '#FF9F0A', pink:      '#FF375F',
    bg:        '#0F172A', surface:   '#1E293B', muted:    '#94A3B8',
    border:    '#334155', text:      '#F1F5F9', textDim:  '#64748B',
    PALETTE:   ['#0A84FF','#30D158','#FFD60A','#FF453A','#BF5AF2','#64D2FF','#FF9F0A','#FF375F'],
  };

  // ── Base class ────────────────────────────────────────────
  class LAMChart {
    constructor(canvas, opts={}) {
      this.canvas  = canvas;
      this.ctx     = canvas.getContext('2d');
      this.opts    = opts;
      this._raf    = null;
      this._animT  = 0;
      this._tooltip= null;
      this._setupDPI();
      this._setupEvents();
    }

    _setupDPI() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width  = (rect.width  || this.canvas.clientWidth  || 400) * dpr;
      this.canvas.height = (rect.height || this.canvas.clientHeight || 240) * dpr;
      this.ctx.scale(dpr, dpr);
      this.W = this.canvas.width  / dpr;
      this.H = this.canvas.height / dpr;
    }

    _setupEvents() {
      this.canvas.addEventListener('mousemove', e => this._onHover(e));
      this.canvas.addEventListener('mouseleave',() => this._hideTooltip());
    }

    _pad() { return this.opts.padding || { top:20, right:20, bottom:36, left:52 }; }
    _plotW() { const p=this._pad(); return this.W-p.left-p.right; }
    _plotH() { const p=this._pad(); return this.H-p.top-p.bottom; }

    _cssVar(name) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || undefined;
    }

    _resolveColor(name) {
      return this._cssVar(`--${name}`) || C[name] || name;
    }

    animate(duration=600) {
      const start = performance.now();
      const tick  = (now) => {
        this._animT = Math.min(1, (now-start)/duration);
        const eased = 1-Math.pow(1-this._animT, 3); // ease-out-cubic
        this.draw(eased);
        if (this._animT < 1) this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    destroy() { cancelAnimationFrame(this._raf); this._hideTooltip(); }

    _showTooltip(x, y, html) {
      this._hideTooltip();
      const tt = document.createElement('div');
      tt.id = 'lam-chart-tooltip';
      tt.style.cssText = `position:fixed;z-index:9999;background:rgba(15,23,42,0.95);color:#fff;
        padding:8px 12px;border-radius:8px;font-size:12px;pointer-events:none;
        box-shadow:0 4px 16px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);
        min-width:120px;max-width:220px;line-height:1.6;`;
      tt.innerHTML = html;
      document.body.appendChild(tt);
      this._tooltip = tt;
      this._moveTooltip(x, y);
    }

    _moveTooltip(x, y) {
      if (!this._tooltip) return;
      const tt = this._tooltip;
      const rect = this.canvas.getBoundingClientRect();
      const tx = rect.left + x + 12;
      const ty = rect.top  + y - 8;
      tt.style.left = `${Math.min(tx, window.innerWidth-230)}px`;
      tt.style.top  = `${Math.max(ty - tt.offsetHeight, 8)}px`;
    }

    _hideTooltip() {
      if (this._tooltip) { this._tooltip.remove(); this._tooltip=null; }
    }

    _onHover() {}

    _fmtVal(v, fmt) {
      if (!fmt) return v?.toLocaleString?.('en-IN') ?? v;
      if (fmt === 'currency') return `₹${Number(v).toLocaleString('en-IN')}`;
      if (fmt === 'percent')  return `${v}%`;
      if (typeof fmt === 'function') return fmt(v);
      return v;
    }

    _grid(min, max, count=5) {
      const range = max-min || 1;
      const raw   = range/(count-1);
      const mag   = Math.pow(10, Math.floor(Math.log10(raw)));
      const nice  = [1,2,2.5,5,10].map(f=>f*mag).find(f=>f>=raw) || raw;
      const lo    = Math.floor(min/nice)*nice;
      const hi    = Math.ceil(max/nice)*nice;
      const ticks = [];
      for (let v=lo; v<=hi+nice*0.01; v+=nice) ticks.push(Math.round(v*1000)/1000);
      return ticks;
    }

    _drawAxes(ticks, labels, fmt) {
      const ctx=this.ctx, p=this._pad(), W=this._plotW(), H=this._plotH();
      const minV=ticks[0], maxV=ticks[ticks.length-1], range=maxV-minV||1;

      ctx.save();
      ctx.strokeStyle = C.border;
      ctx.lineWidth   = 1;
      ctx.setLineDash([4,4]);
      ctx.font        = '10px Arial';
      ctx.fillStyle   = C.textDim;
      ctx.textAlign   = 'right';

      // Y axis gridlines + labels
      ticks.forEach(tick => {
        const y = p.top + H - (tick-minV)/range*H;
        ctx.beginPath(); ctx.moveTo(p.left, y); ctx.lineTo(p.left+W, y); ctx.stroke();
        ctx.fillText(this._fmtVal(tick,fmt), p.left-6, y+4);
      });

      // X axis labels
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.fillStyle = C.textDim;
      labels.forEach((lbl,i) => {
        const x = p.left + (i/(labels.length-1||1))*W;
        ctx.fillText(String(lbl).slice(0,8), x, p.top+H+16);
      });

      ctx.restore();
    }
  }

  // ── Line Chart ────────────────────────────────────────────
  class LineChart extends LAMChart {
    constructor(canvas, { series, labels, opts={} }) {
      super(canvas, opts);
      this.series = series; // [{label, data, color}]
      this.labels = labels;
      this._hoverIdx = -1;
    }

    draw(progress=1) {
      const ctx=this.ctx, p=this._pad(), W=this._plotW(), H=this._plotH();
      ctx.clearRect(0,0,this.W,this.H);

      const allVals = this.series.flatMap(s=>s.data);
      const minV    = Math.min(0, ...allVals);
      const maxV    = Math.max(1, ...allVals);
      const ticks   = this._grid(minV, maxV);
      this._drawAxes(ticks, this.labels, this.opts.fmt);

      const n      = this.labels.length;
      const tMin   = ticks[0], tMax = ticks[ticks.length-1], range = tMax-tMin||1;
      const xStep  = n > 1 ? W/(n-1) : W;

      this.series.forEach((s,si) => {
        const color = s.color || C.PALETTE[si%C.PALETTE.length];
        const pts   = s.data.map((v,i)=>({
          x: p.left + i*xStep,
          y: p.top + H - (v-tMin)/range*H,
        }));
        const drawn = Math.ceil(pts.length * progress);

        // Area fill
        if (this.opts.area !== false) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(pts[0].x, p.top+H);
          pts.slice(0,drawn).forEach(pt => ctx.lineTo(pt.x, pt.y));
          ctx.lineTo(pts[Math.min(drawn-1,pts.length-1)].x, p.top+H);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0,p.top,0,p.top+H);
          grad.addColorStop(0, color+'33');
          grad.addColorStop(1, color+'05');
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.restore();
        }

        // Line
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = this.opts.lineWidth || 2.5;
        ctx.lineJoin    = 'round';
        ctx.lineCap     = 'round';
        ctx.beginPath();
        pts.slice(0,drawn).forEach((pt,i)=> i===0 ? ctx.moveTo(pt.x,pt.y) : ctx.lineTo(pt.x,pt.y));
        ctx.stroke();

        // Dots
        pts.slice(0,drawn).forEach((pt,i) => {
          const isHover = this._hoverIdx===i;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isHover?5:3, 0, Math.PI*2);
          ctx.fillStyle   = color;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth   = 2;
          ctx.fill();
          if (isHover) ctx.stroke();
        });
        ctx.restore();
      });

      // Legend
      if (this.series.length > 1) {
        ctx.save();
        ctx.font = '11px Arial';
        let lx = p.left;
        this.series.forEach((s,i) => {
          const color = s.color || C.PALETTE[i%C.PALETTE.length];
          ctx.fillStyle = color;
          ctx.fillRect(lx, 4, 12, 12);
          ctx.fillStyle = C.textDim;
          ctx.fillText(s.label||`Series ${i+1}`, lx+16, 14);
          lx += ctx.measureText(s.label||`Series ${i+1}`).width + 32;
        });
        ctx.restore();
      }
    }

    _onHover(e) {
      const rect = this.canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const p    = this._pad();
      const W    = this._plotW();
      const n    = this.labels.length;
      const xStep= n>1 ? W/(n-1) : W;
      const idx  = Math.round((mx-p.left)/xStep);
      if (idx>=0 && idx<n && idx!==this._hoverIdx) {
        this._hoverIdx = idx;
        this.draw(1);
        const lines = this.series.map(s => `<div style="color:${s.color||C.PALETTE[0]}">● ${s.label||''}: ${this._fmtVal(s.data[idx],this.opts.fmt)}</div>`).join('');
        this._showTooltip(mx, e.clientY - rect.top, `<div style="font-weight:600;margin-bottom:4px;">${this.labels[idx]}</div>${lines}`);
        this._moveTooltip(mx, e.clientY-rect.top);
      }
    }
  }

  // ── Bar Chart ─────────────────────────────────────────────
  class BarChart extends LAMChart {
    constructor(canvas, { labels, datasets, opts={} }) {
      super(canvas, opts);
      this.labels   = labels;
      this.datasets = datasets; // [{label, data, color}]
      this._hoverIdx= -1;
    }

    draw(progress=1) {
      const ctx=this.ctx, p=this._pad(), W=this._plotW(), H=this._plotH();
      ctx.clearRect(0,0,this.W,this.H);

      const allVals = this.datasets.flatMap(d=>d.data);
      const maxV    = Math.max(1,...allVals);
      const ticks   = this._grid(0, maxV);
      this._drawAxes(ticks, this.labels, this.opts.fmt);

      const n     = this.labels.length;
      const ds    = this.datasets.length;
      const gap   = W/n;
      const bw    = (gap*0.75)/ds;
      const tMax  = ticks[ticks.length-1]||1;

      this.datasets.forEach((dataset,di) => {
        const color = dataset.color || C.PALETTE[di%C.PALETTE.length];
        dataset.data.forEach((val,i) => {
          const bH  = (val/tMax)*H*progress;
          const x   = p.left + i*gap + gap*0.125 + di*bw;
          const y   = p.top + H - bH;
          const isH = this._hoverIdx===i;

          ctx.save();
          ctx.fillStyle = isH ? color+'EE' : color+'BB';
          ctx.beginPath();
          ctx.roundRect?.(x,y,bw-2,bH,3) || ctx.rect(x,y,bw-2,bH);
          ctx.fill();

          // Value label on top
          if (bH > 16 || isH) {
            ctx.fillStyle = C.text;
            ctx.font      = `10px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText(this._fmtVal(val,this.opts.fmt), x+bw/2-1, y-4);
          }
          ctx.restore();
        });
      });
    }

    _onHover(e) {
      const rect  = this.canvas.getBoundingClientRect();
      const mx    = e.clientX - rect.left;
      const p     = this._pad();
      const W     = this._plotW();
      const n     = this.labels.length;
      const idx   = Math.floor((mx-p.left)/(W/n));
      if (idx>=0 && idx<n && idx!==this._hoverIdx) {
        this._hoverIdx = idx;
        this.draw(1);
        const lines = this.datasets.map(d=>`<div style="color:${d.color||C.PALETTE[0]}">● ${d.label||''}: ${this._fmtVal(d.data[idx],this.opts.fmt)}</div>`).join('');
        this._showTooltip(mx, e.clientY-rect.top, `<div style="font-weight:600;margin-bottom:4px;">${this.labels[idx]}</div>${lines}`);
      }
    }
  }

  // ── Donut Chart ───────────────────────────────────────────
  class DonutChart extends LAMChart {
    constructor(canvas, { labels, values, colors, opts={} }) {
      super(canvas, opts);
      this.labels = labels;
      this.values = values;
      this.colors = colors || C.PALETTE;
      this._hoverIdx = -1;
    }

    draw(progress=1) {
      const ctx  = this.ctx;
      const cx   = this.W/2, cy=this.H/2;
      const r    = Math.min(cx,cy)*0.75;
      const inner= r*0.55;
      ctx.clearRect(0,0,this.W,this.H);

      const total  = this.values.reduce((a,b)=>a+b,0)||1;
      let   angle  = -Math.PI/2;

      this.values.forEach((val,i)=>{
        const sweep = (val/total)*Math.PI*2*progress;
        const isH   = this._hoverIdx===i;
        const rr    = r*(isH?1.06:1);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rr, angle, angle+sweep);
        ctx.closePath();
        ctx.fillStyle   = this.colors[i%this.colors.length];
        ctx.shadowColor = isH ? 'rgba(0,0,0,0.4)' : 'transparent';
        ctx.shadowBlur  = isH ? 8 : 0;
        ctx.fill();
        ctx.restore();

        // Segment label for large segments
        if (val/total > 0.08) {
          const midA = angle + sweep/2;
          const lx   = cx + Math.cos(midA)*(r*0.72);
          const ly   = cy + Math.sin(midA)*(r*0.72);
          ctx.save();
          ctx.fillStyle = '#fff';
          ctx.font      = `bold 11px Arial`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(val/total*100)}%`, lx, ly);
          ctx.restore();
        }

        angle += sweep;
      });

      // Inner circle (donut hole)
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, Math.PI*2);
      ctx.fillStyle = this.opts.bgColor || getComputedStyle(document.documentElement).getPropertyValue('--bg-surface') || '#1E293B';
      ctx.fill();

      // Center text
      if (this.opts.centerText) {
        ctx.fillStyle   = C.text;
        ctx.font        = `bold 18px Arial`;
        ctx.textAlign   = 'center';
        ctx.textBaseline= 'middle';
        ctx.fillText(this.opts.centerText, cx, cy-8);
        if (this.opts.centerSubtext) {
          ctx.font      = `11px Arial`;
          ctx.fillStyle = C.textDim;
          ctx.fillText(this.opts.centerSubtext, cx, cy+12);
        }
      }
      ctx.restore();

      // Legend
      const legendX = 8;
      let   legendY = this.H - this.labels.length*18 - 4;
      ctx.save();
      ctx.font = '11px Arial';
      this.labels.forEach((lbl,i) => {
        ctx.fillStyle = this.colors[i%this.colors.length];
        ctx.fillRect(legendX, legendY, 10, 10);
        ctx.fillStyle = C.textDim;
        ctx.textAlign = 'left';
        const vLabel = this.opts.fmt ? this._fmtVal(this.values[i],this.opts.fmt) : this.values[i]?.toLocaleString?.('en-IN');
        ctx.fillText(`${lbl}: ${vLabel}`, legendX+14, legendY+9);
        legendY += 18;
      });
      ctx.restore();
    }

    _onHover(e) {
      const rect = this.canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left - this.W/2;
      const my   = e.clientY - rect.top  - this.H/2;
      const dist = Math.sqrt(mx*mx+my*my);
      const r    = Math.min(this.W/2,this.H/2)*0.75;
      const inner= r*0.55;
      if (dist < inner || dist > r) { this._hoverIdx=-1; this.draw(1); this._hideTooltip(); return; }
      const angle = (Math.atan2(my,mx)+Math.PI*2.5)%(Math.PI*2);
      const total = this.values.reduce((a,b)=>a+b,0)||1;
      let cum=0, idx=-1;
      for (let i=0;i<this.values.length;i++) {
        cum += this.values[i]/total*Math.PI*2;
        if (angle <= cum) { idx=i; break; }
      }
      if (idx>=0 && idx!==this._hoverIdx) {
        this._hoverIdx=idx;
        this.draw(1);
        this._showTooltip(e.clientX-rect.left, e.clientY-rect.top,
          `<div style="font-weight:600;">${this.labels[idx]}</div><div>${this._fmtVal(this.values[idx],this.opts.fmt)} (${Math.round(this.values[idx]/total*100)}%)</div>`);
      }
    }
  }

  // ── Gauge Chart ───────────────────────────────────────────
  class GaugeChart extends LAMChart {
    constructor(canvas, { value, max=100, label, thresholds, opts={} }) {
      super(canvas, opts);
      this.value      = value;
      this.max        = max;
      this.label      = label;
      this.thresholds = thresholds || [
        { at:40, color:C.danger  },
        { at:70, color:C.warning },
        { at:100,color:C.secondary },
      ];
    }

    draw(progress=1) {
      const ctx=this.ctx, cx=this.W/2, cy=this.H*0.72;
      const r  = Math.min(this.W/2,this.H)*0.7;
      const val= Math.min(this.value,this.max)*progress;
      ctx.clearRect(0,0,this.W,this.H);

      // Background arc
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx,cy,r,Math.PI,0);
      ctx.strokeStyle = C.border;
      ctx.lineWidth   = r*0.2;
      ctx.lineCap     = 'round';
      ctx.stroke();

      // Value arc
      const pct    = val/this.max;
      const color  = this.thresholds.findLast(t=>pct*100>=t.at-(100/this.thresholds.length))?.color || C.primary;
      ctx.beginPath();
      ctx.arc(cx,cy,r,Math.PI,Math.PI+pct*Math.PI);
      ctx.strokeStyle = color;
      ctx.lineWidth   = r*0.2;
      ctx.stroke();
      ctx.restore();

      // Center text
      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = C.text;
      ctx.font         = `bold ${r*0.35}px Arial`;
      ctx.fillText(this.opts.fmt ? this._fmtVal(val,this.opts.fmt) : Math.round(val), cx, cy-r*0.05);
      if (this.label) {
        ctx.font      = `12px Arial`;
        ctx.fillStyle = C.textDim;
        ctx.fillText(this.label, cx, cy+r*0.22);
      }
      ctx.restore();
    }
  }

  // ── Sparkline ─────────────────────────────────────────────
  function sparkline(canvas, data, opts={}) {
    const ctx  = canvas.getContext('2d');
    const W    = canvas.width, H = canvas.height;
    const min  = Math.min(...data), max = Math.max(...data)||1;
    const color= opts.color || C.primary;
    ctx.clearRect(0,0,W,H);
    ctx.beginPath();
    data.forEach((v,i) => {
      const x = i/(data.length-1||1)*W;
      const y = H - (v-min)/(max-min||1)*H*0.85 - H*0.075;
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth   = opts.lineWidth||2;
    ctx.lineJoin    = 'round';
    ctx.stroke();
    // Last dot
    const lx = W, ly = H-(data[data.length-1]-min)/(max-min||1)*H*0.85-H*0.075;
    ctx.beginPath(); ctx.arc(lx-2,ly,3,0,Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
  }

  // ── Heatmap (calendar) ────────────────────────────────────
  function heatmap(canvas, data, opts={}) {
    // data: [{date:'2024-01-15', value:42}, ...]
    const ctx = canvas.getContext('2d');
    const W=canvas.width, H=canvas.height;
    const cellSize = Math.floor(W/53);
    ctx.clearRect(0,0,W,H);

    const maxVal = Math.max(1,...data.map(d=>d.value));
    const byDate = {};
    data.forEach(d=>{ byDate[d.date]=d.value; });

    const year = opts.year || new Date().getFullYear();
    const start= new Date(year,0,1);
    const dow   = start.getDay();

    for (let w=0;w<53;w++) {
      for (let d=0;d<7;d++) {
        const dayN = w*7+d-dow;
        if (dayN<0||dayN>=366) continue;
        const date = new Date(year,0,dayN+1);
        const key  = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
        const val  = byDate[key]||0;
        const intensity = val/maxVal;
        const alpha = 0.1+intensity*0.9;
        const color = opts.color||C.primary;
        ctx.fillStyle = val ? color+(Math.round(alpha*255).toString(16).padStart(2,'0')) : C.surface;
        ctx.fillRect(w*cellSize+w, d*cellSize+d, cellSize-1, cellSize-1);
      }
    }
  }

  // ── Factory ───────────────────────────────────────────────
  function create(type, canvas, config) {
    if (!canvas) return null;
    const chart = (() => {
      switch(type) {
        case 'line':   return new LineChart(canvas, config);
        case 'bar':    return new BarChart(canvas, config);
        case 'donut':  return new DonutChart(canvas, config);
        case 'gauge':  return new GaugeChart(canvas, config);
        default:       return null;
      }
    })();
    if (chart) chart.animate(config?.opts?.animDuration||600);
    return chart;
  }

  return { LineChart, BarChart, DonutChart, GaugeChart, sparkline, heatmap, create };

})();

window.LAMCharts = LAMCharts;
