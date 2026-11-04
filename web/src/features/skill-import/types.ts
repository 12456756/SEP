import type { z } from "zod";
import type {
  SkillImportArtifactSchema,
  SkillImportCandidateSchema,
  SkillImportSessionViewSchema,
  SkillImportPreviewResultSchema,
} from "shared/skill-import-schema";

export type SkillImportArtifact = z.infer<typeof SkillImportArtifactSchema>;
export type SkillImportCandidate = z.infer<typeof SkillImportCandidateSchema>;
export type SkillImportSession = z.infer<typeof SkillImportSessionViewSchema>;
export type SkillImportPreview = z.infer<typeof SkillImportPreviewResultSchema>;

export type SkillImportQueueStatus =
  "queued" | "processing" | "succeeded" | "failed";
export type SkillImportQueueItem = {
  candidate: SkillImportCandidate;
  status: SkillImportQueueStatus;
  artifact?: SkillImportArtifact;
  error?: string;
};
export type SkillImportCompletedArtifact = {
  candidateId: string;
  candidateName: string;
  artifact: SkillImportArtifact;
};
