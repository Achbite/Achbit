import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModules } from './gui-projection-contract.mjs';

// TCR: .task-artifacts/T-031-UI_System-20261126/overlay-layout/TCR.md
const local = {path:'/picked/project/notes.HTM'}, bound = { sessionId:'session:A',workspaceId:'input:one',logicalPath:'report.PDF' };
test('opening reads the current preference and the original address; folders always use the file manager', async t => {
  const [{openFilesystemAttachment:open},{useSettingsStore:settings}] = await loadGuiModules(t,['/src/components/local-agent/fileOpening.ts','/src/state/settingsStore.ts']);
  const original = settings.getState().effectiveSettings; t.after(()=>settings.setState({effectiveSettings:original}));
  const calls=[], reader=[], files=[], folders=[];
  const host = { selectedFilePath:async path=>{calls.push(['selected',path]);return path;},
    resolveResource:async (...args)=>{calls.push(args);return {kind:args[2]==='.'?'directory':'file',path:args[2]==='.'?'/Volumes/A':'/Volumes/A/report.PDF'};},
    openFile:async path=>files.push(path),locatePath:async path=>folders.push(path) };
  for (const preference of ['reader','vscode']) {
    settings.setState({effectiveSettings:{...original,'gui.defaultFileOpen':preference}});
    for (const source of [local,bound]) await open(host,source,'file',x=>reader.push(x),()=>true);
    await open(host,{path:'/picked/folder'},'directory',assert.fail,()=>true);
    await open(host,{...bound,logicalPath:'.'},'directory',assert.fail,()=>true);
  }
  assert.deepEqual(folders,['/picked/folder','/Volumes/A','/picked/folder','/Volumes/A']);
  assert.deepEqual(reader,[{kind:'file',path:local.path,canonicalPath:local.path},{kind:'workspace',workspaceId:bound.workspaceId,logicalPath:bound.logicalPath,canonicalPath:'/Volumes/A/report.PDF'}]);
  assert.deepEqual(files,[local.path,'/Volumes/A/report.PDF']);
  assert.deepEqual(calls.slice(0,3),[['selected',local.path],['session:A','input:one','report.PDF'],['session:A','input:one','.']]);
  await assert.rejects(open({...host,locatePath:undefined},{path:'/remote/folder'},'directory',assert.fail,()=>true),/desktop Host/);
  await assert.rejects(open({...host,openFile:undefined},bound,'file',assert.fail,()=>true),/VS Code is unavailable/);
  await assert.rejects(open(host,{...bound,sessionId:null},'file',assert.fail,()=>true),/session_required/);
  const denied=new Error('original permission denied');
  await assert.rejects(open({...host,resolveResource:async()=>{throw denied;}},bound,'file',assert.fail,()=>true),e=>e===denied);
  await assert.rejects(open(host,{...bound,logicalPath:'.'},'file',assert.fail,()=>true),/kind_changed/);
  let current=true;
  await open({...host,selectedFilePath:async()=>{current=false;return local.path;}},local,'file',assert.fail,()=>current);
  assert.equal(files.length,2,'a delayed resolution does not launch an editor after a switch');
});

test('thumbnail budgets, encoding failure and cancellation never manufacture content or read a parent directory',async t=>{
  const [{readAttachmentThumbnail:read,thumbnailFormat}] = await loadGuiModules(t,['/src/components/local-agent/attachmentPreview.ts']);
  const signal=new AbortController().signal, calls=[];
  const host={readLocalFile:async path=>{calls.push(path);return new Blob(['local excerpt']);},resources:{
    readResourceReference:async (...args)=>{calls.push(args);return {content:'retained excerpt'};},readResourceBlob:assert.fail}};
  assert.equal(thumbnailFormat('UPPER.HTM'),'html'); assert.equal(thumbnailFormat('file','application/pdf'),'pdf');
  assert.deepEqual(await read(host,bound,'pdf',4*1024*1024,signal),{kind:'large'});
  assert.deepEqual(await read(host,local,'binary',undefined,signal),{kind:'unsupported'});assert.deepEqual(calls,[]);
  assert.deepEqual(await read(host,local,'text',undefined,signal),{kind:'text',text:'local excerpt'});
  assert.deepEqual(await read(host,bound,'text',15,signal),{kind:'text',text:'retained excerpt'});
  assert.deepEqual(calls,[local.path,['session:A',{workspaceId:'input:one',logicalPath:'report.PDF'},signal]]);
  await assert.rejects(read({readLocalFile:async()=>new Blob([new Uint8Array([0xff,0,0x62])])},local,'text',undefined,signal),/encoding_unsupported/);
  const cancel=new AbortController();await assert.rejects(read({readLocalFile:async()=>{cancel.abort();return new Blob(['late']);}},local,'text',undefined,cancel.signal),e=>e.name==='AbortError');
});
