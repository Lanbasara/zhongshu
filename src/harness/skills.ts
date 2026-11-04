import { createHash } from 'node:crypto';
import { skillOptionSchema, validSkillSpans, type SkillOption } from '../shared/content.ts';
import type { Binding, HarnessInput } from './types.ts';

export type NativeSkill = SkillOption & { path?: string };

export function nativeSkill(binding: Binding, skill: { name: string; label?: string; description: string; path?: string }): NativeSkill | undefined {
  const id = createHash('sha256').update(JSON.stringify([binding.id, binding.cwd, skill.name, skill.path])).digest('hex');
  const parsed = skillOptionSchema.safeParse({ id, name: skill.name, label: skill.label || skill.name, description: skill.description.slice(0, 1000) });
  if (parsed.success) return { ...parsed.data, path: skill.path };
}

export function skillOptions(skills: NativeSkill[]): SkillOption[] {
  return skills.map(({ id, name, label, description }) => ({ id, name, label, description }));
}

/** Resolve every explicit occurrence against the bound Harness before submission. */
export function resolveSkillInput(operation: HarnessInput, skills: NativeSkill[], prefix: '/' | '$') {
  if (!validSkillSpans(operation)) return;
  const byId = new Map(skills.map(skill => [skill.id, skill]));
  const selected = new Map<string, NativeSkill>();
  let text = '';
  let end = 0;
  for (const reference of operation.skills ?? []) {
    const skill = byId.get(reference.id);
    if (!skill || skill.label !== reference.label) return;
    text += operation.text.slice(end, reference.start) + ` ${prefix}${skill.name} `;
    end = reference.end;
    selected.set(skill.id, skill);
  }
  return { text: text + operation.text.slice(end), skills: [...selected.values()] };
}
