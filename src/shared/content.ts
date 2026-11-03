import { z } from 'zod';

export const imageSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(120), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).strict();
const referencePath = z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(part => !part || part === '.' || part === '..') && !/[\u0000-\u001f]/.test(p));
export const workspaceDocumentPath = referencePath.refine(path => !path.split('/').some(part => part.startsWith('.')));
export const recordedFilePath = workspaceDocumentPath.refine(path => !/%(?:25|2[ef]|5c)|[\u007f]/i.test(path));
export const referenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quote'), itemId: z.string().min(1).max(1024), text: z.string().min(1).max(8000) }).strict(),
  z.object({ type: z.literal('file'), path: referencePath }).strict(),
]);
export const contentFields = { images: z.array(imageSchema).max(4).optional(), references: z.array(referenceSchema).max(8).optional() };
export const toolSchema = z.object({ name: z.string().max(200), exitCode: z.number().int().min(-2147483648).max(2147483647).optional(), input: z.string().max(32000).optional(), output: z.string().max(128000).optional() }).strict();
export type ImageAttachment = z.infer<typeof imageSchema>;
export type MessageReference = z.infer<typeof referenceSchema>;
export type InputContent = { text: string; images?: ImageAttachment[]; references?: MessageReference[] };
/** File references remain paths, not frozen file contents. Quotes remain selected text. */
export function nativeText(input: InputContent): string {
  return [input.text, ...(input.references ?? []).map(r => r.type === 'quote' ? `\n[引用消息 ${r.itemId}]\n${r.text}\n[/引用消息]` : `\n[引用工作区原文件] ${r.path}\n请读取工作区中该文件的实际内容；不可读时明确报告。`)].filter(Boolean).join('\n');
}
