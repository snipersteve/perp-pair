import express from 'express'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Engine } from './engine.js'
import { pairInput } from './config.js'
const eq=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
export function createApp(e:Engine){
  const app=express(),csrf=randomBytes(24).toString('hex')
  app.disable('x-powered-by')
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
    if(e.cfg.password){
      let decoded=''
      try{decoded=Buffer.from((req.headers.authorization||'').replace(/^Basic /,''),'base64').toString()}catch{}
      if(!eq(decoded,'admin:'+e.cfg.password)){res.set('WWW-Authenticate','Basic realm="perp-pair", charset="UTF-8"').status(401).send('需要认证');return}
    }
    if(!['GET','HEAD'].includes(req.method)&&!eq(String(req.headers['x-csrf-token']||''),csrf)){res.status(403).json({error:'CSRF校验失败'});return}
    next()
  })
  app.use(express.json({limit:'16kb'}))
  app.get('/api/state',(_req,res)=>res.json({
    tradeNotify:e.cfg.tradeNotify,sharedAccount:e.cfg.sharedAccount,sharedAuto:e.cfg.sharedAuto,mode:e.cfg.mode,firstTif:e.cfg.firstTif,paused:e.paused,busy:e.busy,initialized:e.initialized,halt:e.halt,
    reason:e.reason,lastError:e.lastError,lastReconcile:e.lastReconcile,blockedUntil:e.circuit.until,
    now:Date.now(),csrf,pairs:e.snapshots(),pnl:e.pnl(),trades:e.store.trades(),events:e.store.events(),
    accounts:{aster:e.a.account,binance:e.b.account},
    limits:{maxOrderUsd:e.cfg.maxOrderUsd,totalCap:e.cfg.totalCap,dailyLoss:e.cfg.dailyLoss,trust:e.cfg.trust,buffer:e.cfg.buffer,
      aFee:e.cfg.aFee,bFee:e.cfg.bFee,maxAge:e.cfg.maxAge,maxSkew:e.cfg.maxSkew,maxFundingCost:e.cfg.maxFundingCost,iocSlippage:e.cfg.iocSlippage},
    pending:e.store.pending().map(r=>({id:r.id,venue:r.request.venue,symbol:r.request.symbol,state:r.state})),
  }))
  app.get('/api/markets',(_req,res)=>{
    res.json([...e.a.rules.values()].filter(a=>e.b.rules.has(a.symbol)&&e.b.rules.get(a.symbol)?.base===a.base).map(a=>({symbol:a.symbol,base:a.base,tif:a.timeInForce})))
  })
  app.post('/api/pairs',async(req,res)=>{const p=pairInput.parse(req.body);await e.lock(async()=>e.savePair(p));res.json({ok:true})})
  app.post('/api/control',async(req,res)=>{
    const action=req.body?.action
    if(action==='pause'){e.pause();res.json({ok:true});return}
    await e.lock(async()=>{
      if(action==='resume')await e.resume()
      else if(action==='recover'){await e.recover();await e.reconcile()}
      else if(action==='acknowledge')await e.acknowledge()
      else throw Error('未知操作')
    })
    res.json({ok:true})
  })
  app.use(express.static(fileURLToPath(new URL('../web/',import.meta.url))))
  app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({error:err instanceof Error?err.message:'请求失败'})})
  return app
}
