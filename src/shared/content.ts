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
export const bodyFieldSchema = z.enum(['text', 'input', 'output', 'references']);
export const bodyReferenceSchema = z.object({ version: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export const bodyReferencesSchema = z.object({ text: bodyReferenceSchema.optional(), input: bodyReferenceSchema.optional(), output: bodyReferenceSchema.optional(), references: bodyReferenceSchema.optional() }).strict();
export type BodyReference = z.infer<typeof bodyReferenceSchema>;
export type BodyReferences = z.infer<typeof bodyReferencesSchema>;
export const skillLimit = 8;
const skillId = z.string().regex(/^[a-f0-9]{64}$/);
const skillLabel = z.string().min(1).max(120).regex(/^[^\s\u0000-\u001f\u007f][^\u0000-\u001f\u007f]*$/u);
export const skillOptionSchema = z.object({ id: skillId, name: skillLabel, label: skillLabel, description: z.string().max(1000) }).strict();
export const skillCatalogSchema = z.object({ skills: z.array(skillOptionSchema).max(500) }).strict();
const skillReferenceSchema = z.object({ id: skillId, label: skillLabel, start: z.number().int().min(0).max(16_000), end: z.number().int().min(1).max(16_000) }).strict();
export const inputFields = { ...contentFields, skills: z.array(skillReferenceSchema).max(skillLimit).optional() };
export type SkillOption = z.infer<typeof skillOptionSchema>;
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export const skillLabelText = (label: string) => `⬡ ${label}`;
export function validSkillSpans({ text, skills }: { text: string; skills?: SkillReference[] }): boolean {
  let end = 0;
  for (const skill of skills ?? []) {
    if (skill.start < end || skill.end > text.length || text.slice(skill.start, skill.end) !== skillLabelText(skill.label)) return false;
    end = skill.end;
  }
  return true;
}
export const toolSchema = z.object({ name: z.string().max(200), exitCode: z.number().int().min(-2147483648).max(2147483647).optional(), input: z.string().max(32000).optional(), output: z.string().max(128000).optional() }).strict();
export type ImageAttachment = z.infer<typeof imageSchema>;
export type MessageReference = z.infer<typeof referenceSchema>;
export type InputContent = { text: string; images?: ImageAttachment[]; references?: MessageReference[]; skills?: SkillReference[] };
/** File references remain paths, not frozen file contents. Quotes remain selected text. */
export function nativeText(input: InputContent): string {
  return [input.text, ...(input.references ?? []).map(r => r.type === 'quote' ? `\n[引用消息 ${r.itemId}]\n${r.text}\n[/引用消息]` : `\n[引用工作区原文件] ${r.path}\n请读取工作区中该文件的实际内容；不可读时明确报告。`)].filter(Boolean).join('\n');
}
