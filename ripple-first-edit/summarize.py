import json, statistics
from pathlib import Path
root=Path(__file__).parent
ops=['key','wheel','ripple','undo','redo','fit']
series={build:{str(count):[json.loads((root/f'{build}-{session}/{count}.json').read_text()) for session in [1,2,3]] for count in [400,500]} for build in ['before','after']}
(root/'comparison.json').write_text(json.dumps({build:{count:[run['summary'] for run in runs] for count,runs in counts.items()} for build,counts in series.items()},indent=2))
lines=['| Clips | Gesture | Before median max | After median max | Before p95 | After p95 |','| ---: | --- | ---: | ---: | ---: | ---: |']
for count in [400,500]:
 for op in ops:
  values=[]
  for stat in ['medianMax','p95']:
   for build in ['before','after']:
    values.append(' / '.join(f'{run["summary"][op][stat]:.1f}' for run in series[build][str(count)]))
  lines.append(f'| {count} | {op} | '+ ' | '.join(values)+' |')
(root/'timings-table.md').write_text('\n'.join(lines)+'\n')
first={build:{str(count):[max(next(result for result in run['results'] if result['interaction']=='ripple')['frames']) for run in series[build][str(count)]] for count in [400,500]} for build in ['before','after']}
(root/'first-ripple.json').write_text(json.dumps(first,indent=2))
print('\n'.join(lines))
print('First ripple maxima:',first)
style='''<style>.legend{font-size:12px;color:var(--muted-foreground);margin:0 0 18px;display:flex;gap:20px}.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}.row{display:grid;grid-template-columns:65px minmax(0,1fr) 54px;gap:12px;align-items:center;margin:12px 0;font-size:12px}.bar{height:15px;border-radius:2px}.track{position:relative;border-right:1px dashed var(--border);height:15px}.group{margin-bottom:22px}.label{font-size:12px;color:var(--muted-foreground)}.caption{font-size:12px;line-height:1.5;color:var(--muted-foreground);margin:18px 0 0}p{margin:0}.value{font-variant-numeric:tabular-nums;text-align:right}</style>'''
html=style+'<div class="legend"><span><i class="key" style="background:var(--chart-2)"></i>Before</span><span><i class="key" style="background:var(--chart-1)"></i>After</span><span>150 ms budget at right</span></div>'
for count in [400,500]:
 html+=f'<div class="group"><p class="label">{count} clips</p>'
 for build,color in [('before','--chart-2'),('after','--chart-1')]:
  med=statistics.median(run['summary']['ripple']['medianMax'] for run in series[build][str(count)])
  html+=f'<div class="row"><span>{build.title()}</span><div class="track"><div class="bar" style="width:{med/150*100:.3f}%;background:var({color})"></div></div><span class="value">{med:.1f} ms</span></div>'
 html+='</div>'
html+='<p class="caption">Ripple delete. Median of the three session medians of per-run maximum frame gaps. Each session used three interaction runs on the same host. Raw session values and p95 are in the PR.</p>'
(root/'comparison.html').write_text(html)
