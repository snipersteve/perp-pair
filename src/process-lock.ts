import { openSync,writeFileSync,readFileSync,unlinkSync,closeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
export function processLock(dir:string){
  const file=join(dir,'process.lock')
  try {
    const old=JSON.parse(readFileSync(file,'utf8'))
    if(old.host!==hostname())throw Error('数据目录被另一主机占用，禁止共享')
    try{process.kill(old.pid,0);throw Error('已有进程使用数据目录，禁止双开')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
    unlinkSync(file)
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  const fd=openSync(file,'wx',0o600)
  writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname()}));closeSync(fd)
  return ()=>{try{const r=JSON.parse(readFileSync(file,'utf8'));if(r.pid===process.pid)unlinkSync(file)}catch{}}
}
