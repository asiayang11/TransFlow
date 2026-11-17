import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessions } from '../server/web/sessions.mjs';
import { createFailureLogger } from '../server/web/diagnostics.mjs';
test('timed out translation keeps original, exposes recovery and accounts successful usage',async t=>{
 let slow=true;
 const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const items=JSON.parse(JSON.parse(raw).messages[1].content).items;if(slow)await new Promise(resolve=>setTimeout(resolve,150));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{content:JSON.stringify({items:items.map(item=>({id:item.id,text:'恢复后的译文'}))})}}]}));});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>model.close(resolve)));
 const manager=new BrowserSessions({key:'test',model:'fixture',base:`http://127.0.0.1:${model.address().port}`,timeoutMs:30,inputPrice:1,outputPrice:2});manager.scan=()=>{};
 const block={id:1,source:'Original paragraph',context:''};
 const session={id:'test',epoch:'doc',language:'zh-CN',blocks:[block],metrics:manager.newMetrics(),resourceFailures:new Map(),cache:new Map(),translations:new Map(),failed:new Map(),pending:new Set(),clients:new Set(),sequence:0,workers:0,commands:new Map(),queue:Promise.resolve()};
 await manager.translate(session,[block]);
 assert.equal(session.translations.size,0);assert.match(session.translationError,/超时/);assert.equal(session.translationPaused,true);assert.equal(session.metrics.failedRequests,1);
 assert.equal(manager.status(session).blocks[0].error.code,'MODEL_TIMEOUT');
 slow=false;manager.config.timeoutMs=1000;
 await manager.command(session,{requestId:'retry',type:'retry'});await manager.translate(session,[block]);
 assert.equal(session.translationPaused,false);assert.equal(session.translations.get(1).text,'恢复后的译文');assert.equal(session.translationError,'');
 assert.equal(manager.status(session).blocks[0].error,undefined);
 const status=manager.status(session);assert.equal(status.metrics.inputTokens,100);assert.equal(status.metrics.outputTokens,50);assert.equal(status.metrics.estimatedCostUsd,0.0002);
 manager.config.inputPrice=null;assert.equal(manager.status(session).metrics.estimatedCostUsd,null,'unknown prices never masquerade as free usage');
});

test('one invalid paragraph does not discard valid peers or pause the entire page',async t=>{
 let invalid=true;
 const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(JSON.parse(raw).messages[1].content);
  const content=input.items ? JSON.stringify({items:input.items.map(item=>{
   if(input.contexts)return {id:item.id,text:''};
   if(item.segments)return {id:item.id,segments:invalid ? [] : item.segments.map(segment=>({...segment,text:segment.protected?segment.text:'使用 '}))};
   return {id:item.id,text:'有效译文'};
  })}) : '';
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));
 });
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>model.close(resolve)));
 const directory=await mkdtemp(join(tmpdir(),'transflow-web-diagnostics-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const logger=createFailureLogger(directory);
 const manager=new BrowserSessions({key:'test',model:'fixture',base:`http://127.0.0.1:${model.address().port}`},{logFailure:logger.write});manager.scan=()=>{};
 const blocks=[{id:1,source:'Valid paragraph',context:''},{id:2,source:'Use fetch()',context:'',segments:[{id:2,source:'Use ',protected:false},{id:3,source:'fetch()',protected:true}]}];
 const session={id:'test',epoch:'doc',language:'zh-CN',blocks,metrics:manager.newMetrics(),resourceFailures:new Map(),cache:new Map(),translations:new Map(),failed:new Map(),pending:new Set(),clients:new Set(),sequence:0,workers:0,commands:new Map(),queue:Promise.resolve()};
 await manager.translate(session,blocks);
 assert.equal(session.translations.get(1).text,'有效译文');assert.equal(session.translations.has(2),false);assert.equal(session.failed.size,1);assert.notEqual(session.translationPaused,true);assert.match(session.translationError,/部分段落/);
 const error=manager.status(session).blocks[1].error;
 assert.equal(error.code,'MODEL_RECOVERY_NO_TEXT');
 assert.equal(error.preview,'Use fetch()');
 await logger.flush();
 const log=JSON.parse(await readFile(join(directory,'translation-errors.jsonl'),'utf8'));
 assert.equal(log.blockId,2);assert.equal(log.code,error.code);assert.equal(log.message,error.message);
 assert.equal(log.preview,undefined);assert.equal(log.sessionId,undefined);
 invalid=false;await manager.command(session,{type:'retry',requestId:'retry-invalid'});await manager.translate(session,[blocks[1]]);
 assert.equal(session.translations.get(2).parts[0].text,'使用 ');assert.equal(session.failed.size,0);assert.equal(session.translationError,'');
});
