import type { Candidate, OrderResult } from './types.js'
import { decimal } from './math.js'

export interface TradeNotice {
  id:string; candidate:Candidate; a:OrderResult; b:OrderResult;
  firstTif:string; firstMs:number; hedgeMs:number; totalMs:number; at:number;
  aPosition:number; bPosition:number; halt:string;
}
export function formatTradeNotice(n:TradeNotice):string {
  const {candidate:c,a,b}=n
  const gross=(c.side==='BUY'?b.price-a.price:a.price-b.price)*200/(a.price+b.price)
  const partial=a.qty<c.qty-Math.max(1e-10,c.qty*1e-8)
  const time=new Date(n.at+8*3600000).toISOString().replace('T',' ').slice(0,19)
  return [
    '[perp-pair] '+c.pair.aSymbol+' '+(c.closing?'平仓':'开仓')+' 已对冲',
    c.side==='BUY'?'买 Aster ／ 卖币安':'卖 Aster ／ 买币安',
    n.firstTif+(partial?' 部分成交':'')+' ｜ 计划 '+decimal(c.qty)+'，实际 '+decimal(a.qty)+' ／ '+decimal(b.qty),
    '成交价 Aster '+decimal(a.price)+' ／ 币安 '+decimal(b.price),
    '名义 Aster '+(a.qty*a.price).toFixed(2)+' U ／ 币安 '+(b.qty*b.price).toFixed(2)+' U',
    '成交毛价差 '+(gross>=0?'+':'')+gross.toFixed(3)+'%（未扣费，非已实现利润）',
    '耗时 首腿 '+n.firstMs+'ms ／ 对冲 '+n.hedgeMs+'ms ／ 合计 '+n.totalMs+'ms',
    '成交后账本净数量 Aster '+decimal(n.aPosition)+' ／ 币安 '+decimal(n.bPosition),
    ...(n.halt?['注意：引擎已暂停，请查看风险告警']:[]),
    time+' 北京时间',
    '流水 '+n.id,
  ].join('\n')
}

/** Best effort, never rejects or exposes tokens/errors containing request URLs. No automatic retry. */
export async function sendTradeNotice(token:string,chat:string,text:string,id:string,log:(level:string,message:string)=>void):Promise<void> {
  const safeLog=(level:string,message:string)=>{try{log(level,message)}catch{/* notification cannot affect execution */}}
  try {
    const res=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(5000),
    })
    const body=await res.json() as {ok?:boolean;error_code?:number}
    if(!res.ok||body.ok!==true){
      safeLog('warn','成交 Telegram 推送失败 '+id+'（HTTP '+res.status+'，API '+(typeof body.error_code==='number'?body.error_code:'unknown')+'），未自动重发')
      return
    }
    safeLog('info','成交 Telegram 已发送 '+id)
  }catch{
    safeLog('warn','成交 Telegram 推送失败或超时 '+id+'，交易不受影响；为避免重复消息未自动重发')
  }
}
