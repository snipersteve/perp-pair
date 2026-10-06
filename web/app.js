const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const color=n=>n>=0?'positive':'negative';
let state,selected,editing=false,csrf='',revision=0;
const form=$('#pairForm');
function toast(msg){$('#toast').textContent=msg;$('#toast').style.display='block';setTimeout(()=>$('#toast').style.display='none',5000)}
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d}
function fill(p){
 editing=false;revision=p.revision;
 for(const name of ['id','aSymbol','bSymbol','mode','direction','orderUsd','capUsd','openPct','closePct'])form.elements[name].value=p[name];
 form.elements.id.readOnly=!!selected;$('#formStatus').textContent='版本 '+revision;
}
function pick(id){selected=id;const p=state.pairs.find(p=>p.id===id);if(p)fill(p);render()}
form.addEventListener('input',()=>{editing=true;$('#formStatus').textContent='有未保存修改'});
form.addEventListener('submit',async ev=>{
 ev.preventDefault();const d=Object.fromEntries(new FormData(form));for(const k of ['orderUsd','capUsd','openPct','closePct'])d[k]=Number(d[k]);d.revision=revision;
 try{await api('/api/pairs',d);selected=d.id;editing=false;await refresh();fill(state.pairs.find(p=>p.id===selected));toast('已保存')}catch(e){toast(e.message)}
});
$('#add').onclick=()=>{selected=null;fill({id:'',aSymbol:'',bSymbol:'',mode:'stop',direction:'both',orderUsd:20,capUsd:100,openPct:0.2,closePct:-0.1,revision:0});editing=true;form.elements.id.readOnly=false};
for(const [el,action] of [['pause','pause'],['resume','resume'],['recover','recover'],['ack','acknowledge']]){
 $('#'+el).onclick=async()=>{if(action==='resume'&&!confirm('确认以独立账户开始实盘？仅 run/reduce 的交易对执行。'))return;if(action==='acknowledge'&&!confirm('确认已核对异常？系统仍会强制检查所有订单和仓位。'))return;try{await api('/api/control',{action});toast('操作完成');await refresh()}catch(e){toast(e.message)}};
}
function render(){
 if(!state)return;
 const e=state,p=e.pairs.find(x=>x.id===selected),live=e.mode==='live';
 $('#topStatus').textContent=(live?'实盘':'只读观察')+' · '+e.firstTif+(e.sharedAccount?(e.sharedAuto?' · 共享账户/合约专属':' · 共享账户/人工探针'):'');
 $('#resume').disabled=!live||!e.paused||!!e.halt||(e.sharedAccount&&!e.sharedAuto);
 $('#banner').textContent=e.halt?'熔断：'+e.halt:(e.paused?'暂停 · ':'运行 · ')+e.reason+(e.lastError?' / '+e.lastError:'');
 const vals=[['策略净值估算 U',e.pnl.total],['已实现盈亏 U',e.pnl.realized],['未实现盈亏 U',e.pnl.unrealized],['资金费 U',e.pnl.funding],['手续费估算 U',-e.pnl.feesEstimated]];
 $('#metrics').innerHTML=vals.map(([label,value])=>'<div class="metric"><div class="label">'+label+'</div><div class="value '+color(value)+'">'+fmt(value)+'</div></div>').join('');
 $('#pairList').innerHTML=e.pairs.map(p=>'<div class="pair-item '+(p.id===selected?'active':'')+'" data-id="'+esc(p.id)+'"><b>'+esc(p.aSymbol.replace(/USDT$/,''))+'</b> <span class="badge">'+esc(p.mode)+'</span><small>A '+fmt(p.aPosition.qty,4)+' / B '+fmt(p.bPosition.qty,4)+'</small></div>').join('');
 $('#pairList').querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>pick(el.dataset.id));
 if(p){
  $('#pairTitle').textContent=p.aSymbol.replace(/USDT$/,'')+' · 双合约';$('#capability').textContent=p.capability;$('#pairMode').textContent=p.mode.toUpperCase();
  $('#quotes').innerHTML=[['买 Aster / 卖 Binance',p.buy],['卖 Aster / 买 Binance',p.sell]].map(([title,q])=>'<div class="quote"><div>'+title+'</div><div class="spread '+color(q.netPct)+'">'+fmt(q.netPct,3)+'%</div><div class="muted">净价差'+(q.executable?' · 可执行':' · 参考')+' · '+esc(q.reason)+(q.qty?' · '+fmt(q.qty,4)+' 枚':'')+'</div></div>').join('');
  const book=(name,b,f)=>'<div><b>'+name+'</b><div class="muted">资费 '+fmt(f?.rate*100,4)+'% · 下次 '+(f?.nextTime?new Date(f.nextTime).toLocaleTimeString():'—')+'</div><table><thead><tr><th>买价</th><th>买量</th><th>卖价</th><th>卖量</th></tr></thead><tbody>'+Array.from({length:5},(_,i)=>'<tr><td class="positive">'+fmt(b?.bids[i]?.[0],6)+'</td><td>'+fmt(b?.bids[i]?.[1],1)+'</td><td class="negative">'+fmt(b?.asks[i]?.[0],6)+'</td><td>'+fmt(b?.asks[i]?.[1],1)+'</td></tr>').join('')+'</tbody></table></div>';
  $('#depth').innerHTML=book('Aster',p.aBook,p.aFunding)+book('Binance',p.bBook,p.bFunding);
  $('#bookAge').textContent='接收年龄 A '+(p.aBook?e.now-p.aBook.receivedAt:'—')+'ms / B '+(p.bBook?e.now-p.bBook.receivedAt:'—')+'ms';
  if(!editing&&revision!==p.revision)fill(p);
 }
 $('#trades').innerHTML=e.trades.map(t=>{const d=t.detail;return '<tr><td>'+new Date(t.created).toLocaleString()+'</td><td>'+esc(t.pair_id)+'</td><td>'+esc(d.candidate?.side)+' '+(d.candidate?.closing?'平':'开')+'</td><td>'+fmt(d.a?.qty,4)+' / '+fmt(d.b?.qty,4)+'</td><td title="'+esc(d.error||'')+'">'+esc(t.status)+'</td><td>'+fmt(d.fokConfirmMs,0)+'ms</td><td>'+fmt(d.hedgeMs,0)+'ms</td></tr>'}).join('')||'<tr><td colspan="7">暂无执行；观察模式不生成模拟盈利。</td></tr>';
 $('#events').innerHTML=e.events.map(v=>'<div class="event '+(v.level==='error'?'negative':'')+'"><span class="muted">'+new Date(v.time).toLocaleTimeString()+'</span> '+esc(v.message)+'</div>').join('');
 const l=e.limits;
 $('#riskInfo').textContent='单笔硬顶 '+l.maxOrderUsd+'U · 总仓位 '+l.totalCap+'U · 日亏损熔断 '+l.dailyLoss+'U · 深度折扣 '+l.trust+' · 执行缓冲 '+l.buffer+'% · 盘口年龄 '+l.maxAge+'ms · 双边时差 '+l.maxSkew+'ms';
}
let polling=false;
async function refresh(){if(polling)return;polling=true;try{state=await api('/api/state');csrf=state.csrf;if(selected===undefined&&state.pairs.length){selected=state.pairs[0].id;fill(state.pairs[0])}render()}catch(e){$('#banner').textContent='连接异常：'+e.message}finally{polling=false}}
await refresh();
async function markets(){try{const rows=await api('/api/markets');$('#symbols').innerHTML=rows.map(r=>'<option value="'+esc(r.symbol)+'"></option>').join('');if(!rows.length)setTimeout(markets,5000)}catch{}}
void markets();
setInterval(refresh,1000);
