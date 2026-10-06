#!/usr/bin/env python3
"""Run on calc host; latest qualifying snapshot per uploader, not cumulative-report sums."""
import csv,glob,os,re,json,collections,hashlib,datetime
files=sorted(glob.glob('/opt/calc/uploaded_csv_records/2026-10-0[23]/*'))
def venue(ep):
 p=ep.split('-')
 if p[-1]!='P':return None
 s='-'.join(p[1:-1]).lower()
 a='aster' in s;b='binance' in s or '币安' in s or s.startswith('bn')
 if a and ('bn' in s or '币安' in s or 'binance' in s):return 'ambiguous'
 return 'aster' if a else 'binance' if b else None
by=collections.defaultdict(list)
for f in files:
 m=re.search(r'user-(\d+)',os.path.basename(f))
 if m and 'Funding' not in f and '资金' not in f:by[m[1]].append(f)
selected=[];trades=[];routes=collections.Counter()
for uid,fs in by.items():
 for f in reversed(fs):
  rows=[]
  with open(f,encoding='utf-8-sig',errors='ignore') as h:
   r=csv.reader(h);header=next(r,[])
   for row in r:
    if len(row)<6 or '龙虾' not in row[0] or '龙虾' not in row[1]:continue
    va,vb=venue(row[0]),venue(row[1]);routes[(row[0],row[1])]+=1
    if {va,vb}!={'aster','binance'}:continue
    side=row[2].replace('\\t','').strip()
    if side not in ['+A-B','-A+B']:continue
    try:ap,bp,q=float(row[-2]),float(row[-1]),abs(float(row[3]))
    except:continue
    if min(ap,bp,q)<=0:continue
    a,b=(ap,bp) if va=='aster' else (bp,ap)
    buyA=(side=='+A-B')==(va=='aster')
    premium=(a-b)*200/(a+b);gross=-premium if buyA else premium
    rows.append(dict(user=uid,side='buyA' if buyA else 'sellA',qty=q,aster=a,binance=b,premiumPct=premium,grossPct=gross,notional=q*(a+b)/2))
  if rows:
   selected.append(dict(user=uid,file=os.path.basename(f),sha256=hashlib.sha256(open(f,'rb').read()).hexdigest(),count=len(rows)))
   trades+=rows;break

def quant(xs):
 xs=sorted(xs)
 return {str(p):xs[int((len(xs)-1)*p)] for p in [.05,.1,.25,.5,.75,.9,.95,.99]} if xs else {}
def summary(rows):
 return dict(n=len(rows),notional=sum(x['notional'] for x in rows),grossPct=quant([x['grossPct'] for x in rows]),premiumPct=quant([x['premiumPct'] for x in rows]),orderUsd=quant([x['notional'] for x in rows]))
result=dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),method='Latest qualifying CSV per user uploaded Oct2-3; no timestamps in rows; endpoint aliases ambiguous are excluded; fills not entry/exit labels; gross spreads exclude fees/funding.',selected=selected,totals={side:summary([x for x in trades if x['side']==side]) for side in ['buyA','sellA']},perUser={uid:{s:summary([x for x in trades if x['user']==uid and x['side']==s]) for s in ['buyA','sellA']} for uid in sorted({x['user'] for x in trades})},routes=[dict(a=a,b=b,n=n) for (a,b),n in routes.most_common(20)])
print(json.dumps(result,ensure_ascii=False,indent=2))
