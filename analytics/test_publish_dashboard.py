import json, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from publish_dashboard import aggregate, publish
class PublishTests(unittest.TestCase):
 def test_allowlist_and_daily_totals(self):
  source={'metricsStartedAt':'2026-10-27T00:00:00+00:00','dailyVisitors':[{'day':'2026-10-27','visitors':1}],'dailySessions':[{'day':'2026-10-27','sessions':2,'session':'SECRET'}], 'counts':[{'day':'2026-10-27','event':'files_selected','files':3,'total':1,'tool':'PRIVATE'},{'day':'2026-10-27','event':'job_completed','files':0,'total':1},{'day':'2026-10-27','event':'pilot_feedback','files':0,'total':50},{'day':'2020-01-01','event':'job_completed','total':999}], 'pilotFeedback':[{'code':'P001','token':'SECRET'}]}
  now=datetime(2026,10,27,tzinfo=timezone.utc)
  data=aggregate(source,now);self.assertEqual(len(data['daily']),30)
  self.assertEqual(data['daily'][-1],{'day':'2026-10-27','sessions':2,'visitors':1,'processedFiles':0,'selectedFiles':3,'completedJobs':1,'failedJobs':0,'downloadRequests':0,'confirmedSaves':0})
  self.assertIsNone(data['daily'][0]['visitors']);self.assertIsNone(data['daily'][0]['processedFiles'])
  with tempfile.TemporaryDirectory() as d:
   publish(d,source,now)
   self.assertEqual(set(p.name for p in Path(d).iterdir()),{'index.html','data.json','daily.csv'})
   text=(Path(d)/'data.json').read_text()+(Path(d)/'daily.csv').read_text()
   for secret in ['SECRET','PRIVATE','P001','pilot_feedback','999']:self.assertNotIn(secret,text)
   self.assertIn('2026-10-27,2,1,3,0,1,0,0,0',text)
   publish(d,{'dailySessions':[],'counts':[]},now)
   self.assertEqual(json.loads((Path(d)/'data.json').read_text())['daily'][-1]['sessions'],0)
if __name__=='__main__':unittest.main()
