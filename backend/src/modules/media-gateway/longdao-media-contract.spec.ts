import { closedSubmission, executionEvidence, mediaClientActions, mergeExecutionEvidence, readLongdaoMedia, recoverableTaskId } from './longdao-media-contract';
import { MediaUpstreamException } from '../../common/errors/media-upstream.exception';
import { contractResult } from './longdao-media.test-support';

describe('Longdao media receipt contract', () => {
  it('keeps a 502 exhausted submission as a closed, uncharged failure, including every error', async () => {
    const body = contractResult('original', { task_id: null, submission_status: 'failed', status: null,
      billing: { status: 'not_charged', actual_cost_usd: '0' },
      submission_retry: { attempts: 4, max_attempts: 4, exhausted: true, errors: [{ attempt: 4, message: 'EOF' }] },
      error: { message: 'EOF', operation: 'create' } }).contract;
    const result = await readLongdaoMedia(new Response(JSON.stringify(body), { status: 502 }), 'secret', 'original');
    const evidence = executionEvidence(result);
    expect(closedSubmission(evidence)).toBe(true);
    expect(evidence).toMatchObject({ submissionStatus: 'failed', taskId: null, submissionRetry: { attempts: 4 }, operationError: { status: 502, body: { error: { message: 'EOF' } } } });
    expect(mediaClientActions(evidence, 'unavailable', false)).toEqual({ submissionFinished: true, generationFinished: true,
      shouldPoll: false, pollPurpose: 'none', canStartNewRequest: true, canRetryDownload: false });
  });

  it('ends generation independently of billing trouble or failed refunds', () => {
    const evidence = executionEvidence(contractResult('original', { task_id: null, submission_status: 'failed', status: null,
      billing: { status: 'unknown', actual_cost_usd: null, error: { source: 'platform', message: 'database unavailable' } } }));
    expect(mediaClientActions(evidence, 'unavailable', true)).toMatchObject({ generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' });
  });

  it('reports completed generation and download retry separately', () => {
    const evidence = executionEvidence(contractResult('original', { status: 'completed', is_final: true }));
    expect(mediaClientActions(evidence, 'download_failed', true)).toMatchObject({ generationFinished: true, canStartNewRequest: true,
      canRetryDownload: true, pollPurpose: 'delivery' });
  });

  it('keeps a running task and cached status when a query operation fails', () => {
    const evidence = executionEvidence(contractResult('original', { status: 'in_progress', status_source: 'cached', status_observed_at: 123,
      operation: 'query', error: { message: 'timeout', operation: 'query' } }, 504));
    expect(evidence).toMatchObject({ generationStatus: 'in_progress', statusSource: 'cached', observedAt: 123, operationError: { status: 504 } });
    expect(mediaClientActions(evidence, 'pending', true).canStartNewRequest).toBe(false);
  });

  it.each([
    { status: 'not_charged', actual_cost_usd: null }, { status: 'not_charged', actual_cost_usd: '1' },
    { status: 'settled', actual_cost_usd: null }, { status: 'unknown', actual_cost_usd: '0' },
  ])('rejects contradictory monetary evidence %j', billing => {
    expect(() => contractResult('original', { billing })).toThrow();
  });

  it('rejects another request or task even in an HTTP 200 envelope', async () => {
    const response = () => new Response(JSON.stringify(contractResult('another').contract));
    await expect(readLongdaoMedia(response(), 'key', 'original')).rejects.toMatchObject({ status: 502 });
    await expect(readLongdaoMedia(response(), 'key', 'another', 'different-task')).rejects.toMatchObject({ status: 502 });
  });

  it('retains a reliable task ID from an incomplete response but never borrows another request identity', () => {
    const failure = (body: unknown) => new MediaUpstreamException({ status: 502, body: body as any });
    expect(recoverableTaskId(failure({ request_id: 'original', task_id: 'task-1', billing: {} }), 'original')).toBe('task-1');
    expect(recoverableTaskId(failure({ request_id: 'another', task_id: 'task-1' }), 'original')).toBeNull();
    expect(recoverableTaskId(failure({ request_id: 'original', task_id: 'task-1', id: 'different' }), 'original')).toBeNull();
    expect(recoverableTaskId(failure({ request_id: 'original', task_id: '../bad' }), 'original')).toBeNull();
  });

  it('accepts explicit image pre-dispatch failure without an echo ID only on the original POST response', async () => {
    const body = { schema_version: 2, request_id: '', submission_status: 'failed', status: 'failed',
      billing: { status: 'not_charged', actual_cost_usd: '0' }, error: { message: 'No configured asynchronous account' } };
    const response = () => new Response(JSON.stringify(body), { status: 503 });
    const parsed = await readLongdaoMedia(response(), 'key', 'original', undefined, true);
    expect(executionEvidence(parsed)).toMatchObject({ requestId: 'original', submissionStatus: 'failed',
      operationError: { status: 503, body } });
    await expect(readLongdaoMedia(response(), 'key', 'original')).rejects.toMatchObject({ status: 503 });
  });

  it('does not regress completed generation or confirmed billing after a failed query', () => {
    const previous = executionEvidence(contractResult('original', { status: 'completed', is_final: true,
      billing: { status: 'settled', actual_cost_usd: '0.12' } }));
    const incoming = executionEvidence(contractResult('original', { operation: 'query', status: 'queued', is_final: false,
      billing: { status: 'unknown', actual_cost_usd: null }, operation_error: { message: 'Provider unavailable' } }, 503));
    expect(mergeExecutionEvidence(previous, incoming)).toMatchObject({ generationStatus: 'completed', isFinal: true,
      billing: { status: 'settled', actualCostUsd: '0.12' }, operationError: { status: 503 } });
  });

  it('keeps an uncharged closed submission and its original diagnostics on later observations', () => {
    const previous = executionEvidence(contractResult('original', { task_id: 'diagnostic-only', status: null,
      submission_status: 'protocol_error', submission_error: { message: 'Bad provider receipt' },
      billing: { status: 'not_charged', actual_cost_usd: '0' } }, 502));
    const incoming = executionEvidence(contractResult('original', { status: 'queued' }));
    expect(mergeExecutionEvidence(previous, incoming)).toMatchObject({ submissionStatus: 'protocol_error', generationStatus: null,
      submissionError: { message: 'Bad provider receipt' }, billing: { status: 'not_charged', actualCostUsd: '0' } });
  });
});
