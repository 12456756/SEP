import { LongdaoMediaContractSchema } from './longdao-media-contract';

export function contractResult(requestId: string, changes: Record<string, unknown> = {}, httpStatus = 200) {
  return { contract: LongdaoMediaContractSchema.parse({ schema_version: 2, request_id: requestId,
    task_id: 'task-original', submission_status: 'accepted', status: 'queued',
    billing: { status: 'pending', actual_cost_usd: null }, ...changes }), httpStatus, headers: {} };
}
