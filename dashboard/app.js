"use strict";
/* MintGauge — pre-token launch radar. Reads ../board.json (written next to
   this folder by the entry program, main.ts) and model-data.js (window.MODEL).
   The page re-derives every number it shows from board.json and prints a
   self-verification seal: if the page and the file disagree, the seal says so. */
const M = window.MODEL;
const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function fmt(v){ if(v==null) return "—"; const a=Math.abs(v);
  if(a>=1e9) return "$"+(v/1e9).toFixed(2)+"B"; if(a>=1e6) return "$"+(v/1e6).toFixed(1)+"M";
  if(a>=1e3) return "$"+(v/1e3).toFixed(1)+"K"; return "$"+Math.round(v); }
function fmtFull(v){ return "$" + Math.round(v).toLocaleString("en-US"); }
function sgn(v){ return (v<0?"−$":"+$") + Math.abs(Math.round(v)).toLocaleString("en-US"); }
function pct(v){ if(v==null) return "—"; return (v>0?"+":"")+v.toFixed(1)+"%"; }
function ageTxt(d){ if(d==null) return "—"; if(d<365) return Math.round(d/30)+" mo"; return (d/365).toFixed(1)+" y"; }

/* --- compact SHA-256 (FIPS 180-4), used only for the board seal --- */
function sha256(ascii){
  function rr(v,a){return (v>>>a)|(v<<(32-a));}
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes=[]; for(let i=0;i<ascii.length;i++){ const c=ascii.charCodeAt(i);
    if(c<0x80) bytes.push(c); else if(c<0x800){ bytes.push(0xc0|(c>>6),0x80|(c&63)); }
    else { bytes.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63)); } }
  const bitLen=bytes.length*8; bytes.push(0x80);
  while(bytes.length%64!==56) bytes.push(0);
  for(let i=7;i>=0;i--) bytes.push(Math.floor(bitLen/Math.pow(2,8*i))%256);
  const w=new Array(64);
  for(let b=0;b<bytes.length;b+=64){
    for(let t=0;t<16;t++) w[t]=(bytes[b+4*t]<<24)|(bytes[b+4*t+1]<<16)|(bytes[b+4*t+2]<<8)|bytes[b+4*t+3];
    for(let t=16;t<64;t++){ const s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3), s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);
      w[t]=(w[t-16]+s0+w[t-7]+s1)|0; }
    let [a,bb,c,d,e,f,g,h]=H;
    for(let t=0;t<64;t++){
      const S1=rr(e,6)^rr(e,11)^rr(e,25), ch=(e&f)^(~e&g), t1=(h+S1+ch+K[t]+w[t])|0;
      const S0=rr(a,2)^rr(a,13)^rr(a,22), mj=(a&bb)^(a&c)^(bb&c), t2=(S0+mj)|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=bb; bb=a; a=(t1+t2)|0; }
    H=[(H[0]+a)|0,(H[1]+bb)|0,(H[2]+c)|0,(H[3]+d)|0,(H[4]+e)|0,(H[5]+f)|0,(H[6]+g)|0,(H[7]+h)|0];
  }
  return H.map(x=>("0000000"+(x>>>0).toString(16)).slice(-8)).join("");
}

/* --- state + the farm scenario engine --- */
let rows=[], view="pre", sortKey="rank", sortDir=1;
const state={q:"",cat:"",chain:"",verd:""};
const S={size:10000, drop:7, weeks:12};
const TBILL=0.04;
function scen(r, size, drop, weeks){
  size=size==null?S.size:size; drop=drop==null?S.drop:drop; weeks=weeks==null?S.weeks:weeks;
  const gross=size/r.tvl_usd*(drop/100)*r.implied_value_usd;
  const cash=4*r.gas_usd+2*weeks;
  const net=gross-cash, hours=(85+15*weeks)/60;
  const tbill=size*TBILL*weeks/52;
  return {gross, cash, net, nph:net/hours, hours, tbill,
    verdict: net<=0?"SKIP":(net>=tbill?"FARM":"MARGINAL"),
    be0: cash/(size/r.tvl_usd*r.implied_value_usd)*100,
    beT: (cash+tbill)/(size/r.tvl_usd*r.implied_value_usd)*100};
}
function refreshScen(){ rows.forEach(r=>{ r._s=scen(r); }); }

async function loadBoard(){
  const urls=["../board.json","board.json","./board.json"];
  for(const u of urls){ try{ const r=await fetch(u); if(r.ok){ const txt=await r.text();
    return {data:JSON.parse(txt), text:txt}; } }catch(e){} }
  throw new Error("board.json not found");
}

