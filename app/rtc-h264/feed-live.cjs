const net=require('net'); const http=require('http'); const WebSocket=require('ws');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:8660,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
function annexb(a){const o=[];let p=0;while(p+4<=a.length){const n=a.readUInt32BE(p);p+=4;if(n<=0||p+n>a.length)break;o.push(Buffer.from([0,0,0,1]));o.push(a.subarray(p,p+n));p+=n;}return Buffer.concat(o);}
function avcc(b64){const b=Buffer.from(b64,'base64');const ns=b[5]&0x1f;let p=6;const out=[];for(let i=0;i<ns;i++){const l=b.readUInt16BE(p);p+=2;out.push(Buffer.from([0,0,0,1]));out.push(b.subarray(p,p+l));p+=l;}const np=b[p];p+=1;for(let i=0;i<np;i++){const l=b.readUInt16BE(p);p+=2;out.push(Buffer.from([0,0,0,1]));out.push(b.subarray(p,p+l));p+=l;}return Buffer.concat(out);}
(async()=>{
 const key=process.argv[2];
 const init=await getJson('/h264-init?k='+encodeURIComponent(key));
 const pre=avcc(init.description);
 const sock=net.connect(9900,'127.0.0.1',()=>console.log('tcp connected'));
 const ws=new WebSocket('ws://127.0.0.1:8660/ws-h264?k='+encodeURIComponent(key));
 ws.on('message',(d)=>{ if(typeof d==='string')return; const b=Buffer.from(d); if(b.length<10)return;
   const k=b[4]===1; const len=b.readUInt32BE(5); if(len<=0||b.length<9+len)return;
   let pl=annexb(b.subarray(9,9+len)); if(k) pl=Buffer.concat([pre,pl]);
   const h=Buffer.alloc(5); h.writeUInt32BE(pl.length,0); h[4]=k?1:0; sock.write(Buffer.concat([h,pl]));
 });
})();