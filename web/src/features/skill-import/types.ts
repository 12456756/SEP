import type { z } from 'zod';
import type { SkillImportArtifactSchema, SkillImportCandidateSchema, SkillImportSessionViewSchema, SkillImportPreviewResultSchema } from 'shared/skill-import-schema';

export type SkillImportArtifact = z.infer<typeof SkillImportArtifactSchema>;
export type SkillImportCandidate = z.infer<typeof SkillImportCandidateSchema>;
export type SkillImportSession = z.infer<typeof SkillImportSessionViewSchema>;
export type SkillImportPreview = z.infer<typeof SkillImportPreviewResultSchema>;
