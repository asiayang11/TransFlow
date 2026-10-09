import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('fullscreen reading uses the window, contains notices and fits both panes on narrow screens', {timeout:20000}, async t => {
  const bundle=await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import Web from './src/WebWorkspace.tsx';import './src/styles.css';import './src/workbench.css';createRoot(document.getElementById('app')).render(<Web/>);",resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outfile:'fixture.js',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'\"production\"'}});
  const browser=await chromium.launch({headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/web/health')return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false})});
    if(path==='/fixture.js'||path==='/fixture.css')return route.fulfill({contentType:path.endsWith('.js')?'application/javascript':'text/css',body:bundle.outputFiles.find(file=>file.path.endsWith(path)).text});
    return route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="app"></div><script src="/fixture.js"></script></body></html>'});
  });
  await page.goto('http://transflow.test/web');
  await page.getByRole('alert').waitFor();
  const normal=await page.locator('.web-comparison').evaluate(node=>node.getBoundingClientRect().height);
  await page.getByRole('button',{name:'全屏阅读',exact:true}).click();
  assert.equal(await page.locator('.web-controls').isVisible(),false);
  const expanded=await page.locator('.web-comparison').evaluate(node=>node.getBoundingClientRect().height);
  assert.ok(expanded>normal+200);assert.ok(expanded>900*.8,'reading occupies over 80% of the desktop viewport');
  await page.getByRole('button',{name:'1 项提示',exact:true}).click();
  assert.equal(await page.locator('#web-notices').isVisible(),true);
  assert.equal(await page.locator('.web-comparison').evaluate(node=>node.getBoundingClientRect().height),expanded,'notice overlay does not shrink the pages');
  await page.getByRole('button',{name:'1 项提示',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  const bounds=await page.locator('.web-pane').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:r.x,right:r.right,top:r.top,bottom:r.bottom,height:r.height};}));
  assert.ok(bounds.every(r=>r.x>=0&&r.right<=390&&r.bottom<=844&&r.height>250),'both stacked panes fit inside the mobile window');
  assert.ok(bounds[1].top>=bounds[0].bottom);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.web-controls').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
});
