// Numeric telemetry only. Never fingerprint or inspect a file to identify a visitor.
export const VISITOR_KEY='unilab.usage.daily-visitor';
export const randomId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
export function dailyVisitor(storage,now=Date.now()) {
 const day=new Date(now).toISOString().slice(0,10);
 try {
  let value;try{value=JSON.parse(storage.getItem(VISITOR_KEY)||'null')}catch{}
  if(value?.day!==day||!/^[a-f0-9]{32}$/.test(value?.id||'')){
   value={day,id:randomId()};storage.setItem(VISITOR_KEY,JSON.stringify(value));
  }
  // Blocked storage must not invent a new "unique visitor" for every event.
  return JSON.parse(storage.getItem(VISITOR_KEY))?.id===value.id?value.id:null;
 }catch{return null}
}
export function processingChunks(count){
 if(!Number.isSafeInteger(count)||count<=0)return [];
 const chunks=[];for(let remaining=count;remaining>0;remaining-=1000)chunks.push(Math.min(1000,remaining));return chunks;
}
