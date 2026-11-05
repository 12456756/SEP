import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArchiveCapability, useSaveAdminEmployee } from './use-admin';

const { updateEmployee, post } = vi.hoisted(() => ({ updateEmployee: vi.fn(), post: vi.fn() }));
vi.mock('./admin-api', () => ({ adminApi: { updateEmployee } }));
vi.mock('@/lib/api-client', () => ({ api: { post } }));

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { wrapper, invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateEmployee.mockResolvedValue({ id: 'emp-1' });
  post.mockResolvedValue({});
});

describe('admin employee mutation caches', () => {
  it('refreshes employee lists, details and bindings after archiving a capability', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useArchiveCapability(), { wrapper });
    await act(async () => { await result.current.mutateAsync('cap-1'); });
    expect(post).toHaveBeenCalledWith('/admin/capabilities/cap-1/archive');
    for (const queryKey of [['admin-employees'], ['admin-employee'], ['employee-bindings'], ['enterprise', 'my-employees'], ['subscriptions']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('saves employee metadata and changed capabilities with one request', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSaveAdminEmployee(), { wrapper });
    const data = { name: '员工', capabilityIds: ['cap-2'] };
    await act(async () => { await result.current.mutateAsync({ id: 'emp-1', data }); });
    expect(updateEmployee).toHaveBeenCalledExactlyOnceWith('emp-1', data);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['employee-bindings', 'emp-1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
