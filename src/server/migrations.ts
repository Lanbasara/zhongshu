import type { Migration } from './database.ts';

// Authentication owns schema v1. Additional product migrations stay in one ordered list.
export const productMigrations: Migration[] = [];
