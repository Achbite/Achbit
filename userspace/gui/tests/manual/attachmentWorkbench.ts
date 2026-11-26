import type { FilesystemReference } from '@achbit/protocol';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { emptyComposerState } from '../../src/components/local-agent/composerSubmission';
import type { ConversationHost } from '../../src/components/local-agent/ConversationHost';

// A self-contained, valid two-page PDF (vector paint + page text, byte-addressed xref).
function samplePdf() {
  const stream = (color: string, label: string) => {
    const contents = `${color} rg 0 0 260 320 re f\n0 0 0 rg BT /F1 18 Tf 24 258 Td (${label}) Tj ET\n`;
    return `<< /Length ${contents.length} >>\nstream\n${contents}endstream`;
  };
  const page = (number: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 320] /Resources << /Font << /F1 7 0 R >> >> /Contents ${number} 0 R >>`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', page(4),
    stream('0.95 0.73 0.49', 'ATTACHMENT / 01'), page(6), stream('0.51 0.76 0.89', 'ATTACHMENT / 02'), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let file = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, value] of objects.entries()) { offsets.push(file.length); file += `${i+1} 0 obj\n${value}\nendobj\n`; }
  const xref = file.length;
  file += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([file], { type: 'application/pdf' });
}

export function attachmentWorkbench(host: ConversationHost, session: string, mode: string) {
  const workspaceId = 'input:attached', folder = 'Achbit', root = '/fixture/所选项目/';
  const files = new Map<string, Blob>([
    ['任务说明.txt', new Blob(['附件测试\n1. 保留输入区原文\n2. 打开相同文件\n3. 检查展示结果'], {type:'text/plain'})],
    ['阅读样例.HTM', new Blob(['<!doctype html><html><head><title>静态文档</title></head><body><h1>只读 HTML 正例</h1><p>附件正文与输入框分开。</p><script>document.body.dataset.ran="unexpected"</script></body></html>'], { type: 'text/html' })],
    ['两页.PDF', samplePdf()], ['示意.svg', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="120" height="70"><rect width="100%" height="100%" fill="#6ba0ab"/></svg>'], {type:'image/svg+xml'})],
    ['损坏.pdf', new Blob(['%PDF-1.4\nnot a PDF page\n%%EOF'], {type:'application/pdf'})],
    ['不可读.bin', new Blob([new Uint8Array([0x61,0x00,0xff])])], ['较大.txt', new Blob(['x'.repeat(300_000)], {type:'text/plain'})],
  ]);
  const refs: FilesystemReference[] = [{ referenceId:'ref:folder',workspaceId,logicalPath:folder,displayName:folder,kind:'directory' }, ...Array.from(files, ([name, blob]) =>
    ({ referenceId:'ref:'+name,workspaceId,logicalPath:name,displayName:name,kind:'file' as const,mediaType:blob.type,byteLength:blob.size }))];
  const reads: string[] = [], writes: string[] = [], savedImages: boolean[] = [];
  host.saveImage = async ({ blob }) => { savedImages.push(blob.type === 'image/svg+xml' && await blob.text() === await files.get('示意.svg')!.text()); };
  const read = (name: string) => { const blob = files.get(name); if (!blob) throw Error('missing fixture: '+name); return blob; };
  host.selectedFilePath = async path => { if (!path.startsWith(root)) throw Error('unexpected local path'); read(path.slice(root.length)); return path; };
  host.readLocalFile = async path => { if (!path.startsWith(root)) throw Error('unexpected local read'); reads.push('selected:'+path); return read(path.slice(root.length)).slice(); }; // desktop picker returns untyped bytes
  host.resolveResource = async (id, workspace, name) => {
    if (session !== id || workspace !== workspaceId || (name !== folder && !files.has(name))) throw Error('unexpected retained handle');
    return { kind: name === folder ? 'directory':'file', path: '/retained/'+name };
  };
  host.resources = { ...host.resources,
    async readResourceBlob(id, ref, format) {
      if (!('workspaceId' in ref)) throw Error('unexpected resource');
      await host.resolveResource(id, ref.workspaceId, ref.logicalPath); reads.push(`${format}:${id}:${ref.logicalPath}`); return read(ref.logicalPath);
    },
    async readResourceReference(id, ref) {
      if (!('workspaceId' in ref)) throw Error('unexpected resource');
      await host.resolveResource(id, ref.workspaceId, ref.logicalPath); reads.push(`text:${id}:${ref.logicalPath}`);
      const blob = read(ref.logicalPath), content = await blob.text(); if (content.includes('\0')) throw Error('file_encoding_unsupported');
      return { logicalPath:ref.logicalPath, content, sizeBytes:blob.size,startLine:1,endLine:content.split('\n').length };
    },
  };
  const draft = emptyComposerState(); draft.draft = '保留原草稿\n第二行还有选择范围\n第三行';
  if (mode === 'draft') draft.filesystemPaths = refs.map(r => ({ path:root+r.displayName,kind:r.kind }));
  else if (mode === 'recovered') draft.filesystemReferences = refs;
  const key = mode === 'draft' ? 'new:independent' : session;
  sessionStorage.setItem('achbit:composer:'+key, JSON.stringify(draft));
  const projection = useLocalAgentStore.getState().projection!;
  useLocalAgentStore.setState({ sessionId:mode === 'draft' ? null:session, draftProjectId:null,
    projection:mode === 'draft' ? null : mode === 'sent' ? { ...projection, messages: [{ role:'user',messageId:'msg:cards',sequence:1,
      createdAt:'2026-11-26T00:00:00Z',content:'查看这些附件',filesystemReferences:refs,pluginSelections:[],feedback:null }],
      timeline:[{kind:'message',timelineId:'timeline:cards',messageId:'msg:cards',sequence:1}] } : projection,
    sendMessage:async () => { writes.push('send'); throw Error('Draft must not be sent'); } });
  const preference = (target: 'reader'|'vscode') => useSettingsStore.setState(s => ({ effectiveSettings:{...s.effectiveSettings,'gui.defaultFileOpen':target} }));
  preference('reader');
  Object.assign(window, { attachmentFixture: { reads, writes, savedImages, preference, session:() => useLocalAgentStore.getState().sessionId, root,
    draft:() => JSON.parse(sessionStorage.getItem('achbit:composer:'+key)!) } });
}
