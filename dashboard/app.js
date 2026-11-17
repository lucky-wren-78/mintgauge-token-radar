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

/* --- state --- */
let rows=[], view="pre", sortKey="rank", sortDir=1;
const state={q:"",cat:"",verd:""};

async function loadBoard(){
  const urls=["../board.json","board.json","./board.json"];
  for(const u of urls){ try{ const r=await fetch(u); if(r.ok){ const txt=await r.text();
    return {data:JSON.parse(txt), text:txt}; } }catch(e){} }
  throw new Error("board.json not found");
}

/* --- header, seal, methodology --- */
function renderHead(board){
  const total=board.rows.reduce((s,r)=>s+r.implied_value_usd,0);
  const stats=[["Protocols ranked",board.rows.length],["Watchlist covered",M.board.watchlist+" / "+M.board.watchlist_total],
    ["Total implied value",fmt(total)],["Model holdout miss","×"+M.holdout.model_miss.toFixed(2)],
    ["Flat multiple miss","×"+M.holdout.flat_miss.toFixed(2)],["Snapshot date",M.as_of]];
  $("#stats").innerHTML=stats.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#asof").textContent=M.as_of;
  $("#model-text").textContent=
    `Implied value = exp(${M.fit.intercept} + ${M.fit.slope} × ln TVL) × category premium. `+
    `The curve is an ordinary-least-squares log-log fit on the ${M.n_calibration} snapshot protocols that already trade `+
    `(slope ${M.fit.slope}: 10× the TVL ≈ ${(Math.pow(10,M.fit.slope)).toFixed(2)}× the value; R² ${M.fit.r2}). `+
    `Category premiums are each category's mean residual, shrunk toward 1.00 by n/(n+${M.shrink_k}) so thin categories cannot dominate. `+
    `A sanity cap keeps every implied value at or below ${M.cap_ratio}× TVL — the ${M.cap_percentile}th percentile of traded comps' value/TVL — `+
    `and binds ${M.n_capped} of ${M.board.rows} rows on this snapshot. Momentum and age were tested as extra regressors and rejected: `+
    `they did not improve the holdout, so they are not in the model.`;
  $("#holdout").innerHTML=
    `<tr><th>Model</th><th>Median miss</th><th>Within ×2</th></tr>`+
    `<tr><td>Fitted curve + category premiums (this board)</td><td>×${M.holdout.model_miss.toFixed(2)}</td><td>${M.holdout.model_within2}%</td></tr>`+
    `<tr><td>Flat multiple (${M.flat_multiple}× TVL)</td><td>×${M.holdout.flat_miss.toFixed(2)}</td><td>${M.holdout.flat_within2}%</td></tr>`;
  $("#exclusions").innerHTML=M.exclusions.map(e=>
    `<tr><td>${esc(e.reason)}</td><td>${e.n}</td></tr>`).join("")+
    `<tr><td><b>Snapshot total</b></td><td><b>${M.n_snapshot}</b></td></tr>`;
  $("#premiums").innerHTML=M.premiums.slice(0,14).map(p=>
    `<span>${esc(p.c)} <b>×${p.m.toFixed(2)}</b> (n=${p.n})</span>`).join("");
  drawScatter();
}
function seal(board, text){
  const rs=board.rows; let ok=true; const why=[];
  if(rs.length!==M.board.rows){ ok=false; why.push("row count differs from model data"); }
  rs.forEach((r,i)=>{ if(r.rank!==i+1){ ok=false; why.push("ranks not sequential"); } });
  for(let i=1;i<rs.length;i++) if(rs[i].implied_value_usd>rs[i-1].implied_value_usd){ ok=false; why.push("values not non-increasing"); break; }
  const total=rs.reduce((s,r)=>s+r.implied_value_usd,0);
  if(total!==M.board.total_implied_usd){ ok=false; why.push("total differs"); }
  const hash=sha256(text);
  if(hash!==M.board.sha256){ ok=false; why.push("hash differs"); }
  const wl=rs.filter(r=>r.watchlist).length;
  $("#seal").textContent = ok
    ? `SEAL ✓ this page = board.json · ${rs.length} rows drawn = ${rs.length} written · ranks 1..${rs.length} sequential · values non-increasing · total ${fmtFull(total)} · watchlist ${wl}/${M.board.watchlist_total} · sha256 ${hash.slice(0,16)}…`
    : `SEAL ✗ mismatch: ${why.join("; ")}`;
}
function drawScatter(){
  const cs=M.comps.filter(c=>c.t>0&&c.m>0); if(!cs.length) return;
  const W=520,Hh=250,pl=46,pb=26,pt=8,pr=8;
  const lx=v=>Math.log10(v), ly=v=>Math.log10(v);
  const xs=cs.map(c=>lx(c.t)), ys=cs.map(c=>ly(c.m));
  const x0=Math.floor(Math.min(...xs)), x1=Math.ceil(Math.max(...xs));
  const y0=Math.floor(Math.min(...ys)), y1=Math.ceil(Math.max(...ys));
  const X=v=>pl+(lx(v)-x0)/(x1-x0)*(W-pl-pr), Y=v=>Hh-pb-(ly(v)-y0)/(y1-y0)*(Hh-pt-pb);
  let s=`<svg viewBox="0 0 ${W} ${Hh}">`;
  s+=`<rect x="${pl}" y="${pt}" width="${W-pl-pr}" height="${Hh-pt-pb}" fill="none" stroke="oklch(0.32 0.03 255)"/>`;
  for(let e=x0;e<=x1;e+=2) s+=`<text x="${X(Math.pow(10,e))}" y="${Hh-8}" fill="oklch(0.72 0.02 250)" font-size="9" text-anchor="middle">$1e${e}</text>`;
  s+=`<text x="6" y="${pt+8}" fill="oklch(0.72 0.02 250)" font-size="9">mcap →</text>`;
  cs.forEach(c=>{ s+=`<circle cx="${X(c.t).toFixed(1)}" cy="${Y(c.m).toFixed(1)}" r="2.4" fill="oklch(0.78 0.16 195)" fill-opacity="0.55"/>`; });
  const f=t=>Math.exp(M.fit.intercept+M.fit.slope*Math.log(t));
  s+=`<polyline fill="none" stroke="oklch(0.83 0.15 85)" stroke-width="1.6" points="${X(Math.pow(10,x0)).toFixed(1)},${Y(f(Math.pow(10,x0))).toFixed(1)} ${X(Math.pow(10,x1)).toFixed(1)},${Y(f(Math.pow(10,x1))).toFixed(1)}"/>`;
  s+=`</svg>`;
  $("#scatter").innerHTML=s;
}

