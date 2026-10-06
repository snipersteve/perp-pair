import { DatabaseSync } from 'node:sqlite'
import { applyPosition } from './math.js'
import { sign, terminal, type OrderRequest, type OrderResult, type Pair, type Venue } from './types.js'
export interface OrderRow { id:string; tradeId:string; pairId:string; request:OrderRequest; result?:OrderResult; state:string; created:number; updated:number }
export interface LedgerPosition { venue:Venue; symbol:string; qty:number; entry:number; realized:number; fees:number }
export class Store {
  db: DatabaseSync
  constructor(path:string) {
    this.db=new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,trade_id TEXT,pair_id TEXT,request TEXT,result TEXT,state TEXT,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS positions(venue TEXT,symbol TEXT,qty REAL,entry REAL,realized REAL,fees REAL,PRIMARY KEY(venue,symbol));
      CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY,pair_id TEXT,status TEXT,json TEXT,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER,level TEXT,message TEXT);
      CREATE TABLE IF NOT EXISTS funding(venue TEXT,id TEXT,symbol TEXT,amount REAL,time INTEGER,PRIMARY KEY(venue,id));
      CREATE TABLE IF NOT EXISTS equity(day TEXT PRIMARY KEY,value REAL);
      CREATE INDEX IF NOT EXISTS orders_state ON orders(state);
    `)
    if(!this.get('createdAt')) this.set('createdAt',Date.now())
  }
  get<T=unknown>(key:string):T|undefined { const r=this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|undefined; return r?JSON.parse(r.value):undefined }
  set(key:string,value:unknown) { this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)) }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try {const r=fn(); this.db.exec('COMMIT'); return r} catch(e){this.db.exec('ROLLBACK');throw e} }
  pairs():Pair[] {return (this.db.prepare('SELECT json FROM pairs ORDER BY id').all() as {json:string}[]).map(r=>JSON.parse(r.json))}
  pair(id:string) {return this.pairs().find(p=>p.id===id)}
  savePair(p:Pair) { this.db.prepare('INSERT INTO pairs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(p.id,JSON.stringify(p)) }
  event(level:string,message:string) {this.db.prepare('INSERT INTO events(time,level,message) VALUES(?,?,?)').run(Date.now(),level,message); console.log(JSON.stringify({time:new Date().toISOString(),level,message}))}
  events() {return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all()}
  positions():LedgerPosition[] {return this.db.prepare('SELECT * FROM positions').all() as unknown as LedgerPosition[]}
  position(venue:Venue,symbol:string):LedgerPosition {return this.positions().find(p=>p.venue===venue&&p.symbol===symbol) || {venue,symbol,qty:0,entry:0,realized:0,fees:0}}
  intent(tradeId:string,pairId:string,r:OrderRequest) {
    this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,NULL,?,?,?)').run(r.id,tradeId,pairId,JSON.stringify(r),'PENDING',Date.now(),Date.now())
  }
  order(id:string):OrderRow|undefined {
    const r=this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as any
    return r?{id:r.id,tradeId:r.trade_id,pairId:r.pair_id,request:JSON.parse(r.request),result:r.result?JSON.parse(r.result):undefined,state:r.state,created:r.created,updated:r.updated}:undefined
  }
  pending():OrderRow[] {return (this.db.prepare("SELECT id FROM orders WHERE state IN ('PENDING','UNKNOWN')").all() as {id:string}[]).map(r=>this.order(r.id)!)}
  unknown(id:string) {this.db.prepare("UPDATE orders SET state='UNKNOWN',updated=? WHERE id=?").run(Date.now(),id)}
  finish(id:string,result:OrderResult,feePct:number) {
    if(!terminal(result.status))throw Error('非终态不可结算')
    this.transaction(()=>{
      const row=this.order(id); if(!row)throw Error('订单意图不存在')
      if(row.state==='DONE')return // exactly-once fill application, including restart query
      if(result.qty<0 || !Number.isFinite(result.qty) || (result.qty>0&&!(result.price>0)))throw Error('无效成交回执')
      const r=row.request, p=this.position(r.venue,r.symbol)
      if(result.qty>0){
        const n=applyPosition(p.qty,p.entry,sign(r.side)*result.qty,result.price)
        this.db.prepare('INSERT INTO positions VALUES(?,?,?,?,?,?) ON CONFLICT(venue,symbol) DO UPDATE SET qty=excluded.qty,entry=excluded.entry,realized=excluded.realized,fees=excluded.fees')
          .run(r.venue,r.symbol,n.qty,n.entry,p.realized+n.realized,p.fees+result.qty*result.price*feePct/100)
      }
      this.db.prepare("UPDATE orders SET result=?,state='DONE',updated=? WHERE id=?").run(JSON.stringify(result),Date.now(),id)
    })
  }
  trade(id:string,pairId:string,status:string,detail:unknown) {
    this.db.prepare('INSERT INTO trades VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json,updated=excluded.updated')
      .run(id,pairId,status,JSON.stringify(detail),Date.now(),Date.now())
  }
  trades() {return (this.db.prepare('SELECT * FROM trades ORDER BY created DESC LIMIT 100').all() as any[]).map(r=>({...r,detail:JSON.parse(r.json),json:undefined}))}
  incompleteTrades() {return this.db.prepare("SELECT id FROM trades WHERE status='EXECUTING'").all()}
  baseline(day:string,value:number):number {this.db.prepare('INSERT OR IGNORE INTO equity VALUES(?,?)').run(day,value);return (this.db.prepare('SELECT value FROM equity WHERE day=?').get(day) as {value:number}).value}
  addFunding(venue:Venue,id:string,symbol:string,amount:number,time:number) {this.db.prepare('INSERT OR IGNORE INTO funding VALUES(?,?,?,?,?)').run(venue,id,symbol,amount,time)}
  fundingTotal():number {return (this.db.prepare('SELECT coalesce(sum(amount),0) AS total FROM funding').get() as {total:number}).total}
  close() {this.db.close()}
}
