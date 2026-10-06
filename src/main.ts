import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { Circuit } from './exchanges/http.js'
import { Exchange } from './exchanges/client.js'
import { Engine } from './engine.js'
import { createApp } from './server.js'
import { processLock } from './process-lock.js'
process.umask(0o077)
const cfg=loadConfig()
mkdirSync(cfg.dataDir,{recursive:true,mode:0o700})
const unlock=processLock(cfg.dataDir),store=new Store(join(cfg.dataDir,'perp-pair.sqlite'))
const circuit=new Circuit(store,cfg.rateLimitStopHook)
const note=(message:string)=>store.event('warn',message)
const a=new Exchange('aster',cfg,circuit,note),b=new Exchange('binance',cfg,circuit,note)
const e=new Engine(cfg,store,a,b,circuit)
if(!store.pairs().length)store.savePair({id:'lobster',aSymbol:'龙虾USDT',bSymbol:'龙虾USDT',mode:'stop',orderUsd:Math.min(20,cfg.maxOrderUsd),capUsd:Math.min(100,cfg.totalCap),openPct:0.2,closePct:-0.1,direction:'both',revision:1})
const server=createApp(e).listen(cfg.port,cfg.host,()=>store.event('info','UI listening http://'+cfg.host+':'+cfg.port+'；mode='+cfg.mode))
try{await e.lock(()=>e.initialize())}catch(err){e.lastError=(err as Error).message;store.event('warn','启动尚未就绪，将重试: '+e.lastError)}
e.start()
let exiting=false
async function shutdown(){
  if(exiting)return;exiting=true
  server.close()
  await e.stop()
  // If still busy, leave lock/journal for next process recovery.
  if(!e.busy){store.close();unlock()}
  process.exit(e.busy?1:0)
}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown())
process.on('uncaughtException',err=>{e.trip('未捕获异常: '+err.message);void shutdown()})
process.on('unhandledRejection',err=>{e.trip('未处理异步异常: '+String(err));void shutdown()})
