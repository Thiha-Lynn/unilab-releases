"""Render an operator-only HTML evidence snapshot from server.py report JSON."""
import collections, csv, html, json, sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text());out=Path(sys.argv[2])
e=lambda x:html.escape(str(x))
totals=collections.Counter()
for row in r['counts']:totals[row['event']]+=row['total'];totals['selected_files']+=row['files'] if row['event']=='files_selected' else 0
active={x['code'] for x in r['pilotActivity'] if x['event']=='tool_open' and x['tool'] not in {'pilot','home','privacy','install'}}
solved={x['code'] for x in r['pilotFeedback'] if x['solved']=='yes'}
def table(rows,keys):return '<table><tr>'+''.join('<th>'+e(k)+'</th>' for k in keys)+'</tr>'+''.join('<tr>'+''.join('<td>'+e(row.get(k,''))+'</td>' for k in keys)+'</tr>' for row in rows)+'</table>'
cards=[('Sessions in reporting window (not people)',sum(x['sessions'] for x in r['dailySessions'])),('Locally selected files',totals['selected_files']),('Completed jobs',totals['job_completed']),('Download requests',totals['download_requested']),('Active pilot codes',len(active)),('Codes reporting a solved task',len(solved))]
days=collections.defaultdict(lambda:collections.Counter())
for row in r['dailySessions']:days[row['day']]['sessions']+=row['sessions']
for row in r['counts']:
    days[row['day']][row['event']]+=row['total']
    if row['event']=='files_selected':days[row['day']]['selectedFiles']+=row['files']
daily=[dict(day=day,**counts) for day,counts in sorted(days.items())]
columns=['day','sessions','tool_open','selectedFiles','job_completed','job_failed','download_requested','download_saved']
with out.with_suffix('.daily.csv').open('w',newline='') as stream:
    writer=csv.DictWriter(stream,fieldnames=columns,extrasaction='ignore');writer.writeheader()
    writer.writerows({k:row.get(k,0) for k in columns} for row in daily)
public='--public' in sys.argv
if public:cards=cards[:4]
body='<h1>UniLab usage evidence</h1><p>Generated '+e(r['generatedAt'])+' · 30-day window · operator snapshot</p><div class="cards">'+''.join('<div><b>'+e(v)+'</b><span>'+e(k)+'</span></div>' for k,v in cards)+'</div><p><strong>Goal: 30 distinct people completing useful tasks.</strong> Invitation codes are not automatically verified humans. Reconcile each code against the organiser’s separate participant checklist. Repeated sessions, downloads and automated tests must never be presented as distinct users.</p><h2>Pilot outcomes</h2>'+table(r['pilotSummary'],['code','completedJobs','downloadRequests'])+table(r['pilotFeedback'],['code','day','tool','solved','rating'])+'<h2>Daily activity (UTC)</h2><p>UTC days change at 07:00 Bangkok. Missing days have no recorded events. Exported daily CSV accompanies this snapshot.</p>'+table(daily,columns)+'<h2>Usage by tool</h2>'+table(r['counts'],['day','tool','event','platform','version','total','files'])+'<h2>Measurement limits</h2><ul>'+''.join('<li>'+e(v)+'</li>' for v in r['definitions'].values())+'</ul><p>Selected files means local file input, never uploads to UniLab. Download requests can be canceled. Opt-out, offline use, blockers and failed requests are absent. Counts are observable activity, not a fraud-proof census.</p>'
if public:
    start=body.index('<h2>Pilot outcomes</h2>');end=body.index('<h2>Daily activity',start)
    body=body[:start]+body[end:]
    body=body.replace('operator snapshot','aggregate public snapshot')
out.write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>UniLab usage evidence</title><style>body{font:16px/1.6 system-ui;color:#183430;max-width:1150px;margin:40px auto;padding:20px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.cards div{padding:20px;background:#e8f1ec;border-radius:12px}.cards b{display:block;font-size:38px}.cards span{display:block}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{padding:8px;border-bottom:1px solid #ccc;text-align:left;font-size:13px}@media(max-width:650px){.cards{grid-template-columns:1fr 1fr}}@media print{body{margin:0}tr{break-inside:avoid}}</style>'+body+'</html>')
