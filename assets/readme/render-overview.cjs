// Media authoring helper. Requires playwright-core and a local Chromium.
// Example: NODE_PATH=/tmp/achbit-readme-media/node_modules node render-overview.cjs
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = __dirname;
  const output = process.env.ACHBIT_MEDIA_FRAMES || '/tmp/achbit-readme-frames';
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  const languages = (process.env.ACHBIT_MEDIA_LANGUAGES || 'en,zh').split(',');
  try {
    for (const language of languages) {
      const directory = path.join(output, language);
      await fs.mkdir(directory,{recursive:true});
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(pathToFileURL(path.join(root,'achbit-overview.html')).href+`?render&lang=${language}`);
      await page.evaluate(()=>window.demoReady);
      const samples = process.env.ACHBIT_MEDIA_PREVIEW === '1' ? [2.5,10.5,16.5,22.5] : Array.from({length:288},(_,i)=>i/12);
      for (let i=0;i<samples.length;i++) {
        await page.evaluate(t=>window.seekDemo(t),samples[i]);
        await page.screenshot({path:path.join(directory,`frame-${String(i).padStart(4,'0')}.png`),animations:'disabled'});
      }
      if(errors.length) throw Error(errors.join('\n'));
      console.log(`${language}: ${samples.length} frames → ${directory}`);
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
