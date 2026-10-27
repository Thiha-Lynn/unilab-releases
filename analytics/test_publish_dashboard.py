import json, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from publish_dashboard import aggregate, publish
class PublishTests(unittest.TestCase):
 def test_allowlist_and_daily_totals(self):
  source={'dailySessions':[{'day':'2026-10-27','sessions':2,'session':'SECRET'}], 'counts':[{'day':'2026-10-27','event':'files_selected','files':3,'total':1,'tool':'PRIVATE'},{'day':'2026-10-27','event':'job_completed','files':0,'total':1},{'day':'2026-10-27','event':'pilot_feedback','files':0,'total':50},{'day':'2020-01-01','event':'job_completed','total':999}], 'pilotFeedback':[{'code':'P001','token':'SECRET'}]}
  now=datetime(2026,10,27,tzinfo=timezone.utc)
  data=aggregate(source,now);self.assertEqual(len(data['daily']),30)
  self.assertEqual(data['daily'][-1],{'day':'2026-10-27','sessions':2,'selectedFiles':3,'completedJobs':1,'failedJobs':0,'downloadRequests':0,'confirmedSaves':0})
  with tempfile.TemporaryDirectory() as d:
   publish(d,source,now)
   self.assertEqual(set(p.name for p in Path(d).iterdir()),{'index.html','data.json','daily.csv'})
   text=(Path(d)/'data.json').read_text()+(Path(d)/'daily.csv').read_text()
   for secret in ['SECRET','PRIVATE','P001','pilot_feedback','999']:self.assertNotIn(secret,text)
   self.assertIn('2026-10-27,2,3,1,0,0,0',text)
   publish(d,{'dailySessions':[],'counts':[]},now)
   self.assertEqual(json.loads((Path(d)/'data.json').read_text())['daily'][-1]['sessions'],0)
if __name__=='__main__':unittest.main()
