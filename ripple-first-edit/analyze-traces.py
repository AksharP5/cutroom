import gzip,json,pathlib,sys
root=pathlib.Path(__file__).parent
rows=[]
for build in ['before','after']:
 for count in [400,500]:
  path=root/f'{build}-trace/{count}.trace.json.gz'
  if not path.exists(): continue
  events=json.load(gzip.open(path))['traceEvents']
  start=next(e for e in events if e['name']=='ripple:start')
  end=next(e for e in events if e['name']=='ripple:end')
  gaps=[e for e in events if e['name'].startswith('frame-gap:') and start['ts']<e['ts']<end['ts']]
  worst=max(gaps,key=lambda e:float(e['name'].split(':')[1]))
  gap=float(worst['name'].split(':')[1]); lo=worst['ts']-gap*1000; hi=worst['ts']
  work=[e for e in events if e.get('pid')==start['pid'] and e.get('tid')==start['tid'] and lo<=e['ts']<hi and e['name'] in ['UpdateLayoutTree','Layout']]
  styles=[e for e in work if e['name']=='UpdateLayoutTree']
  layouts=[e for e in work if e['name']=='Layout']
  heaviest=max(styles,key=lambda e:e.get('dur',0))
  first_gap=gaps[0]
  first_ms=float(first_gap['name'].split(':')[1]); first_lo=first_gap['ts']-first_ms*1000
  first_work=[v for v in events if v.get('pid')==start['pid'] and v.get('tid')==start['tid'] and first_lo<=v['ts']<first_gap['ts'] and v['name'] in ['UpdateLayoutTree','Layout']]
  first_style=max((v for v in first_work if v['name']=='UpdateLayoutTree'),key=lambda v:v.get('dur',0))
  first=dict(frame_ms=first_ms,style_elements=first_style['args'].get('elementCount'),style_ms=first_style.get('dur',0)/1000,layout_ms=sum(v.get('dur',0) for v in first_work if v['name']=='Layout')/1000)
  row=dict(first=first,build=build,count=count,frame_ms=gap,frame_start_after_input_ms=(lo-start['ts'])/1000,style_elements=heaviest['args'].get('elementCount'),style_ms=heaviest.get('dur',0)/1000,total_style_ms=sum(e.get('dur',0) for e in styles)/1000,layout_ms=sum(e.get('dur',0) for e in layouts)/1000,events=work)
  rows.append(row)
  print({k:v for k,v in row.items() if k!='events'})
(root/'trace-summary.json').write_text(json.dumps(rows,indent=2))
