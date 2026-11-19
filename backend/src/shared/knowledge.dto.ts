import { z } from 'zod';

// ============================================================================
// Knowledge Base DTOs
// ============================================================================

export const KnowledgeBaseCreateDtoSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional(),
}).strict();
export type KnowledgeBaseCreateDto = z.infer<typeof KnowledgeBaseCreateDtoSchema>;

export const KnowledgeBaseUpdateDtoSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(1000).optional(),
}).strict().refine(data => Object.keys(data).length > 0, 'At least one field is required');
export type KnowledgeBaseUpdateDto = z.infer<typeof KnowledgeBaseUpdateDtoSchema>;

export const DocumentUploadDtoSchema = z.object({
  // File upload handled by multer, metadata validation only
  originalName: z.string().min(1),
  mimeType: z.string(),
  fileSize: z.number().int().positive(),
});
export type DocumentUploadDto = z.infer<typeof DocumentUploadDtoSchema>;

export const KnowledgeGrantCreateDtoSchema = z.object({
  subscriptionId: z.string().optional(),
  departmentId: z.string().optional(),
}).strict().refine(data => data.subscriptionId || data.departmentId, {
  message: 'Either subscriptionId or departmentId must be provided',
});
export type KnowledgeGrantCreateDto = z.infer<typeof KnowledgeGrantCreateDtoSchema>;

// ============================================================================
// Phase 2: 检索测试 / 文档状态 / 分析 DTOs
// ============================================================================

/** 检索测试请求 */
export const TestSearchDtoSchema = z.object({
  query: z.string().min(1, '查询内容不能为空').max(1000),
  topK: z.number().int().min(1).max(20).optional().default(5),
  scoreThreshold: z.number().min(0).max(1).optional().default(0.5),
  useRerank: z.boolean().optional().default(false),
  strategy: z.enum(['lexical', 'vector', 'hybrid', 'auto']).optional().default('auto'),
}).strict();
export type TestSearchDto = z.infer<typeof TestSearchDtoSchema>;

/** 批量重处理请求 */
export const BatchReprocessDtoSchema = z.object({
  /** 不传则重处理该知识库下所有 FAILED 文档 */
  documentIds: z.array(z.string()).optional(),
  /** 过滤状态，不传默认只重处理 FAILED */
  statuses: z.array(z.enum(['PENDING', 'PROCESSING', 'FAILED'])).optional(),
});
export type BatchReprocessDto = z.infer<typeof BatchReprocessDtoSchema>;

const KnowledgeIdSchema = z.string().trim().min(1).max(128);
export const KnowledgePageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(100).optional(),
}).strict();
export type KnowledgePageQuery = z.infer<typeof KnowledgePageQuerySchema>;

export const KnowledgePreviewQuerySchema = KnowledgePageQuerySchema.omit({ keyword: true }).extend({
  versionId: z.string().min(1).max(100).optional(),
});
export const KnowledgeChunkQuerySchema = z.object({ search: z.string().trim().max(100).optional() }).strict();
export const KnowledgeGrantCandidateQuerySchema = KnowledgePageQuerySchema.extend({ view: z.literal('knowledge-grant') });
export type KnowledgeGrantCandidateQuery = z.infer<typeof KnowledgeGrantCandidateQuerySchema>;
export const KnowledgeMemberGrantCreateDtoSchema = z.object({
  memberIds: z.array(KnowledgeIdSchema).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Member IDs must be unique'),
}).strict();
export type KnowledgeMemberGrantCreateDto = z.infer<typeof KnowledgeMemberGrantCreateDtoSchema>;
/** Legacy bodies are parsed only to return controlled 410; never persisted. */
export const KnowledgeGrantMutationDtoSchema = z.union([KnowledgeMemberGrantCreateDtoSchema, KnowledgeGrantCreateDtoSchema]);
export type KnowledgeGrantMutationDto = z.infer<typeof KnowledgeGrantMutationDtoSchema>;
export const KnowledgeMemberSearchDtoSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  knowledgeBaseIds: z.array(KnowledgeIdSchema).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Knowledge base IDs must be unique').optional(),
  topK: z.number().int().min(1).max(20).default(5),
}).strict();
export type KnowledgeMemberSearchDto = z.infer<typeof KnowledgeMemberSearchDtoSchema>;

export type KnowledgeSearchStatus = 'MATCHED' | 'NO_MATCH' | 'NO_ACCESS' | 'NOT_READY';
export type KnowledgeSearchStrategy = 'HYBRID' | 'LEXICAL';

export interface KnowledgeSourceLocation {
  pageStart: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  blockStart: number;
  blockEnd: number;
}

export interface KnowledgeSearchResult {
  sourceId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  versionId: string;
  chunkId: string;
  content: string;
  tokenCount: number;
  truncated: boolean;
  location: KnowledgeSourceLocation;
}

export interface KnowledgeSearchResponse {
  searchId: string;
  status: KnowledgeSearchStatus;
  actualStrategy: KnowledgeSearchStrategy | null;
  degraded: boolean;
  degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE' | null;
  diagnostic?: unknown;
  durationMs: number;
  count: number;
  partial: boolean;
  results: KnowledgeSearchResult[];
}

export interface KnowledgeSourceResponse {
  sourceId: string;
  knowledgeBaseId: string;
  documentId: string;
  documentName: string;
  versionId: string;
  chunkId: string;
  content: string;
  location: KnowledgeSourceLocation;
  isCurrent: boolean;
}
export const KnowledgeEmptyBodySchema = z.object({}).strict();

export const KNOWLEDGE_LIMITS = {
  allowedExtensions: ['.pdf', '.docx', '.txt', '.md'], maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerRequest: 1, maxQueryCharacters: 1000, maxSearchKnowledgeBases: 100,
  maxTopK: 20, maxResultTokens: 6000,
};

export function knowledgeMemberDisplay(member: {
  id: string; position: string | null; user: { name: string | null; avatar: string | null };
  department: { name: string } | null;
}) {
  return { memberId: member.id, name: member.user.name?.trim() || '企业成员',
    avatarUrl: member.user.avatar, position: member.position,
    departmentName: member.department?.name ?? null };
}
