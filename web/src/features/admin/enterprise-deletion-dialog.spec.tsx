import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { toast } from '@/components/ui/toast';
import { EnterpriseDeletionDialog } from './enterprise-deletion-dialog';
import { enterpriseDeletionKeys } from './enterprise-deletion-hooks';
import type { EnterpriseDeletionJob, EnterpriseDeletionPreview } from './enterprise-deletion-api';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }));

const preview: EnterpriseDeletionPreview = {
  enterpriseId: 'org-1', enterpriseName: '示例企业', balance: 80, frozenAmount: 10,
  computeReservedCNY: 20, memberCount: 3, subscriptionCount: 2, knowledgeBaseCount: 1,
  documentCount: 5, taskCount: 8, runningTaskCount: 1, pendingOrderCount: 1,
  warnings: ['企业余额不会自动退款'],
};
const job: EnterpriseDeletionJob = {
  id: 'job-1', enterpriseId: 'org-1', enterpriseName: '示例企业', status: 'RUNNING',
  phase: 'DATABASE', attempts: 1, error: null, createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z', completedAt: null,
};

function setup(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCompleted = vi.fn();
  const onOpenChange = vi.fn();
  const props = { open, enterpriseId: 'org-1', enterpriseName: '示例企业', onCompleted, onOpenChange };
  const view = render(<QueryClientProvider client={client}><EnterpriseDeletionDialog {...props} /></QueryClientProvider>);
  return { client, onCompleted, onOpenChange, ...view };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith('deletion-preview')) return preview;
    if (path.includes('enterprise-deletions')) return job;
    return null;
  });
  vi.mocked(api.post).mockResolvedValue(job);
});
afterEach(cleanup);

describe('enterprise deletion dialog', () => {
  it('does not query until opened', () => {
    setup(false);
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires the exact enterprise name, allows warnings, and waits for completion', async () => {
    const { client, onCompleted } = setup();
    const input = await screen.findByLabelText('输入企业全名确认：示例企业');
    const submit = screen.getByRole('button', { name: '确认永久删除' });
    expect(screen.getByText('企业余额不会自动退款')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: '示例企业 ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: '示例企业' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByText('正在执行：清理企业数据');
    expect(api.post).toHaveBeenCalledWith('/admin/enterprises/org-1/deletion', { confirmName: '示例企业' });
    expect(onCompleted).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    act(() => client.setQueryData(enterpriseDeletionKeys.job('job-1'), { ...job, status: 'COMPLETED', phase: 'DONE' }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('resumes an existing failed job and retries without another confirmation request', async () => {
    const failed = { ...job, status: 'FAILED', phase: 'FILES', error: '文件暂时不可用' };
    vi.mocked(api.get).mockResolvedValue(failed);
    const { onCompleted } = setup();
    await screen.findByText('执行失败：清理企业文件');
    expect(screen.getByText('文件暂时不可用')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/admin/enterprises/org-1/deletion-preview');
    fireEvent.click(screen.getByRole('button', { name: '重试删除' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/enterprise-deletions/job-1/retry'));
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('shows start errors without marking deletion complete', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('无权限'));
    const { onCompleted } = setup();
    fireEvent.change(await screen.findByLabelText('输入企业全名确认：示例企业'), { target: { value: '示例企业' } });
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作失败：无权限');
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
