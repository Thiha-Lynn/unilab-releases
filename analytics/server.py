"""First-party usage counts. No file bytes, filenames, user agents or raw IPs stored."""
import argparse, collections, hashlib, hmac, json, os, re, secrets, sqlite3, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EVENTS={'session_start','tool_open','files_selected','files_processed','job_started','job_completed','job_failed','download_requested','download_saved','pilot_feedback'}
PLATFORMS={'web','android','desktop'}
ORIGINS={'https://unilab.ztvmm.live','https://localhost','capacitor://localhost','app://unilab'}
BASE=Path(os.environ.get('UNILAB_USAGE_DIR','./usage-data'))
LOCK=threading.Lock(); BUCKETS={}

def connect():
    BASE.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(BASE/'usage.sqlite',timeout=10)
    db.executescript('''CREATE TABLE IF NOT EXISTS counts(day TEXT,tool TEXT,event TEXT,platform TEXT,version TEXT,total INTEGER,files INTEGER,PRIMARY KEY(day,tool,event,platform,version));
    CREATE TABLE IF NOT EXISTS sessions(day TEXT,session TEXT,platform TEXT,PRIMARY KEY(day,session,platform));
    CREATE TABLE IF NOT EXISTS visitors(day TEXT,visitor TEXT,platform TEXT,PRIMARY KEY(day,visitor,platform));
    CREATE TABLE IF NOT EXISTS receipts(day TEXT,eventid TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS pilots(token TEXT PRIMARY KEY,code TEXT UNIQUE,created INTEGER);
    CREATE TABLE IF NOT EXISTS pilot_activity(code TEXT,day TEXT,tool TEXT,event TEXT,total INTEGER,PRIMARY KEY(code,day,tool,event));
    CREATE TABLE IF NOT EXISTS feedback(code TEXT,day TEXT,tool TEXT,solved TEXT,rating INTEGER,PRIMARY KEY(code,day,tool));''')
    db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('metricsStartedAt',datetime.now(timezone.utc).isoformat()))
    db.commit()
    return db

def secret():
    p=BASE/'secret';BASE.mkdir(parents=True,exist_ok=True)
    if not p.exists():
        fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:f.write(secrets.token_hex(32))
    return p.read_bytes()

def digest(value):return hmac.new(secret(),value.encode(),hashlib.sha256).hexdigest()

def validate(p,tools):
    if not isinstance(p,dict) or set(p)-{'event','tool','platform','version','session','count','pilot','solved','rating','visitor','eventId'}:raise ValueError('Unexpected fields')
    if p.get('event') not in EVENTS or p.get('platform') not in PLATFORMS:raise ValueError('Unknown event/platform')
    if p.get('tool') not in tools|{'home','privacy','pilot','install'}:raise ValueError('Unknown tool')
    if not re.fullmatch(r'\d+\.\d+\.\d+',str(p.get('version',''))):raise ValueError('Invalid version')
    if not re.fullmatch(r'[a-f0-9]{32}',str(p.get('session',''))):raise ValueError('Invalid session')
    if type(p.get('count',1)) is not int or not 1<=p.get('count',1)<=1000:raise ValueError('Invalid count')
    if 'visitor' in p and not re.fullmatch(r'[a-f0-9]{32}',str(p['visitor'])):raise ValueError('Invalid visitor')
    if p['event']=='files_processed':
        if 'count' not in p or not re.fullmatch(r'[a-f0-9]{32}',str(p.get('eventId',''))):raise ValueError('Processing receipt required')
    elif 'eventId' in p:raise ValueError('Processing receipts only')
    if p.get('pilot') and not re.fullmatch(r'[a-f0-9]{48}',p['pilot']):raise ValueError('Invalid pilot token')
    if p['event']=='pilot_feedback':
        if not p.get('pilot') or p.get('solved') not in {'yes','partly','no'} or type(p.get('rating')) is not int or not 1<=p['rating']<=5:raise ValueError('Invalid feedback')
    elif 'solved' in p or 'rating' in p:raise ValueError('Feedback only')
    return p

def record(p,db):
    now=int(time.time());day=datetime.now(timezone.utc).strftime('%Y-%m-%d')
    code=None
    if p.get('pilot'):
        row=db.execute('SELECT code FROM pilots WHERE token=? AND created>?',(digest(p['pilot']),now-30*86400)).fetchone()
        if not row:raise ValueError('Expired or unknown pilot invitation')
        code=row[0]
    if p['event']=='files_processed':
        inserted=db.execute('INSERT OR IGNORE INTO receipts VALUES(?,?)',(day,digest('event:'+p['eventId'])))
        if not inserted.rowcount:return
    if p.get('visitor'):
        db.execute('INSERT OR IGNORE INTO visitors VALUES(?,?,?)',(day,digest('visitor:'+day+':'+p['visitor']),p['platform']))
    db.execute('INSERT OR IGNORE INTO sessions VALUES(?,?,?)',(day,digest(day+':'+p['session']),p['platform']))
    db.execute('INSERT INTO counts VALUES(?,?,?,?,?,1,?) ON CONFLICT(day,tool,event,platform,version) DO UPDATE SET total=total+1,files=files+excluded.files',(day,p['tool'],p['event'],p['platform'],p['version'],p.get('count',1) if p['event'] in {'files_selected','files_processed'} else 0))
    if code:
        db.execute('INSERT INTO pilot_activity VALUES(?,?,?,?,1) ON CONFLICT(code,day,tool,event) DO UPDATE SET total=total+1',(code,day,p['tool'],p['event']))
        if p['event']=='pilot_feedback':db.execute('INSERT OR REPLACE INTO feedback VALUES(?,?,?,?,?)',(code,day,p['tool'],p['solved'],p['rating']))
    cleanup(db,now)

