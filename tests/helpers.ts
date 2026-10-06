import { loadConfig } from '../src/config.js'
import type { Client, Account, OrderRequest, OrderResult, Rules, Venue } from '../src/types.js'
import { Store } from '../src/store.js'
import { Circuit, ApiError } from '../src/exchanges/http.js'
import { Engine } from '../src/engine.js'
export const cfg=()=>({...loadConfig(),mode:'live' as const,live:true,dedicated:true,fokVerified:true,firstTif:'FOK' as const,resolveMs:10,maxAge:1000,maxSkew:500,maxOrderUsd:100,trust:0.5,buffer:0.1})
export const rules=(symbol='TESTUSDT'):Rules=>({symbol,base:'TEST',quote:'USDT',step:'1',marketStep:'1',tick:'0.01',timeInForce:['FOK','IOC'],minQty:1,maxQty:100000,minNotional:5})
export const pair=()=>({id:'test',aSymbol:'TESTUSDT',bSymbol:'TESTUSDT',mode:'run' as const,orderUsd:20,capUsd:100,openPct:0.2,closePct:-0.2,direction:'both' as const,revision:0})
export class Fake implements Client{
 rules=new Map([['TESTUSDT',rules()]]);books=new Map([['TESTUSDT',{bids:[[1,1000]] as [number,number][],asks:[[1.01,1000]] as [number,number][],receivedAt:Date.now(),eventAt:Date.now(),sequence:1}]])
 funding=new Map([['TESTUSDT',{rate:0,nextTime:Date.now()+3600000,mark:1}]]);offsetMs=0
 account:Account={at:Date.now(),available:1000,equity:1000,positions:[],oneWay:true}
 calls:OrderRequest[]=[];queries=0;onPlace?:(r:OrderRequest)=>Promise<OrderResult>;onQuery?:(r:OrderRequest)=>Promise<OrderResult>
 constructor(public venue:Venue){}
 async init(){}subscribe(){}close(){}async configure(){}async refreshFunding(){}
 async refreshAccount(){this.account.at=Date.now();return this.account}
 async incomes(){return []}
 async place(r:OrderRequest){this.calls.push(r);if(this.onPlace)return this.onPlace(r);return result(r)}
 async query(r:OrderRequest){this.queries++;if(this.onQuery)return this.onQuery(r);throw new ApiError('not found',-2013,400)}
}
export const result=(r:OrderRequest,qty=Number(r.qty),status='FILLED'):OrderResult=>({status,qty,price:qty?1:0,quote:qty,orderId:'123456789012345678',ackAt:Date.now()})
export function setup(){
 const store=new Store(':memory:'),a=new Fake('aster'),b=new Fake('binance'),c=cfg(),e=new Engine(c,store,a,b,new Circuit(store))
 store.savePair(pair())
 // Fake account snapshots from ledger to model successful reconciliation.
 for(const client of [a,b])client.refreshAccount=async()=>({...client.account,at:Date.now(),positions:store.positions().filter(p=>p.venue===client.venue&&p.qty!==0).map(p=>({symbol:p.symbol,qty:p.qty,mark:1,unrealized:0,liquidation:0,leverage:2,isolated:false}))})
 return {store,a,b,c,e}
}
export const candidate=()=>({pair:pair(),side:'BUY' as const,qty:10,qtyText:'10',priceText:'1.01',aVwap:1.01,bVwap:1.02,grossPct:1,netPct:0.8,closing:false,at:Date.now(),notional:10})
