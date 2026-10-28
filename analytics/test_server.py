import tempfile, unittest, threading, json, http.client
from pathlib import Path
import server
class UsageTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();server.BASE=Path(self.tmp.name);self.p={'event':'job_completed','tool':'compress-pdf','platform':'web','version':'0.4.0','session':'a'*32}
 def tearDown(self):self.tmp.cleanup()
 def test_rejects_sensitive_or_arbitrary_fields(self):
  for key in ['filename','error','url','email','content','ip']:
   with self.assertRaises(ValueError):server.validate({**self.p,key:'secret'},{'compress-pdf'})
 def test_rollup_and_sessions(self):
  with server.connect() as db:
   for _ in range(2):server.record(server.validate(self.p,{'compress-pdf'}),db)
   self.assertEqual(db.execute('SELECT total FROM counts').fetchone()[0],2)
   self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],1)
   self.assertNotEqual(db.execute('SELECT session FROM sessions').fetchone()[0],self.p['session'])
 def test_pilot_requires_valid_invitation(self):
  with server.connect() as db:
   with self.assertRaises(ValueError):server.record({**self.p,'pilot':'b'*48},db)
   self.assertEqual(db.execute('SELECT count(*) FROM counts').fetchone()[0],0)
 def test_feedback_validation(self):
  for rating in [0,6,True,'5']:
   with self.assertRaises(ValueError):server.validate({**self.p,'event':'pilot_feedback','pilot':'b'*48,'solved':'yes','rating':rating},{'compress-pdf'})
 def test_expiry_without_new_traffic(self):
  with server.connect() as db:
   server.record(self.p,db)
   server.cleanup(db,int(server.time.time())+32*86400)
   self.assertEqual(db.execute('SELECT count(*) FROM counts').fetchone()[0],0)
   self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
 def test_http_origin_limits_and_private_reports(self):
  server.Handler.tools={'compress-pdf'};server.BUCKETS.clear();server.secret()
  http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
  thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
  def request(method,path,body='',origin='https://unilab.ztvmm.live'):
   client=__import__('http.client',fromlist=['HTTPConnection']).HTTPConnection('127.0.0.1',http.server_port,timeout=2)
   client.request(method,path,body,{'Origin':origin,'Content-Type':'application/json'});r=client.getresponse();status=r.status;r.read();client.close();return status
  try:
   self.assertEqual(request('POST','/api/usage',json.dumps(self.p)),202)
   self.assertEqual(request('POST','/api/usage',json.dumps(self.p),'https://evil.example'),403)
   self.assertEqual(request('POST','/api/usage',json.dumps({**self.p,'filename':'private.pdf'})),400)
   self.assertEqual(request('POST','/api/usage','x'*2049),413)
   self.assertEqual(request('GET','/report'),404)
   # Exercise real HTTP ingestion -> SQLite deduplication -> public projection.
   from publish_dashboard import aggregate
   receipt={**self.p,'visitor':'c'*32,'event':'files_processed','eventId':'d'*32,'count':3}
   self.assertEqual(request('POST','/api/usage',json.dumps(receipt)),202)
   self.assertEqual(request('POST','/api/usage',json.dumps(receipt)),202)
   self.assertEqual(request('POST','/api/usage',json.dumps({**self.p,'session':'b'*32,'visitor':'c'*32,'event':'download_requested'})),202)
   public=aggregate(server.report());today=public['daily'][-1]
   self.assertEqual(today['visitors'],1)
   self.assertEqual(today['sessions'],2)
   self.assertEqual(today['processedFiles'],3)
   self.assertEqual(today['downloadRequests'],1)
   self.assertEqual(today['confirmedSaves'],0)
   for private in ['visitor"','eventId','session"','private.pdf','pilotFeedback']:
    self.assertNotIn(private,json.dumps(public))
  finally:http.shutdown();http.server_close();thread.join()
if __name__=='__main__':unittest.main()

class NewMetricsTests(unittest.TestCase):
 setUp=UsageTests.setUp
 tearDown=UsageTests.tearDown
 def test_daily_visitors_and_idempotent_success_counts(self):
  p={**self.p,'visitor':'c'*32,'event':'files_processed','eventId':'d'*32,'count':3}
  with server.connect() as db:
   server.record(server.validate(p,{'compress-pdf'}),db)
   server.record(p,db)
   server.record({**self.p,'session':'b'*32,'visitor':'c'*32},db)
   self.assertEqual(db.execute('SELECT count(*) FROM visitors').fetchone()[0],1)
   self.assertNotEqual(db.execute('SELECT visitor FROM visitors').fetchone()[0],p['visitor'])
   self.assertEqual(db.execute("SELECT total,files FROM counts WHERE event='files_processed'").fetchone(),(1,3))
   server.cleanup(db,int(server.time.time())+32*86400)
   self.assertEqual(db.execute('SELECT count(*) FROM visitors').fetchone()[0],0)
   self.assertEqual(db.execute('SELECT count(*) FROM receipts').fetchone()[0],0)
 def test_new_fields_are_bounded(self):
  for extra in [{'visitor':'fingerprint'},{'event':'files_processed','count':2},{'eventId':'e'*32}]:
   with self.assertRaises(ValueError):server.validate({**self.p,**extra},{'compress-pdf'})
