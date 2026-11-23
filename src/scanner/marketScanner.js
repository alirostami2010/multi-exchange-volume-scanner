/**
 * GATE.IO USDT PERPETUAL — WAVE PULLBACK-END RADAR
 * File: src/scanner/marketScanner.js
 * Node.js 20+ | Public Gate.io endpoints | No order execution
 *
 * Finds markets with a confirmed bullish impulse, a healthy pullback, and
 * early evidence that the pullback is ending. All structural decisions use
 * completed candles. Live ticker is used only for current-price/risk checks.
 */
import { readFileSync } from 'node:fs';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

function loadEnvFile() {
  try {
    const content = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || m[1] in process.env) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
loadEnvFile();

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4', SETTLE: 'usdt', BTC: 'BTC_USDT',
  LIMITS: { fast: 100, main: 240, context: 100, macro: 100 },
  MIN_QUOTE_VOLUME_24H: Number(process.env.MIN_QUOTE_VOLUME_24H) > 0 ? Number(process.env.MIN_QUOTE_VOLUME_24H) : 75000,
  CONCURRENCY: 5, REQUEST_SPACING_MS: 130, REQUEST_TIMEOUT_MS: 15000, RETRIES: 4,
  TELEGRAM_MAX_LENGTH: 3800, MIN_SCORE_TO_REPORT: 45, MIN_READY_SCORE: 68,
  MIN_READY_RR: 1.5, MAX_READY_RISK_PCT: 5, MAX_SPREAD_PCT: 0.45,
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const positive = x => Number.isFinite(x) && x > 0;
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = a => { const b = a.filter(Number.isFinite).sort((x,y)=>x-y); if (!b.length) return 0; const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const pct = (a,b) => b > 0 ? (a / b - 1) * 100 : 0;
const round = (x,d=2) => Number.isFinite(x) ? Number(x.toFixed(d)) : null;
const fmt = (x,d=2) => Number.isFinite(x) ? x.toFixed(d) : '—';
let lastRequestAt = 0, requestQueue = Promise.resolve();

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);
  for (const [k,v] of Object.entries(params)) if (v != null) url.searchParams.set(k,String(v));
  const slot = requestQueue.then(async()=>{ const d=CONFIG.REQUEST_SPACING_MS-(Date.now()-lastRequestAt); if(d>0) await sleep(d); lastRequestAt=Date.now(); });
  requestQueue = slot.catch(()=>{}); await slot;
  let last;
  for(let i=0;i<=CONFIG.RETRIES;i++) {
    try {
      const res=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)});
      if(res.ok) return await res.json();
      const body=await res.text().catch(()=>''); const e=new Error(`Gate ${res.status} ${path}: ${body.slice(0,140)}`);
      e.status=res.status; e.retryAfter=Number(res.headers.get('retry-after')||0);
      if(![408,425,429,500,502,503,504].includes(res.status)) throw e; last=e;
    } catch(e) { last=e; if(i===CONFIG.RETRIES || (e.status>=400&&e.status<500&&![408,425,429].includes(e.status))) break; }
    await sleep(last?.status===429&&last.retryAfter>0?Math.min(last.retryAfter*1000,30000):Math.min(700*2**i,12000));
  }
  throw last || new Error(`Gate request failed: ${path}`);
}
async function mapPool(items, concurrency, worker) {
  const out=new Array(items.length); let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{ while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await worker(items[i],i);}catch(e){out[i]={__error:e?.message||String(e)};}}}));
  return out;
}