/* --- header, evidence panel, seal --- */
const ACCT_COLORS=["oklch(0.78 0.16 195)","oklch(0.62 0.05 250)","oklch(0.55 0.10 230)","oklch(0.68 0.08 280)","oklch(0.70 0.19 25)","oklch(0.83 0.15 85)","oklch(0.80 0.16 150)"];
function renderHead(board){
  const total=board.rows.reduce((s,r)=>s+r.implied_value_usd,0);
  const medOdds=board.rows.map(r=>r.token_odds).sort((a,b)=>a-b)[Math.floor(board.rows.length/2)];
  const stats=[["Protocols ranked",board.rows.length],["Watchlist covered",M.board.watchlist+" / "+M.board.watchlist_total],
    ["Total implied value",fmt(total)],["Value if all launched",fmt(M.board.total_value_if_usd)],
    ["Median token odds",Math.round(medOdds*100)+"%"],["Snapshot date",M.as_of]];
  $("#stats").innerHTML=stats.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  const V=M.validation, O=M.odds, B=M.bands;
  $("#valstrip").innerHTML=
    [["Value miss — leave-one-out","×"+V.loo.model.toFixed(2),"fit without it; flat multiple ×"+V.loo.flat.toFixed(2)],
     ["Value miss — walk-forward","×"+V.wf.model.toFixed(2),"earlier listings price later ones ("+V.wf_n+" points); flat ×"+V.wf.flat.toFixed(2)],
     ["Value miss — holdout","×"+V.holdout.model.toFixed(2),V.repeats+" repeated 80/20 splits; flat multiple ×"+V.holdout.flat.toFixed(2)],
     ["Token-odds Brier — ten-fold",O.brier_cv.toFixed(3),"base rate "+O.brier_base.toFixed(3)+"; calibration slope "+O.calib_slope.toFixed(2)],
     ["Band coverage — leave-one-out",B.coverage[0].a+"% / "+B.coverage[0].b+"%","caps inside P25–P75 / P10–P90 vs 50% / 80% claims"],
     ["⚠ Odds calibration — WF","slope "+O.wf_slope.toFixed(2),"in time: over-confident; Brier "+O.brier_wf.toFixed(3)+" vs "+O.brier_wf_base.toFixed(3)]]
    .map(([k,v,s],i)=>`<div${i===5?' class="warn"':""}><span class="vk">${esc(k)}</span><b>${esc(v)}</b><span class="vs">${esc(s)}</span></div>`).join("");
  $("#asof").textContent=M.as_of;
  $("#acctbar").innerHTML=M.exclusions.map((e,i)=>`<i style="width:${(e.n/M.n_snapshot*100).toFixed(2)}%;background:${ACCT_COLORS[i%ACCT_COLORS.length]}" title="${esc(e.reason)}: ${e.n}"></i>`).join("");
  $("#acctleg").innerHTML=M.exclusions.map((e,i)=>`<span><span class="sw" style="background:${ACCT_COLORS[i%ACCT_COLORS.length]}"></span>${esc(e.reason.split(" (")[0])} <b>${e.n}</b></span>`).join("");
  const verdictTxt={base:"base model",kept:"KEPT","not-kept":"tested, not kept","passed-not-adopted":"passed both tests — not adopted"};
  const ablHead=`<tr><th>Term (added to the base, one at a time)</th><th class="n">Holdout</th><th class="n">Leave-one-out</th><th class="n">Walk-forward</th><th>Verdict</th></tr>`;
  const ablRow=a=>`<tr><td>${esc(a.t)}</td><td class="n">×${a.h.toFixed(2)}</td><td class="n">×${a.loo.toFixed(2)}</td><td class="n">×${a.wf.toFixed(2)}</td><td class="v ${a.v}">${verdictTxt[a.v]}</td></tr>`;
  $("#ablation").innerHTML=ablHead+[0,1,4,10,14,16].map(i=>ablRow(M.ablation[i])).join("");
  $("#ablation-full").innerHTML=ablHead+M.ablation.map(ablRow).join("");
}
function seal(board, text){
  const rs=board.rows; const bad=[]; const good=[];
  const chk=(ok,msg)=>{ (ok?good:bad).push(msg); };
  chk(rs.length===M.board.rows, `${rs.length} rows drawn = ${M.board.rows} written in board.json`);
  chk(rs.every((r,i)=>r.rank===i+1), `ranks 1..${rs.length} sequential`);
  chk(rs.every((r,i)=>i===0||r.implied_value_usd<rs[i-1].implied_value_usd), "implied values strictly decreasing with rank");
  const total=rs.reduce((s,r)=>s+r.implied_value_usd,0);
  chk(total===M.board.total_implied_usd, `total implied ${fmtFull(total)} recomputed = printed`);
  const wl=rs.filter(r=>r.watchlist).length;
  chk(wl===M.board.watchlist, `watchlist ${wl}/${M.board.watchlist_total} covered`);
  const accounted=M.exclusions.reduce((s,e)=>s+e.n,0);
  chk(accounted===M.n_snapshot, `ledger: ${accounted}/${M.n_snapshot} protocols accounted for`);
  let maxDev=0; rs.forEach(r=>{ if(r.value_if_launches_usd>0) maxDev=Math.max(maxDev, Math.abs(r.implied_value_usd/r.value_if_launches_usd - r.token_odds)); });
  chk(maxDev<=0.0001, `implied = value × odds on every row (odds to 4 dp; worst gap ${maxDev.toFixed(5)})`);
  const hash=sha256(text);
  chk(hash===M.board.sha256, `board.json sha256 ${hash.slice(0,16)}… matches`);
  $("#integrity").innerHTML=good.map(g=>`<li>${esc(g)}</li>`).join("")+bad.map(g=>`<li class="bad">${esc(g)}</li>`).join("");
  $("#seal").textContent = bad.length===0
    ? `SEAL ✓ this page = board.json · ${rs.length} rows · total ${fmtFull(total)} · watchlist ${wl}/${M.board.watchlist_total} · sha256 ${hash.slice(0,16)}…`
    : `SEAL ✗ mismatch: ${bad.join("; ")}`;
}

