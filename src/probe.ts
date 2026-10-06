// Explicit standalone FOK/IOC capability probe; production service MUST be stopped (same data-directory lock).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { Circuit } from './exchanges/http.js'
import { Exchange } from './exchanges/client.js'
import { Engine } from './engine.js'
import { processLock } from './process-lock.js'
import { assertOwnership } from './shared-account.js'
import { commonStep,decimal,priceBound,quantize,sweep,validBook } from './math.js'
const args=process.argv.slice(2)
const flag=(name:string,def:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:def}
const mode=flag('--mode','metadata'),symbol=flag('--symbol','龙虾USDT')
const maxUsd=Number(flag('--max-usd','10'))
if(!['metadata','account','validate','no-fill','fill','close'].includes(mode)||!(maxUsd>=5&&maxUsd<=20))throw Error('mode=metadata|validate|no-fill|fill; max-usd必须5~20')
const original=loadConfig()
if(mode!=='metadata'&&original.mode!=='live')throw Error('私有核验需完整live环境；共享凭证仅通过显式配置读取')
if(['no-fill','fill','close'].includes(mode)&&!args.includes('--confirm-real-orders'))throw Error('真实订单需 --confirm-real-orders；可能留下对冲仓位并产生手续费')
const tif=flag('--tif',original.firstTif)
if(tif!=='FOK'&&tif!=='IOC')throw Error('--tif必须为FOK或IOC')
const cfg:typeof original={...original,firstTif:tif,fokVerified:tif==='FOK'}
mkdirSync(cfg.dataDir,{recursive:true,mode:0o700})
const unlock=processLock(cfg.dataDir),store=new Store(join(cfg.dataDir,'perp-pair.sqlite')),circuit=new Circuit(store,cfg.rateLimitStopHook)
const note=(m:string)=>store.event('info',m)
const a=new Exchange('aster',cfg,circuit,note),b=new Exchange('binance',cfg,circuit,note)
try{
 await Promise.all([a.init(),b.init()])
 const ar=a.rules.get(symbol),br=b.rules.get(symbol)
 if(!ar||!br)throw Error('两所没有同名合约')
 console.log(JSON.stringify({symbol,asterTimeInForce:ar.timeInForce,binanceTimeInForce:br.timeInForce,probeTimeInForce:cfg.firstTif},null,2))
 if(mode!=='metadata'){
  const e=new Engine(cfg,store,a,b,circuit)
  await e.recover()
  if(e.halt)throw Error('存在历史熔断，请先通过服务恢复查询/对账并解除：'+e.halt)
  if(store.pending().length)throw Error('存在未知订单，不能核验')
  const [aa,bb]=await Promise.all([a.refreshAccount(),b.refreshAccount()])
  assertOwnership(cfg,symbol)
  console.log('account preflight:',JSON.stringify({aster:{available:aa.available,positions:aa.positions},binance:{available:bb.available,positions:bb.positions},sharedAccount:cfg.sharedAccount}))
  if(mode==='account'){await e.reconcile();process.exitCode=0}
  else {
  if(mode!=='close'&&(aa.positions.length||bb.positions.length||store.positions().some(p=>p.qty!==0)))throw Error('核验要求受管合约和本地账本都空仓')
  await e.reconcile()
  const existing=store.pairs().find(p=>p.aSymbol===symbol||p.bSymbol===symbol)
  const pair=existing||{id:'probe',aSymbol:symbol,bSymbol:symbol,mode:'stop' as const,orderUsd:maxUsd,capUsd:20,openPct:0,closePct:0,direction:'both' as const,revision:1}
  if(pair.aSymbol!==symbol||pair.bSymbol!==symbol)throw Error('与现有pair映射不一致')
  if(!existing)store.savePair(pair)
  a.subscribe([symbol]);b.subscribe([symbol])
  const until=Date.now()+15000
  while((!validBook(a.books.get(symbol),Date.now(),cfg.maxAge)||!validBook(b.books.get(symbol),Date.now(),cfg.maxAge))&&Date.now()<until)await new Promise(r=>setTimeout(r,100))
  const ab=a.books.get(symbol),bbk=b.books.get(symbol)
  if(!validBook(ab,Date.now(),cfg.maxAge)||!validBook(bbk,Date.now(),cfg.maxAge))throw Error('双边深度未就绪')
  const closing=mode==='close',position=store.position('aster',symbol).qty
  if(closing&&position<=0)throw Error('该探针只平自己的多A空B仓位，当前不存在')
  const qty=closing?position:quantize(Math.min(maxUsd,cfg.maxOrderUsd)/Math.max(ab.asks[0][0],bbk.bids[0][0]),commonStep(ar.step,ar.marketStep,br.step,br.marketStep))
  const av=sweep(closing?ab.bids:ab.asks,qty,cfg.trust),bv=sweep(closing?bbk.asks:bbk.bids,qty,cfg.trust)
  if(!av||!bv||qty<Math.max(ar.minQty,br.minQty)||(!closing&&qty*Math.min(av.price,bv.price)<Math.max(ar.minNotional,br.minNotional)))throw Error('小额预算低于最小订单/深度不足')
  const price=priceBound(closing?av.worst*0.999:mode==='fill'?av.worst*1.001:ab.bids[0][0]*0.99,ar.tick,closing?'SELL':'BUY')
  if(!closing&&qty*price>maxUsd*1.0011)throw Error('探针金额超过硬顶')
  if(!closing&&qty*price<ar.minNotional)throw Error('探针价格低于最小名义')
  if(mode==='validate'){
   try{console.log('test-order response:',JSON.stringify(await a.testOrder({id:'validate',venue:'aster',symbol,side:'BUY',qty:decimal(qty),kind:cfg.firstTif,price:decimal(price),reduceOnly:false})))}
   catch(err){console.log('测试接口未通过；不会自动尝试真实订单或切换timeInForce。');throw err}
  }else{
   if(!closing){
    for(const [name,x] of [['Aster',aa],['Binance',bb]] as const)if(x.available-maxUsd/cfg.leverage<cfg.marginBuffer)throw Error(name+'保证金余量不足，可用 '+x.available+'U')
    await Promise.all([a.configure(symbol,cfg.leverage),b.configure(symbol,cfg.leverage)])
   }
   console.log('发送真实'+cfg.firstTif+'探针；按真实成交量立即币安市价对冲；最大名义',maxUsd)
   await e.execute({pair,side:closing?'SELL':'BUY',qty,qtyText:decimal(qty),priceText:decimal(price),aVwap:av.price,bVwap:bv.price,grossPct:0,netPct:0,closing,at:Date.now(),notional:qty*(av.price+bv.price)/2})
   console.log(JSON.stringify(store.trades()[0],null,2))
   if(e.halt)process.exitCode=2
  }
  }
  console.log('不会自动写入 ASTER_FOK_VERIFIED。需要人工检查拒单原因、终态、成交量；fill探针成交后仓位保留在账本。')
 }
}finally{a.close();b.close();store.close();unlock()}
