// Vite on 5187. Real form primitives, synthetic values, no network mutations.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const artifacts=path.resolve('artifacts/form-controls'); await fs.mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({channel:process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome',headless:true});
const result=[];
try {
 const page=await browser.newPage({viewport:{width:1129,height:1039}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5187/e2e/fixtures/form-controls.html');
 const select=page.getByLabel('Grouped choice');
 await expect(select).toHaveCSS('appearance','base-select');
 for(const dark of [false,true]) for(const preset of ['default','blue','mint','apricot','rose','gray']) {
   await page.evaluate(({preset,dark})=>window.setControlAppearance(preset,dark),{preset,dark});
   await select.click(); await expect.poll(()=>select.evaluate(el=>el.matches(':open'))).toBe(true);
   const visual=await select.evaluate(el=>{
     const style=getComputedStyle(el,'::picker(select)'), selected=getComputedStyle(el.selectedOptions[0]);
     const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
     const lum=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
     const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
     return {background:style.backgroundColor, contrast:ratio(style.color,style.backgroundColor),selectedContrast:ratio(selected.color,selected.backgroundColor)};
   });
   expect(visual.contrast).toBeGreaterThanOrEqual(4.5);expect(visual.selectedContrast).toBeGreaterThanOrEqual(4.5);
   await page.screenshot({path:path.join(artifacts,`${preset}-${dark?'dark':'light'}-select.png`)});
   await page.keyboard.press('Escape'); await expect(select).toBeFocused();
   result.push({preset,dark,...visual});
 }
 await select.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
 await expect(select).toHaveValue('b'); // disabled row is skipped, exactly one commit
 await expect(page.getByLabel('Change count')).toHaveText('1');
 await select.focus(); await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Escape');
 await expect(select).toHaveValue('b');
 await select.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
 await expect(select).toHaveValue('a');
 await select.click(); await select.getByRole('option',{name:'Beta',exact:true}).click();
 await expect(select).toHaveValue('b');
 await select.click(); await page.keyboard.press('g'); await page.keyboard.press('Escape');
 await expect(select).toHaveValue('b');
 await expect(page.getByLabel('Disabled choice')).toBeDisabled();
 await select.click(); await page.getByLabel('Enabled',{exact:true}).click();
 await expect.poll(()=>select.evaluate(el=>el.matches(':open'))).toBe(false);
 await page.getByLabel('Enabled',{exact:true}).focus(); await page.keyboard.press('Space');
 await expect(page.getByLabel('Enabled',{exact:true})).toBeChecked();
 await page.getByLabel('One',{exact:true}).focus(); await page.keyboard.press('ArrowRight');
 await expect(page.getByLabel('Two',{exact:true})).toBeChecked();
 await page.getByLabel('Amount').focus(); await page.keyboard.press('ArrowRight');
 await expect(page.getByLabel('Amount')).toHaveValue('31');
 // A nested picker consumes Escape before its owning dialog.
 await page.getByRole('button',{name:'Open dialog',exact:true}).click();
 await page.getByLabel('Dialog choice').click(); await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog',{name:'Choice dialog'})).toBeVisible();
 await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
 // Date boundaries, keyboard selection, time staging and native form payloads.
 await page.getByRole('button',{name:'Choose date',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sunday, February 27, 2028'})).toBeDisabled();
 await page.screenshot({path:path.join(artifacts,'calendar-dark.png')});
 await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
 await expect(page.getByLabel('Date',{exact:true})).toHaveValue('2028-03-01');
 await page.getByRole('button',{name:'Choose time',exact:true}).click();
 await page.getByLabel('Hour',{exact:true}).selectOption('23');
 await page.getByLabel('Minute',{exact:true}).click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
 await page.screenshot({path:path.join(artifacts,'clock-dark.png')});
 await expect(page.getByLabel('Time',{exact:true})).toHaveValue('09:15');
 await page.getByRole('button',{name:'Apply',exact:true}).click();
 await expect(page.getByLabel('Time',{exact:true})).toHaveValue('23:59');
 expect(await page.evaluate(()=>window.controlForm)).toBeUndefined();
 await page.getByRole('button',{name:'Submit form',exact:true}).click();
 expect(await page.evaluate(()=>window.controlForm)).toMatchObject({choice:'b',enabled:'on',mode:'two',amount:'31',date:'2028-03-01',time:'23:59'});
 await page.getByRole('button',{name:'Reset native fields',exact:true}).click();
 await expect(page.getByLabel('One',{exact:true})).toBeChecked();
 await expect(page.getByLabel('Amount')).toHaveValue('30');
 // Long menus must scroll inside the viewport and reach the last option.
 await page.setViewportSize({width:390,height:740});
 const large=page.getByLabel('Large catalog'); await large.click();
 await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(large).toHaveValue('999');
 await select.click(); await select.getByRole('option',{name:/A long model identifier/}).click();
 await select.click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 const option=select.getByRole('option',{name:/A long model identifier/});
 const box=await option.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);
 await page.screenshot({path:path.join(artifacts,'mobile-long-select.png')}); await page.keyboard.press('Escape');
 await page.screenshot({path:path.join(artifacts,'mobile-long-closed.png')});
 await page.getByRole('button',{name:'Choose date',exact:true}).click();
 const calendar=await page.getByRole('dialog').boundingBox();expect(calendar.x).toBeGreaterThanOrEqual(0);expect(calendar.x+calendar.width).toBeLessThanOrEqual(390);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'Choose date',exact:true})).toBeFocused();
 for (const key of ['F4', 'Alt+ArrowDown']) {
   await page.getByLabel('Date',{exact:true}).focus(); await page.keyboard.press(key);
   await expect(page.getByRole('dialog',{name:'Choose date',exact:true})).toBeVisible();
   await page.keyboard.press('Escape');
   await expect(page.getByRole('button',{name:'Choose date',exact:true})).toBeFocused();
 }
 await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
 await expect(page.getByLabel('Enabled',{exact:true})).toHaveCSS('appearance','auto');
 await page.getByLabel('Enabled',{exact:true}).focus(); await page.keyboard.press('Space');
 await expect(page.getByLabel('Enabled',{exact:true})).not.toBeChecked();
 await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
 expect(errors).toEqual([]);
 await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(result,null,2));
 console.log('PASS: 12 palettes, grouped/disabled options, keyboard/pointer selection, dialog Escape, checkbox/radio/range, calendar/time, form payload and 1000-option mobile menu');
} finally {await browser.close();}
