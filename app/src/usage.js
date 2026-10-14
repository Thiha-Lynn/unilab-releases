// Small first-party counters. Never pass files, names, text, URLs or errors here.
import { TOOLS } from './registry.js';
const ids=new Set(TOOLS.map(t=>t.id));
const events=new Set(['session_start','tool_open','files_selected','job_started','job_completed','job_failed','download_requested','download_saved','pilot_feedback']);
const DISABLED='unilab.usage.disabled', SESSION='unilab.usage.session', PILOT='unilab.pilot';
const get=(storage,key)=>{try{return storage.getItem(key)}catch{return null}};
const put=(storage,key,value)=>{try{storage.setItem(key,value)}catch{/* storage may be unavailable */}};
export function toolId(){const id=location.hash.replace(/^#\/?/,'').split('?')[0];return ids.has(id)?id:['privacy','install','pilot'].includes(id)?id:'home';}
export function pilot(){try{const p=JSON.parse(get(localStorage,PILOT)||'null');return p&&p.expires>Date.now()&&/^[a-f0-9]{48}$/.test(p.token)?p:null}catch{return null}}
export function joinPilot(token){if(!/^[a-f0-9]{48}$/.test(token))throw Error('Invalid invitation');put(localStorage,PILOT,JSON.stringify({token,expires:Date.now()+30*86400000}));}
export function leavePilot(){try{localStorage.removeItem(PILOT)}catch{}}
export function usageEnabled(){return get(localStorage,DISABLED)!=='1'&&navigator.doNotTrack!=='1'&&!navigator.globalPrivacyControl;}
export function setUsageEnabled(value){put(localStorage,DISABLED,value?'0':'1');}
let volatileSession;
function session(){let value;try{value=JSON.parse(get(sessionStorage,SESSION)||'null')}catch{}value ||= volatileSession;if(!value||Date.now()-value.at>30*60000){value={id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),at:Date.now()};}value.at=Date.now();put(sessionStorage,SESSION,JSON.stringify(value));volatileSession=value;return value.id;}
export function payload(event,details={},env={tool:toolId(),platform:location.protocol==='app:'?'desktop':location.hostname==='localhost'&&location.protocol==='https:'?'android':'web',version:__APP_VERSION__,session:session(),pilot:pilot()?.token}){
 if(!events.has(event))return null;
 const p={event,tool:env.tool,platform:env.platform,version:env.version,session:env.session};
 if(env.pilot)p.pilot=env.pilot;
 if(event==='files_selected')p.count=Math.min(1000,Math.max(1,Math.floor(details.count)||1));
 if(event==='pilot_feedback'){if(ids.has(details.tool))p.tool=details.tool;if(!env.pilot||!['yes','partly','no'].includes(details.solved)||!Number.isInteger(details.rating)||details.rating<1||details.rating>5)return null;p.solved=details.solved;p.rating=details.rating;}
 return p;
}
export async function track(event,details={}){
 // Development and QA never pollute public counts. Production native origins allowed.
 if(location.hostname==='127.0.0.1'||location.protocol==='http:'||location.search.includes('qa='))return false;
 if(!usageEnabled()&&!pilot())return false;
 if(!navigator.onLine)return false; // no hidden offline queue
 const body=payload(event,details);if(!body)return false;
 try{const response=await fetch('https://unilab.ztvmm.live/api/usage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',referrerPolicy:'no-referrer',keepalive:true,signal:AbortSignal.timeout(4000)});return response.ok}catch{return false}
}
export function initUsage(){
 track('session_start');let active=toolId(),started=false;const seen=new WeakSet();
 const opened=()=>{active=toolId();started=false;track('tool_open')};opened();window.addEventListener('hashchange',opened);
 document.addEventListener('click',e=>{if(!ids.has(toolId()))return;const b=e.target.closest('button');if(b?.matches('.ts__go,[data-go],[data-save],[data-apply]')&&!b.disabled){started=true;const shell=document.querySelector('.ts');if(shell)seen.delete(shell);track('job_started')}},true);
 const observer=new MutationObserver(()=>{
  const app=document.querySelector('#app');if(!app||active!==toolId())return;
  for(const node of app.querySelectorAll('.result,.ts[data-stage="done"],.citation-out')){if(!seen.has(node)){seen.add(node);track('job_completed');started=false;}}
  if(started){const error=app.querySelector('.error-box');if(error&&!seen.has(error)){seen.add(error);track('job_failed');started=false;}}
 });observer.observe(document.querySelector('#app'),{subtree:true,childList:true,attributes:true,attributeFilter:['data-stage']});
}
