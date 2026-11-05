const WebSocket=require('ws'); const fs=require('fs'); const http=require('http');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:8660,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
function annexb(avcc){ const out=[]; let o=0; while(o+4<=avcc.length){ const n=avcc.readUInt32BE(o); o+=4; if(n<=0||o+n>avcc.length) break; out.push(Buffer.from([0,0,0,1])); out.push(avcc.subarray(o,o+n)); o+=n; } return Buffer.concat(out); }
function parseAvcC(b64){ const b=Buffer.from(b64,'base64'); const nSps=b[5]&0x1f; let o=6; const sps=[]; for(let i=0;i<nSps;i++){ const l=b.readUInt16BE(o); o+=2; sps.push(b.subarray(o,o+l)); o+=l; } const nPps=b[o]; o+=1; const pps=[]; for(let i=0;i<nPps;i++){ const l=b.readUInt16BE(o); o+=2; pps.push(b.subarray(o,o+l)); o+=l; } const pre=[]; for(const s of sps){pre.push(Buffer.from([0,0,0,1]));pre.push(s);} for(const p of pps){pre.push(Buffer.from([0,0,0,1]));pre.push(p);} return Buffer.concat(pre); }
(async()=>{
 const key=process.argv[2]; const out=process.argv[3];
 const init=await getJson('/h264-init?k='+encodeURIComponent(key));
 const prefix=parseAvcC(init.description);
 const fd=fs.openSync(out,'w'); let n=0;
 const ws=new WebSocket('ws://127.0.0.1:8660/ws-h264?k='+encodeURIComponent(key));
 ws.on('message',(d)=>{ if(typeof d==='string')return; const b=Buffer.from(d); if(b.length<10)return;
   const keyf=b[4]===1; const len=b.readUInt32BE(5); if(len<=0||b.length<9+len)return;
   let payload=annexb(b.subarray(9,9+len));
   if(keyf) payload=Buffer.concat([prefix,payload]);
   const head=Buffer.alloc(5); head.writeUInt32BE(payload.length,0); head[4]=keyf?1:0;
   fs.writeSync(fd,head); fs.writeSync(fd,payload); n++;
 });
 setTimeout(()=>{ try{fs.closeSync(fd)}catch(e){}; console.log('recorded '+n+' annexb frames'); process.exit(0); },6000);
})();