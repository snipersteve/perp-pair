import { readFileSync } from 'node:fs'
import type { Config } from './config.js'
export function assertScope(cfg:Config,symbol:string){
 if(cfg.sharedAccount&&!cfg.sharedSymbols.includes(symbol))throw Error('不在共享账户专属合约清单: '+symbol)
}
export function assertOwnership(cfg:Config,symbol:string){
 assertScope(cfg,symbol)
 if(!cfg.sharedAccount)return
 if(cfg.sharedAuto){
  const reservations=JSON.parse(readFileSync(cfg.reservationFile,'utf8'))
  for(const venue of ['aster','binance'])if(reservations[venue+':'+symbol]?.owner!=='perp-pair'||reservations[venue+':'+symbol]?.enabled!==true)throw Error('缺少合约专属登记: '+venue+':'+symbol)
 }
 for(const file of cfg.foreignPairFiles){
  const data=JSON.parse(readFileSync(file,'utf8')),ps=Array.isArray(data)?data:data.pairs
  if(!Array.isArray(ps))throw Error('外部pair文件格式不可核验: '+file)
  for(const p of ps)if(p.cexSymbol===symbol&&(cfg.sharedAuto||p.status!=='stop'))throw Error('合约被其他策略使用: '+symbol+' '+file)
 }
}
