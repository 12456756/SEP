import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { enterpriseDeletionApi } from './enterprise-deletion-api';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe('enterprise deletion API', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses encoded enterprise ids for preview and existing job lookup', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ warnings: [] }).mockResolvedValueOnce(null);
    await enterpriseDeletionApi.preview('org/a');
    await expect(enterpriseDeletionApi.current('org/a')).resolves.toBeNull();
    expect(api.get).toHaveBeenNthCalledWith(1, '/admin/enterprises/org%2Fa/deletion-preview');
    expect(api.get).toHaveBeenNthCalledWith(2, '/admin/enterprises/org%2Fa/deletion');
  });

  it('normalizes an empty successful response to no current job', async () => {
    vi.mocked(api.get).mockResolvedValue(undefined);
    await expect(enterpriseDeletionApi.current('org-1')).resolves.toBeNull();
  });

  it('sends the exact confirmation name and retries by job id', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'job-1' });
    await enterpriseDeletionApi.start('org-1', 'Acme');
    await enterpriseDeletionApi.retry('job/1');
    expect(api.post).toHaveBeenNthCalledWith(1, '/admin/enterprises/org-1/deletion', { confirmName: 'Acme' });
    expect(api.post).toHaveBeenNthCalledWith(2, '/admin/enterprise-deletions/job%2F1/retry');
  });
});
