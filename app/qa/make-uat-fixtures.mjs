// Deterministic synthetic documents. None of these represent real people or credentials.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
const root=new URL('./fixtures/uat/',import.meta.url);mkdirSync(root,{recursive:true});
const save=(name,bytes)=>writeFileSync(new URL(name,root),bytes);
for (const [name,count,title] of [['application-form.pdf',1,'SYNTHETIC APPLICATION'],['petition-form.pdf',1,'SYNTHETIC PETITION'],['data-structures-textbook.pdf',120,'SYNTHETIC TEXTBOOK']]) {
 const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica);
 for(let i=1;i<=count;i++){const p=d.addPage([595,842]);p.drawText(title,{font,x:40,y:750,size:22});p.drawText(`Page ${i} - QA fixture only. No personal data.`,{font,x:40,y:700,size:15});if(name.startsWith('petition')){p.drawText('Signature:',{font,x:40,y:210,size:16});p.drawLine({start:{x:160,y:200},end:{x:450,y:200}});}}
 save(name,await d.save());
}
for(const [name,label,color] of [['ielts-cert.jpg','SYNTHETIC SCORECARD','#2266aa'],['thai-id-card.png','SYNTHETIC ID - NOT VALID','#bb5522']]){
 const c=createCanvas(900,550),g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,900,550);g.fillStyle=color;g.fillRect(40,40,820,140);g.fillStyle='#fff';g.font='bold 28px sans-serif';g.fillText(label,60,120);g.fillStyle='#111';g.font='26px sans-serif';g.fillText('Fictional fixture. No real identity or scores.',40,280);save(name,c.toBuffer(name.endsWith('jpg')?'image/jpeg':'image/png'));
}
const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica);
for(let i=1;i<=6;i++){
 const c=createCanvas(1400,1900),g=c.getContext('2d');let seed=i;
 const pixels=g.createImageData(1400,1900);
 for(let k=0;k<pixels.data.length;k+=4){seed=(1664525*seed+1013904223)>>>0;const n=220+(seed%36);pixels.data[k]=n;pixels.data[k+1]=n-6;pixels.data[k+2]=n-12;pixels.data[k+3]=255;}g.putImageData(pixels,0,0);
 const im=await d.embedJpg(c.toBuffer('image/jpeg',95));const p=d.addPage([595,842]);p.drawImage(im,{x:0,y:0,width:595,height:842});p.drawRectangle({x:40,y:680,width:515,height:100,color:rgb(.1,.4,.8)});p.drawText(`UPRIGHT - SYNTHETIC SLIDE ${i}`,{font,x:55,y:735,size:20,color:rgb(1,1,1)});p.drawText('Readability check: assignment due 4 November.',{font,x:40,y:620,size:15});if(i===3)p.setRotation(degrees(180));
}
const raw=Buffer.from(await d.save());const pad=15_000_000-raw.length;
if(pad<2)throw Error('Fixture exceeds intended 15 MB');
const eof=raw.lastIndexOf('%%EOF');save('sample-lecture-slides-15mb.pdf',Buffer.concat([raw.subarray(0,eof),Buffer.from('%'+'x'.repeat(pad-2)+'\n'),raw.subarray(eof)]));
save('README.txt',Buffer.from('Synthetic fixtures only. Slide PDF has six scanned-style pages and deterministic comment padding to exactly 15,000,000 bytes; it is a size-path fixture, not representative compression benchmark evidence. Page 3 is rotated 180 degrees. Textbook has 120 labelled pages. No participant data.'));
console.log('UAT fixtures generated in qa/fixtures/uat');
