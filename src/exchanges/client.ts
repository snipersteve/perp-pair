import { createHmac, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import WebSocket from 'ws'
import { randomInt } from 'node:crypto'
import { assertScope } from '../shared-account.js'
import type { Config } from '../config.js'
import { ApiError, Circuit, request, NotSent } from './http.js'
import type { Account, Book, Client, Funding, Income, OrderRequest, OrderResult, Rules, Venue } from '../types.js'
const finite=(x:unknown,name:string)=>{if(x===undefined||x===null||x==='')throw Error('缺失字段 '+name);const v=Number(x);if(!Number.isFinite(v))throw Error('非法字段 '+name);return v}
export function decodeOrder(d:any,r:OrderRequest):OrderResult {
  if(d.symbol!==r.symbol || d.side!==r.side || d.clientOrderId!==r.id)throw Error('订单身份不匹配')
  const qty=finite(d.executedQty,'executedQty')
  const quote=finite(d.cumQuote??d.cumQuoteQty??'0','cumQuote')
  const price=qty>0?(Number(d.avgPrice)>0?finite(d.avgPrice,'avgPrice'):quote/qty):0
  if((d.status==='FILLED'&&qty<=0) || qty<0 || qty>Number(r.qty)*(1+1e-8) || (qty>0&&!(price>0)))throw Error('成交数量/价格非法')
  if(!['NEW','PARTIALLY_FILLED','FILLED','EXPIRED','EXPIRED_IN_MATCH','CANCELED','REJECTED'].includes(d.status))throw Error('未知订单状态')
  return {status:d.status,qty,price,quote,orderId:String(d.orderId),ackAt:Date.now()}
}
export class Exchange implements Client {
  rules=new Map<string,Rules>(); books=new Map<string,Book>(); funding=new Map<string,Funding>()
  account?:Account; offsetMs=0
  private signer?:ReturnType<typeof privateKeyToAccount>; private pem?:KeyObject; private nonce=0
  private ws?:WebSocket; private symbols:string[]=[]; private retry?:NodeJS.Timeout; private ping?:NodeJS.Timeout; private stopped=false
  private lastFrame=0; private seq=0
  private base:string; private version:string
  constructor(public venue:Venue,private cfg:Config,private circuit:Circuit,private note:(msg:string)=>void){
    this.base=venue==='aster'?'https://fapi.asterdex.com':'https://fapi.binance.com'
    this.version=venue==='aster'?'/fapi/v3':'/fapi/v1'
    if(cfg.mode==='live'){
      if(venue==='aster')this.signer=privateKeyToAccount(cfg.aKey as `0x${string}`)
      else if(cfg.bPem)this.pem=createPrivateKey(readFileSync(cfg.bPem,'utf8'))
    }
  }
  private async call(path:string,params:Record<string,string|number>={},method='GET',signed=false) {
    let q=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])),headers:Record<string,string>={}
    if(signed){
      if(this.cfg.mode!=='live')throw new NotSent('观察模式禁止私有接口')
      if(this.venue==='aster'){
        if(!this.signer)throw new NotSent('缺少Aster signer')
        this.nonce=Math.max(Math.trunc((Date.now()+this.offsetMs)*1000)+(this.cfg.sharedAccount?randomInt(100,900):0),this.nonce+1)
        q.set('nonce',String(this.nonce));q.set('user',this.cfg.aUser);q.set('signer',this.signer.address)
        const signature=await this.signer.signTypedData({
          domain:{name:'AsterSignTransaction',version:'1',chainId:1666,verifyingContract:'0x0000000000000000000000000000000000000000'},
          types:{Message:[{name:'msg',type:'string'}]},primaryType:'Message',message:{msg:q.toString()},
        })
        q.set('signature',signature)
      }else{
        q.set('timestamp',String(Math.trunc(Date.now()+this.offsetMs)));q.set('recvWindow','5000')
        const payload=q.toString(),sig=this.pem?cryptoSign(null,Buffer.from(payload),this.pem).toString('base64'):createHmac('sha256',this.cfg.bSecret).update(payload).digest('hex')
        q.set('signature',sig);headers['X-MBX-APIKEY']=this.cfg.bKey
      }
    }
    return request(this.base,path,method,q.toString(),headers,this.cfg.timeout,this.circuit)
  }
  async init(){
    const t=Date.now(), clock=await this.call(this.version+'/time')
    this.offsetMs=finite(clock.serverTime,'serverTime')-(Date.now()+t)/2
    if(Math.abs(this.offsetMs)>this.cfg.maxClock)throw Error(this.venue+' 时钟偏差过大，请校时')
    const info=await this.call(this.version+'/exchangeInfo'), rules=new Map<string,Rules>()
    for(const s of info.symbols){
      if(s.status!=='TRADING'||s.contractType!=='PERPETUAL'||s.quoteAsset!=='USDT')continue
      // Binance's perpetual sentinel is year 2100. A real announced delivery time fences entries.
      if(s.deliveryDate && Number(s.deliveryDate)<Date.UTC(2090,0,1))continue
      const f=(name:string)=>s.filters.find((f:any)=>f.filterType===name)
      const lot=f('LOT_SIZE'),market=f('MARKET_LOT_SIZE'),tick=f('PRICE_FILTER'),notional=f('MIN_NOTIONAL')
      if(!lot||!tick||!notional)continue
      rules.set(s.symbol,{symbol:s.symbol,base:s.baseAsset,quote:s.quoteAsset,step:lot.stepSize,tick:tick.tickSize,
        marketStep:Number(market?.stepSize)>0?market.stepSize:lot.stepSize,timeInForce:s.timeInForce||[],
        minQty:Math.max(Number(lot.minQty),Number(market?.minQty||0)),maxQty:Math.min(Number(lot.maxQty),Number(market?.maxQty)||Infinity),
        minNotional:finite(notional.notional??notional.minNotional,'minNotional')})
    }
    this.rules=rules
  }
  subscribe(symbols:string[]){
    if(JSON.stringify([...symbols].sort())===JSON.stringify([...this.symbols].sort())&&this.ws)return
    this.symbols=symbols;this.stopped=false;this.connect()
  }
  private connect(){
    if(this.retry)clearTimeout(this.retry)
    if(this.ping)clearInterval(this.ping)
    this.ws?.removeAllListeners();this.ws?.terminate();this.books.clear()
    if(!this.symbols.length||this.stopped)return
    const ws=new WebSocket(this.venue==='aster'?'wss://fstream.asterdex.com/ws':'wss://fstream.binance.com/ws')
    this.ws=ws
    ws.on('open',()=>{
      this.lastFrame=Date.now()
      ws.send(JSON.stringify({method:'SUBSCRIBE',params:this.symbols.map(s=>s.toLowerCase()+'@depth20@100ms'),id:++this.seq}))
      this.ping=setInterval(()=>{if(Date.now()-this.lastFrame>15000)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.ping()},5000)
    })
    ws.on('pong',()=>{this.lastFrame=Date.now()})
    ws.on('message',data=>{
      this.lastFrame=Date.now()
      try {
        const envelope=JSON.parse(data.toString()), d=envelope.data||envelope
        if(d.code){this.note(this.venue+' 行情订阅失败');return}
        if(d.e!=='depthUpdate'||!this.symbols.includes(d.s))return
        const convert=(rows:any[],buy:boolean)=>rows.map(([p,q])=>[Number(p),Number(q)] as [number,number])
          .filter(([p,q])=>Number.isFinite(p)&&Number.isFinite(q)&&p>0&&q>0).sort((x,y)=>buy?y[0]-x[0]:x[0]-y[0])
        const b:Book={bids:convert(d.b,true),asks:convert(d.a,false),receivedAt:Date.now(),eventAt:finite(d.T??d.E,'event time')-this.offsetMs,sequence:finite(d.u,'update id')}
        const prev=this.books.get(d.s)
        if(prev&&b.sequence<=prev.sequence)return
        if(!b.bids.length||!b.asks.length||b.bids[0][0]>=b.asks[0][0]){this.books.delete(d.s);return}
        this.books.set(d.s,b)
      }catch{ /* malformed frame never refreshes depth */ }
    })
    ws.on('error',()=>{}) // no URLs / keys in logs
    ws.on('close',()=>{if(this.ws!==ws)return;this.books.clear();if(this.ping)clearInterval(this.ping);if(!this.stopped)this.retry=setTimeout(()=>this.connect(),2000)})
  }
  close(){this.stopped=true;if(this.retry)clearTimeout(this.retry);if(this.ping)clearInterval(this.ping);this.ws?.terminate();this.books.clear()}
  async refreshFunding(){
    const rows=await this.call(this.version+'/premiumIndex'), m=new Map<string,Funding>()
    for(const r of rows)m.set(r.symbol,{rate:finite(r.lastFundingRate,'funding'),nextTime:finite(r.nextFundingTime,'next funding'),mark:finite(r.markPrice,'mark')})
    this.funding=m
  }
  async refreshAccount():Promise<Account>{
    const [a,positions,mode,openOrders]=await Promise.all([
      this.call(this.venue==='aster'?'/fapi/v3/accountWithJoinMargin':'/fapi/v2/account',{},'GET',true),
      this.call(this.venue==='aster'?'/fapi/v3/positionRisk':'/fapi/v2/positionRisk',{},'GET',true),
      this.call(this.version+'/positionSide/dual',{},'GET',true),
      this.cfg.sharedAccount
        ? Promise.all(this.cfg.sharedSymbols.map(symbol=>this.call(this.version+'/openOrders',{symbol},'GET',true))).then(xs=>xs.flat())
        : this.call(this.version+'/openOrders',{},'GET',true),
    ])
    if(openOrders.some((o:any)=>!this.cfg.sharedAccount||this.cfg.sharedSymbols.includes(o.symbol)))throw Error(this.venue+' 存在活动挂单，拒绝与其他策略共享账户')
    const p=positions.filter((p:any)=>Number(p.positionAmt)!==0&&(!this.cfg.sharedAccount||this.cfg.sharedSymbols.includes(p.symbol))).map((p:any)=>({
      symbol:String(p.symbol),qty:finite(p.positionAmt,'positionAmt'),mark:finite(p.markPrice,'markPrice'),
      unrealized:finite(p.unRealizedProfit,'unRealizedProfit'),liquidation:finite(p.liquidationPrice,'liquidationPrice'),
      leverage:finite(p.leverage,'leverage'),isolated:p.isolated===true||p.isolated==='true',
    }))
    if(mode.dualSidePosition!==false&&mode.dualSidePosition!=='false')throw Error(this.venue+' 必须为单向持仓')
    return this.account={at:Date.now(),available:finite(a.availableBalance,'available'),equity:finite(a.totalMarginBalance,'equity'),positions:p,oneWay:true}
  }
  async configure(symbol:string,leverage:number){
    assertScope(this.cfg,symbol)
    await this.call(this.version+'/leverage',{symbol,leverage},'POST',true)
    // Cross margin only. -4046 is explicitly "No need to change margin type".
    try{await this.call(this.version+'/marginType',{symbol,marginType:'CROSSED'},'POST',true)}
    catch(e){if(!(e instanceof ApiError&&e.code===-4046))throw e}
  }
  async place(r:OrderRequest):Promise<OrderResult>{
    assertScope(this.cfg,r.symbol)
    const p:Record<string,string|number>={symbol:r.symbol,side:r.side,type:r.kind==='MARKET'?'MARKET':'LIMIT',quantity:r.qty,newClientOrderId:r.id,newOrderRespType:'RESULT'}
    if(r.kind!=='MARKET'){
      if(!this.rules.get(r.symbol)?.timeInForce.includes(r.kind) && !(this.venue==='aster' && r.kind==='FOK' && this.cfg.fokVerified))throw new NotSent(this.venue+' 未声明支持 '+r.kind+'，FOK须先独立核验')
      if(!r.price)throw new NotSent('限价单缺少价格')
      p.timeInForce=r.kind;p.price=r.price
    }
    if(r.reduceOnly)p.reduceOnly='true'
    const d=await this.call(this.version+'/order',p,'POST',true)
    // Fast path: never wait for userTrades / commission queries before returning.
    return decodeOrder(d,r)
  }
  async testOrder(r:OrderRequest){
    assertScope(this.cfg,r.symbol)
    if(r.kind!=='FOK'&&r.kind!=='IOC')throw new NotSent('测试接口仅允许FOK/IOC限价单')
    // Diagnostic only: never fallback from /order/test to a real order.
    return this.call(this.version+'/order/test',{symbol:r.symbol,side:r.side,type:'LIMIT',timeInForce:r.kind,quantity:r.qty,price:r.price!,newOrderRespType:'RESULT'},'POST',true)
  }
  async query(r:OrderRequest){return decodeOrder(await this.call(this.version+'/order',{symbol:r.symbol,origClientOrderId:r.id},'GET',true),r)}
  async incomes(start:number,end:number):Promise<Income[]>{
    const rows=await this.call(this.version+'/income',{incomeType:'FUNDING_FEE',startTime:start,endTime:end,limit:1000},'GET',true)
    if(rows.length>=1000)throw Error('资金费分页窗口溢出，拒绝静默截断')
    return rows.filter((r:any)=>!this.cfg.sharedAccount||this.cfg.sharedSymbols.includes(r.symbol)).map((r:any)=>({id:String(r.tranId),symbol:r.symbol,amount:finite(r.income,'income'),asset:r.asset,time:finite(r.time,'time')}))
  }
}
