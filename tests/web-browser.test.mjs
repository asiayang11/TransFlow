import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { BrowserSessions } from '../server/web/sessions.mjs';

const fixture = `<!doctype html><html><head><title>Public reading fixture</title><style>body{font:18px sans-serif;margin:32px}p{max-width:40em}button:hover{color:red}.spacer{height:1000px}</style></head><body>
<h1>A shared reading state</h1><p>Read this <a href="#bottom">public document</a> in context with <code>fetch()</code>.</p>
<button id="counter" onclick="this.textContent='Clicked '+(++window.clicks)">Expand information</button>
<details><summary>More details</summary><p>New visible content is translated too.</p></details>
<input id="search" type="search" aria-label="Search" onfocus="document.body.dataset.focused='yes'" oninput="document.querySelector('#output').textContent=this.value"><p id="output">Initial result</p>
<a id="next" href="/next" target="_blank">Next article</a><div class="spacer"></div><h2 id="bottom">Keep your reading position</h2><p>Bottom paragraph.</p>
<iframe src="/frame" title="Unsupported embedded region"></iframe><script>window.clicks=0;window.siteRuns=(window.siteRuns||0)+1</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for capture/translation'); await delay(30); }
}

test('real Chromium capture, single execution, incremental translation, navigation and disposal', { timeout: 45000 }, async t => {
  let failModel = false, modelCalls = 0;
  const model = http.createServer(async (request, response) => {
    modelCalls++;
    let raw=''; for await (const chunk of request) raw += chunk;
    if (failModel) { response.writeHead(401); response.end('{}'); return; }
    const items=JSON.parse(JSON.parse(raw).messages[1].content).items;
    await delay(80);
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({ choices:[{message:{content:JSON.stringify({items:items.map(item=>({id:item.id,...(item.segments ? {segments:item.segments.map(part=>({...part,text:part.protected?part.text:`译文：${part.text.trim()}`}))} : {text:`译文：${item.text.trim()}`})}))})}}] }));
  });
  await new Promise(resolve => model.listen(0,'127.0.0.1',resolve));
  const manager = new BrowserSessions({key:'test-only',model:'fixture',mode:'openai',base:`http://127.0.0.1:${model.address().port}`}, {
    prepareContext: context => context.route('**/*', route => route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname === '/frame' ? '<html><body>Embedded content</body></html>' : fixture})),
  });
  t.after(async () => { await manager.shutdown(); await new Promise(resolve => model.close(resolve)); });
  // A public literal IP avoids relying on DNS or reaching a real website. All
  // requests are fulfilled by the injected fixture; production has no bypass.
  const session = await manager.create({url:'https://1.1.1.1/fixture'});
  const errors=[]; session.page.on('pageerror',error => errors.push(error.message));
  await session.queue;
  await until(()=>!!session.epoch && session.events.some(event=>event.type===2));
  await manager.scan(session); await until(()=>session.translations.size>0);
  assert.equal(await session.page.evaluate(()=>window.siteRuns),1);
  assert.deepEqual(errors,[]);
  assert.ok(session.blocks.find(block=>block.source.startsWith('Read this')).segments.some(part=>part.protected && part.source==='fetch()'));
  assert.ok(session.blocks.some(block=>block.source.includes('shared reading')));
  assert.ok([...session.translations.values()].some(entry=>entry.text.includes('译文')));
  await until(()=>[...session.translations.values()].some(entry=>entry.attribute==='aria-label'));
  const replayContext=await (await manager.browser()).newContext();
  const replayPage=await replayContext.newPage();
  await replayPage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));
  await replayPage.goto('https://1.1.1.1/replay');
  await replayPage.addScriptTag({content:await readFile(new URL('../node_modules/@rrweb/replay/dist/replay.umd.cjs',import.meta.url),'utf8')});
  await replayPage.evaluate(events=>{
    window.player=new rrwebReplay.Replayer([],{root:document.querySelector('#root'),liveMode:true,useVirtualDom:false,mouseTail:false});
    player.startLive(Date.now()-100); events.forEach(event=>player.addEvent({...event,timestamp:Date.now()-150}));
  },session.events);
  await replayPage.waitForFunction(()=>window.player.iframe.contentDocument?.body?.innerText.includes('A shared reading state'));
  assert.equal(await replayPage.evaluate(()=>window.player.iframe.contentWindow.siteRuns),undefined,'mirrors never execute site scripts');
  await replayContext.close();
  const id = selector => session.page.evaluate(selector=>window.__transflow.record.mirror.getId(document.querySelector(selector)),selector);
  const command = data => manager.command(session,{requestId:crypto.randomUUID(),epoch:session.epoch,...data});
  const click={type:'click',id:await id('#counter'),epoch:session.epoch,requestId:'click-once'};
  await Promise.all([manager.command(session,click),manager.command(session,click)]);
  assert.equal(await session.page.evaluate(()=>window.clicks),1,'duplicate action executes once');
  await manager.scan(session); await until(()=>[...session.translations.values()].some(entry=>entry.source==='Clicked 1'));
  await command({type:'click',id:await id('summary')});
  await manager.scan(session); await until(()=>[...session.translations.values()].some(entry=>entry.source.includes('New visible')));
  await command({type:'focus',id:await id('#search')});
  assert.equal(await session.page.evaluate(()=>document.body.dataset.focused),'yes');
  await command({type:'hover',id:await id('#counter')});
  assert.equal(await session.page.locator('#counter').evaluate(node=>getComputedStyle(node).color),'rgb(255, 0, 0)');
  await command({type:'unhover',id:await id('#counter')});
  assert.notEqual(await session.page.locator('#counter').evaluate(node=>getComputedStyle(node).color),'rgb(255, 0, 0)');
  await command({type:'input',id:await id('#search'),value:'Public search'});
  assert.equal(await session.page.locator('#output').textContent(),'Public search');
  await command({type:'scroll',id:await id('#bottom'),containerId:0,offset:0,ratio:1,left:0});
  assert.ok(await session.page.evaluate(()=>scrollY)>500);
  const oldEpoch=session.epoch;
  await command({type:'click',id:await id('#next')});
  await until(()=>session.url.endsWith('/next') && session.epoch!==oldEpoch);
  assert.equal(session.context.pages().length,1,'target blank stays in one authoritative page');
  await assert.rejects(command({type:'click',id:click.id,epoch:oldEpoch}),/页面已变化/);
  await command({type:'language',language:'ja'});
  assert.equal(session.language,'ja');
  await until(()=>session.translations.size>0 && !session.workers);
  failModel = true;
  await command({type:'language',language:'de'});
  await until(()=>session.translationPaused && !session.workers);
  const failedCalls = modelCalls;
  await manager.scan(session); await manager.scan(session);
  assert.equal(modelCalls,failedCalls,'model failure pauses additional scheduling');
  failModel = false;
  await command({type:'retry'});
  await until(()=>session.translations.size>0);
  assert.ok(session.metrics.requests>0); assert.ok(session.metrics.firstTranslationMs>=0);
  await manager.close(session);
  assert.equal(manager.sessions.size,0); assert.equal(session.closed,true);
});
