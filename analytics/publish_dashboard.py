"""Publish only allowlisted daily aggregates; private reports never enter the web root."""
import csv, io, json, os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from server import report

FIELDS = {'files_selected': 'selectedFiles', 'job_completed': 'completedJobs',
          'job_failed': 'failedJobs', 'download_requested': 'downloadRequests',
          'download_saved': 'confirmedSaves'}
COLUMNS = ['day', 'sessions', *FIELDS.values()]

def aggregate(source, now=None):
    now = now or datetime.now(timezone.utc)
    days = {(now.date()-timedelta(days=i)).isoformat(): dict.fromkeys(COLUMNS[1:], 0)
            for i in reversed(range(30))}
    for row in source['dailySessions']:
        if row['day'] in days:
            days[row['day']]['sessions'] += row['sessions']
    for row in source['counts']:
        key = FIELDS.get(row['event'])
        if key and row['day'] in days:
            days[row['day']][key] += row['files'] if key == 'selectedFiles' else row['total']
    return {'generatedAt': now.isoformat(), 'timezone': 'UTC', 'retentionDays': 30,
            'refreshSeconds': 300,
            'daily': [dict(day=day, **values) for day, values in days.items()]}

def publish(target, source=None, now=None):
    target = Path(target); target.mkdir(parents=True, exist_ok=True)
    data = aggregate(report() if source is None else source, now)
    csvfile = io.StringIO(); writer = csv.DictWriter(csvfile, fieldnames=COLUMNS)
    writer.writeheader(); writer.writerows(data['daily'])
    files = {'data.json': json.dumps(data), 'daily.csv': csvfile.getvalue(),
             'index.html': Path(__file__).with_name('public-dashboard.html').read_text()}
    for name, content in files.items():
        temporary = target / ('.'+name+'.tmp')
        temporary.write_text(content); temporary.chmod(0o644)
        os.replace(temporary, target/name)

if __name__ == '__main__':
    publish(os.environ.get('UNILAB_PUBLIC_USAGE_DIR', '/var/lib/unilab-public-usage'))
