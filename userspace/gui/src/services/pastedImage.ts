export interface PastedImageInput {
  inputId: string;
  name: string;
  mediaType: string;
  byteLength: number;
  dataUrl: string;
}

export const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024;

export function clipboardImages(clipboard: DataTransfer): File[] {
  return Array.from(clipboard.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

export async function readPastedImage(file: File, inputId: string, chinese: boolean): Promise<PastedImageInput> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
    throw new Error(chinese ? '支持粘贴 PNG、JPEG、GIF 或 WebP 图片。' : 'Paste a PNG, JPEG, GIF or WebP image.');
  }
  if (file.size > MAX_PASTED_IMAGE_BYTES) {
    throw new Error(chinese ? '图片超过 8 MiB 限额，请缩小后重试。' : 'The image exceeds 8 MiB. Resize it and try again.');
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('clipboard_image_read_failed'));
    reader.readAsDataURL(file);
  });
  return { inputId, name: file.name, mediaType: file.type, byteLength: file.size, dataUrl };
}

export function pastedImageBytes(image: PastedImageInput): Uint8Array<ArrayBuffer> {
  const data = atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1));
  return Uint8Array.from(data, (character) => character.charCodeAt(0));
}
