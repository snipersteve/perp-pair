import { execFile } from 'node:child_process'
import { Store } from '../store.js'
export class ApiError extends Error {
  constructor(message:string, public code:number|undefined, public status:number, public definitive=false){super(message)}
}
export class NotSent extends Error {}
export class Circuit {
  until=0
  constructor(private store:Store,private stopHook=''){this.until=store.get<number>('blockedUntil')||0}
  check(){if(Date.now()<this.until)throw new NotSent('全局交易所退避中')}
  block(until:number){
    const alreadyBlocked=this.until>Date.now()
    this.until=Math.max(this.until,until);this.store.set('blockedUntil',this.until)
    if(this.stopHook&&!alreadyBlocked)execFile(this.stopHook,[],{timeout:90000},err=>{
      this.store.event(err?'error':'warn',err?'共享限流停机hook失败，需立即人工停止同机交易进程':'共享限流停机hook已完成；其它进程不会自动恢复')
    })
  }
}
export function parseJson(text:string):any {
  // Order and income ids are not safe JS numbers. Preserve before JSON parsing.
  return JSON.parse(text.replace(/("(?:orderId|tranId|tradeId|id)"\s*:\s*)(\d{16,})/g,'$1"$2"'))
}
export async function request(base:string,path:string,method:string,query:string,headers:Record<string,string>,timeout:number,circuit:Circuit) {
  circuit.check()
  const url=base+path+(method==='GET'&&query?'?'+query:'')
  const res=await fetch(url,{method,headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:method==='GET'?undefined:query,signal:AbortSignal.timeout(timeout)})
  const text=await res.text()
  let body:any
  try{body=parseJson(text)}catch{
    if(res.status===429||res.status===418)body={msg:text.slice(0,500)}
    else throw new ApiError('交易所返回非JSON',undefined,res.status)
  }
  if(res.status===429||res.status===418){
    const retry=Number(res.headers.get('retry-after'))*1000
    const ban=Number(String(body.msg||'').match(/banned until\s+(\d+)/i)?.[1]||0)
    circuit.block(Math.max(Date.now()+(retry>0?retry:res.status===418?3600000:60000),ban))
    throw new ApiError('交易所限流，所有请求停止',body.code,res.status)
  }
  if(!res.ok || (typeof body.code==='number'&&body.code<0)){
    // Fail closed for unknown/timeout/5xx, even when the body has an error code.
    const safe=[-1100,-1101,-1102,-1111,-1115,-1116,-1121,-1013,-1021,-1022,-2010,-2014,-2015,-2019,-2021,-2022,-4003,-4004,-4005,-4014,-4023,-4164,-5021]
    throw new ApiError('交易所拒绝: '+String(body.msg||res.status).slice(0,250),body.code,res.status,res.status<500&&safe.includes(body.code))
  }
  return body
}
