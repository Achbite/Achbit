export type DocumentFormat = 'html' | 'pdf' | 'markdown';

export function documentFormat(path: string): DocumentFormat | null {
  const suffix = path.split('.').at(-1)?.toLowerCase();
  if (suffix === 'html' || suffix === 'htm') return 'html';
  if (suffix === 'md' || suffix === 'markdown') return 'markdown';
  return suffix === 'pdf' ? 'pdf' : null;
}

export function imageMediaType(path: string): string | null {
  const extension = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.exec(path)?.[1].toLowerCase();
  if (!extension) return null;
  return 'image/' + (extension === 'jpg' ? 'jpeg' : extension === 'svg' ? 'svg+xml' : extension);
}

/** The file picker returns raw bytes on desktop; supply the image type for its Blob URL. */
export async function selectedFilePreview(path: string, blob: Blob) {
  const imageType = imageMediaType(path);
  if (imageType) return { status: 'document' as const, format: 'image' as const, blob: blob.slice(0, blob.size, imageType) };
  const format = documentFormat(path);
  if (format === 'pdf' && await blob.slice(0, 5).text() !== '%PDF-') throw new Error('当前文件不是 PDF 文档。');
  if (format) return { status: 'document' as const, format, blob };
  return { status: 'source' as const, content: await readDocumentText(blob) };
}

export function workspaceResourceLink(href: string): { workspaceId: string; logicalPath: string } | null {
  const match = /^workspace:\/\/([^/]+)\/(.+)$/.exec(href);
  if (!match) return null;
  try {
    const workspaceId = decodeURIComponent(match[1]);
    const logicalPath = decodeURIComponent(match[2]);
    return workspaceId && logicalPath ? { workspaceId, logicalPath } : null;
  } catch { return null; }
}

export async function readDocumentText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('file_encoding_unsupported: 当前文件不是支持的文本文件。');
  return content;
}