export function normalizeCandles(raw, interval) {
  const sec=interval==='15m'?900:interval==='1h'?3600:interval==='4h'?14400:86400, now=Math.floor(Date.now()/1000);
  if(!Array.isArray(raw)) return [];
  return raw.map(r=>Array.isArray(r)?{t:n(r[0]),v:n(r[1])??0,c:n(r[2]),h:n(r[3]),l:n(r[4]),o:n(r[5]),q:n(r[6])}:{t:n(r.t),v:n(r.v)??0,c:n(r.c),h:n(r.h),l:n(r.l),o:n(r.o),q:n(r.sum)})
    .filter(c=>c.t!=null&&positive(c.o)&&positive(c.c)&&positive(c.h)&&positive(c.l)&&c.h>=c.l)
    .sort((a,b)=>a.t-b.t).filter(c=>c.t+sec<=now-1);
}
async function getCandles(symbol, interval, limit) { return normalizeCandles(await requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`,{contract:symbol,interval,limit}),interval); }
function turnover(c){return positive(c.q)?c.q:Math.max(0,c.v)*c.c;}
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let x=mean(v.slice(0,p));for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function atr(cs,p=14){if(cs.length<p+1)return null;const tr=[];for(let i=1;i<cs.length;i++){const c=cs[i],q=cs[i-1];tr.push(Math.max(c.h-c.l,Math.abs(c.h-q.c),Math.abs(c.l-q.c)));}return mean(tr.slice(-p));}
function rsi(v,p=14){if(v.length<p+1)return 50;let g=0,l=0;for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}return l===0?100:100-100/(1+(g/p)/(l/p));}
function candlePressure(c){const range=Math.max(c.h-c.l,c.c*1e-8);return {closeLocation:clamp((c.c-c.l)/range),body:(c.c-c.o)/range,upperWick:(c.h-Math.max(c.o,c.c))/range,lowerWick:(Math.min(c.o,c.c)-c.l)/range};}

// Confirmed pivots are used to describe completed waves, never to claim an unconfirmed pivot.
function swingPoints(cs,left=2,right=2){const highs=[],lows=[];for(let i=left;i<cs.length-right;i++){let hi=true,lo=true;for(let j=i-left;j<=i+right;j++){if(j===i)continue;if(cs[j].h>=cs[i].h)hi=false;if(cs[j].l<=cs[i].l)lo=false;}if(hi)highs.push({i,p:cs[i].h});if(lo)lows.push({i,p:cs[i].l});}return {highs,lows};}
function regressionSlope(v){const len=v.length;if(len<3)return 0;const xm=(len-1)/2,ym=mean(v);let a=0,b=0;for(let i=0;i<len;i++){a+=(i-xm)*(v[i]-ym);b+=(i-xm)**2;}return b?a/b:0;}

export function analyzeFrame(cs,frame){
  if(cs.length<(frame==='1h'?80:35))return null;
  const closes=cs.map(c=>c.c),last=cs.at(-1),prev=cs.at(-2),e9=ema(closes,9),e20=ema(closes,20),e50=ema(closes,50),a14=atr(cs,14);
  const recent=cs.slice(-6),prior=cs.slice(-18,-6),recentTurn=recent.map(turnover),baseTurn=cs.slice(-31,-6).map(turnover).filter(x=>x>0);
  const upTurn=recent.filter(c=>c.c>c.o).reduce((s,c)=>s+turnover(c),0),downTurn=recent.filter(c=>c.c<c.o).reduce((s,c)=>s+turnover(c),0);
  const bearish=recent.filter(c=>c.c<c.o),bullish=recent.filter(c=>c.c>c.o);
  const bearishAvgBody=mean(bearish.map(c=>Math.abs(pct(c.c,c.o)))),bullishAvgBody=mean(bullish.map(c=>Math.abs(pct(c.c,c.o))));
  const pressure=mean(recent.map(c=>candlePressure(c).closeLocation*.65+(c.c>c.o?.35:0)));
  const priorHigh=Math.max(...prior.map(c=>c.h)),priorLow=Math.min(...prior.map(c=>c.l));
  const recentHigh=Math.max(...recent.map(c=>c.h)),recentLow=Math.min(...recent.map(c=>c.l));
  const piv=swingPoints(cs.slice(-100)); const highs=piv.highs,lows=piv.lows,lh=highs.slice(-2),ll=lows.slice(-2);
  const pullbackHigh=Math.max(...cs.slice(-36).map(c=>c.h));
  return {frame,last,prev,e9,e20,e50,atr:a14,atrPct:a14? a14/last.c*100:0,rsi:rsi(closes),
    ret1:pct(last.c,prev.c),ret3:pct(last.c,cs.at(-4).c),ret6:pct(last.c,cs.at(-7).c),ret12:pct(last.c,cs.at(-13).c),ret24:pct(last.c,cs.at(-25).c),
    volumeRatio:median(recentTurn)/Math.max(median(baseTurn),1e-12),upDownTurnRatio:upTurn/Math.max(downTurn,1e-12),pressure,
    closeLoc:candlePressure(last).closeLocation,priorHigh,priorLow,recentHigh,recentLow,pullbackFromHigh:pct(last.c,pullbackHigh),
    slope:regressionSlope(closes.slice(-20))/Math.max(last.c,1e-12)*100,
    higherHighs:lh.length===2&&lh[1].p>lh[0].p,higherLows:ll.length===2&&ll[1].p>ll[0].p,
    lowerLows:ll.length===2&&ll[1].p<ll[0].p,structureFloor:ll.at(-1)?.p??priorLow,
    swingHighs:highs.map(x=>x.p),swingLows:lows.map(x=>x.p),swingHighPoints:highs,swingLowPoints:lows,
    distanceE20Atr:a14?(last.c-e20)/a14:0,distFromRecentHighAtr:a14?(pullbackHigh-last.c)/a14:0,
    sellingWeakening:bearishAvgBody<=bullishAvgBody*1.05||downTurn<=upTurn*1.05,
    rangePct:(recentHigh-recentLow)/last.c*100};
}

/**
 * Wave model: find a recent impulse low -> impulse high -> pullback low sequence.
 * The pullback is considered late only when retracement is mature, the impulse
 * origin remains intact, selling pressure contracts, and recent closed candles
 * show rejection/stabilisation. 15m response is checked separately below.
 */
export function detectWavePullbackEnd(candles,h1,m15){
  const cs=(candles||[]).slice(-150),piv=swingPoints(cs,2,2), lows=piv.lows, highs=piv.highs;
  if(!h1?.atr||cs.length<30)return {valid:false,reason:'تاریخچه کافی برای تشخیص موج کامل نیست'};
  const lastIndex=cs.length-1, highStart=Math.max(0,lastIndex-42);
  const highSlice=cs.slice(highStart);
  const highOffset=highSlice.reduce((best,c,i,a)=>c.h>a[best].h?i:best,0);
  const recentHighs=[{i:highStart+highOffset,p:highSlice[highOffset].h}];
  let best=null;
  for(let hi=recentHighs.length-1;hi>=0;hi--){
    const top=recentHighs[hi];
    const originWindow=cs.slice(Math.max(0,top.i-55),top.i-2);
    if(originWindow.length<3)continue;
    const originOffset=originWindow.reduce((best,c,i,a)=>c.l<a[best].l?i:best,0);
    const origin={i:Math.max(0,top.i-55)+originOffset,p:originWindow[originOffset].l};
    const impulse=top.p-origin.p,impulsePct=impulse/origin.p*100,impulseAtr=impulse/h1.atr;
    if(impulse<=0||impulsePct<3||impulseAtr<3.2)continue;
    if(top.i>lastIndex-3)continue; // no pullback yet
    const pullLow=Math.min(...cs.slice(top.i+1).map(c=>c.l));
    const retrace=(top.p-pullLow)/impulse;
    const pullAge=lastIndex-top.i;
    if(retrace<0.22||retrace>0.72||pullAge<3||pullAge>34)continue;
    if(pullLow<=origin.p*1.003)continue;
    const recent=cs.slice(-5), prior=cs.slice(-10,-5);
    const recentLow=Math.min(...recent.map(c=>c.l)), priorLow=Math.min(...prior.map(c=>c.l));
    const lowHeld=recentLow>pullLow*0.996;
    const noFreshLow=recentLow>=priorLow*0.997 || recent.at(-1).l>recent[0].l;
    const downRecent=recent.filter(c=>c.c<c.o),downPrior=prior.filter(c=>c.c<c.o);
    const recentSellBody=mean(downRecent.map(c=>Math.abs(pct(c.c,c.o))));
    const priorSellBody=mean(downPrior.map(c=>Math.abs(pct(c.c,c.o))));
    const recentSellTurn=mean(downRecent.map(turnover)),priorSellTurn=mean(downPrior.map(turnover));
    const sellingExhaustion=(downRecent.length===0)||(priorSellBody>0&&recentSellBody<priorSellBody*.82)||(priorSellTurn>0&&recentSellTurn<priorSellTurn*.82);
    const rejection=recent.some(c=>{const p=candlePressure(c);return p.lowerWick>=.28&&p.closeLocation>=.52;});
    const lastBull=recent.at(-1).c>recent.at(-1).o&&candlePressure(recent.at(-1)).closeLocation>=.55;
    const nearPullLow=(h1.last.c-pullLow)/h1.atr<=1.35;
    const retraceScore=retrace>=.30&&retrace<=.62?20:retrace<=.68?13:7;
    const ageScore=pullAge>=5&&pullAge<=20?12:7;
    const endScore=(lowHeld?12:0)+(noFreshLow?10:0)+(sellingExhaustion?14:0)+(rejection?8:0)+(lastBull?5:0)+(nearPullLow?8:0);
    const score=retraceScore+ageScore+endScore;
    const candidate={origin:origin.p,top:top.p,pullLow,retrace,pullAge,impulsePct,impulseAtr,lowHeld,noFreshLow,sellingExhaustion,rejection,lastBull,nearPullLow,score};
    if(!best||candidate.score>best.score)best=candidate;
  }
  if(!best)return {valid:false,reason:'موج صعودی سابق و اصلاح معتبر پس از آن شناسایی نشد'};
  const response15=m15 && ((m15.last.c>m15.last.o&&m15.closeLoc>=.56)||(m15.pressure>=.55&&m15.ret3>0)||(m15.upDownTurnRatio>1.08&&m15.ret3>=0));
  const response1h=h1.last.c>h1.last.o&&h1.closeLoc>=.52;
  const endEvidence=best.lowHeld&&best.noFreshLow&&best.sellingExhaustion&&(best.rejection||best.lastBull||response15||response1h);
  const valid=best.score>=43&&endEvidence;
  return {...best,valid,response15,response1h,endEvidence,reason:valid?'اصلاح موج صعودی به انتها نزدیک شده و نشانه‌های کاهش فشار فروش/بازگشت دیده می‌شود':'اصلاح هنوز نشانه کافی برای پایان‌گرفتن ندارد'};
}

function scoreTrend(h1,h4){let s=0;if(h4.last.c>h4.e50)s+=12;if(h4.e20>h4.e50)s+=8;if(h1.higherLows)s+=10;if(h1.higherHighs)s+=5;if(h4.higherLows)s+=8;if(h1.last.c>h1.structureFloor)s+=7;if(h1.lowerLows)s-=12;if(h4.lowerLows)s-=10;return clamp(s,0,50);}
function scoreWave(w){return w.valid?clamp(w.score,0,65):0;}
function scoreBuyerResponse(h1,m15,w){let s=0;s+=clamp((m15.pressure-.42)*55,0,12);s+=clamp((h1.pressure-.42)*35,0,8);if(m15.upDownTurnRatio>1.05)s+=8;if(w.rejection)s+=6;if(w.sellingExhaustion)s+=6;if(m15.ret3>0)s+=5;return clamp(s,0,45);}
function scoreRelative(h1,h4,b1,b4){const rs1=h1.ret6-b1.ret6,rs4=h4.ret6-b4.ret6;return {score:clamp(12+rs1*1.8+rs4,0,25),rs1:round(rs1),rs4:round(rs4)};}

export function riskAndEntry(h1,m15,h4,livePrice,wave){
  const a=h1.atr||livePrice*.01;
  const support=Math.max(wave.pullLow,h1.structureFloor);
  const invalidation=Math.min(support-a*.25,wave.origin-a*.08);
  const riskPct=(livePrice-invalidation)/livePrice*100;
  const resistances=[...h1.swingHighs,...h4.swingHighs,h1.priorHigh,h4.priorHigh].filter(x=>positive(x)&&x>livePrice*1.002).sort((x,y)=>x-y);
  const resistance1=resistances[0]??null,resistance2=resistances.find(x=>resistance1&&x>resistance1*1.015)??null;
  // Entry is near the pullback floor/short EMA area, not a fixed percentage below price.
  const entryLow=Math.max(support-a*.12,h1.e20-a*.65),entryHigh=Math.min(support+a*.48,livePrice+a*.08);
  const zoneLow=Math.min(entryLow,entryHigh),zoneHigh=Math.max(entryLow,entryHigh);
  const entryReference=clamp(livePrice,zoneLow,zoneHigh),riskPerUnit=Math.max(entryReference-invalidation,a*.35);
  const t1=resistance1&&resistance1>entryReference?Math.min(resistance1*.995,entryReference+Math.max(a*1.5,riskPerUnit*1.5)):entryReference+Math.max(a*1.8,riskPerUnit*1.7);
  const t2=resistance2&&resistance2>t1?resistance2*.995:entryReference+Math.max(a*3,riskPerUnit*2.4);
  const rr=(t1-entryReference)/riskPerUnit,extension=(livePrice-h1.e20)/a;
  let score=0;if(riskPct<=2.5)score+=12;else if(riskPct<=CONFIG.MAX_READY_RISK_PCT)score+=7;else score-=8;
  if(rr>=2.2)score+=14;else if(rr>=CONFIG.MIN_READY_RR)score+=9;else score-=12;
  if(extension<=1.1)score+=8;else if(extension<=1.8)score+=3;else score-=8;
  const inZone=livePrice>=zoneLow&&livePrice<=zoneHigh;
  if(inZone)score+=6;
  return {score:clamp(score,0,40),support,invalidation,riskPct,resistance1,resistance2,entryLow:zoneLow,entryHigh:zoneHigh,entryReference,target1:t1,target2:t2,rr,extension,inZone,riskPerUnit,rewardPct:pct(t1,entryReference)};
}

export function analyzeBtcRegime(h1,h4,d1){
  const score=(h1.last.c>h1.e20?1:-1)+(h4.last.c>h4.e20?1:-1)+(d1.last.c>d1.e20?1:-1)+(h1.higherLows?.5:-.5)+(h4.higherLows?.5:-.5)+(d1.higherLows?.5:-.5);
  const hardBreakdown=h1.ret6<-1.8&&h4.ret6<-2.8,label=hardBreakdown||score<=-2?'BEARISH':score>=2?'BULLISH':'NEUTRAL';
  return {label,score:round(score,1),ret1h6:round(h1.ret6),ret4h6:round(h4.ret6),ret1d6:round(d1.ret6),hardBreakdown};
}

function analyzeCoin(symbol,ticker,frames,btc,marketBreadth){
  const h1=analyzeFrame(frames.h1,'1h'),m15=analyzeFrame(frames.m15,'15m'),h4=analyzeFrame(frames.h4,'4h');
  if(!h1||!m15||!h4)return null;
  const livePrice=n(ticker.last);if(!positive(livePrice))return null;
  const spread=(()=>{const bid=n(ticker.highest_bid),ask=n(ticker.lowest_ask);return positive(bid)&&positive(ask)&&ask>=bid?(ask/bid-1)*100:null;})();
  const wave=detectWavePullbackEnd(frames.h1,h1,m15);
  // A rising macro context is required, but 1h EMA alignment is deliberately not a gate:
  // pullback-end candidates often sit below their short EMA before the next leg starts.
  const structureOk=h1.last.c>wave.origin&&h4.last.c>h4.e50&&!h1.lowerLows&&!h4.lowerLows;
  if(!wave.valid||!structureOk)return null;
  const risk=riskAndEntry(h1,m15,h4,livePrice,wave);
  const rel=scoreRelative(h1,h4,btc.h1,btc.h4);
  const independent=rel.rs1>=1&&rel.rs4>=1.5;
  if(btc.regime.label==='BEARISH'&&!independent)return null;
  if(spread!=null&&spread>CONFIG.MAX_SPREAD_PCT*1.5)return null;
  const trend=scoreTrend(h1,h4),waveScore=scoreWave(wave),buyers=scoreBuyerResponse(h1,m15,wave);
  const qv=n(ticker.volume_24h_quote)??0,funding=n(ticker.funding_rate),change24=n(ticker.change_percentage)??0;
  const liquidity=clamp((Math.log10(Math.max(qv,1))-4)*9,0,18);
  const response15=wave.response15;
  const rrOk=risk.rr>=CONFIG.MIN_READY_RR&&risk.riskPct>0&&risk.riskPct<=CONFIG.MAX_READY_RISK_PCT;
  const spreadOk=spread==null||spread<=CONFIG.MAX_SPREAD_PCT;
  const ready=wave.endEvidence&&response15&&risk.inZone&&rrOk&&spreadOk&&risk.extension<=1.8&&btc.regime.label!=='BEARISH';
  const waitingReason=!wave.response15?'انتهای اصلاح محتمل است؛ منتظر واکنش روشن‌تر خریداران در ۱۵ دقیقه':!risk.inZone?'نزدیک انتهای اصلاح است؛ قیمت هنوز در محدوده مناسب قرار نگرفته':!rrOk?'ریسک یا نسبت سود به زیان مناسب نیست':!spreadOk?'اسپرد بازار بالاست':btc.regime.label==='BEARISH'?'شرایط بیت‌کوین نامساعد است':'نشانه‌های پایان اصلاح در حال شکل‌گیری است';
  const score=clamp(trend*.22+waveScore*.42+buyers*.18+rel.score*.08+liquidity*.1-(funding!=null&&funding>.003?7:0)-(change24>30?5:0)-(marketBreadth.ratio<.25?4:0),0,100);
  if(score<CONFIG.MIN_SCORE_TO_REPORT)return null;
  const status=ready&&score>=CONFIG.MIN_READY_SCORE?'READY':'WAITING';
  return {symbol,contract:symbol,score:round(score,1),rankScore:round(score,1),persistenceScore:round((trend+waveScore)/2,1),opportunityType:'BULLISH_WAVE_PULLBACK_END',tradeStatus:status,entryReadiness:status==='READY'?'READY':'WAIT',entryTriggerConfirmed:ready,btcRegime:btc.regime.label,setupLabel:status==='READY'?'اصلاح موج صعودی تمام‌شده/در آستانه پایان؛ واکنش خریدار تأیید شده':waitingReason,
    price:livePrice,livePrice,change24h:round(change24),quoteVolume24h:round(qv,0),fundingRate:funding,
    volume:{'15m':round(m15.volumeRatio,2),'1h':round(h1.volumeRatio,2)},volumeRatio15m:round(m15.volumeRatio,2),volumeRatio1h:round(h1.volumeRatio,2),buyerPressure15m:round(m15.pressure*100,1),buyerPressure1h:round(h1.pressure*100,1),upDownTurnover15m:round(m15.upDownTurnRatio,2),rsi1h:round(h1.rsi,1),atrPct1h:round(h1.atrPct,2),trendScore:round(trend,1),pullbackScore:round(waveScore,1),buyerScore:round(buyers,1),volumeScore:round(m15.volumeRatio*10,1),relativeScore:round(rel.score,1),relativeStrength:{excess6h1h:rel.rs1,excess24h4h:rel.rs4},
    wave:{origin:round(wave.origin),impulseHigh:round(wave.top),pullbackLow:round(wave.pullLow),retracementPct:round(wave.retrace*100,1),pullbackAgeHours:wave.pullAge,impulsePct:round(wave.impulsePct,1),sellingWeakening:wave.sellingExhaustion,lowHeld:wave.lowHeld,rejection:wave.rejection},
    structure:{higherHighs:h1.higherHighs,higherLows:h1.higherLows,floor:h1.structureFloor},entryZone:{low:round(risk.entryLow,8),high:round(risk.entryHigh,8),reference:round(risk.entryReference,8)},invalidation:round(risk.invalidation,8),target1:round(risk.target1,8),target2:round(risk.target2,8),resistance1:risk.resistance1,resistance2:risk.resistance2,spreadPct:round(spread,3),rrToTarget1:round(risk.rr,2),riskPercent:round(risk.riskPct,2),rewardToTarget1Percent:round(risk.rewardPct,2),extensionAtr:round(risk.extension,2),moveStatus:status==='READY'?'PULLBACK_END_CONFIRMED':'PULLBACK_END_FORMING',stage:status==='READY'?'READY':'PULLBACK_END',
    reasons:[`موج صعودی قبلی ${fmt(wave.impulsePct,1)}٪ از کف تا سقف`, `اصلاح ${fmt(wave.retrace*100,1)}٪ از موج قبلی`,wave.sellingExhaustion?'کاهش فشار فروش در انتهای اصلاح':null,wave.lowHeld?'کف اصلاح حفظ شده':null,wave.rejection?'سایه پایینی/دفاع از کف مشاهده شده':null,wave.response15?'واکنش اولیه خریداران در ۱۵ دقیقه':null,rel.rs1>0?'قدرت نسبی بهتر از BTC':null].filter(Boolean),
    _sort:{trend,wave:waveScore,buyers,relative:rel.score,risk:risk.score,liquidity}};
}

async function getOrderBook(symbol){const b=await requestGate(`/futures/${CONFIG.SETTLE}/order_book`,{contract:symbol,limit:20});const bids=(b.bids||[]).reduce((s,x)=>s+(n(x.p)||0)*Math.abs(n(x.s)||0),0),asks=(b.asks||[]).reduce((s,x)=>s+(n(x.p)||0)*Math.abs(n(x.s)||0),0),total=bids+asks;return {bidShare:total?bids/total*100:null,imbalance:asks?bids/asks:null};}
export function rankCandidates(items){return items.sort((a,b)=>{const so={READY:0,WAITING:1};if((so[a.tradeStatus]??9)!==(so[b.tradeStatus]??9))return(so[a.tradeStatus]??9)-(so[b.tradeStatus]??9);if(b.score!==a.score)return b.score-a.score;if((b._sort?.wave??0)!==(a._sort?.wave??0))return(b._sort?.wave??0)-(a._sort?.wave??0);return(b.quoteVolume24h||0)-(a.quoteVolume24h||0);}).map((x,i)=>({...x,rank:i+1}));}
function reportLine(c,i){const st=c.tradeStatus==='READY'?'🟢 آماده بررسی':'🟡 انتهای اصلاح در حال شکل‌گیری؛ فعلاً صبر';return [`${i+1}. ${c.symbol} | ${c.score}/100 | ${st}`,`قیمت: ${c.price} | BTC: ${c.btcRegime} | RSI: ${fmt(c.rsi1h,1)}`,`موج: کف ${c.wave.origin} ← سقف ${c.wave.impulseHigh} | اصلاح: ${fmt(c.wave.retracementPct,1)}٪ | عمر اصلاح: ${c.wave.pullbackAgeHours} کندل`, `فشار خریدار ۱۵د: ${fmt(c.buyerPressure15m,0)}٪ | حجم نسبی ۱۵د: ${fmt(c.volumeRatio15m)}x`, `محدوده بررسی: ${c.entryZone.low} تا ${c.entryZone.high} | ابطال: ${c.invalidation} | TP1: ${c.target1} | TP2: ${c.target2} | R:R: ${fmt(c.rrToTarget1)} | ریسک: ${fmt(c.riskPercent)}٪`,`دلیل: ${c.reasons.join('؛ ')||c.setupLabel}`].join('\n');}
function buildReport(o){const lines=['🚀 GATE.IO | رادار انتهای اصلاح موج صعودی','━━━━━━━━━━━━━━━━━━',`زمان: ${o.scannedAt}`,`قرارداد فعال: ${o.stats.active} | بازار نقدشونده: ${o.stats.liquid} | بررسی موفق: ${o.stats.success} | خطا: ${o.stats.failed}`,`نامزدها: ${o.stats.candidates} | آماده بررسی: ${o.stats.ready} | در انتظار: ${o.stats.waiting}`,`BTC: ${o.btc.regime} | پهنای بازار مثبت: ${fmt(o.marketBreadth.positivePct,1)}٪`,'معیار: موج صعودی قبلی + اصلاح سالم + نشانه‌های انتهای اصلاح','━━━━━━━━━━━━━━━━━━'];const ready=o.candidates.filter(x=>x.tradeStatus==='READY'),waiting=o.candidates.filter(x=>x.tradeStatus!=='READY');if(!ready.length)lines.push('⛔ موقعیت آماده‌ای تأیید نشد.');else{lines.push('🟢 آماده بررسی:');ready.forEach((c,i)=>lines.push(reportLine(c,i),'━━━━━━━━━━━━━━━━━━'));}if(waiting.length){lines.push('🟡 فهرست انتظار:');waiting.forEach((c,i)=>lines.push(reportLine(c,i),'━━━━━━━━━━━━━━━━━━'));}lines.push('⚠️ خروجی تحلیلی است و تضمین سود یا دستور معامله نیست.');return lines.join('\n');}
async function sendTelegram(message){const token=process.env.TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId){console.warn('[TELEGRAM] Credentials missing; report printed locally only.');return false;}const chunks=[];let cur='';for(const line of message.split('\n')){if((cur+'\n'+line).length>CONFIG.TELEGRAM_MAX_LENGTH&&cur){chunks.push(cur);cur=line;}else cur=cur?`${cur}\n${line}`:line;}if(cur)chunks.push(cur);for(const chunk of chunks){const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:chunk,disable_web_page_preview:true}),signal:AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)});const data=await r.json().catch(()=>null);if(!r.ok||!data?.ok)throw new Error(data?.description||`Telegram HTTP ${r.status}`);await sleep(350);}return true;}

export async function scanGateMarkets(){
  const started=Date.now();console.log('\n🚀 GATE.IO BULLISH WAVE PULLBACK-END RADAR');
  const [contracts,tickers]=await Promise.all([requestGate(`/futures/${CONFIG.SETTLE}/contracts`),requestGate(`/futures/${CONFIG.SETTLE}/tickers`)]);
  const tickerMap=new Map((tickers||[]).map(t=>[t.contract,t]));
  const active=(contracts||[]).filter(c=>typeof c.name==='string'&&c.name.endsWith('_USDT')&&c.status==='trading'&&c.in_delisting===false);
  const markets=active.map(c=>{const t=tickerMap.get(c.name),q=n(t?.volume_24h_quote)??0;return t&&positive(n(t.last))&&q>=CONFIG.MIN_QUOTE_VOLUME_24H?{symbol:c.name,ticker:t,quoteVolume24h:q}:null;}).filter(Boolean);
  const btcTicker=tickerMap.get(CONFIG.BTC);if(!btcTicker)throw new Error('BTC_USDT ticker is unavailable.');
  const [b1,b4,bd]=await Promise.all([getCandles(CONFIG.BTC,'1h',CONFIG.LIMITS.main),getCandles(CONFIG.BTC,'4h',CONFIG.LIMITS.context),getCandles(CONFIG.BTC,'1d',CONFIG.LIMITS.macro)]);
  const btc={h1:analyzeFrame(b1,'1h'),h4:analyzeFrame(b4,'4h'),d1:analyzeFrame(bd,'1d')};if(!btc.h1||!btc.h4||!btc.d1)throw new Error('BTC benchmark history is insufficient.');btc.regime=analyzeBtcRegime(btc.h1,btc.h4,btc.d1);
  const breadth=markets.map(m=>n(m.ticker.change_percentage)).filter(Number.isFinite),positiveCount=breadth.filter(x=>x>0).length;
  const marketBreadth={total:breadth.length,positive:positiveCount,ratio:breadth.length?positiveCount/breadth.length:.5,positivePct:breadth.length?positiveCount/breadth.length*100:50};
  let success=0,failed=0,done=0,qualified=0;console.log(`Active: ${active.length} | Liquid: ${markets.length}`);
  const analyzed=await mapPool(markets,CONFIG.CONCURRENCY,async m=>{const [m15,h1,h4]=await Promise.all([getCandles(m.symbol,'15m',CONFIG.LIMITS.fast),getCandles(m.symbol,'1h',CONFIG.LIMITS.main),getCandles(m.symbol,'4h',CONFIG.LIMITS.context)]);const c=analyzeCoin(m.symbol,m.ticker,{m15,h1,h4},btc,marketBreadth);success++;done++;if(c)qualified++;if(done%50===0)console.log(`[PROGRESS] ${done}/${markets.length} | candidates ${qualified}`);return c;});
  const all=[];for(const x of analyzed){if(x?.__error)failed++;else if(x)all.push(x);}const rankedAll=rankCandidates(all);
  const shortlist=rankedAll.slice(0,12),books=await mapPool(shortlist,3,x=>getOrderBook(x.symbol));books.forEach((b,i)=>{if(b&&!b.__error){shortlist[i].orderBook={bidShare:round(b.bidShare,1),imbalance:round(b.imbalance,3)};}});
  const ranked=rankCandidates(rankedAll);ranked.forEach((c,i)=>{c.rank=i+1;delete c._sort;});
  const output={success:true,exchange:'GATE.IO',market:'USDT PERPETUAL',strategy:'BULLISH WAVE PULLBACK-END RADAR',scannedAt:new Date().toISOString(),stats:{active:active.length,liquid:markets.length,success,failed,candidates:ranked.length,ready:ranked.filter(c=>c.tradeStatus==='READY').length,waiting:ranked.filter(c=>c.tradeStatus!=='READY').length,durationMs:Date.now()-started},btc:{change1h6:round(btc.h1.ret6),change4h6:round(btc.h4.ret6),change1d6:round(btc.d1.ret6),regime:btc.regime.label,regimeScore:btc.regime.score},marketBreadth,candidates:ranked,rankedCandidates:ranked};
  try{const stored=await saveMarketSnapshot(rankedAll.map(c=>({...c,_sort:undefined})));output.historyCount=stored?.historyCount??0;output.summaryCount=stored?.summaryCount??rankedAll.length;output.rankChanges=stored?.rankChanges??{};}catch(e){console.error('[STORAGE] Snapshot save failed:',e.message);}
  const report=buildReport(output);console.log(report);console.log(`\nFinished in ${(output.stats.durationMs/1000).toFixed(1)}s | scanned ${markets.length} | success ${success} | failed ${failed}`);await sendTelegram(report);return output;
}

if(process.env.SCANNER_NO_AUTORUN!=='1'){
  try{const r=await scanGateMarkets();console.log('[SCANNER RESULT]',JSON.stringify({success:r.success,active:r.stats.active,liquid:r.stats.liquid,successful:r.stats.success,failed:r.stats.failed,candidates:r.stats.candidates,durationMs:r.stats.durationMs},null,2));}
  catch(e){console.error('[SCANNER FATAL ERROR]',e);process.exitCode=1;}
}