/* --- board table --- */
const COLS=[
  {k:"rank",t:"Rank",num:1},{k:"name",t:"Protocol",num:0},{k:"tvl_usd",t:"TVL",num:1},
  {k:"change_7d",t:"7d",num:1},{k:"age_days",t:"Age",num:1},{k:"implied_value_usd",t:"Implied value",num:1},
  {k:"band",t:"Band (IQR)",num:0},{k:"farm_verdict",t:"Farm",num:0}];
let bandMin=0, bandMax=1;
function buildHead(){
  $("#thead").innerHTML="<tr>"+COLS.map(c=>{
    const sorted=sortKey===c.k;
    return `<th scope="col" ${sorted?`aria-sort="${sortDir===1?"ascending":"descending"}"`:""} data-k="${c.k}">`+
      (c.k==="band"||c.k==="farm_verdict"||c.k==="name"&&false ? esc(c.t) :
      `<button type="button" data-sort="${c.k}">${esc(c.t)}</button>`)+"</th>"; }).join("")+"</tr>";
  document.querySelectorAll("[data-sort]").forEach(b=>b.addEventListener("click",()=>{
    const k=b.dataset.sort;
    if(sortKey===k) sortDir=-sortDir; else { sortKey=k; sortDir=(k==="rank"||k==="name")?1:-1; }
    applySort(); buildHead(); }));
}
function rowEl(r){
  const tr=document.createElement("tr");
  const lo=((Math.log(r.band_lo_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const hi=((Math.log(r.band_hi_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const mid=((Math.log(r.implied_value_usd)-bandMin)/(bandMax-bandMin)*100).toFixed(1);
  const chg=r.change_7d==null?"—":`<span class="${r.change_7d>=0?"up":"down"}">${r.change_7d>=0?"▲":"▼"} ${pct(r.change_7d)}</span>`;
  tr.innerHTML=
    `<td class="rank">${r.rank}</td>`+
    `<td><span class="pname">${esc(r.name)}</span>${r.watchlist?'<span class="wl">watchlist</span>':""}`+
    `<span class="pmeta">${esc(r.category||"—")} · ${esc((r.chains||[])[0]||"")}${(r.chains||[]).length>1?" +"+(r.chains.length-1):""}</span></td>`+
    `<td data-v="${r.tvl_usd}">${fmt(r.tvl_usd)}</td><td data-v="${r.change_7d==null?-1e9:r.change_7d}">${chg}</td>`+
    `<td data-v="${r.age_days==null?-1:r.age_days}">${ageTxt(r.age_days)}</td>`+
    `<td data-v="${r.implied_value_usd}"><b>${fmt(r.implied_value_usd)}</b></td>`+
    `<td><span class="bandbar"><i style="left:${lo}%;width:${Math.max(hi-lo,1.5)}%"></i><b style="left:${mid}%"></b></span>`+
    `<span class="bandtxt">${fmt(r.band_lo_usd)} – ${fmt(r.band_hi_usd)}</span></td>`+
    `<td><span class="chip ${esc(r.farm_verdict)}">${esc(r.farm_verdict)}</span></td>`;
  tr.addEventListener("click",()=>openDetail(r));
  tr._row=r;
  return tr;
}
function matches(r){
  if(state.cat && r.category!==state.cat) return false;
  if(state.verd && r.farm_verdict!==state.verd) return false;
  if(state.q){ const q=state.q.toLowerCase();
    const hay=(r.name+" "+(r.category||"")+" "+(r.chains||[]).join(" ")).toLowerCase();
    if(!hay.includes(q)) return false; }
  return true;
}
function renderBoard(){
  const tb=$("#tbody"); tb.textContent="";
  const frag=document.createDocumentFragment();
  rows.filter(matches).forEach(r=>frag.appendChild(rowEl(r)));
  tb.appendChild(frag);
  applySort(); updateShown();
}
function applySort(){
  const tb=$("#tbody"); const trs=[...tb.children];
  const idx={rank:0,tvl_usd:2,change_7d:3,age_days:4,implied_value_usd:5}[sortKey];
  trs.sort((a,b)=>{
    let va,vb;
    if(sortKey==="rank"){ va=a._row.rank; vb=b._row.rank; }
    else if(sortKey==="name"){ va=a._row.name.toLowerCase(); vb=b._row.name.toLowerCase();
      return sortDir*va.localeCompare(vb); }
    else { va=parseFloat(a.children[idx].dataset.v); vb=parseFloat(b.children[idx].dataset.v); }
    return sortDir*(va-vb);
  });
  trs.forEach(tr=>tb.appendChild(tr));
}
function updateShown(){
  const n=$("#tbody").children.length;
  $("#shown").textContent = view==="pre" ? `${n} of ${rows.length} rows shown` : `${n} traded comps shown`;
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
  tb.appendChild(frag); updateShown();
}
function setView(v){
  view=v;
  document.querySelectorAll(".tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.view===v)));
  $("#boardcap").textContent = v==="pre" ? "Pre-token protocols ranked by implied launch value"
    : "Traded protocols used to fit the curve (reference — not ranked)";
  $("#verd").disabled = v!=="pre";
  if(v==="pre"){ buildHead(); renderBoard(); } else renderLive();
}

/* --- detail dialog --- */
function nearestComps(r){
  const d = c => Math.abs(Math.log(c.t / r.tvl_usd));
  return [...M.comps].sort((a, b) => d(a) - d(b)).slice(0, 3);
}
function openDetail(r){
  $("#d-name").textContent=r.name;
  $("#d-sub").textContent=`Rank ${r.rank} of ${rows.length} · ${r.category||"—"} · ${(r.chains||[]).join(", ")}${r.watchlist?" · on the official watchlist":""}`;
  const comps=nearestComps(r).map(c=>
    `<div><b>${esc(c.n)}</b> — TVL ${fmt(c.t)}, real market cap ${fmt(c.m)} (×${(c.m/c.t).toFixed(2)})</div>`).join("");
  $("#d-body").innerHTML=
    `<div class="kv"><span><b>TVL</b> ${fmtFull(r.tvl_usd)}</span><span><b>7d</b> ${pct(r.change_7d)}</span>`+
    `<span><b>Listed for</b> ${ageTxt(r.age_days)}</span><span><b>Implied / TVL</b> ×${(r.implied_value_usd/r.tvl_usd).toFixed(3)}</span></div>`+
    `<h3>How this value is built</h3><dl class="wf">`+
    `<dt>Size curve at this TVL (global fit)</dt><dd>${fmtFull(r.curve_value_usd)}</dd>`+
    `<dt>Category premium — ${esc(r.category||"uncategorised")} (shrunk)</dt><dd>× ${Number(r.premium_mult).toFixed(2)}</dd>`+
    (r.capped?`<dt>Sanity cap at ${M.cap_ratio}× TVL</dt><dd>applied</dd>`:`<dt>Sanity cap at ${M.cap_ratio}× TVL</dt><dd>not binding</dd>`)+
    `<dt><b>Implied launch value</b></dt><dd><b>${fmtFull(r.implied_value_usd)}</b></dd>`+
    `<dt>Band — cross-fitted residual IQR</dt><dd>${fmtFull(r.band_lo_usd)} – ${fmtFull(r.band_hi_usd)}</dd>`+
    `<dt>Band — wider P10–P90</dt><dd>${fmtFull(r.wide_lo_usd)} – ${fmtFull(r.wide_hi_usd)}</dd>`+
    `<dt>Rank range (200 bootstrap refits, P10–P90)</dt><dd>${r.rank_lo} – ${r.rank_hi}</dd></dl>`+
    `<h3>Nearest traded comparables</h3><div class="comps">${comps}</div>`+
    `<h3>Farm plan — verdict <span class="chip ${esc(r.farm_verdict)}">${esc(r.farm_verdict)}</span></h3>`+
    `<ol class="farm">${r.farm_steps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>`;
  const d=$("#detail"); if(typeof d.showModal==="function") d.showModal(); else d.setAttribute("open","");
}

/* --- wiring --- */
function init(board, text){
  rows=board.rows;
  bandMin=Math.min(...rows.map(r=>Math.log(r.band_lo_usd)));
  bandMax=Math.max(...rows.map(r=>Math.log(r.band_hi_usd)));
  renderHead(board); seal(board, text);
  const cats=[...new Set(rows.map(r=>r.category).filter(Boolean))].sort();
  $("#cat").innerHTML='<option value="">All categories</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join("");
  buildHead(); renderBoard();
  $("#q").addEventListener("input",e=>{ state.q=e.target.value; view==="pre"?renderBoard():renderLive(); });
  $("#cat").addEventListener("change",e=>{ state.cat=e.target.value; view==="pre"?renderBoard():renderLive(); });
  $("#verd").addEventListener("change",e=>{ state.verd=e.target.value; renderBoard(); });
  document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
}
loadBoard().then(({data,text})=>init(data,text)).catch(e=>{
  $("#seal").textContent="SEAL ✗ board.json could not be loaded ("+e.message+"). Serve this folder over HTTP or place board.json beside index.html.";
});
