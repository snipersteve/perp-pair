import type { Book, Level, Rules, Side } from './types.js'
const SCALE = 10n ** 12n
function units(s: string): bigint {
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw Error('不支持的精度: ' + s)
  const [a,b=''] = s.split('.')
  return BigInt(a)*SCALE + BigInt(b.padEnd(12,'0'))
}
const gcd = (a: bigint,b: bigint): bigint => b === 0n ? a : gcd(b,a%b)
export function commonStep(...steps: string[]): number {
  let n=1n
  for(const s of steps){const u=units(s); if(u<=0n)throw Error('step必须为正'); n=n/gcd(n,u)*u}
  return Number(n)/Number(SCALE)
}
export function quantize(n: number, step: number, up=false): number {
  const u=BigInt(Math.round(step*1e12)); if(u<=0n || !Number.isFinite(n) || n<0)throw Error('非法数量')
  const v=BigInt(Math.floor(n*1e12+0.1)); return Number((up ? (v+u-1n)/u : v/u)*u)/1e12
}
export const decimal = (n: number) => n.toFixed(12).replace(/\.?0+$/,'') || '0'
export function priceBound(n: number, tick: string, side: Side): number {
  // BUY rounds DOWN, SELL rounds UP: never weaken the price bound.
  return quantize(n,Number(tick),side==='SELL')
}
export function sweep(levels: Level[], qty: number, trust=1): { price:number; worst:number } | null {
  let left=qty, quote=0,worst=0
  for(const [p,q] of levels){const take=Math.min(left,q*trust); if(take<=0)continue; quote+=p*take; left-=take; worst=p; if(left<=qty*1e-10) return {price:quote/qty,worst}}
  return null
}
export function validBook(b: Book | undefined, now:number, maxAge:number): b is Book {
  return !!b && b.bids.length>0 && b.asks.length>0 && b.bids[0][0]<b.asks[0][0] &&
    now-b.receivedAt<=maxAge && now-b.eventAt<=maxAge && b.eventAt-now<2000
}
export function checkRules(a: Rules,b: Rules) {
  if(a.base!==b.base || a.quote!=='USDT' || b.quote!=='USDT')throw Error('只支持同标的、相同币数量口径的USDT永续；不自动映射1000倍合约')
}
export function applyPosition(qty:number,entry:number,delta:number,price:number) {
  if(qty===0 || Math.sign(qty)===Math.sign(delta)){
    const total=qty+delta
    return {qty:total,entry:(Math.abs(qty)*entry+Math.abs(delta)*price)/Math.abs(total),realized:0}
  }
  const closed=Math.min(Math.abs(qty),Math.abs(delta))
  const realized=closed*(price-entry)*Math.sign(qty), total=qty+delta
  return {qty:Math.abs(total)<1e-10?0:total,entry:Math.abs(total)<1e-10?0:Math.sign(total)===Math.sign(qty)?entry:price,realized}
}
