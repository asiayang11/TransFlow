import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicUrl, isPublicAddress, publicAddress, pinnedLookup } from '../server/web/network.mjs';
import { parseTranslations, sourceKey, modelOptions } from '../server/web/translation.mjs';
import { BrowserSessions } from '../server/web/sessions.mjs';

test('URL policy rejects credentials, special protocols and nonstandard ports', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com', 'https://user:pass@example.com', 'http://example.com:8787']) assert.throws(() => parsePublicUrl(url));
  assert.equal(parsePublicUrl('https://example.com/docs?q=hello#section').hostname, 'example.com');
});
test('network policy covers IPv4, IPv6, mapped IPv4 and mixed DNS results', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(publicAddress('example.com', async () => [{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]));
  assert.deepEqual(await publicAddress('example.com', async () => [{address:'1.1.1.1',family:4}]), {address:'1.1.1.1',family:4});
});
test('pinned lookup honors Node single-address and autoSelectFamily contracts', () => {
  const lookup = pinnedLookup({address:'1.1.1.1',family:4});
  lookup('ignored.example',{all:true},(error,addresses)=>{ assert.equal(error,null); assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]); });
  lookup('ignored.example',{},(error,address,family)=>{ assert.equal(error,null); assert.equal(address,'1.1.1.1'); assert.equal(family,4); });
});
test('translation protocol retains inline whitespace and rejects incomplete/duplicate IDs', () => {
  const blocks = [{id:1,source:' Read ',context:'Read the docs'}, {id:2,source:'the docs',context:'Read the docs'}];
  assert.deepEqual(parseTranslations('{"items":[{"id":2,"text":"文档"},{"id":1,"text":"阅读"}]}', blocks).map(x => x.text), [' 阅读 ','文档']);
  for (const content of ['{"items":[]}', '{"items":[{"id":1,"text":"a"},{"id":1,"text":"b"}]}','{"items":[{"id":1,"text":""},{"id":2,"text":"b"}]}']) assert.throws(() => parseTranslations(content, blocks));
  assert.notEqual(sourceKey(blocks[0]), sourceKey({...blocks[0],context:'Different context'}));
});
test('paragraph slots are complete, protected and cached independently of DOM IDs', () => {
  const block = {id:10,source:'Read the docs with fetch().',context:'',segments:[{id:10,source:'Read ',protected:false},{id:11,source:'the docs',protected:false},{id:12,source:' with ',protected:false},{id:13,source:'fetch()',protected:true},{id:14,source:'.',protected:true}]};
  const valid = {items:[{id:10,segments:[{id:10,text:'阅读'},{id:11,text:'文档'},{id:12,text:'，使用 '}]}]};
  const translated = parseTranslations(JSON.stringify(valid),[block])[0];
  assert.deepEqual(translated.parts.map(part=>part.id),[10,11,12]);
  assert.equal(translated.parts[2].text,'，使用 ');
  assert.equal(sourceKey(block),sourceKey({...block,id:20,segments:block.segments.map(part=>({...part,id:part.id+10}))}));
  for (const slots of [[{id:10,text:'阅读'}],[{id:10,text:'a'},{id:10,text:'b'},{id:12,text:'c'}],[{id:10,text:'a'},{id:11,text:'b'},{id:13,text:'overwrite code'}]]) assert.throws(()=>parseTranslations(JSON.stringify({items:[{id:10,segments:slots}]}),[block]));
});
test('mirror snapshot disables scripts/frames and routes resources through session assets', () => {
  const manager = new BrowserSessions({});
  const session = { id:'a'.repeat(48), url:'https://example.com/', assetUrls:new Map() };
  const snapshot = {type:2,data:{node:{type:0,id:1,childNodes:[{type:2,id:2,tagName:'html',attributes:{},childNodes:[{type:2,id:3,tagName:'head',attributes:{},childNodes:[{type:2,id:4,tagName:'script',attributes:{src:'https://evil.example/a.js'},childNodes:[]}]},{type:2,id:5,tagName:'img',attributes:{src:'https://example.com/a.png',onerror:'fetch("/api")',srcset:'https://evil.example/a.png 2x'},childNodes:[]}]}]}}};
  const sanitized = manager.sanitizeEvent(session,snapshot);
  const html = sanitized.data.node.childNodes[0], head = html.childNodes[0], image = html.childNodes[1];
  assert.equal(head.childNodes[0].attributes['http-equiv'],'Content-Security-Policy');
  assert.match(head.childNodes[0].attributes.content,/script-src 'none'/);
  assert.equal(head.childNodes[1].tagName,'noscript');
  assert.match(image.attributes.src,/^\/api\/web\/sessions\//);
  assert.equal(image.attributes.onerror,undefined); assert.equal(image.attributes.srcset,undefined);
  assert.equal(snapshot.data.node.childNodes[0].childNodes[0].childNodes[0].tagName,'script');
});
test('iframe document mutations are dropped without clearing the main mirror document', () => {
  const manager = new BrowserSessions({});
  const session = { id:'a'.repeat(48), url:'https://example.com/', assetUrls:new Map(), blockedNodes:new Set([9]) };
  const event = manager.sanitizeEvent(session,{type:3,data:{source:0,adds:[{parentId:9,node:{type:0,id:10,childNodes:[{type:2,id:11,tagName:'html',attributes:{},childNodes:[]}]}}],removes:[],texts:[],attributes:[]}});
  assert.equal(event.data.adds.length,0);
  assert.ok(session.blockedNodes.has(11));
  const followup = manager.sanitizeEvent(session,{type:3,data:{source:0,adds:[],removes:[],texts:[{id:11,value:'child frame'}],attributes:[]}});
  assert.equal(followup.data.texts.length,0);
});

test('blocked embeds keep a safe footprint and validated semantic scroll metadata', () => {
  const manager = new BrowserSessions({});
  const session = { id:'a'.repeat(48), url:'https://example.com/', assetUrls:new Map() };
  const snapshot = {type:2,transflowAnchor:{id:2,containerId:0,fraction:0,before:24,ratio:0.3,left:0},data:{node:{type:0,id:1,childNodes:[{type:2,id:2,tagName:'html',attributes:{},childNodes:[{type:2,id:9,tagName:'iframe',attributes:{src:'https://evil.example',rr_width:'320px',rr_height:'180px'},childNodes:[]}]}]}}};
  const safe = manager.sanitizeEvent(session,snapshot), embed = safe.data.node.childNodes[0].childNodes[0];
  assert.equal(embed.tagName,'div'); assert.equal(embed.attributes.src,undefined);
  assert.match(embed.attributes.style,/width:320px;height:180px/);
  assert.deepEqual(safe.transflowAnchor,snapshot.transflowAnchor);
  const invalid = manager.sanitizeEvent(session,{...snapshot,transflowAnchor:{...snapshot.transflowAnchor,id:9}});
  assert.equal(invalid.transflowAnchor,undefined);
});

test('positional paragraph slots allow disappearing articles but reject empty paragraphs', () => {
  const block={id:1,source:'The docs',context:'',segments:[{id:1,source:'The ',protected:false},{id:2,source:'docs',protected:false}]};
  const result=parseTranslations(JSON.stringify({items:[{id:1,translations:['','文档']}]}),[block]);
  assert.equal(result[0].parts[0].text,''); assert.equal(result[0].parts[1].text,'文档');
  assert.throws(()=>parseTranslations(JSON.stringify({items:[{id:1,translations:['','']}]}),[block]));
});

test('protected paragraph output is immutable and Ark thinking switch is provider scoped', () => {
 const block={id:1,source:'Use fetch()',context:'',segments:[{id:1,source:'Use ',protected:false},{id:2,source:'fetch()',protected:true}]};
 const items=[{id:1,segments:[{text:'使用 ',protected:false},{text:'fetch()',protected:true}]}];
 assert.equal(parseTranslations(JSON.stringify({items}),[block])[0].parts[0].text,'使用 ');
 items[0].segments[1].text='mutated()';assert.throws(()=>parseTranslations(JSON.stringify({items}),[block]),/受保护/);
 assert.deepEqual(modelOptions({base:'https://ark.cn-beijing.volces.com/api/v3'}),{thinking:{type:'disabled'}});
 assert.deepEqual(modelOptions({base:'https://ark.cn-beijing.volces.com/api/v3',thinking:'default'}),{});
 assert.deepEqual(modelOptions({base:'https://other.example/v1'}),{});
});

test('protected whitespace stays in the DOM even when model trims its echo', () => {
 const block={id:1,source:'Hello  world',context:'',segments:[{id:1,source:'Hello',protected:false},{id:2,source:'  ',protected:true},{id:3,source:'world',protected:false}]};
 const result=parseTranslations(JSON.stringify({items:[{id:1,segments:[{text:'你好',protected:false},{text:'',protected:true},{text:'世界',protected:false}]}]}),[block]);
 assert.deepEqual(result[0].parts.map(part=>part.id),[1,3]);assert.equal(block.segments[1].source,'  ');
});
