import type { Config } from './config.js'
import type { Candidate, Client, Pair, Side } from './types.js'
import { checkRules, commonStep, decimal, priceBound, quantize, sweep, validBook } from './math.js'
export function evaluate(pair:Pair,side:Side,a:Client,b:Client,aPosition:number,cfg:Config,now=Date.now()):{candidate?:Candidate;reason:string} {
  const ar=a.rules.get(pair.aSymbol),br=b.rules.get(pair.bSymbol)
  if(!ar||!br)return {reason:'合约未上市/已交割/精度缺失'}
  try{checkRules(ar,br)}catch(e){return {reason:(e as Error).message}}
  const ab=a.books.get(pair.aSymbol),bb=b.books.get(pair.bSymbol)
  if(!validBook(ab,now,cfg.maxAge)||!validBook(bb,now,cfg.maxAge))return {reason:'盘口缺失或陈旧'}
  if(Math.abs(ab.eventAt-bb.eventAt)>cfg.maxSkew)return {reason:'双边盘口不同步'}
  const closing=aPosition!==0&&Math.sign(aPosition)!==(side==='BUY'?1:-1)
  if(!closing&&(pair.mode==='reduce'))return {reason:'只减仓'}
  if(!closing&&pair.direction!=='both'&&pair.direction!==(side==='BUY'?'longA':'shortA'))return {reason:'方向禁用'}
  const al=side==='BUY'?ab.asks:ab.bids,bl=side==='BUY'?bb.bids:bb.asks
  const step=commonStep(ar.step,ar.marketStep,br.step,br.marketStep)
  const room=closing?Math.abs(aPosition):Math.max(0,pair.capUsd/Math.max(al[0][0],bl[0][0])-Math.abs(aPosition))
  const max=quantize(Math.min(pair.orderUsd,cfg.maxOrderUsd)/Math.max(al[0][0],bl[0][0]),step)
  const ceiling=Math.min(max,room,ar.maxQty,br.maxQty)
  const threshold=closing?pair.closePct:pair.openPct
  const iocSlippagePct=cfg.firstTif==='IOC'?cfg.iocSlippage:0
  if(!closing){
    const af=a.funding.get(pair.aSymbol),bf=b.funding.get(pair.bSymbol)
    if(!af||!bf||af.nextTime<now||bf.nextTime<now)return {reason:'资金费数据未就绪'}
    // Conservative: pay adverse settlements on BOTH venues; do not net different settlement times.
    const s=side==='BUY'?1:-1,cost=(Math.max(0,s*af.rate)+Math.max(0,-s*bf.rate))*100
    if(cost>cfg.maxFundingCost)return {reason:'下一次双边不利资金费超限'}
  }
  for(let i=20;i>=1;i--){
    const qty=quantize(ceiling*i/20,step)
    if(qty<=0||qty<Math.max(ar.minQty,br.minQty))continue
    const x=sweep(al,qty,cfg.trust),y=sweep(bl,qty,cfg.trust)
    if(!x||!y)continue
    if(!closing&&(qty*x.price<ar.minNotional||qty*y.price<br.minNotional))continue
    const signalBound=priceBound(x.worst,ar.tick,side)
    // Signal threshold is unchanged. IOC may consume part of the execution buffer.
    // Round inward so tick alignment never allows more than the configured slippage.
    const bound=priceBound(signalBound*(side==='BUY'?1+iocSlippagePct/100:1-iocSlippagePct/100),ar.tick,side)
    const budgetPrice=Math.max(signalBound,bound,y.worst)
    if(!closing&&qty*bound<ar.minNotional)continue
    if(qty*budgetPrice>Math.min(pair.orderUsd,cfg.maxOrderUsd)*(1+1e-10))continue
    if(!closing&&(Math.abs(aPosition)+qty)*budgetPrice>pair.capUsd*(1+1e-10))continue
    // Size not just for entry; the Aster opposite book must allow a bounded unwind.
    if(!sweep(side==='BUY'?ab.bids:ab.asks,qty,cfg.trust))continue
    const gross=(side==='BUY'?y.price-signalBound:signalBound-y.price)*2/(signalBound+y.price)*100
    const net=gross-cfg.aFee-cfg.bFee-cfg.buffer
    if(net<threshold)continue
    const limitGrossPct=(side==='BUY'?y.price-bound:bound-y.price)*2/(bound+y.price)*100
    return {reason:'可执行',candidate:{pair,side,qty,qtyText:decimal(qty),priceText:decimal(bound),
      signalPriceText:decimal(signalBound),iocSlippagePct,limitGrossPct,limitNetPct:limitGrossPct-cfg.aFee-cfg.bFee-cfg.buffer,
      aVwap:x.price,bVwap:y.price,grossPct:gross,netPct:net,closing,at:now,notional:qty*budgetPrice}}
  }
  return {reason:room<=0?'仓位额度已满':'深度/净价差/最小数量不足'}
}
