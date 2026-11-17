// Opt-in real site/model check. Never emits keys or provider endpoints.
import { BrowserSessions } from '../server/web/sessions.mjs';
import { loadWebConfig } from '../server/web/config.mjs';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const sites = [
 ['example','article','https://example.com'],
 ['mdn-details','docs','https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details'],
 ['python-about','product','https://www.python.org/about/'],
 ['w3c-accessibility','article','https://www.w3.org/WAI/fundamentals/accessibility-intro/'],
 ['webdev-html','docs','https://web.dev/learn/html'],
 ['react-learn','spa-docs','https://react.dev/learn'],
];
const output = new URL('../runtime/web-review/p0/',import.meta.url); await mkdir(output,{recursive:true});
const bundle = await build({entryPoints:['src/web-mirror.ts'],bundle:true,write:false,format:'iife',globalName:'MirrorModule'});
const manager = new BrowserSessions(await loadWebConfig());
const reports=[];
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function inspect([name,category,url]) {
 const started=Date.now(); let session,replay;
 const report={name,category,url,protocol:'protected-segments-v3',budget:{milliseconds:60000,requests:6},date:new Date().toISOString()};
 try {
  session=await manager.create({url,width:680,height:650}); await session.queue;
  const deadline=Date.now()+60000; let budgetPaused=false;
  while(Date.now()<deadline && !session.error) {
   if(session.translationPaused && !budgetPaused) break;
   if(session.metrics.requests>=6) { session.translationPaused=true; budgetPaused=true; }
   if(session.metrics.viewportMs!==null || (session.metrics.firstTranslationMs!==null && !session.workers)) break;
   await delay(250);
  }
  const state=manager.status(session);
  Object.assign(report,{finalUrl:session.url,total:state.total,completed:state.completed,viewport:state.viewport,viewportCompleted:state.viewportCompleted,metrics:state.metrics,error:state.error,translationError:state.translationError,blockedFrames:await session.page.locator('iframe').count(),samples:[...session.translations.values()].filter(entry=>entry.parts).slice(0,5).map(entry=>({source:entry.source,translation:entry.guards.map(part=>entry.parts.find(translated=>translated.id===part.id)?.text ?? part.source).join('')}))});
  replay=await (await manager.browser()).newContext({viewport:{width:1400,height:750}});
  const page=await replay.newPage();
  await page.route('**/*',async route=>{
   const match=new URL(route.request().url()).pathname.match(/\/assets\/([a-f0-9]{64})$/);
   if(match) { try { const asset=await manager.asset(session,match[1]); return route.fulfill({contentType:asset.type,body:asset.body}); } catch { report.assetFailures=(report.assetFailures||0)+1; return route.fulfill({status:404,body:''}); } }
   return route.fulfill({contentType:'text/html',body:'<html><body style="margin:10px;display:flex;gap:10px"><div id="source"></div><div id="target"></div></body></html>'});
  });
  await page.goto('https://1.1.1.1/review'); await page.addScriptTag({content:bundle.outputFiles[0].text});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(({epoch,events,translations,language})=>{
   window.mirror=new MirrorModule.WebMirror([document.querySelector('#source'),document.querySelector('#target')],()=>{},()=>{},()=>{window.renderFailed=true;});
   mirror.dimensions(680,650,1); mirror.bootstrap(epoch,events,translations,language);
  },{epoch:session.epoch,events:session.events,translations:[...session.translations.values()],language:session.language});
  await page.waitForTimeout(2000);
  Object.assign(report,await page.evaluate(()=>({sourceText:mirror.players[0].iframe.contentDocument?.body?.innerText.length||0,targetText:mirror.players[1].iframe.contentDocument?.body?.innerText.length||0,renderFailed:!!window.renderFailed, structureSame:[...mirror.players[0].iframe.contentDocument.querySelectorAll('*')].map(node=>node.tagName).join(',') === [...mirror.players[1].iframe.contentDocument.querySelectorAll('*')].map(node=>node.tagName).join(',')})));
  report.replayErrors=errors;
  report.classification=report.error || !report.sourceText || report.renderFailed ? 'failed' : report.assetFailures || report.blockedFrames || report.translationError || report.viewportCompleted < report.viewport ? 'partial' : 'supported';
  await page.screenshot({path:new URL(`${name}.png`,output).pathname,fullPage:true});
 } catch(error) {report.classification='failed';report.error=String(error.message).split('\n')[0];}
 finally {await replay?.close();if(session)await manager.close(session);}
 report.elapsedMs=Date.now()-started;reports.push(report);await writeFile(new URL('compatibility.json',output),JSON.stringify(reports,null,2));
 console.log(JSON.stringify({site:name,result:report.classification,firstMs:report.metrics?.firstTranslationMs,viewport:`${report.viewportCompleted}/${report.viewport}`,error:report.error||report.translationError||''}));
}
try {for(let index=0;index<sites.length;index+=2) await Promise.all(sites.slice(index,index+2).map(inspect));}
finally {await manager.shutdown();}
