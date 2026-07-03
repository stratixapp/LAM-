// ============================================================
// LAM ML Engine v1 — Pure JS machine learning, zero dependency
// Demand forecasting, delay prediction, anomaly detection,
// price optimization, cash flow prediction — all client-side.
// No API calls. No data leaves the device.
// ============================================================

const LAMML = (() => {

  // ── Linear Regression ─────────────────────────────────────
  // Ordinary Least Squares — fast, interpretable, no overfit on small data
  function linearRegression(xs, ys) {
    const n   = xs.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
    const xMean = xs.reduce((a,b)=>a+b,0)/n;
    const yMean = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for (let i=0;i<n;i++) { num+=(xs[i]-xMean)*(ys[i]-yMean); den+=(xs[i]-xMean)**2; }
    const slope     = den ? num/den : 0;
    const intercept = yMean - slope*xMean;
    // R-squared
    let ssTot=0, ssRes=0;
    for (let i=0;i<n;i++) { ssTot+=(ys[i]-yMean)**2; ssRes+=(ys[i]-(slope*xs[i]+intercept))**2; }
    const r2 = ssTot ? 1 - ssRes/ssTot : 0;
    return { slope, intercept, r2, predict: x => slope*x+intercept };
  }

  // ── Exponential Smoothing (Holt-Winters) ──────────────────
  // Best for seasonal time series (monthly demand)
  function holtWinters(data, alpha=0.3, beta=0.1, gamma=0.2, period=12, horizon=3) {
    if (data.length < period*2) {
      // Fallback to simple exponential smoothing
      return simpleExpSmoothing(data, alpha, horizon);
    }
    const n = data.length;
    // Initialize
    let L = data.slice(0, period).reduce((a,b)=>a+b,0)/period;
    let T = (data.slice(period, period*2).reduce((a,b)=>a+b,0)/period - L) / period;
    const S = [];
    for (let i=0;i<period;i++) S.push(data[i]/L);

    const smoothed = [];
    for (let t=0;t<n;t++) {
      const s  = t >= period ? S[t % period] : 1;
      const Lp = L, Tp = T;
      L = alpha * (data[t]/s) + (1-alpha)*(Lp+Tp);
      T = beta  * (L-Lp)     + (1-beta)*Tp;
      S[t % period] = gamma * (data[t]/L) + (1-gamma)*s;
      smoothed.push((Lp+Tp)*s);
    }
    // Forecast
    const forecast = [];
    for (let h=1;h<=horizon;h++) {
      forecast.push(Math.max(0, Math.round((L+h*T)*S[(n+h-1)%period])));
    }
    return { smoothed, forecast, level: L, trend: T, seasonal: S };
  }

  function simpleExpSmoothing(data, alpha=0.3, horizon=3) {
    if (!data.length) return { smoothed:[], forecast:[] };
    let S = data[0];
    const smoothed = [S];
    for (let i=1;i<data.length;i++) { S = alpha*data[i]+(1-alpha)*S; smoothed.push(S); }
    const forecast = Array(horizon).fill(Math.max(0, Math.round(S)));
    return { smoothed, forecast, level: S };
  }

  // ── Moving Average ────────────────────────────────────────
  function movingAverage(data, window=3) {
    const result = [];
    for (let i=0;i<data.length;i++) {
      const slice = data.slice(Math.max(0,i-window+1), i+1);
      result.push(slice.reduce((a,b)=>a+b,0)/slice.length);
    }
    return result;
  }

  // ── Anomaly Detection (IQR + Z-score) ────────────────────
  function detectAnomalies(values, opts={}) {
    const { method='iqr', threshold=2.5 } = opts;
    if (values.length < 4) return values.map(()=>false);
    const sorted = [...values].sort((a,b)=>a-b);
    if (method === 'iqr') {
      const q1  = sorted[Math.floor(sorted.length*0.25)];
      const q3  = sorted[Math.floor(sorted.length*0.75)];
      const iqr = q3-q1;
      const lo  = q1 - 1.5*iqr;
      const hi  = q3 + 1.5*iqr;
      return values.map(v => v < lo || v > hi);
    } else {
      const mean  = values.reduce((a,b)=>a+b,0)/values.length;
      const std   = Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length);
      return values.map(v => std ? Math.abs((v-mean)/std) > threshold : false);
    }
  }

  // ── K-Means clustering ────────────────────────────────────
  function kMeans(points, k=3, maxIter=50) {
    if (points.length < k) return { clusters: points.map((_,i)=>i%k), centroids: points.slice(0,k) };
    // Random init
    let centroids = points.slice().sort(()=>Math.random()-0.5).slice(0,k);
    let clusters  = new Array(points.length).fill(0);
    for (let iter=0;iter<maxIter;iter++) {
      // Assign
      let changed = false;
      for (let i=0;i<points.length;i++) {
        let minDist=Infinity, best=0;
        for (let j=0;j<k;j++) {
          const d = _euclidean(points[i], centroids[j]);
          if (d < minDist) { minDist=d; best=j; }
        }
        if (clusters[i] !== best) { clusters[i]=best; changed=true; }
      }
      if (!changed) break;
      // Update centroids
      centroids = Array.from({length:k},(_,j)=>{
        const members = points.filter((_,i)=>clusters[i]===j);
        if (!members.length) return centroids[j];
        return members[0].map((_,d) => members.reduce((s,p)=>s+p[d],0)/members.length);
      });
    }
    return { clusters, centroids };
  }

  function _euclidean(a, b) {
    return Math.sqrt(a.reduce((s,v,i)=>s+(v-b[i])**2,0));
  }

  // ── Demand Forecasting ────────────────────────────────────

  /**
   * Forecast product demand for next N months
   * @param {Object} product
   * @param {Array} salesHistory - [{month:'2024-01', qty:120}, ...]
   * @param {number} horizon - months to forecast (default 3)
   */
  function forecastDemand(product, salesHistory, horizon=3) {
    if (!salesHistory.length) {
      return {
        product:     product.name,
        productId:   product.id,
        horizon,
        forecast:    Array(horizon).fill(0),
        confidence:  0,
        method:      'no-data',
        trend:       'unknown',
        reorderPoint: Number(product.reorderQty || product.reorderPoint || 0),
        currentStock: Number(product.qty || 0),
        daysOfStock:  0,
        recommendation: 'Add sales data to enable forecasting.',
      };
    }

    // Sort and extract monthly quantities
    const sorted = [...salesHistory].sort((a,b)=>a.month>b.month?1:-1);
    const qtys   = sorted.map(s => Number(s.qty) || 0);

    // Choose method based on data volume
    let forecast, confidence, method, r2=0;
    if (qtys.length >= 24) {
      // Enough for Holt-Winters seasonal
      const hw = holtWinters(qtys, 0.3, 0.1, 0.2, 12, horizon);
      forecast   = hw.forecast;
      confidence = Math.min(85, 50 + qtys.length);
      method     = 'holt-winters';
    } else if (qtys.length >= 6) {
      // Linear regression on index
      const xs  = qtys.map((_,i)=>i);
      const reg = linearRegression(xs, qtys);
      forecast  = Array.from({length:horizon},(_,i)=>Math.max(0,Math.round(reg.predict(qtys.length+i))));
      r2        = Math.max(0, reg.r2);
      confidence= Math.min(80, 40 + qtys.length*2 + r2*20);
      method    = 'linear-regression';
    } else {
      // Simple exponential smoothing
      const ses = simpleExpSmoothing(qtys, 0.4, horizon);
      forecast  = ses.forecast;
      confidence= Math.min(65, 25 + qtys.length*5);
      method    = 'exponential-smoothing';
    }

    // Trend detection
    const recentAvg = qtys.slice(-3).reduce((a,b)=>a+b,0)/Math.min(3,qtys.length);
    const olderAvg  = qtys.slice(0,3).reduce((a,b)=>a+b,0)/Math.min(3,qtys.length);
    const trendPct  = olderAvg ? (recentAvg-olderAvg)/olderAvg*100 : 0;
    const trend     = trendPct>10?'rising':trendPct<-10?'falling':'stable';

    // Anomaly detection
    const anomalies    = detectAnomalies(qtys);
    const anomalyCount = anomalies.filter(Boolean).length;

    // Stock days calculation
    const avgMonthlyDemand = forecast.reduce((a,b)=>a+b,0)/horizon || 1;
    const avgDailyDemand   = avgMonthlyDemand/30;
    const currentStock     = Number(product.qty || 0);
    const daysOfStock      = avgDailyDemand ? Math.round(currentStock/avgDailyDemand) : 999;
    const reorderPoint     = Number(product.reorderQty||product.reorderPoint||0) || Math.round(avgMonthlyDemand*1.5);

    // Safety stock (1.65σ for 95% service level)
    const stdDev      = Math.sqrt(qtys.reduce((s,v)=>s+(v-recentAvg)**2,0)/Math.max(1,qtys.length));
    const safetyStock = Math.round(1.65*stdDev);

    // Recommendation
    let recommendation = '';
    const totalForecast = forecast.reduce((a,b)=>a+b,0);
    if (daysOfStock < 14) recommendation = `⚠️ Critical: only ${daysOfStock} days of stock. Order ${totalForecast+safetyStock} units immediately.`;
    else if (daysOfStock < 30) recommendation = `🟡 Order soon: ${daysOfStock} days remaining. Suggested order: ${totalForecast} units.`;
    else if (trend === 'rising') recommendation = `📈 Rising demand. Consider increasing safety stock by 20%.`;
    else recommendation = `✅ Stock healthy for ${daysOfStock} days. Next review in ${Math.min(daysOfStock-14,30)} days.`;

    return {
      product:       product.name,
      productId:     product.id,
      category:      product.category,
      horizon,
      forecast,
      forecastLabels: _nextMonthLabels(horizon),
      confidence:    Math.round(confidence),
      method,
      r2:            Math.round(r2*100)/100,
      trend,
      trendPct:      Math.round(trendPct),
      reorderPoint,
      safetyStock,
      currentStock,
      daysOfStock,
      anomalyCount,
      avgMonthlyDemand: Math.round(avgMonthlyDemand),
      recommendation,
    };
  }

  function _nextMonthLabels(n) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const result = [];
    const d = new Date();
    for (let i=1;i<=n;i++) {
      const m = new Date(d.getFullYear(), d.getMonth()+i, 1);
      result.push(`${months[m.getMonth()]} ${m.getFullYear()}`);
    }
    return result;
  }

  // ── Delay Predictor ───────────────────────────────────────

  /**
   * Predict delivery delay risk for a trip
   * @param {Object} trip
   * @param {Object} context - { driver, vehicle, historicalTrips, weather }
   */
  function predictDelay(trip, context={}) {
    const { driver, vehicle, historicalTrips=[] } = context;
    const features = [];
    let delayProb  = 0.1; // base 10%

    // Feature 1: driver delay history
    if (driver) {
      const driverHistory = historicalTrips.filter(t=>t.driverId===trip.driverId);
      if (driverHistory.length > 0) {
        const delayRate = driverHistory.filter(t=>t.delayed||t.status==='delayed').length/driverHistory.length;
        delayProb += delayRate * 0.4;
        features.push({ name:'Driver delay history', value:`${Math.round(delayRate*100)}%`, impact: delayRate*0.4 });
      }
    }

    // Feature 2: vehicle maintenance
    if (vehicle) {
      const kmOverdue = Number(vehicle.currentKm||0) - Number(vehicle.nextServiceKm||Infinity);
      if (kmOverdue > 0) {
        const impact = Math.min(0.25, kmOverdue/5000*0.1);
        delayProb += impact;
        features.push({ name:'Vehicle overdue service', value:`+${Math.round(kmOverdue)}km`, impact });
      }
    }

    // Feature 3: distance
    const dist = Number(trip.distanceKm||trip.distance||0);
    if (dist > 800) { delayProb+=0.2; features.push({ name:'Very long route', value:`${dist}km`, impact:0.2 }); }
    else if (dist > 400) { delayProb+=0.1; features.push({ name:'Long route', value:`${dist}km`, impact:0.1 }); }

    // Feature 4: time of day departure
    if (trip.departureTime) {
      const h = parseInt(trip.departureTime.split(':')[0]);
      if (h >= 7 && h <= 10) { delayProb+=0.1; features.push({ name:'Rush hour departure', value:trip.departureTime, impact:0.1 }); }
    }

    // Feature 5: load weight
    const weight = Number(trip.loadWeight||trip.weight||0);
    if (weight > 15000) { delayProb+=0.1; features.push({ name:'Heavy load', value:`${weight}kg`, impact:0.1 }); }

    // Feature 6: historical route performance
    const sameRoute = historicalTrips.filter(t=>
      t.origin===trip.origin && t.destination===trip.destination
    );
    if (sameRoute.length >= 3) {
      const routeDelayRate = sameRoute.filter(t=>t.delayed).length/sameRoute.length;
      if (routeDelayRate > 0.2) {
        delayProb += routeDelayRate*0.2;
        features.push({ name:`Route delay history`, value:`${Math.round(routeDelayRate*100)}%`, impact:routeDelayRate*0.2 });
      }
    }

    delayProb = Math.min(0.95, delayProb);

    const risk = delayProb >= 0.6 ? 'high' : delayProb >= 0.35 ? 'medium' : 'low';
    const riskColor = { high:'#FF453A', medium:'#FFD60A', low:'#30D158' }[risk];

    // ETA with buffer
    const etaBuffer = risk==='high' ? 0.25 : risk==='medium' ? 0.12 : 0.05;
    const baseDuration = dist ? Math.round(dist/60*60) : 0; // ~60kmph avg
    const predictedDuration = Math.round(baseDuration*(1+etaBuffer));

    return {
      tripId:    trip.id,
      tripNumber:trip.tripNumber || trip.tripId,
      risk,
      riskColor,
      delayProbability: Math.round(delayProb*100),
      features: features.sort((a,b)=>b.impact-a.impact),
      etaBufferPct: Math.round(etaBuffer*100),
      baseDurationMin: baseDuration,
      predictedDurationMin: predictedDuration,
      recommendation: risk==='high'
        ? 'Assign backup driver or reschedule. High delay risk.'
        : risk==='medium'
        ? 'Monitor closely. Add 2-3 hour buffer to ETA.'
        : 'On-time delivery expected.',
    };
  }

  // ── Cash Flow Predictor ───────────────────────────────────

  /**
   * Predict next 3 months cash flow
   * @param {Array} invoices
   * @param {Array} expenses
   * @param {Array} payments
   */
  function predictCashFlow(invoices, expenses, payments, horizon=3) {
    const now = new Date();

    // Historical monthly revenue
    const revenueByMonth = {};
    payments.forEach(p => {
      const m = p.date ? p.date.slice(0,7) : null;
      if (m) revenueByMonth[m] = (revenueByMonth[m]||0) + Number(p.amount||0);
    });

    // Historical monthly expenses
    const expByMonth = {};
    expenses.forEach(e => {
      const m = e.date ? e.date.slice(0,7) : null;
      if (m) expByMonth[m] = (expByMonth[m]||0) + Number(e.amount||0);
    });

    // Get last 6 months
    const months6 = Array.from({length:6},(_,i)=>{
      const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    });

    const revData = months6.map(m => revenueByMonth[m]||0);
    const expData = months6.map(m => expByMonth[m]||0);

    // Forecast
    const revForecast = revData.some(v=>v>0)
      ? simpleExpSmoothing(revData, 0.4, horizon).forecast
      : Array(horizon).fill(0);
    const expForecast = expData.some(v=>v>0)
      ? simpleExpSmoothing(expData, 0.4, horizon).forecast
      : Array(horizon).fill(0);

    // Outstanding receivables (invoices due within forecast period)
    const outstanding = invoices
      .filter(i => i.paymentStatus !== 'paid' && i.dueDate)
      .reduce((s,i) => s + Number(i.totalAmount||0), 0);

    const labels = _nextMonthLabels(horizon);
    const cashFlow = labels.map((label,i) => ({
      label,
      revenue:  revForecast[i] || 0,
      expenses: expForecast[i] || 0,
      net:      (revForecast[i]||0) - (expForecast[i]||0),
    }));

    const totalNet = cashFlow.reduce((s,m)=>s+m.net,0);

    return {
      cashFlow,
      outstanding,
      totalNetForecast: totalNet,
      status: totalNet >= 0 ? 'positive' : 'negative',
      recommendation: totalNet < 0
        ? `⚠️ Projected cash deficit of ₹${Math.abs(totalNet).toLocaleString('en-IN')} over ${horizon} months. Review expenses.`
        : `✅ Positive cash flow of ₹${totalNet.toLocaleString('en-IN')} projected over ${horizon} months.`,
    };
  }

  // ── Price Optimization ────────────────────────────────────

  /**
   * Suggest optimal price for a product
   * @param {Object} product
   * @param {Array} salesHistory - [{price, qty, month}]
   * @param {Object} context - { competitors, costPrice }
   */
  function optimizePrice(product, salesHistory, context={}) {
    const { costPrice = Number(product.costPrice||0), margin = 0.3 } = context;
    const currentPrice = Number(product.sellingPrice||product.price||0);

    if (!salesHistory.length || !costPrice) {
      return {
        currentPrice,
        suggestedPrice: currentPrice || Math.round(costPrice*(1+margin)),
        minPrice:       Math.round(costPrice*1.05),
        confidence:     0,
        reason:         'Insufficient data for optimization.',
      };
    }

    // Price elasticity estimation using regression
    const prices = salesHistory.map(s => Number(s.price||currentPrice));
    const qtys   = salesHistory.map(s => Number(s.qty||0));

    const reg = linearRegression(prices, qtys);
    const elasticity = reg.slope < 0 ? Math.abs(reg.slope * currentPrice / (qtys.reduce((a,b)=>a+b,0)/qtys.length)) : 0;

    // Revenue maximization: dRevenue/dPrice = qty + price*(dQty/dPrice) = 0
    // Optimal price = -qty/(2*slope) if linear demand
    let optimalPrice = currentPrice;
    if (reg.slope < 0) {
      optimalPrice = Math.round(-reg.intercept / (2*reg.slope));
      // Constrain within 20% of current price
      optimalPrice = Math.max(currentPrice*0.8, Math.min(currentPrice*1.2, optimalPrice));
    }

    const minPrice  = Math.round(costPrice*1.05);
    const suggested = Math.max(minPrice, optimalPrice);
    const confidence= Math.min(80, 30+salesHistory.length*5+Math.abs(reg.r2)*20);
    const uplift    = suggested-currentPrice;

    return {
      currentPrice,
      suggestedPrice:   suggested,
      minPrice,
      costPrice,
      currentMarginPct: currentPrice ? Math.round((currentPrice-costPrice)/currentPrice*100) : 0,
      suggestedMarginPct: suggested ? Math.round((suggested-costPrice)/suggested*100) : 0,
      elasticity:       Math.round(elasticity*100)/100,
      confidence:       Math.round(confidence),
      upliftAmt:        uplift,
      upliftPct:        currentPrice ? Math.round(uplift/currentPrice*100) : 0,
      reason: Math.abs(uplift) < 1
        ? 'Price is already near optimal.'
        : uplift > 0
        ? `Demand analysis suggests ${Math.round(uplift/currentPrice*100)}% price increase potential.`
        : `Lowering price may increase volume and total revenue.`,
    };
  }

  // ── Customer Segmentation (RFM) ───────────────────────────

  /**
   * Segment customers by Recency, Frequency, Monetary value
   * @param {Array} customers
   * @param {Array} invoices
   */
  function segmentCustomers(customers, invoices) {
    const now  = Date.now();
    const data = customers.map(c => {
      const cInvoices = invoices.filter(i => i.customerId === c.id && i.paymentStatus === 'paid');
      if (!cInvoices.length) return null;

      const lastDate  = Math.max(...cInvoices.map(i => new Date(i.invoiceDate||i.createdAt).getTime()));
      const recency   = Math.round((now-lastDate)/(1000*60*60*24)); // days
      const frequency = cInvoices.length;
      const monetary  = cInvoices.reduce((s,i)=>s+Number(i.totalAmount||0),0);

      return { customer: c, recency, frequency, monetary };
    }).filter(Boolean);

    if (!data.length) return [];

    // Score each dimension 1-5
    const score = (val, sorted, invert=false) => {
      const pct = sorted.indexOf(val)/sorted.length;
      const s   = Math.ceil(pct*5);
      return invert ? 6-s : s;
    };

    const recencies   = [...data.map(d=>d.recency)].sort((a,b)=>a-b);
    const frequencies = [...data.map(d=>d.frequency)].sort((a,b)=>a-b);
    const monetaries  = [...data.map(d=>d.monetary)].sort((a,b)=>a-b);

    return data.map(d => {
      const R = score(d.recency,   recencies,   true);  // lower recency = better
      const F = score(d.frequency, frequencies, false);
      const M = score(d.monetary,  monetaries,  false);
      const rfm = R*100 + F*10 + M;

      let segment, color, action;
      if (R>=4&&F>=4&&M>=4) { segment='Champions';          color='#30D158'; action='Reward them. Upsell premium products.'; }
      else if (R>=3&&F>=3)  { segment='Loyal Customers';    color='#0A84FF'; action='Offer loyalty program. Ask for reviews.'; }
      else if (R>=4&&F<=2)  { segment='Promising';          color='#64D2FF'; action='Onboard carefully. Offer welcome discount.'; }
      else if (R>=3&&M>=3)  { segment='Potential Loyalist'; color='#5AC8FA'; action='Offer membership. Recommend products.'; }
      else if (R<=2&&F>=4)  { segment='At Risk';            color='#FF9F0A'; action='Send win-back campaign. Special offer.'; }
      else if (R<=1&&F>=3)  { segment='Cannot Lose Them';   color='#FF453A'; action='Win back immediately. Survey them.'; }
      else if (R<=2&&F<=2)  { segment='Hibernating';        color='#8E8E93'; action='Offer relevant promotions.'; }
      else                  { segment='Lost';               color='#636366'; action='Revive with new offerings.'; }

      return { ...d, R, F, M, rfm, segment, color, action };
    }).sort((a,b)=>b.monetary-a.monetary);
  }

  // ── Inventory Optimization ────────────────────────────────

  /**
   * Calculate Economic Order Quantity and reorder point
   * @param {Object} product
   * @param {number} annualDemand
   * @param {number} holdingCostPct - fraction of unit cost (default 0.2)
   * @param {number} orderCost - cost per order in ₹ (default 500)
   */
  function calcEOQ(product, annualDemand, holdingCostPct=0.2, orderCost=500) {
    const unitCost    = Number(product.costPrice||product.price||0);
    const holdingCost = unitCost * holdingCostPct;

    if (!annualDemand || !holdingCost) return null;

    const eoq = Math.round(Math.sqrt(2*annualDemand*orderCost/holdingCost));
    const ordersPerYear = Math.round(annualDemand/eoq*10)/10;
    const avgInventory  = eoq/2;
    const totalCost     = ordersPerYear*orderCost + avgInventory*holdingCost;

    // Lead time reorder point (assume 7 days lead time)
    const dailyDemand = annualDemand/365;
    const leadTimeDays = Number(product.leadTime||7);
    const safetyStock  = Math.round(dailyDemand*leadTimeDays*0.25);
    const reorderPoint = Math.round(dailyDemand*leadTimeDays + safetyStock);

    return {
      eoq,
      ordersPerYear,
      avgInventory,
      totalAnnualCost: Math.round(totalCost),
      reorderPoint,
      safetyStock,
      leadTimeDays,
      interpretation: `Order ${eoq} units ${Math.ceil(ordersPerYear)}x per year. Reorder when stock hits ${reorderPoint} units.`,
    };
  }

  // ── Expense Anomaly Detection ─────────────────────────────

  function detectExpenseAnomalies(expenses, lookbackMonths=6) {
    const byCategory = {};
    expenses.forEach(e => {
      const cat = e.category || 'other';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({ amount: Number(e.amount||0), date: e.date, id: e.id, description: e.description });
    });

    const anomalies = [];
    for (const [cat, items] of Object.entries(byCategory)) {
      if (items.length < 4) continue;
      const amounts = items.map(i=>i.amount);
      const flags   = detectAnomalies(amounts, { method:'iqr' });
      items.forEach((item,i) => {
        if (flags[i]) anomalies.push({
          ...item, category:cat,
          severity: item.amount > amounts.reduce((a,b)=>a+b,0)/amounts.length*3 ? 'high' : 'medium',
        });
      });
    }

    return anomalies.sort((a,b)=>b.amount-a.amount);
  }

  // ── Revenue Attribution ───────────────────────────────────

  function attributeRevenue(invoices, customers, products) {
    // By customer
    const byCustomer = {};
    invoices.filter(i=>i.paymentStatus==='paid').forEach(i => {
      const k = i.customerId||'unknown';
      byCustomer[k] = (byCustomer[k]||0) + Number(i.totalAmount||0);
    });

    // By product (from invoice items)
    const byProduct = {};
    invoices.forEach(inv => {
      (inv.items||[]).forEach(item => {
        const k = item.productId||item.description||'unknown';
        byProduct[k] = (byProduct[k]||0) + Number(item.qty||1)*Number(item.unitPrice||0);
      });
    });

    // Top customers
    const topCustomers = Object.entries(byCustomer)
      .map(([id,rev]) => ({ id, name:customers.find(c=>c.id===id)?.name||id, revenue:Math.round(rev) }))
      .sort((a,b)=>b.revenue-a.revenue).slice(0,10);

    // Top products
    const topProducts = Object.entries(byProduct)
      .map(([id,rev]) => ({ id, name:products.find(p=>p.id===id)?.name||id, revenue:Math.round(rev) }))
      .sort((a,b)=>b.revenue-a.revenue).slice(0,10);

    // Pareto: what % of customers drive 80% of revenue
    const totalRev = topCustomers.reduce((s,c)=>s+c.revenue,0);
    let cumRev=0, paretoIdx=0;
    for (let i=0;i<topCustomers.length;i++) {
      cumRev += topCustomers[i].revenue;
      if (cumRev/totalRev >= 0.8) { paretoIdx=i+1; break; }
    }

    return { topCustomers, topProducts, totalRevenue:Math.round(totalRev), paretoCustomers:paretoIdx };
  }

  // ── Summary stats helper ──────────────────────────────────
  function stats(arr) {
    if (!arr.length) return { min:0, max:0, mean:0, median:0, std:0, sum:0 };
    const sorted = [...arr].sort((a,b)=>a-b);
    const sum    = arr.reduce((a,b)=>a+b,0);
    const mean   = sum/arr.length;
    const std    = Math.sqrt(arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length);
    const median = sorted.length%2===0
      ? (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2
      : sorted[Math.floor(sorted.length/2)];
    return { min:sorted[0], max:sorted[sorted.length-1], mean:Math.round(mean), median, std:Math.round(std), sum:Math.round(sum) };
  }

  return {
    // Core ML
    linearRegression,
    holtWinters,
    simpleExpSmoothing,
    movingAverage,
    detectAnomalies,
    kMeans,
    stats,

    // Business intelligence
    forecastDemand,
    predictDelay,
    predictCashFlow,
    optimizePrice,
    segmentCustomers,
    calcEOQ,
    detectExpenseAnomalies,
    attributeRevenue,
  };

})();

window.LAMML = LAMML;
