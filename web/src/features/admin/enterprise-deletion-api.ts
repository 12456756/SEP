import { api } from '@/lib/api-client';

export interface EnterpriseDeletionPreview {
  enterpriseId: string;
  enterpriseName: string;
  balance: number;
  frozenAmount: number;
  computeReservedCNY: number;
  memberCount: number;
  subscriptionCount: number;
  knowledgeBaseCount: number;
  documentCount: number;
  taskCount: number;
  runningTaskCount: number;
  pendingOrderCount: number;
  warnings: string[];
}

export type EnterpriseDeletionStatus = 'PENDING' | 'RUNNING' | 'FAILED' | 'COMPLETED';
export type EnterpriseDeletionPhase = 'PREPARE' | 'DATABASE' | 'FILES' | 'DONE';

export interface EnterpriseDeletionJob {
  id: string;
  enterpriseId: string;
  enterpriseName: string;
  status: EnterpriseDeletionStatus;
  phase: EnterpriseDeletionPhase;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const enterpriseDeletionApi = {
  preview: (enterpriseId: string) => api.get<EnterpriseDeletionPreview>(`/admin/enterprises/${encodeURIComponent(enterpriseId)}/deletion-preview`),
  current: (enterpriseId: string) => api.get<EnterpriseDeletionJob | null>(`/admin/enterprises/${encodeURIComponent(enterpriseId)}/deletion`),
  start: (enterpriseId: string, confirmName: string) => api.post<EnterpriseDeletionJob>(`/admin/enterprises/${encodeURIComponent(enterpriseId)}/deletion`, { confirmName }),
  getJob: (jobId: string) => api.get<EnterpriseDeletionJob>(`/admin/enterprise-deletions/${encodeURIComponent(jobId)}`),
  retry: (jobId: string) => api.post<EnterpriseDeletionJob>(`/admin/enterprise-deletions/${encodeURIComponent(jobId)}/retry`),
};
