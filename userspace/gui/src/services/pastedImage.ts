import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

export interface PastedImageInput {
  inputId: string;
  name: string;
  mediaType: string;
  byteLength: number;
  dataUrl: string;
}

export const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function clipboardImages(clipboard: DataTransfer): File[] {
  return Array.from(clipboard.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

export async function readPastedImage(file: File, inputId: string, chinese: boolean): Promise<PastedImageInput> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
    throw new Error(chinese ? '支持粘贴 PNG、JPEG、GIF 或 WebP 图片。' : 'Paste a PNG, JPEG, GIF or WebP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(chinese ? '图片源文件超过 32 MiB，请先缩小再粘贴。' : 'The source image exceeds 32 MiB. Resize it before pasting.');
  }
  let prepared: Blob = file;
  if (file.size > MAX_PASTED_IMAGE_BYTES) {
    // Prepare a bounded draft before creating a data URL; no Session, upload archive or model request yet.
    try {
      const response = await fetch(`${getKernelApiBase()}/conversation/input-resources/prepare-image`, {
        method: 'POST', headers: { ...getHostConnectionHeaders(), 'Content-Type': file.type }, body: file,
      });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) {
        const failure = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(failure?.message || `HTTP ${response.status}`);
      }
      prepared = await response.blob();
      if (!['image/png', 'image/jpeg'].includes(prepared.type) || !prepared.size || prepared.size > MAX_PASTED_IMAGE_BYTES) {
        throw new Error(chinese ? '无效的压缩结果。' : 'Invalid compressed image.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(chinese ? `超过 8 MiB 的图片无法压缩：${detail}` : `Could not reduce the image over 8 MiB: ${detail}`);
    }
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('clipboard_image_read_failed'));
    reader.readAsDataURL(prepared);
  });
  return { inputId, name: file.name, mediaType: prepared.type, byteLength: prepared.size, dataUrl };
}

export function pastedImageBytes(image: PastedImageInput): Uint8Array<ArrayBuffer> {
  const data = atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1));
  return Uint8Array.from(data, (character) => character.charCodeAt(0));
}
