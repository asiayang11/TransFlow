import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { BrowserSessions } from '../server/web/sessions.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) { const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw Error('mirror assertion timeout');await delay(30);} }
const html=`<html><head><style>input:focus{outline:3px solid red}button:hover{color:red}</style></head><body>
<nav style="position:fixed;top:0;left:0"><ul><li>Sticky navigation</li></ul></nav><iframe src="about:blank" width="320" height="120"></iframe><h1>Reading together</h1><p id="sentence">Read <a href="#end">the docs</a> with <code>fetch()</code>.</p>
<input type="search" id="search" oninput="window.searches=(window.searches||0)+1;document.querySelector('#result').textContent=this.value"><p id="result">Search result</p>
<details><summary>Expand</summary><p>New details content</p></details>
<button id="spa" onclick="history.pushState({},'', '/next');document.querySelector('h1').textContent='Next article'">Next page</button>
<div style="height:1500px"></div><p id="end">The last paragraph</p><script>new IntersectionObserver(entries=>{if(entries[0].isIntersecting&&!document.querySelector('#lazy')){let p=document.createElement('p');p.id='lazy';p.textContent='Lazy content loaded';document.body.append(p);}}).observe(document.querySelector('#end'));</script></body></html>`;
test('two real DOM mirrors: atomic paragraphs, IME, focus, hover, SPA, lazy scroll and reconnect', {timeout:30000},async t=>{
 const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const items=JSON.parse(JSON.parse(raw).messages[1].content).items;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{prompt_tokens:10,completion_tokens:5},choices:[{message:{content:JSON.stringify({items:items.map(item=>({id:item.id,...(item.segments?{segments:item.segments.map(s=>({...s,text:s.protected?s.text:'中 '+s.text}))}:{text:'中 '+item.text})}))})}}]}));});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const manager=new BrowserSessions({key:'test',model:'fixture',base:`http://127.0.0.1:${model.address().port}`},{prepareContext:c=>c.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}))});
 let replay;
 t.after(async()=>{await replay?.close();await manager.shutdown();await new Promise(resolve=>model.close(resolve));});
 const session=await manager.create({url:'https://1.1.1.1/fixture',width:600,height:400});await session.queue;
 await until(()=>session.translations.size>3);
 replay=await(await manager.browser()).newContext({viewport:{width:1300,height:600}});const page=await replay.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body><div id="source"></div><div id="target"></div></body></html>'}));await page.goto('https://1.1.1.1/harness');
 const bundle=await build({entryPoints:['src/web-mirror.ts'],bundle:true,write:false,format:'iife',globalName:'Module'});await page.addScriptTag({content:bundle.outputFiles[0].text});
 const commands=[];let delivery=Promise.resolve();
 await page.exposeFunction('action',command=>{commands.push(command);return manager.command(session,{...command,requestId:crypto.randomUUID()}).catch(()=>{});});
 const send=manager.send.bind(manager);manager.send=(s,type,data)=>{send(s,type,data);if(s!==session)return;delivery=delivery.then(()=>page.evaluate(({type,data})=>{if(type==='record')mirror.record(data.event);if(type==='reset')mirror.reset(data.epoch);if(type==='translations')mirror.translations(data.epoch,data.language,data.entries);}, {type,data})).catch(()=>{});};
 const bootstrap=()=>page.evaluate(data=>{if(!window.mirror){window.mirror=new Module.WebMirror([document.querySelector('#source'),document.querySelector('#target')],value=>window.action(value),()=>{},()=>{window.failed=true;},{interacted:()=>{window.interactions=(window.interactions||0)+1;}});mirror.dimensions(600,400);}mirror.bootstrap(data.epoch,data.events,data.entries,data.language);},{epoch:session.epoch,events:session.events,entries:[...session.translations.values()],language:session.language});
 await bootstrap();await until(()=>page.evaluate(()=>mirror.players[1].iframe.contentDocument?.querySelector('h1')?.textContent.startsWith('中')));
 assert.equal(await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('code').textContent),'fetch()');
 assert.equal(await page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('.rr-block').getBoundingClientRect().height),124,'blocked iframe retains its measured border-box height');
 await page.evaluate(()=>{const doc=mirror.players[1].iframe.contentDocument,input=doc.querySelector('input');input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='中';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));input.value='中文';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
 await delay(100);assert.equal(commands.filter(c=>c.type==='input').length,0,'IME intermediate states never trigger source searches');
 await page.evaluate(()=>{const input=mirror.players[1].iframe.contentDocument.querySelector('input');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input.dispatchEvent(new InputEvent('input',{bubbles:true}));});
 await until(()=>session.page.evaluate(()=>window.searches===1));
 assert.equal(commands.filter(c=>c.type==='input').length,1,'IME final input is sent once');
 await until(()=>page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('input').value==='中文'));
 assert.equal(await page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('input').classList.contains('transflow-focus')),true);
 await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('#spa').dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));
 assert.equal(await page.evaluate(()=>mirror.players.every(player=>player.iframe.contentDocument.querySelector('#spa').classList.contains(':hover'))),true);
 await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('#spa').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:null})));
 assert.equal(await page.evaluate(()=>mirror.players.every(player=>!player.iframe.contentDocument.querySelector('#spa').classList.contains(':hover'))),true);
 await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('summary').click());
 await until(()=>page.evaluate(()=>mirror.players.every(player=>player.iframe.contentDocument.querySelector('details').open)));
 await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('#spa').click());
 await until(()=>session.url.endsWith('/next'));
 await until(()=>page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('h1').textContent==='Next article'));
 await page.evaluate(()=>mirror.players[1].iframe.contentWindow.scrollTo(0,1600));
 await until(()=>session.page.locator('#lazy').count());
 await until(()=>page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('#lazy')!==null));
 // Fixed navigation must never be the semantic anchor for scrolling content.
 const interactions=await page.evaluate(()=>window.interactions||0);
 await page.evaluate(()=>mirror.players[0].iframe.contentWindow.scrollTo(0,800));
 await until(()=>page.evaluate(()=>{const positions=mirror.players.map(player=>player.iframe.contentDocument.querySelector('#end').getBoundingClientRect().top);return Math.abs(positions[0]-positions[1])<100 && mirror.players[1].iframe.contentDocument.scrollingElement.scrollTop>500;}));
 const position=await page.evaluate(()=>mirror.players.map(player=>player.iframe.contentDocument.querySelector('#end').getBoundingClientRect().top));
 assert.ok(Math.abs(position[0]-position[1])<100,'source and target follow body content rather than fixed navigation');
 assert.equal(await page.evaluate(()=>window.interactions||0),interactions,'layout/source scroll is not user intent');
 await page.evaluate(()=>mirror.players[0].iframe.contentDocument.body.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true})));
 assert.equal(await page.evaluate(()=>window.interactions),interactions+1,'wheel is explicit user intent');
 // An authoritative scroll echo must follow content even when raw pixels differ.
 await delay(850);
 await session.page.evaluate(()=>window.scrollTo(0,900));
 await until(()=>session.events.some(event=>event.type===3&&event.data.source===3&&event.transflowAnchor));
 const sourceTop=await session.page.locator('#end').evaluate(node=>node.getBoundingClientRect().top);
 await until(()=>page.evaluate(top=>mirror.players.every(player=>Math.abs(player.iframe.contentDocument.querySelector('#end').getBoundingClientRect().top-top)<100),sourceTop));
 const scrollEvent=session.events.filter(event=>event.type===3&&event.data.source===3&&event.transflowAnchor).at(-1);
 await page.evaluate(event=>mirror.record({...event,data:{...event.data,y:3000}}),scrollEvent);await delay(100);
 assert.equal(await page.evaluate(top=>mirror.players.every(player=>Math.abs(player.iframe.contentDocument.querySelector('#end').getBoundingClientRect().top-top)<100),sourceTop),true);
 await delivery;await bootstrap();await delay(100);
 assert.equal(await page.evaluate(top=>mirror.players.every(player=>Math.abs(player.iframe.contentDocument.querySelector('#end').getBoundingClientRect().top-top)<100),sourceTop),true,'reconnect restores semantic position');
 await page.evaluate(()=>mirror.players[0].iframe.contentWindow.scrollTo(0,0));
 await until(()=>page.evaluate(()=>mirror.players.every(player=>player.iframe.contentDocument.scrollingElement.scrollTop===0)));
 const headingId=await session.page.locator('h1').evaluate(node=>window.__transflow.record.mirror.getId(node));
 await manager.command(session,{type:'scroll',requestId:crypto.randomUUID(),epoch:session.epoch,id:headingId,containerId:0,ratio:0,offset:999,left:0});
 assert.equal(await session.page.evaluate(()=>document.scrollingElement.scrollTop),0,'page-top endpoint overrides geometry differences');
 await delivery;await bootstrap();await until(()=>page.evaluate(()=>mirror.players[0].iframe.contentDocument.querySelector('h1')?.textContent==='Next article'));
 await manager.command(session,{type:'resources',requestId:crypto.randomUUID()});
 await delay(100); await delivery;
 await page.evaluate(()=>mirror.players[1].iframe.contentDocument.querySelector('summary').click());
 await until(()=>page.evaluate(()=>mirror.players.every(player=>!player.iframe.contentDocument.querySelector('details').open)));
 assert.ok(session.events.some(event=>event.type===2));
 assert.equal(await page.evaluate(()=>!!window.failed),false);
 assert.ok(session.metrics.inputTokens>0);assert.ok(session.metrics.outputTokens>0);
});