def cleanup(db,now=None):
    now=int(time.time()) if now is None else now
    cutoff=datetime.fromtimestamp(now-30*86400,timezone.utc).strftime('%Y-%m-%d')
    for table in ['counts','sessions','visitors','receipts','pilot_activity','feedback']:db.execute(f'DELETE FROM {table} WHERE day<?',(cutoff,))
    db.execute('DELETE FROM pilots WHERE created<?',(now-30*86400,));db.commit()

def report():
    db=connect();db.row_factory=sqlite3.Row
    rows=lambda sql:[dict(r) for r in db.execute(sql)]
    return {'generatedAt':datetime.now(timezone.utc).isoformat(),'retentionDays':30,'metricsStartedAt':db.execute("SELECT value FROM metadata WHERE key='metricsStartedAt'").fetchone()[0],'dailyVisitors':rows('SELECT day,count(*) AS visitors FROM visitors GROUP BY day'),'definitions':{'sessions':'Daily browser/app sessions, not unique people. Offline or opted-out use is missing.','download_requested':'Save/download initiated, not proof of a saved or useful file.','pilot':'Organizer must verify one distinct person per invitation. No names collected here.'},'dailySessions':rows('SELECT day,platform,count(*) AS sessions FROM sessions GROUP BY day,platform'),'counts':rows('SELECT * FROM counts ORDER BY day,tool,event'),'pilotActivity':rows('SELECT * FROM pilot_activity ORDER BY code,day'),'pilotFeedback':rows('SELECT * FROM feedback ORDER BY code,day'),'pilotSummary':rows("SELECT p.code,COALESCE(SUM(CASE WHEN a.event='job_completed' THEN a.total ELSE 0 END),0) AS completedJobs,COALESCE(SUM(CASE WHEN a.event='download_requested' THEN a.total ELSE 0 END),0) AS downloadRequests FROM pilots p LEFT JOIN pilot_activity a ON p.code=a.code GROUP BY p.code")}

class Handler(BaseHTTPRequestHandler):
    tools=set()
    def log_message(self,*args):pass # do not persist addresses or payloads
    def reply(self,status,body=b''):
        self.send_response(status)
        origin=self.headers.get('Origin','')
        if origin in ORIGINS:self.send_header('Access-Control-Allow-Origin',origin)
        self.send_header('Vary','Origin');self.send_header('Cache-Control','no-store');self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_OPTIONS(self):
        if self.headers.get('Origin') not in ORIGINS:return self.reply(403)
        self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers['Origin']);self.send_header('Access-Control-Allow-Methods','POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Vary','Origin');self.end_headers()
    def do_GET(self):self.reply(404) # reports available only through operator SSH/CLI
    def do_POST(self):
        if self.path!='/api/usage' or self.headers.get('Origin') not in ORIGINS:return self.reply(403)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=2048:return self.reply(413)
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply(415)
            # The service binds loopback; nginx overwrites this header.
            key=self.headers.get('X-Real-IP',self.client_address[0]);now=time.monotonic()
            with LOCK:
                if len(BUCKETS)>10000:BUCKETS.clear()
                at,n=BUCKETS.get(key,(now,0));at,n=(now,0) if now-at>=60 else (at,n)
                BUCKETS[key]=(at,n+1)
            if n>=600:return self.reply(429)
            p=validate(json.loads(self.rfile.read(length)),self.tools)
            with connect() as db:record(p,db)
            self.reply(202,b'{"accepted":true}')
        except (ValueError,TypeError,json.JSONDecodeError):self.reply(400,b'{"accepted":false}')
        except Exception:self.reply(503,b'{"accepted":false}')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('command',choices=['serve','report','invite','cleanup','erase']);ap.add_argument('--count',type=int,default=30);ap.add_argument('--port',type=int,default=8788);ap.add_argument('--code');args=ap.parse_args()
    if args.command=='cleanup':
        with connect() as db:cleanup(db)
        return
    if args.command=='erase':
        if not re.fullmatch(r'P[0-9]{3,}',args.code or ''):raise SystemExit('Supply --code P001')
        with connect() as db:
            for table in ['pilots','pilot_activity','feedback']:db.execute(f'DELETE FROM {table} WHERE code=?',(args.code,))
        return
    if args.command=='report':print(json.dumps(report(),indent=2));return
    if args.command=='invite':
        if not 1<=args.count<=100:raise SystemExit('Count must be 1..100')
        with connect() as db:
            start=db.execute("SELECT COALESCE(MAX(CAST(SUBSTR(code,2) AS INTEGER)),0) FROM pilots").fetchone()[0]
            for i in range(start+1,start+args.count+1):
                code=f'P{i:03d}';token=secrets.token_hex(24);db.execute('INSERT INTO pilots VALUES(?,?,?)',(digest(token),code,int(time.time())))
                print(code+'\thttps://unilab.ztvmm.live/#/pilot?invite='+token)
            db.commit()
        return
    Handler.tools=set(json.loads((Path(__file__).parent/'tools.json').read_text()))
    connect().close();secret();ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
if __name__=='__main__':main()
