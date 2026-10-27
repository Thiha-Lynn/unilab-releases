import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
class DashboardTests(unittest.TestCase):
 def test_public_export_excludes_pilot_identifiers_and_escapes_text(self):
  report={'generatedAt':'test','counts':[{'day':'2026-10-27','tool':'<script>bad()</script>','event':'files_selected','total':1,'files':3}], 'dailySessions':[{'day':'2026-10-27','sessions':2}], 'pilotActivity':[], 'pilotFeedback':[{'code':'PRIVATE-P001','solved':'yes','rating':5}], 'pilotSummary':[{'code':'PRIVATE-P001'}], 'definitions':{'sessions':'Sessions are not people'}}
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(tmp)/'r.json';source.write_text(json.dumps(report));out=Path(tmp)/'public.html'
   subprocess.run([sys.executable,str(Path(__file__).with_name('dashboard.py')),str(source),str(out),'--public'],check=True)
   html=out.read_text();self.assertNotIn('PRIVATE-P001',html);self.assertNotIn('<script>',html);self.assertIn('Daily activity (UTC)',html)
   self.assertIn('2026-10-27,2,0,3,0,0,0,0',out.with_suffix('.daily.csv').read_text())
if __name__=='__main__':unittest.main()
