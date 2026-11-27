import { imageSchema, type ImageAttachment } from '../shared/content.ts';
import { imageCountLimit, imageSourceLimit, imageUploadLimit, legacyImageUploadLimit, messageImageLimit } from '../shared/image-limits.ts';
import { putUpload, type UploadDraft } from './upload-drafts.ts';
import { request } from './workbench-client.ts';

export const sendImage = (item: UploadDraft) => item.compressed ?? item.file;
export const attachmentBytes = (images: ImageAttachment[] = []) =>
  images.reduce((bytes, image) => bytes + (image.byteSize ?? legacyImageUploadLimit), 0);
const imageFormats = new Set<string>(imageSchema.shape.mediaType.options);
const overBudget = '图片超过限额（单张发送最多 5 MiB，每条合计 8 MiB）。请移除图片或分条发送。';
const compressionFailed = '自动压缩后仍无法发送。原图已保留，请移除或替换标记的图片。';

export function imageUploadProblem(items: UploadDraft[], usedBytes = 0): string {
  if (items.some(item => item.compressionFailed)) return compressionFailed;
  if (items.some(item => sendImage(item).size > imageUploadLimit) ||
      items.reduce((bytes, item) => bytes + sendImage(item).size, usedBytes) > messageImageLimit) return overBudget;
  return '';
}

function imageBudgets(files: File[], used: number): number[] {
  let remaining = Math.max(0, messageImageLimit - used);
  const bySize = files.map((file, index) => ({ size: file.size, index })).sort((a, b) => a.size - b.size);
  const budgets: number[] = [];
  for (const [position, entry] of bySize.entries()) {
    const budget = Math.min(entry.size, imageUploadLimit, Math.floor(remaining / (bySize.length - position)));
    budgets[entry.index] = budget;
    remaining -= budget;
  }
  return budgets;
}

async function compressImage(file: File, budget: number): Promise<Blob | undefined> {
  if (budget <= 0) return;
  const bitmap = await createImageBitmap(file);
  try {
    // Limit canvas memory, and scale smaller only when the remaining byte budget is tight.
    const pixels = Math.min(16_000_000, budget * 6);
    const scale = Math.min(1, Math.sqrt(pixels / (bitmap.width * bitmap.height)), 8192 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.88));
    if (result && result.size > 0 && result.size <= budget && imageFormats.has(result.type)) return result;
  } finally {
    bitmap.close();
  }
}

export async function stageImages(conversation: string, files: File[], count: number, usedBytes: number) {
  if (count + files.length > imageCountLimit) return { items: [], error: '每条消息最多添加 4 张图片。' };
  const allowed = files.filter(file => imageFormats.has(file.type) && file.size > 0 && file.size <= imageSourceLimit);
  let error = allowed.length === files.length ? '' : '请选择 10 MiB 以内的 PNG、JPEG 或 WebP 原图。';
  const items: UploadDraft[] = [];
  const budgets = imageBudgets(allowed, usedBytes);
  for (const [index, file] of allowed.entries()) {
    const item: UploadDraft = { id: crypto.randomUUID(), conversation, file };
    const budget = budgets[index]!;
    if (file.size > budget) item.compressionFailed = true;
    try {
      // Save the original before decoding. A refresh or failed encode leaves a removable attachment.
      await putUpload(item);
    } catch {
      error = '无法暂存图片，本次未添加。';
      continue;
    }
    if (item.compressionFailed) {
      try {
        const compressed = await compressImage(file, budget);
        if (compressed) {
          await putUpload({ ...item, compressed, compressionFailed: undefined });
          item.compressed = compressed;
          delete item.compressionFailed;
        }
      } catch { /* The original remains in the draft. */ }
      if (item.compressionFailed) error = compressionFailed;
    }
    items.push(item);
  }
  return { items, error };
}

export async function uploadImage(conversation: string, csrf: string, item: UploadDraft, signal?: AbortSignal) {
  const image = sendImage(item);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(new Error('无法读取图片。'));
    reader.readAsDataURL(image);
  });
  const originalName = item.file.name;
  const suffix = image.type === 'image/jpeg' ? 'jpg' : image.type.split('/')[1];
  const name = item.compressed ? `${originalName.replace(/\.[^./]+$/, '').slice(0, 115) || '图片'}.${suffix}` : originalName.slice(0, 120) || '图片';
  const uploaded = await request(`/conversations/${conversation}/resources`, imageSchema, { csrf, body: { name, data }, signal, timeoutMs: 45_000 });
  return { ...uploaded, byteSize: uploaded.byteSize ?? image.size, ...(item.compressed ? { originalByteSize: item.file.size } : {}) };
}

export function compressionLabel(original: number, sent: number) {
  const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `已压缩 · ${mib(original)} → ${mib(sent)}`;
}
