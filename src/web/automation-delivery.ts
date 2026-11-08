import { createContext } from 'react';

export type DeliveredReminder = { scheduleId: string; occurrenceAt: string; prompt: string };

/**
 * The reminders inside a native automation delivery (ADR 0021). DSH frames a one-shot reminder as `[SCHEDULE REMINDER]`
 * with `schedule_id_json`, `occurrence_at` and a JSON-encoded `reminder_prompt_json` line, and a recurring batch as
 * `[SCHEDULE REMINDER BATCH]` with a `reminders_json` array. Anything else, or a frame that does not parse, returns
 * undefined so the raw text is shown.
 */
export function deliveredReminders(text: string): DeliveredReminder[] | undefined {
  const lines = text.split('\n');
  const field = (key: string) => lines.find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const json = (key: string): unknown => { const raw = field(key); return raw === undefined ? undefined : JSON.parse(raw); };
  try {
    if (lines[0] === '[SCHEDULE REMINDER]') {
      const scheduleId = json('schedule_id_json'); const prompt = json('reminder_prompt_json'); const occurrenceAt = field('occurrence_at');
      return typeof scheduleId === 'string' && typeof prompt === 'string' && occurrenceAt ? [{ scheduleId, occurrenceAt, prompt }] : undefined;
    }
    if (lines[0] === '[SCHEDULE REMINDER BATCH]') {
      const value = json('reminders_json');
      if (!Array.isArray(value) || !value.length || value.length > 50) return undefined;
      const reminders = value.map((entry: unknown) => {
        const { schedule_id: scheduleId, occurrence_at: occurrenceAt, reminder_prompt: prompt } = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        return typeof scheduleId === 'string' && typeof occurrenceAt === 'string' && typeof prompt === 'string' ? { scheduleId, occurrenceAt, prompt } : undefined;
      });
      return reminders.every(reminder => reminder !== undefined) ? reminders as DeliveredReminder[] : undefined;
    }
  } catch { /* a frame that does not parse is shown as written */ }
  return undefined;
}

/** Task titles by native id, so a delivered message can say which task sent it. */
export const AutomationTitles = createContext<ReadonlyMap<string, string>>(new Map());
