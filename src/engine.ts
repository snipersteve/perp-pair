import { formatTradeNotice, sendTradeNotice, type TradeNotice } from './trade-notify.js'
import { randomBytes } from 'node:crypto'
import { assertOwnership } from './shared-account.js'
import { Store } from './store.js'
import type { Config } from './config.js'
import { Circuit, ApiError, NotSent } from './exchanges/http.js'
import { evaluate } from './strategy.js'
import { commonStep, decimal, priceBound, quantize, sweep, validBook, checkRules } from './math.js'
import { opposite, sign, terminal, type Candidate, type Client, type OrderRequest, type OrderResult, type Pair, type Venue } from './types.js'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const id=(prefix:string)=>prefix+randomBytes(12).toString('hex')
export class UnknownOrder extends Error {}
export class Engine {
  busy=false; paused=true; stopping=false; initialized=false; reason='启动后默认暂停，需人工恢复'
  halt:string; signals:Record<string,unknown>={}; lastReconcile=0; lastError=''
  private notifications=new Set<Promise<void>>()
  private notifyTrade(n:TradeNotice){
    if(!this.cfg.tradeNotify)return
    try{
      const task=sendTradeNotice(this.cfg.tradeTgToken,this.cfg.tradeTgChat,formatTradeNotice(n),n.id,(level,msg)=>this.store.event(level,msg))
      this.notifications.add(task)
      void task.finally(()=>this.notifications.delete(task))
    }catch{this.store.event('warn','成交推送构造失败 '+n.id+'；交易不受影响')}
  }
  async flushNotifications(){await Promise.allSettled([...this.notifications])}
  private tickTimer?:NodeJS.Timeout; private maintenanceTimer?:NodeJS.Timeout; private lastAttempt=0; private lastMeta=0; private lastFunding=0
  constructor(readonly cfg:Config,readonly store:Store,readonly a:Client,readonly b:Client,readonly circuit:Circuit) {
    this.halt=store.get<string>('halt')||''
    if(store.pending().length||store.incompleteTrades().length)this.trip('发现未完成订单/执行记录，必须恢复查询并对账')
  }
  event(level:string,msg:string){
    this.store.event(level,msg)
    if((level==='error'||level==='warn')&&this.cfg.tgToken&&this.cfg.tgChat){
      // Out-of-band: never delay hedge, never log URL containing bot token.
      void fetch('https://api.telegram.org/bot'+this.cfg.tgToken+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:this.cfg.tgChat,text:'[perp-pair] '+msg}),signal:AbortSignal.timeout(5000)}).catch(()=>{})
    }
  }
  trip(msg:string){if(this.halt===msg&&this.paused)return;this.halt=msg;this.paused=true;this.reason=msg;this.store.set('halt',msg);this.event('error',msg)}
  async lock<T>(fn:()=>Promise<T>):Promise<T>{if(this.busy)throw Error('执行/巡检中，请稍后重试');this.busy=true;try{return await fn()}finally{this.busy=false}}
  async initialize(){
    await Promise.all([this.a.init(),this.b.init()])
    this.initialized=true;this.lastMeta=Date.now()
    this.subscribe()
    await Promise.all([this.a.refreshFunding(),this.b.refreshFunding()])
    if(this.cfg.mode==='live'){
      await this.recover()
      await this.reconcile()
    }
    this.event('info','行情初始化完成；模式 '+this.cfg.mode+'；首腿 '+this.cfg.firstTif+'；不会自动恢复交易')
  }
  subscribe(){const ps=this.store.pairs();this.a.subscribe([...new Set(ps.map(p=>p.aSymbol))]);this.b.subscribe([...new Set(ps.map(p=>p.bSymbol))])}
  start(){
    this.tickTimer=setInterval(()=>{void this.tick().catch(e=>this.trip('执行异常: '+(e as Error).message))},100)
    this.maintenanceTimer=setInterval(()=>{
      if(this.busy||this.stopping)return
      void this.lock(async()=>{
        try {
          if(!this.initialized){await this.initialize();return}
          if(Date.now()-this.lastMeta>300000){await Promise.all([this.a.init(),this.b.init()]);this.lastMeta=Date.now()}
          await Promise.all([this.a.refreshFunding(),this.b.refreshFunding()])
          if(this.cfg.mode==='live'){
            try{await this.reconcile()}catch(err){this.trip('账户/仓位巡检失败: '+(err as Error).message);throw err}
            if(Date.now()-this.lastFunding>60000){await this.collectFunding();this.lastFunding=Date.now()}
          }
          this.lastError=''
        }catch(e){this.lastError=(e as Error).message;this.reason=this.lastError}
      }).catch(()=>{})
    },this.cfg.accountPollMs)
  }
  async reconcile(){
    const [aa,bb]=await Promise.all([this.a.refreshAccount(),this.b.refreshAccount()])
    const ps=this.store.pairs()
    for(const p of ps){assertOwnership(this.cfg,p.aSymbol);assertOwnership(this.cfg,p.bSymbol)}
    for(const [venue,account] of [['aster',aa],['binance',bb]] as const){
      for(const p of account.positions){
        if(!ps.some(x=>(venue==='aster'?x.aSymbol:x.bSymbol)===p.symbol))throw Error(venue+' 存在不属于本程序的仓位: '+p.symbol)
        if(p.isolated||p.leverage>this.cfg.leverage)throw Error(venue+' 仓位模式/杠杆不符合配置')
      }
      for(const row of this.store.positions().filter(p=>p.venue===venue)){
        const actual=account.positions.find(p=>p.symbol===row.symbol)?.qty||0
        if(Math.abs(actual-row.qty)>1e-8*Math.max(1,Math.abs(row.qty)))throw Error(venue+' 仓位漂移 '+row.symbol+'，实际 '+actual+' 账本 '+row.qty)
      }
      for(const p of account.positions){
        const expected=this.store.position(venue,p.symbol).qty
        if(Math.abs(p.qty-expected)>1e-8*Math.max(1,Math.abs(p.qty)))throw Error(venue+' 外来/手工仓位 '+p.symbol)
      }
    }
    for(const p of ps){
      const aq=this.store.position('aster',p.aSymbol).qty,bq=this.store.position('binance',p.bSymbol).qty
      if(Math.abs(aq+bq)>1e-8*Math.max(1,Math.abs(aq)))throw Error(p.id+' 双腿敞口不平: '+(aq+bq))
    }
    this.lastReconcile=Date.now()
    const net=this.pnl().total, day=new Date(Date.now()+8*3600000).toISOString().slice(0,10), baseline=this.store.baseline(day,net)
    if(net-baseline < -this.cfg.dailyLoss)throw Error('日内净值亏损触发熔断')
  }
  async collectFunding(){
    const end=Date.now()
    for(const c of [this.a,this.b]){
      const key='fundingCursor:'+c.venue,start=this.store.get<number>(key)||this.store.get<number>('createdAt')!
      const windowEnd=Math.min(end,start+3600000)
      if(windowEnd<=start)continue
      const rows=await c.incomes(Math.max(0,start-60000),windowEnd)
      for(const r of rows){
        if(r.asset!=='USDT')throw Error('非USDT资金费不能直接折美元')
        this.store.addFunding(c.venue,r.id,r.symbol,r.amount,r.time)
      }
      this.store.set(key,windowEnd)
    }
  }
  async recover(){
    for(const row of this.store.pending()){
      const c=row.request.venue==='aster'?this.a:this.b
      try{
        const r=await c.query(row.request)
        if(terminal(r.status)){this.store.finish(row.id,r,c.venue==='aster'?this.cfg.aFee:this.cfg.bFee);this.event('warn','恢复确认订单 '+row.id+' '+r.status)}
      }catch{ /* not found is NOT proof of non-execution */ }
    }
  }
  async resume(){
    if(this.cfg.sharedAccount&&!this.cfg.sharedAuto)throw Error('共享账户目前仅允许人工监督的单次探针，不支持后台自动交易')
    for(const p of this.store.pairs()){assertOwnership(this.cfg,p.aSymbol);assertOwnership(this.cfg,p.bSymbol)}
    if(this.cfg.mode!=='live')throw Error('观察模式不能下单；需要部署级开启实盘')
    if(this.halt)throw Error('存在熔断，先恢复查询/对账再确认解除')
    await this.recover()
    if(this.store.pending().length)throw Error('存在结局未知订单')
    for(const p of this.store.pairs().filter(p=>p.mode!=='stop')){
      this.validatePair(p)
      await Promise.all([this.a.configure(p.aSymbol,this.cfg.leverage),this.b.configure(p.bSymbol,this.cfg.leverage)])
    }
    await this.reconcile()
    this.paused=false;this.reason='运行';this.event('info','操作员恢复交易')
  }
  pause(){this.paused=true;this.reason='人工暂停：不发新首腿，已成交对冲继续';this.event('info',this.reason)}
  async acknowledge(){
    await this.recover()
    if(this.store.pending().length)throw Error('仍有结果未知订单，禁止解除')
    await this.reconcile()
    this.halt='';this.store.set('halt','');this.paused=true;this.reason='对账通过，已解除熔断但仍暂停'
    this.store.db.prepare("UPDATE trades SET status='RECOVERED_REVIEW' WHERE status='EXECUTING'").run()
    this.event('warn',this.reason)
  }
  validatePair(p:Pair){
    const ar=this.a.rules.get(p.aSymbol),br=this.b.rules.get(p.bSymbol)
    if(!ar||!br)throw Error('两边必须为可交易的USDT永续')
    checkRules(ar,br);commonStep(ar.step,ar.marketStep,br.step,br.marketStep)
    if(p.orderUsd>this.cfg.maxOrderUsd||p.capUsd>this.cfg.totalCap)throw Error('超过部署级金额上限')
    if(!ar.timeInForce.includes(this.cfg.firstTif)&&!(this.cfg.firstTif==='FOK'&&this.cfg.fokVerified))throw Error('Aster未声明支持FOK，先独立核验；禁止隐式改IOC')
  }
  savePair(p:Pair){
    const old=this.store.pair(p.id)
    if(old&&old.revision!==p.revision)throw Error('配置已更新，请刷新')
    if(!old&&p.revision!==0)throw Error('新配置版本必须为0')
    for(const x of this.store.pairs())if(x.id!==p.id&&(x.aSymbol===p.aSymbol||x.bSymbol===p.bSymbol))throw Error('同一账户同一合约不可分配多个pair')
    if(old&&(old.aSymbol!==p.aSymbol||old.bSymbol!==p.bSymbol)){
      if(old.mode!=='stop'||p.mode!=='stop')throw Error('改合约必须先停止')
      if(this.store.position('aster',old.aSymbol).qty||this.store.position('binance',old.bSymbol).qty||this.store.pending().some(o=>o.pairId===p.id))throw Error('有仓位/未知订单不能改合约')
    }
    if(p.mode!=='stop')this.validatePair(p)
    if(!this.paused&&p.mode!=='stop')throw Error('修改活跃参数先全局暂停，再恢复时核验杠杆')
    this.store.savePair({...p,revision:p.revision+1});this.subscribe()
  }
  pnl(){
    let realized=0,fees=0,unrealized=0
    for(const p of this.store.positions()){
      const c=p.venue==='aster'?this.a:this.b, mark=c.funding.get(p.symbol)?.mark||p.entry
      realized+=p.realized;fees+=p.fees;unrealized+=p.qty*(mark-p.entry)
    }
    const funding=this.store.fundingTotal()
    return {realized,feesEstimated:fees,unrealized,funding,total:realized+unrealized+funding-fees}
  }
  snapshots(){
    return this.store.pairs().map(p=>{
      const aq=this.store.position('aster',p.aSymbol),bq=this.store.position('binance',p.bSymbol)
      const buy=evaluate(p,'BUY',this.a,this.b,aq.qty,this.cfg),sell=evaluate(p,'SELL',this.a,this.b,aq.qty,this.cfg)
      const summarize=(e:ReturnType<typeof evaluate>,side:'BUY'|'SELL')=>{
        if(e.candidate)return {reason:e.reason,qty:e.candidate.qty,netPct:e.candidate.netPct,grossPct:e.candidate.grossPct,closing:e.candidate.closing,executable:true}
        const ab=this.a.books.get(p.aSymbol),bb=this.b.books.get(p.bSymbol)
        if(!validBook(ab,Date.now(),this.cfg.maxAge)||!validBook(bb,Date.now(),this.cfg.maxAge))return {reason:e.reason}
        const al=side==='BUY'?ab.asks:ab.bids,bl=side==='BUY'?bb.bids:bb.asks
        const qty=p.orderUsd/Math.max(al[0][0],bl[0][0]),x=sweep(al,qty,this.cfg.trust),y=sweep(bl,qty,this.cfg.trust)
        if(!x||!y)return {reason:e.reason}
        const gross=(side==='BUY'?y.price-x.price:x.price-y.price)*2/(x.price+y.price)*100
        return {reason:e.reason,qty,netPct:gross-this.cfg.aFee-this.cfg.bFee-this.cfg.buffer,grossPct:gross,executable:false}
      }
      const ar=this.a.rules.get(p.aSymbol)
      return {...p,aPosition:aq,bPosition:bq,buy:summarize(buy,'BUY'),sell:summarize(sell,'SELL'),
        aBook:this.a.books.get(p.aSymbol),bBook:this.b.books.get(p.bSymbol),
        aFunding:this.a.funding.get(p.aSymbol),bFunding:this.b.funding.get(p.bSymbol),
        capability:ar?.timeInForce.includes(this.cfg.firstTif)?'交易所已声明':this.cfg.firstTif==='FOK'&&this.cfg.fokVerified?'操作员已核验FOK':'FOK未声明，禁止实盘'}
    })
  }
  async tick(){
    if(this.busy||this.stopping||this.paused||this.halt||this.cfg.mode!=='live'||!this.initialized)return
    for(const p of this.store.pairs()){assertOwnership(this.cfg,p.aSymbol);assertOwnership(this.cfg,p.bSymbol)}
    if(Date.now()-this.lastAttempt<this.cfg.cooldown)return
    if(this.circuit.until>Date.now()){this.trip('交易所限流熔断，所有进程内请求停止');return}
    if(Date.now()-this.lastReconcile>this.cfg.accountMaxAge){this.reason='账户对账陈旧';return}
    if(this.lastError){this.reason=this.lastError;return}
    const candidates:Candidate[]=[]
    for(const p of this.store.pairs().filter(p=>p.mode!=='stop')){
      const aq=this.store.position('aster',p.aSymbol).qty
      for(const side of ['BUY','SELL'] as const){const e=evaluate(p,side,this.a,this.b,aq,this.cfg);if(e.candidate)candidates.push(e.candidate)}
    }
    candidates.sort((x,y)=>Number(y.closing)-Number(x.closing)||y.netPct-x.netPct)
    if(!candidates.length){this.reason='等待满足深度与净价差条件';return}
    await this.lock(async()=>{
      const c=candidates[0];this.validatePair(c.pair)
      if(!c.closing){
        let total=0
        for(const p of this.store.positions().filter(p=>p.venue==='aster'))total+=Math.abs(p.qty)*(this.a.funding.get(p.symbol)?.mark||p.entry)
        if(total+c.notional>this.cfg.totalCap){this.reason='总仓位额度不足';return}
        for(const client of [this.a,this.b]){
          const account=client.account
          if(!account||Date.now()-account.at>this.cfg.accountMaxAge){this.reason='账户数据陈旧';return}
          const need=c.notional/this.cfg.leverage
          if(account.available-need<this.cfg.marginBuffer || need>account.available*this.cfg.marginUse/100){this.reason='保证金不足';return}
        }
      }
      this.lastAttempt=Date.now();await this.execute(c)
    })
  }
  async submit(tradeId:string,pairId:string,r:OrderRequest):Promise<OrderResult>{
    this.store.intent(tradeId,pairId,r) // durable BEFORE request; never blind retry POST
    const client=r.venue==='aster'?this.a:this.b
    let result:OrderResult|undefined
    try{result=await client.place(r)}
    catch(e){
      if(e instanceof NotSent || e instanceof ApiError&&e.definitive){
        result={status:e instanceof ApiError&&e.code===-5021?'EXPIRED':'REJECTED',qty:0,price:0,quote:0,orderId:'',ackAt:Date.now(),rejection:e.message,code:e instanceof ApiError?e.code:undefined}
      }
    }
    if(!result||!terminal(result.status)){
      const until=Date.now()+this.cfg.resolveMs
      while(Date.now()<until){
        try{result=await client.query(r);if(terminal(result.status))break}catch{/* includes -2013: never infer zero */}
        await sleep(200)
      }
    }
    if(!result||!terminal(result.status)){
      this.store.unknown(r.id);throw new UnknownOrder('订单结局未知 '+r.venue+' '+r.id)
    }
    this.store.finish(r.id,result,r.venue==='aster'?this.cfg.aFee:this.cfg.bFee)
    return result
  }
  async execute(c:Candidate){
    const tradeId=id('t'),started=Date.now()
    const detail:any={candidate:c,firstTif:this.cfg.firstTif,started}
    this.store.trade(tradeId,c.pair.id,'EXECUTING',detail)
    try {
      assertOwnership(this.cfg,c.pair.aSymbol);assertOwnership(this.cfg,c.pair.bSymbol)
      const first:OrderRequest={id:id('a'),venue:'aster',symbol:c.pair.aSymbol,side:c.side,qty:c.qtyText,kind:this.cfg.firstTif,price:c.priceText,reduceOnly:c.closing}
      const a=await this.submit(tradeId,c.pair.id,first);detail.a=a;detail.fokConfirmMs=Date.now()-started
      if(a.qty===0){
        this.store.trade(tradeId,c.pair.id,a.status==='REJECTED'?'REJECTED':'NO_FILL',detail)
        if(a.status==='REJECTED')this.trip('Aster首腿拒绝: '+(a.rejection||a.status)+'；不是正常FOK未成交，停止重试')
        return
      }
      const fokPartial=this.cfg.firstTif==='FOK'&&Math.abs(a.qty-c.qty)>c.qty*1e-8
      const br=this.b.rules.get(c.pair.bSymbol)!
      const hedgeQty=quantize(a.qty,commonStep(br.step,br.marketStep))
      let b:OrderResult={status:'REJECTED',qty:0,price:0,quote:0,orderId:'',ackAt:Date.now()}
      const hedgeStarted=Date.now()
      if(hedgeQty>=br.minQty&&(c.closing||hedgeQty*c.bVwap>=br.minNotional)){
        b=await this.submit(tradeId,c.pair.id,{id:id('b'),venue:'binance',symbol:c.pair.bSymbol,side:opposite(c.side),qty:decimal(hedgeQty),kind:'MARKET',reduceOnly:c.closing})
      }
      detail.b=b;detail.hedgeMs=Date.now()-hedgeStarted;detail.totalMs=Date.now()-started
      const residual=a.qty-b.qty
      if(residual>Math.max(1e-10,a.qty*1e-8)){
        detail.rollback=await this.rollback(tradeId,c,a,residual)
        this.store.trade(tradeId,c.pair.id,'ROLLBACK',detail)
        this.trip('币安未完全成交，已尝试撤回Aster差额；需人工核对后恢复')
      }else{
        this.store.trade(tradeId,c.pair.id,'HEDGED',detail)
        this.event('info',c.pair.id+' '+(c.closing?'平仓':'开仓')+' 已对冲 '+a.qty+'；首腿 '+detail.fokConfirmMs+'ms / 币安 '+detail.hedgeMs+'ms')
      }
      if(fokPartial)this.trip('FOK出现部分成交，已按真实量对冲并停止；不得继续信任FOK语义')
      // No subsequent entry until account positions agree with our newly updated ledger.
      this.lastReconcile=0
      try{await this.reconcile()}catch(e){this.trip('成交后对账失败: '+(e as Error).message)}
      if(residual<=Math.max(1e-10,a.qty*1e-8))this.notifyTrade({id:tradeId,candidate:c,a,b,firstTif:this.cfg.firstTif,
        firstMs:detail.fokConfirmMs,hedgeMs:detail.hedgeMs,totalMs:detail.totalMs,at:Date.now(),
        aPosition:this.store.position('aster',c.pair.aSymbol).qty,bPosition:this.store.position('binance',c.pair.bSymbol).qty,halt:this.halt})
    }catch(e){
      detail.error=(e as Error).message
      this.store.trade(tradeId,c.pair.id,'MANUAL_REQUIRED',detail)
      this.trip(detail.error)
    }
  }
  private async rollback(tradeId:string,c:Candidate,first:OrderResult,qty:number){
    const book=this.a.books.get(c.pair.aSymbol),r=this.a.rules.get(c.pair.aSymbol)!
    if(!validBook(book,Date.now(),this.cfg.maxAge))throw Error('撤回盘口陈旧，单腿需人工处置')
    const side=opposite(c.side), fill=sweep(side==='BUY'?book.asks:book.bids,qty,this.cfg.trust)
    if(!fill)throw Error('撤回深度不足，单腿需人工处置')
    const bound=priceBound(fill.worst*(side==='BUY'?1+this.cfg.rollbackSlippage/100:1-this.cfg.rollbackSlippage/100),r.tick,side)
    const worstPnl=sign(c.side)*(bound-first.price)*qty-qty*(bound+first.price)*this.cfg.aFee/100
    if(worstPnl < -this.cfg.rollbackLoss)throw Error('撤回最坏损失超预算，单腿需人工处置')
    const aligned=quantize(qty,Number(r.step))
    if(Math.abs(aligned-qty)>qty*1e-8)throw Error('撤回差额不满足精度，禁止扩大交易')
    const result=await this.submit(tradeId,c.pair.id,{id:id('r'),venue:'aster',symbol:c.pair.aSymbol,side,qty:decimal(qty),kind:'IOC',price:decimal(bound),reduceOnly:!c.closing})
    if(Math.abs(result.qty-qty)>qty*1e-8)throw Error('撤回未完全成交，保留敞口并告警')
    return result
  }
  async stop(){
    this.stopping=true;this.paused=true
    if(this.tickTimer)clearInterval(this.tickTimer);if(this.maintenanceTimer)clearInterval(this.maintenanceTimer)
    const until=Date.now()+30000
    while(this.busy&&Date.now()<until)await sleep(100)
    if(this.busy)this.event('error','退出等待超时；意图已持久化，下次启动只恢复查询，不重下')
    await this.flushNotifications()
    this.a.close();this.b.close()
  }
}