/* --- board table --- */
const COLS=[
  {k:"rank",t:"Rank"},{k:"name",t:"Protocol"},{k:"tvl_usd",t:"TVL"},{k:"change_7d",t:"7d"},
  {k:"age_days",t:"Age"},{k:"token_odds",t:"Token odds"},{k:"value_if_launches_usd",t:"If it launches"},
  {k:"implied_value_usd",t:"Implied value"},{k:"net",t:"Net of fees"},{k:"nph",t:"Net / hour"},{k:"farm_verdict",t:"Farm"}];
let bandMin=0, bandMax=1;
function buildHead(){
  $("#thead").innerHTML="<tr>"+COLS.map(c=>{
    const sorted=sortKey===c.k;
    return `<th scope="col" ${sorted?`aria-sort="${sortDir===1?"ascending":"descending"}"`:""}>`+
      (c.k==="farm_verdict" ? esc(c.t) : `<button type="button" data-sort="${c.k}">${esc(c.t)}</button>`)+"</th>"; }).join("")+"</tr>";
  document.querySelectorAll("[data-sort]").forEach(b=>b.addEventListener("click",()=>{
    const k=b.dataset.sort;
    if(sortKey===k) sortDir=-sortDir; else { sortKey=k; sortDir=(k==="rank"||k==="name")?1:-1; }
    buildHead(); renderBoard(); }));
}
function sortVal(r,k){
  if(k==="net") return r._s.net;
  if(k==="nph") return r._s.nph;
  const v=r[k]; return v==null?-1e18:v;
}
function matches(r){
  if(state.cat && r.category!==state.cat) return false;
  if(state.chain && (r.chains||[])[0]!==state.chain) return false;
  if(state.verd && r._s.verdict!==state.verd) return false;
  if(state.q){ const q=state.q.toLowerCase();
    const hay=(r.name+" "+(r.category||"")+" "+(r.chains||[]).join(" ")).toLowerCase();
    if(!hay.includes(q)) return false; }
  return true;
}
function rowEl(r){
  const tr=document.createElement("tr");
  const L=v=>Math.log(Math.max(v,1));
  const lo=((L(r.band_lo_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const hi=((L(r.band_hi_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const wlo=((L(r.wide_lo_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const whi=((L(r.wide_hi_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const mid=((L(r.value_if_launches_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const chg=r.change_7d==null?"—":`<span class="${r.change_7d>=0?"up":"down"}">${r.change_7d>=0?"▲":"▼"} ${pct(r.change_7d)}</span>`;
  const s=r._s;
  tr.innerHTML=
    `<td class="rank">${r.rank}</td>`+
    `<td><span class="pname">${esc(r.name)}</span>${r.watchlist?'<span class="wl">watchlist</span>':""}`+
    `<span class="pmeta">${esc(r.category||"—")} · ${esc((r.chains||[])[0]||"")}${(r.chains||[]).length>1?" +"+(r.chains.length-1):""}</span></td>`+
    `<td>${fmt(r.tvl_usd)}</td><td>${chg}</td><td>${ageTxt(r.age_days)}</td>`+
    `<td>${Math.round(r.token_odds*100)}%<span class="oddsbar"><i style="width:${(r.token_odds*100).toFixed(0)}%"></i></span></td>`+
    `<td><b>${fmt(r.value_if_launches_usd)}</b><span class="bandbar"><s style="left:${wlo}%;width:${Math.max(whi-wlo,1)}%"></s><i style="left:${lo}%;width:${Math.max(hi-lo,1.5)}%"></i><b style="left:${mid}%"></b></span>`+
    `<span class="bandtxt">${fmt(r.band_lo_usd)} – ${fmt(r.band_hi_usd)}</span></td>`+
    `<td><b>${fmt(r.implied_value_usd)}</b></td>`+
    `<td class="${s.net>=0?"netpos":"netneg"}">${sgn(s.net)}</td>`+
    `<td class="${s.nph>=0?"netpos":"netneg"}">${sgn(s.nph)}</td>`+
    `<td><span class="chip ${s.verdict}">${s.verdict}</span></td>`;
  tr.addEventListener("click",()=>openDetail(r));
  return tr;
}
function renderBoard(){
  const list=rows.filter(matches);
  list.sort((a,b)=>{ const va=sortVal(a,sortKey), vb=sortVal(b,sortKey);
    return typeof va==="string" ? sortDir*va.localeCompare(vb) : sortDir*(va-vb); });
  const tb=$("#tbody"); tb.textContent="";
  const frag=document.createDocumentFragment();
  list.forEach(r=>frag.appendChild(rowEl(r)));
  tb.appendChild(frag); updateShown(list.length);
}
function updateShown(n){
  $("#shown").textContent = view==="pre" ? `${n} of ${rows.length} rows shown` : view==="live" ? `${n} traded comps shown` : "";
}
function renderChips(){
  const counts={FARM:0,MARGINAL:0,SKIP:0};
  rows.forEach(r=>counts[r._s.verdict]++);
  const opts=[["","All"],["FARM","FARM"],["MARGINAL","MARGINAL"],["SKIP","SKIP"]];
  $("#vchips").innerHTML=opts.map(([v,l])=>`<button type="button" data-verd="${v}" aria-pressed="${state.verd===v}">${l}${v?" · "+counts[v]:""}</button>`).join("");
  document.querySelectorAll("[data-verd]").forEach(b=>b.addEventListener("click",()=>{
    state.verd=b.dataset.verd; renderChips(); renderBoard(); }));
  const med=rows.map(r=>r._s.net).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
  $("#scenread").innerHTML=`At this scenario: <b>${counts.FARM} FARM</b> · <b>${counts.MARGINAL} MARGINAL</b> · <b>${counts.SKIP} SKIP</b> · median net <b>${sgn(med)}</b> · a T-bill pays <b>${fmtFull(S.size*TBILL*S.weeks/52)}</b> on ${fmtFull(S.size)} over ${S.weeks} weeks`;
}

/* --- live comps view --- */
function renderLive(){
  $("#thead").innerHTML=`<tr><th scope="col">#</th><th scope="col">Protocol (traded)</th><th scope="col">TVL</th><th scope="col">Market cap</th><th scope="col">Cap / TVL</th></tr>`;
  const tb=$("#tbody"); tb.textContent="";
  const q=state.q.toLowerCase();
  const list=M.comps.filter(c=>!state.cat||c.c===state.cat)
    .filter(c=>!q||(c.n+" "+(c.c||"")).toLowerCase().includes(q));
  const frag=document.createDocumentFragment();
  list.forEach((c,i)=>{ const tr=document.createElement("tr");
    tr.innerHTML=`<td class="rank">${i+1}</td><td><span class="pname">${esc(c.n)}</span><span class="pmeta">${esc(c.c||"—")}</span></td>`+
      `<td>${fmt(c.t)}</td><td><b>${fmt(c.m)}</b></td><td>×${(c.m/c.t).toFixed(2)}</td>`;
    frag.appendChild(tr); });
  tb.appendChild(frag); updateShown(list.length);
}
function setView(v){
  view=v;
  document.querySelectorAll(".tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.view===v)));
  const isMethod=v==="method";
  $("#methodview").hidden=!isMethod;
  $(".tablewrap").style.display=isMethod?"none":"";
  $("#boardcap").textContent = v==="pre" ? "Pre-token protocols ranked by implied launch value (value if it launches × token odds)"
    : "Traded protocols used to fit the curve (reference — not ranked)";
  if(v==="pre"){ buildHead(); renderBoard(); } else if(v==="live"){ renderLive(); }
  else updateShown(0);
}

/* --- method view --- */
function renderMethod(){
  const F=M.fit;
  const eff=t=>(F.slope+2*F.quad*Math.log(t)).toFixed(2);
  $("#model-text").textContent=
    `Value if it launches = exp(${F.intercept} + ${F.slope} × ln TVL + ${F.quad} × (ln TVL)²) × category premium. `+
    `An ordinary-least-squares log-log fit on the ${M.n_calibration} snapshot protocols that already trade (R² ${F.r2}); the curvature term bends the effective slope from ${eff(5e7)} at $50M of TVL to ${eff(2.8e9)} at $2.8B. `+
    `Category premiums are each category's mean residual, shrunk toward 1.00 by n/(n+${M.shrink_k}). `+
    `A sanity cap holds every value at or below ${M.cap_ratio}× TVL — the ${M.cap_percentile}th percentile of traded comps' value/TVL — and binds ${M.n_capped} of ${M.board.rows} rows on this snapshot. `+
    `Implied value then multiplies by the token odds from the second model (right). Bands are cross-fitted residual quantiles, so the spread on the board is the spread the tests actually measured — not parameter wobble alone.`;
  drawScatter();
  const O=M.odds;
  $("#oddsev").innerHTML=
    `<table class="mini"><tr><th>Test</th><th class="n">Odds model</th><th class="n">Base rate</th></tr>`+
    `<tr><td>Brier score, ten-fold</td><td class="n">${O.brier_cv.toFixed(3)}</td><td class="n">${O.brier_base.toFixed(3)}</td></tr>`+
    `<tr><td>Brier score, walk-forward</td><td class="n">${O.brier_wf.toFixed(3)}</td><td class="n">${O.brier_wf_base.toFixed(3)}</td></tr>`+
    `<tr><td>AUC, ten-fold / walk-forward</td><td class="n">${O.auc_cv.toFixed(2)} / ${O.auc_wf.toFixed(2)}</td><td class="n">0.50</td></tr>`+
    `<tr><td>Calibration, out-of-fold</td><td class="n">slope ${O.calib_slope.toFixed(2)}</td><td class="n">intercept ${O.calib_intercept>=0?"+":""}${O.calib_intercept.toFixed(2)}</td></tr></table>`+
    `<div class="warnbox"><b>Printed warning:</b> forward in time the odds run over-confident — the walk-forward calibration slope is only ${O.wf_slope.toFixed(2)}, because recently listed protocols have had little time to launch and the age feature only partly corrects for it. The odds still beat the base rate on Brier in both protocols, so they are used — with this warning attached, not buried.</div>`+
    `<p class="note">A ridge logit (λ = ${O.lambda}, picked on a grid by ten-fold Brier) fitted on all ${M.n_snapshot} protocols: outcome = already records a token (${Math.round(O.base_rate*M.n_snapshot)}) vs pre-token. Features: log age without a token, ln TVL, 7-day growth, log chain count, category. TVL alone scores at the base rate — the signal lives in category and age.</p>`;
  $("#deciles").innerHTML=O.deciles.map((d,i)=>
    `<div class="decrow"><span>D${i+1}</span><span class="decbar"><i style="width:${(d[0]*100).toFixed(0)}%"></i><b style="left:${(d[1]*100).toFixed(0)}%"></b></span><span>pred ${d[0].toFixed(2)} · real ${d[1].toFixed(2)}</span></div>`).join("")+
    `<p class="note">Bar: mean predicted odds per decile. Tick: the share that actually records a token.</p>`;
  $("#oddsabl").innerHTML=`<tr><th>Feature set</th><th class="n">Brier</th></tr>`+
    O.ablation.map(a=>`<tr><td>${esc(a[0])}</td><td class="n">${a[1].toFixed(3)}</td></tr>`).join("");
  const B=M.bands;
  $("#bandcov").innerHTML=`<tr><th>Coverage test</th><th class="n">P25–P75 (claim 50%)</th><th class="n">P10–P90 (claim 80%)</th></tr>`+
    B.coverage.map(c=>`<tr><td>${esc(c.t)}</td><td class="n">${c.a}%</td><td class="n">${c.b}%</td></tr>`).join("")+
    `<tr><td colspan="3" class="note">Band widths: P25–P75 spans ×${B.width75} around the value estimate; P10–P90 spans ×${B.width90}. Quantiles: ${B.q25} / ${B.q75} and ${B.q10} / ${B.q90} in log space.</td></tr>`;
  $("#premiums").innerHTML=M.premiums.slice(0,14).map(p=>
    `<span>${esc(p.c)} <b>×${p.m.toFixed(2)}</b> (n=${p.n})</span>`).join("");
  $("#exclusions").innerHTML=M.exclusions.map(e=>
    `<tr><td>${esc(e.reason)}</td><td class="n">${e.n}</td></tr>`).join("")+
    `<tr><td><b>Snapshot total</b></td><td class="n"><b>${M.n_snapshot}</b></td></tr>`;
}
function drawScatter(){
  const cs=M.comps.filter(c=>c.t>0&&c.m>0); if(!cs.length) return;
  const W=520,Hh=250,pl=46,pb=26,pt=8,pr=8;
  const lx=v=>Math.log10(v);
  const xs=cs.map(c=>lx(c.t)), ys=cs.map(c=>lx(c.m));
  const x0=Math.floor(Math.min(...xs)), x1=Math.ceil(Math.max(...xs));
  const y0=Math.floor(Math.min(...ys)), y1=Math.ceil(Math.max(...ys));
  const X=v=>pl+(lx(v)-x0)/(x1-x0)*(W-pl-pr), Y=v=>Hh-pb-(lx(v)-y0)/(y1-y0)*(Hh-pt-pb);
  const f=t=>Math.exp(M.fit.intercept+M.fit.slope*Math.log(t)+M.fit.quad*Math.pow(Math.log(t),2));
  const line=(mult)=>{ let pts=""; for(let i=0;i<=16;i++){ const t=Math.pow(10,x0+(x1-x0)*i/16);
    pts+=`${X(t).toFixed(1)},${Y(f(t)*mult).toFixed(1)} `; } return pts; };
  let s=`<svg viewBox="0 0 ${W} ${Hh}">`;
  s+=`<rect x="${pl}" y="${pt}" width="${W-pl-pr}" height="${Hh-pt-pb}" fill="none" stroke="oklch(0.32 0.03 255)"/>`;
  for(let e=x0;e<=x1;e+=2) s+=`<text x="${X(Math.pow(10,e))}" y="${Hh-8}" fill="oklch(0.72 0.02 250)" font-size="9" text-anchor="middle">$1e${e}</text>`;
  s+=`<text x="6" y="${pt+8}" fill="oklch(0.72 0.02 250)" font-size="9">mcap →</text>`;
  s+=`<polygon fill="oklch(0.55 0.10 195)" fill-opacity="0.13" stroke="none" points="${line(Math.exp(M.bands.q75))}${line(Math.exp(M.bands.q25)).split(" ").filter(Boolean).reverse().join(" ")}"/>`;
  cs.forEach(c=>{ s+=`<circle cx="${X(c.t).toFixed(1)}" cy="${Y(c.m).toFixed(1)}" r="2.4" fill="oklch(0.78 0.16 195)" fill-opacity="0.55"/>`; });
  s+=`<polyline fill="none" stroke="oklch(0.83 0.15 85)" stroke-width="1.6" points="${line(1)}"/>`;
  s+=`</svg>`;
  $("#scatter").innerHTML=s;
}

/* --- detail view (full page) --- */
const PHASES=["VERIFY","FUND","CORE","SCALE","CADENCE","WATCH","CLAIM","EXIT"];
function oddsParts(r){
  const C=M.odds.coef;
  const missing=r.age_days==null, age=missing?C.age_med:r.age_days;
  const raw=[Math.log1p(Math.max(age,0)), Math.log(r.tvl_usd),
    (r.change_7d==null?0:Math.max(-60,Math.min(120,r.change_7d)))/100,
    Math.log(Math.max((r.chains||[]).length,1)), missing?1:0];
  const names=["Age without a token","TVL (log)","7-day growth","Chain count","No listing date"];
  const parts=raw.map((v,j)=>({n:names[j], c:C.cont[j]*(v-C.mu[j])/C.sd[j]}));
  parts.push({n:"Category: "+(r.category||"uncategorised"), c:C.cats[r.category]||0});
  const z=C.b0+parts.reduce((s,p)=>s+p.c,0);
  return {parts, odds:1/(1+Math.exp(-z))};
}
function peers(r){
  const prem={}; M.premiums.forEach(p=>prem[p.c]=p.m);
  const mv=c=>Math.exp(M.fit.intercept+M.fit.slope*Math.log(c.t)+M.fit.quad*Math.pow(Math.log(c.t),2))*(prem[c.c]||1);
  return [...M.comps].sort((a,b)=>Math.abs(Math.log(a.t/r.tvl_usd))-Math.abs(Math.log(b.t/r.tvl_usd)))
    .slice(0,7).map(c=>({c, model:mv(c)}));
}
function sensTable(r){
  const shares=[3.5,7,14], poss=[1000,10000,50000];
  let h=`<table class="mini sens"><tr><th>Drop share</th>`+poss.map(p=>`<th class="n">on ${fmtFull(p)}</th>`).join("")+`</tr>`;
  for(const sh of shares){
    h+=`<tr><td>${sh}%</td>`+poss.map(p=>{ const net=Math.round(scen(r,p,sh,S.weeks).net);
      return `<td class="n ${net>=0?"pos":"neg"}">${sgn(net)}</td>`; }).join("")+`</tr>`;
  }
  return h+`</table><p class="note">Net at the scenario horizon (${S.weeks} weeks) after this row's cash costs. The plan's own working capital is separate and comes back on exit.</p>`;
}
function openDetail(r){
  $("#d-name").textContent=r.name;
  $("#d-sub").textContent=`Rank ${r.rank} of ${rows.length} · ${r.category||"—"} · ${(r.chains||[]).join(", ")}${r.watchlist?" · on the official watchlist":""}`;
  const s=r._s, op=oddsParts(r);
  const maxAbs=Math.max(...op.parts.map(p=>Math.abs(p.c)),0.1);
  $("#d-body").innerHTML=
    `<div class="kv"><span><b>TVL</b> ${fmtFull(r.tvl_usd)}</span><span><b>7d</b> ${pct(r.change_7d)}</span>`+
    `<span><b>Listed for</b> ${ageTxt(r.age_days)}</span><span><b>Implied / TVL</b> ×${(r.implied_value_usd/r.tvl_usd).toFixed(3)}</span>`+
    `<span><b>Rank range (bootstrap P10–P90)</b> ${r.rank_lo} – ${r.rank_hi}</span></div>`+
    `<h3>How this figure is made — value, then odds</h3><dl class="wf">`+
    `<dt>Size curve at this TVL (global fit, with curvature)</dt><dd>${fmtFull(r.curve_value_usd)}</dd>`+
    `<dt>Category premium — ${esc(r.category||"uncategorised")} (shrunk)</dt><dd>× ${Number(r.premium_mult).toFixed(2)}</dd>`+
    (r.capped?`<dt>Sanity cap at ${M.cap_ratio}× TVL</dt><dd>applied</dd>`:`<dt>Sanity cap at ${M.cap_ratio}× TVL</dt><dd>not binding</dd>`)+
    `<dt><b>Value if it launches</b> (= curve × premium, capped)</dt><dd><b>${fmtFull(r.value_if_launches_usd)}</b></dd>`+
    `<dt>Band on the value — P25–P75 (cross-fitted residuals)</dt><dd>${fmtFull(r.band_lo_usd)} – ${fmtFull(r.band_hi_usd)}</dd>`+
    `<dt>Band on the value — wider P10–P90</dt><dd>${fmtFull(r.wide_lo_usd)} – ${fmtFull(r.wide_hi_usd)}</dd>`+
    `<dt>Token odds (decomposed below)</dt><dd>× ${r.token_odds.toFixed(2)}</dd>`+
    `<dt><b>Implied value (ranked)</b></dt><dd><b>${fmtFull(r.implied_value_usd)}</b></dd></dl>`+
    `<h3>Why these odds — the logit's contributions</h3>`+
    op.parts.map(p=>`<div class="contrib"><span>${esc(p.n)}</span><span class="cb${p.c<0?" neg":""}"><i style="left:${p.c<0?(50-Math.abs(p.c)/maxAbs*48):50}%;width:${(Math.abs(p.c)/maxAbs*48).toFixed(1)}%"></i></span><span class="cv">${p.c>=0?"+":"−"}${Math.abs(p.c).toFixed(2)}</span></div>`).join("")+
    `<p class="note">Contributions in log-odds points around the intercept; they sum to this row's fitted odds of ${(op.odds*100).toFixed(0)}% (board prints ${Math.round(r.token_odds*100)}%). The snapshot base rate is ${Math.round(M.odds.base_rate*100)}%. Remember the printed warning: forward in time these odds run over-confident (walk-forward calibration slope ${M.odds.wf_slope.toFixed(2)}).</p>`+
    `<h3>Nearest traded peers — actual caps vs the same model</h3>`+
    `<table class="peers"><tr><th>Peer</th><th>TVL</th><th>Actual cap</th><th>Cap/TVL</th><th>Model value</th><th>Actual ÷ model</th></tr>`+
    peers(r).map(({c,model})=>`<tr><td><b>${esc(c.n)}</b> <span class="pmeta">${esc(c.c||"")}</span></td><td>${fmt(c.t)}</td><td>${fmt(c.m)}</td><td>×${(c.m/c.t).toFixed(2)}</td><td>${fmt(model)}</td><td>×${(c.m/model).toFixed(2)}</td></tr>`).join("")+`</table>`+
    `<h3>Verdict at the current scenario — plan ${fmtFull(S.size)}, drop share ${S.drop}%, ${S.weeks} weeks</h3>`+
    `<dl class="wf"><dt>Expected gross (share of TVL × drop share × implied)</dt><dd>${fmtFull(s.gross)}</dd>`+
    `<dt>Cash costs over the horizon</dt><dd>−${fmtFull(s.cash)}</dd>`+
    `<dt><b>Net of fees</b></dt><dd><b>${sgn(s.net)}</b></dd>`+
    `<dt>Hands-on time</dt><dd>${s.hours.toFixed(1)} h → net ${sgn(s.nph)}/hour</dd>`+
    `<dt>T-bill at 4%/yr on the same money</dt><dd>${fmtFull(s.tbill)}</dd>`+
    `<dt>Net vs T-bill</dt><dd>${s.net>=s.tbill?"beats it by "+fmtFull(s.net-s.tbill):"misses it by "+fmtFull(s.tbill-s.net)}</dd>`+
    `<dt>Break-even drop share (net = 0)</dt><dd>${s.be0.toFixed(1)}%</dd>`+
    `<dt>Break-even drop share (net = T-bill)</dt><dd>${s.beT.toFixed(1)}%</dd>`+
    `<dt><b>Scenario verdict</b></dt><dd><span class="chip ${s.verdict}">${s.verdict}</span></dd></dl>`+
    `<p class="note">Exit rule, quantified: withdraw if TVL falls 25% or more within 7 days, if no token or rewards are announced by day ${r.hold_days}, or immediately on any official exploit warning — whichever comes first (step 8 of the plan).</p>`+
    sensTable(r)+
    `<h3>Farm plan — ${r.farm_steps.length} steps · plan verdict <span class="chip ${esc(r.farm_verdict)}">${esc(r.farm_verdict)}</span></h3>`+
    `<p class="planecon">Working capital <b>${fmtFull(r.farm_capital_usd)}</b> (returned on exit) · cash costs ≈ <b>${fmtFull(r.farm_cash_cost_usd)}</b> over the plan's own ${r.hold_days}-day hold · upkeep 15 min/week</p>`+
    `<ol class="farm">${r.farm_steps.map((st,i)=>{
      const cost=(st.match(/Cost: ([^.]+)\./)||[])[1]||"", time=(st.match(/Time: ([^.]+)\./)||[])[1]||"";
      return `<li><span class="phase">${PHASES[i]||"STEP"}</span>${esc(st)} <span class="ctchip">Cost <b>${esc(cost)}</b></span> <span class="ctchip">Time <b>${esc(time)}</b></span></li>`; }).join("")}</ol>`;
  $("#boardview").hidden=true; $("#detailview").hidden=false;
  window.scrollTo(0,0);
}
function closeDetail(){ $("#detailview").hidden=true; $("#boardview").hidden=false; }

/* --- wiring --- */
function init(board, text){
  rows=board.rows;
  bandMin=Math.min(...rows.map(r=>Math.log(Math.max(r.wide_lo_usd,1))));
  bandMax=Math.max(...rows.map(r=>Math.log(r.wide_hi_usd)));
  refreshScen();
  renderHead(board); seal(board, text); renderMethod();
  const cats=[...new Set(rows.map(r=>r.category).filter(Boolean))].sort();
  $("#cat").innerHTML='<option value="">All categories</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join("");
  const chains=[...new Set(rows.map(r=>(r.chains||[])[0]).filter(Boolean))].sort();
  $("#chain").innerHTML='<option value="">All chains</option>'+chains.map(c=>`<option>${esc(c)}</option>`).join("");
  buildHead(); renderChips(); renderBoard();
  $("#q").addEventListener("input",e=>{ state.q=e.target.value; view==="pre"?renderBoard():view==="live"&&renderLive(); });
  $("#cat").addEventListener("change",e=>{ state.cat=e.target.value; view==="pre"?renderBoard():view==="live"&&renderLive(); });
  $("#chain").addEventListener("change",e=>{ state.chain=e.target.value; if(view==="pre") renderBoard(); });
  document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  const upd=()=>{ S.size=+$("#in-size").value; S.drop=+$("#in-drop").value; S.weeks=+$("#in-weeks").value;
    $("#v-size").textContent=fmtFull(S.size); $("#v-drop").textContent=S.drop+"%"; $("#v-weeks").textContent=S.weeks+" weeks";
    refreshScen(); renderChips(); if(view==="pre") renderBoard(); };
  ["in-size","in-drop","in-weeks"].forEach(id=>$("#"+id).addEventListener("input",upd));
  upd();
  $("#backbtn").addEventListener("click",closeDetail);
}
loadBoard().then(({data,text})=>init(data,text)).catch(e=>{
  $("#seal").textContent="SEAL ✗ board.json could not be loaded ("+e.message+"). Serve this folder over HTTP or place board.json beside index.html.";
});
