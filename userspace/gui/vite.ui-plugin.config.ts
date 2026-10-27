import {defineConfig} from 'vite';
import path from 'node:path';
import fs from 'node:fs';
export default defineConfig(()=>{
  const root=process.env.ACHBIT_UI_PLUGIN_ROOT;
  if(!root||!path.isAbsolute(root))throw new Error('ACHBIT_UI_PLUGIN_ROOT must name an absolute plugin directory.');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'achbit-ui.json'),'utf8'));
  if(manifest.entry!=='dist/index.js')throw new Error('The source template build writes dist/index.js. Set that manifest entry.');
  return {build:{outDir:path.join(root,'dist'),emptyOutDir:true,lib:{entry:path.join(root,'src/index.ts'),formats:['es'],fileName:()=> 'index.js'},rollupOptions:{output:{inlineDynamicImports:true}}}};
});
