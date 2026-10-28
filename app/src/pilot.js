import { el } from './ui.js';
import { TOOLS } from './registry.js';
import { pilot,joinPilot,leavePilot,track,usageEnabled,setUsageEnabled } from './usage.js';
export function renderPilot(app){
 const query=new URLSearchParams(location.hash.split('?')[1]||'');const token=query.get('invite');
 const wrap=el('<div class="wrap privacy-page"><a class="back" href="#/">← All tools</a><h1>Help improve UniLab</h1><p>Files stay on your device. Share only whether a tool solved your problem.</p></div>');
 const box=el('<section class="panel"><h2>Optional 30-person pilot</h2><p>Joining links tool names, task outcomes and download requests to your invitation code for up to 30 days. We do not collect your files, filenames, document text, name or email. Your organiser knows who received each invitation; this pilot data is pseudonymous, not anonymous.</p><p>You can leave at any time. Previously submitted counts remain for up to 30 days. Offline work is not sent later automatically.</p></section>');
 if(token&&!pilot()){
  const consent=el('<label class="checkbox"><input type="checkbox"> I agree to share the listed pilot activity for this study.</label>');
  const button=el('<button class="btn" disabled>Join pilot</button>');consent.querySelector('input').onchange=e=>button.disabled=!e.target.checked;
  button.onclick=async()=>{try{joinPilot(token);const ok=await track('tool_open');if(!ok){leavePilot();status.textContent='Could not validate this invitation. Check your connection or ask the organiser for a current link.';return}history.replaceState(null,'','#/pilot');renderPilot(app)}catch{status.textContent='This invitation is invalid.'}};box.append(consent,button);
 }else if(pilot()){
  box.append(el('<p><b>Pilot participation is on.</b> Try a task, inspect the result, then return here to report the outcome.</p>'));
  const leave=el('<button class="btn secondary">Leave pilot</button>');leave.onclick=()=>{leavePilot();renderPilot(app)};box.append(leave);
 }else box.append(el('<p>Ask your organiser for a personal pilot invitation. Ordinary use needs no account and no study participation.</p>'));
 const status=el('<p role="status" aria-live="polite"></p>');box.append(status);wrap.append(box);
 if(pilot()){
  const feedback=el('<section class="panel"><h2>Report a task outcome</h2><div class="field"><label for="pilot-tool">Tool you used</label><select id="pilot-tool"></select></div><div class="field"><label for="pilot-solved">Did the output solve your problem?</label><select id="pilot-solved"><option value="yes">Yes</option><option value="partly">Partly</option><option value="no">No</option></select></div><div class="field"><label for="pilot-rating">How easy was it?</label><select id="pilot-rating"><option value="5">5 — Very easy</option><option value="4">4 — Easy</option><option value="3">3 — Neutral</option><option value="2">2 — Difficult</option><option value="1">1 — Very difficult</option></select></div><button class="btn">Send feedback</button><p role="status" aria-live="polite"></p></section>');
  const select=feedback.querySelector('#pilot-tool');for(const t of TOOLS){const o=document.createElement('option');o.value=t.id;o.textContent=t.name;select.append(o)}
  feedback.querySelector('button').onclick=async e=>{e.target.disabled=true;const result=feedback.querySelector('[role=status]');
   try{const ok=await track('pilot_feedback',{tool:select.value,solved:feedback.querySelector('#pilot-solved').value,rating:Number(feedback.querySelector('#pilot-rating').value)});if(!ok)throw Error();result.textContent='Feedback received. Thank you for trying a real task.'}catch{result.textContent='Feedback was not sent. Check your connection and try again.'}finally{e.target.disabled=false}
  };wrap.append(feedback);
 }
 const settings=el('<section class="panel"><h2>Anonymous usage counts</h2><p>We count tool visits, locally selected files, successfully processed input files, completed jobs and download requests, grouped by version and platform. A random identifier lasts for this browser session (renewed after 30 minutes idle). A separate random daily identifier in local storage counts browser/app instances across tabs. It resets each UTC day, is deleted when counts are disabled, and is stored server-side only as a day-specific keyed hash. Neither visitor nor session counts prove distinct people. Files and filenames are never included. Our first-party server receives your IP for the connection but the counter database does not store it. Counts expire after 30 days.</p><label class="checkbox"><input type="checkbox"> Allow anonymous usage counts</label><p>Do Not Track and Global Privacy Control disable ordinary counts. Explicit pilot participation is separate. No analytics cookies or advertising trackers.</p></section>');settings.querySelector('input').checked=usageEnabled();settings.querySelector('input').onchange=e=>setUsageEnabled(e.target.checked);wrap.append(settings);app.replaceChildren(wrap);
}
