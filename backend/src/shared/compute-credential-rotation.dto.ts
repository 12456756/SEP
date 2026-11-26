import { z } from 'zod';

export const ComputeCredentialRotationRequestSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.enum(['chat', 'image', 'video']),
  expectedVersion: z.number().int().positive().max(2147483646),
}).strict();
export type ComputeCredentialRotationRequest = z.infer<typeof ComputeCredentialRotationRequestSchema>;
export interface ComputeCredentialRotationView {
  id: string; operationId: string; kind: 'chat' | 'image' | 'video'; expectedVersion: number;
  status: 'PENDING' | 'SWITCHED' | 'DRAINING' | 'COMPLETED' | 'BLOCKED';
  lastErrorCode: string | null; lastErrorMessage: string | null; createdAt: string;
}
