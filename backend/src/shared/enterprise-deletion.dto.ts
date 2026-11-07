import { z } from 'zod';

export const RequestEnterpriseDeletionSchema = z.object({
  confirmName: z.string().min(1, '请输入企业名称').max(500),
}).strict();
export type RequestEnterpriseDeletion = z.infer<typeof RequestEnterpriseDeletionSchema>;

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

export interface EnterpriseDeletionView {
  id: string;
  enterpriseId: string;
  enterpriseName: string;
  status: 'PENDING' | 'RUNNING' | 'FAILED' | 'COMPLETED';
  phase: 'PREPARE' | 'DATABASE' | 'FILES' | 'DONE';
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
