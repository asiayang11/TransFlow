import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebServer } from '../server/web/main.mjs';
import { createPublicProxy } from '../server/web/network.mjs';
import http from 'node:http';

test('local API rejects cross-origin mutations, missing headers and private URL sessions', async t => {
  const app=await startWebServer({port:0,config:{key:'',mode:'openai'}});
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/web/health`)).status,200);
  assert.equal((await fetch(`${base}/api/web/sessions`,{method:'POST',headers:{Origin:'https://evil.example','X-TransFlow-Web':'1'},body:'{}'})).status,403);
  assert.equal((await fetch(`${base}/api/web/sessions`,{method:'POST',body:'{}'})).status,403);
  for (const url of ['http://127.0.0.1','http://2130706433','http://[::1]','http://169.254.169.254']) {
    const response=await fetch(`${base}/api/web/sessions`,{method:'POST',headers:{'X-TransFlow-Web':'1'},body:JSON.stringify({url})});
    assert.equal(response.status,400,url);
  }
  assert.equal(app.sessions.sessions.size,0);
});
test('Chromium forward proxy blocks loopback HTTP and CONNECT destinations', async t => {
  const proxy=await createPublicProxy(); t.after(()=>proxy.close());
  for (const target of ['http://127.0.0.1/','http://169.254.169.254/latest/meta-data/']) {
    const status=await new Promise((resolve,reject)=>{ const req=http.get(proxy.url,{path:target},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject); });
    assert.equal(status,403);
  }
  const status=await new Promise((resolve,reject)=>{
    const req=http.request(proxy.url,{method:'CONNECT',path:'127.0.0.1:443'});
    req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.on('error',reject);req.end();
  });
  assert.equal(status,403);
});
