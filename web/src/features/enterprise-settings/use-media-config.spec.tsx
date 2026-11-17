import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import {
  MediaPolicyFormSchema, useAvailableMediaProfiles, useEnterpriseMediaConfig,
  useUpdateEnterpriseMediaConfig, type MediaPolicy, type MediaAvailableProfile,
} from './use-media-config';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

const policy: MediaPolicy = {
  enabledProfileIds: ['image-basic'], defaultProfileId: 'image-basic', allowedOperations: ['generate'],
  maxOutputs: 2, maxWidth: 4096, maxHeight: 4096,
};
const profile: MediaAvailableProfile = {
  profileId: 'image-basic', kind: 'image', displayName: 'Basic Image',
  configVersion: 'version-7', operations: ['generate'], executionMode: 'sync-response',
  capabilities: { supportsReferenceImage: false, maxOutputs: 2, sizes: ['1024x1024'], maxReferenceCount: 0 }, enabled: true, verified: true,
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('enterprise media configuration hooks', () => {
  it('loads configured/canEdit and isolates policy caches by enterprise', async () => {
    vi.mocked(api.get).mockResolvedValue({ policy, configured: true, canEdit: false });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useEnterpriseMediaConfig('enterprise-a'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/enterprise/media-config');
    expect(result.current.data).toEqual({ policy, configured: true, canEdit: false });
    expect(client.getQueryData(qk.mediaConfig('enterprise-a'))).toEqual(result.current.data);
    expect(client.getQueryData(qk.mediaConfig('enterprise-b'))).toBeUndefined();
  });

  it('does not query without an enterprise identity', () => {
    const { wrapper } = setup();
    renderHook(() => ({ config: useEnterpriseMediaConfig(''), profiles: useAvailableMediaProfiles('') }), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('offers only enabled, verified image profiles', async () => {
    vi.mocked(api.get).mockResolvedValue([
      profile, { ...profile, profileId: 'unverified', verified: false },
      { ...profile, profileId: 'disabled', enabled: false }, { ...profile, profileId: 'video-only', kind: 'video' },
    ]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAvailableMediaProfiles('enterprise-a'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([profile]));
    expect(api.get).toHaveBeenCalledWith('/enterprise/media-config/available-profiles');
  });

  it('saves policy to the enterprise endpoint and refreshes only that enterprise', async () => {
    const response = { policy, configured: true, canEdit: true };
    vi.mocked(api.put).mockResolvedValue(response);
    const { client, wrapper } = setup();
    client.setQueryData(qk.availableMediaProfiles('enterprise-a'), []);
    client.setQueryData(qk.availableMediaProfiles('enterprise-b'), []);
    const { result } = renderHook(() => useUpdateEnterpriseMediaConfig('enterprise-a'), { wrapper });
    await act(async () => { await result.current.mutateAsync(policy); });
    expect(api.put).toHaveBeenCalledWith('/enterprise/media-config', {
      enabledProfileIds: policy.enabledProfileIds, defaultProfileId: policy.defaultProfileId,
    });
    expect(client.getQueryData(qk.mediaConfig('enterprise-a'))).toEqual(response);
    expect(client.getQueryState(qk.availableMediaProfiles('enterprise-a'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.availableMediaProfiles('enterprise-b'))?.isInvalidated).toBe(false);
  });

  it('strips obsolete limits and validates only model authorization and default membership', () => {
    expect(MediaPolicyFormSchema.parse({ ...policy, allowedOperations: [], maxWidth: -1, maxOutputs: 0 })).toEqual({
      enabledProfileIds: policy.enabledProfileIds, defaultProfileId: policy.defaultProfileId,
    });
    expect(MediaPolicyFormSchema.safeParse({ ...policy, enabledProfileIds: ['invalid profile'] }).success).toBe(false);
    expect(MediaPolicyFormSchema.safeParse({ ...policy, defaultProfileId: 'not-selected' }).success).toBe(false);
  });
});
