export const MEMORY_CATEGORIES = [
  "group_facts",
  "members",
  "lore",
  "recurring_topics",
  "decisions",
] as const;

export type GroupMemoryCategory = (typeof MEMORY_CATEGORIES)[number];
