import { z } from 'zod';

export const SKILL_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const SKILL_PACKAGE_MAX_BYTES = 100 * 1024 * 1024;
export const SKILL_PACKAGE_MAX_ENTRIES = 10000;
export const SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

export const SkillContentSchema = z.string()
  .refine((content) => content.trim().length > 0, '技能正文不能为空')
  .refine((content) => new TextEncoder().encode(content).byteLength <= SKILL_CONTENT_MAX_BYTES,
    '技能正文不能超过 2MiB（UTF-8）');
