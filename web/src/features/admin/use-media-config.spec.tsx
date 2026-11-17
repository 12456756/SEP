import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import {
  CreateImageProfileSchema, UpdateImageProfileSchema, useCreateMediaProfile,
  useMediaConnection, useMediaProfiles, useUpdateMediaConnection, useUpdateMediaProfile,
  useDiscoverMediaModels, useVerifyMediaProfile,
  type CreateImageProfileDto,
} from './use-media-config';
import { CreateMediaProfileDtoSchema, UpdateMediaProfileDtoSchema } from '../../../../backend/src/shared/media.dto';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }));

const createDto: CreateImageProfileDto = {
  profileId: 'image-basic', kind: 'image', displayName: 'Basic Image', modelId: 'image-model',
  operations: ['generate'], executionMode: 'sync-response',
  capabilities: { supportsReferenceImage: false, maxOutputs: 1, sizes: ['1024x1024'], maxReferenceCount: 0 },
  enabled: false,
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.post).mockResolvedValue({});
  vi.mocked(api.patch).mockResolvedValue({});
  vi.mocked(api.put).mockResolvedValue({ baseUrl: 'https://relay.example/v1', apiKeyConfigured: true, configured: true });
});

describe('admin media configuration hooks', () => {
  it('aliases the shared schemas including their refinements', () => {
    expect(CreateImageProfileSchema).toBe(CreateMediaProfileDtoSchema);
    expect(UpdateImageProfileSchema).toBe(UpdateMediaProfileDtoSchema);
  });

  it('loads only configuration endpoints with dedicated cache keys', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => path === '/admin/media/profiles' ? [] : {
      baseUrl: 'https://relay.example/v1', apiKeyConfigured: true, configured: true,
    });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => ({ profiles: useMediaProfiles(), connection: useMediaConnection() }), { wrapper });
    await waitFor(() => expect(result.current.connection.isSuccess && result.current.profiles.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/admin/media/profiles');
    expect(api.get).toHaveBeenCalledWith('/admin/media/connection');
    expect(client.getQueryData(qk.adminMediaProfiles)).toEqual([]);
    expect(result.current.connection.data).toMatchObject({ apiKeyConfigured: true, configured: true });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('creates disabled image profiles without configVersion or verified', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(useCreateMediaProfile, { wrapper });
    await act(async () => { await result.current.mutateAsync({ ...createDto, enabled: true }); });
    expect(api.post).toHaveBeenCalledWith('/admin/media/profiles', createDto);
    const payload = vi.mocked(api.post).mock.calls[0][1];
    expect(payload).not.toHaveProperty('configVersion');
    expect(payload).not.toHaveProperty('verified');
  });

  it.each([
    { capabilities: { ...createDto.capabilities, sizes: [] } },
    { capabilities: { ...createDto.capabilities, sizes: ['0x1024'] } },
    { capabilities: { ...createDto.capabilities, sizes: ['1024X1024'] } },
    { operations: ['edit'], capabilities: { ...createDto.capabilities, supportsReferenceImage: false } },
    { kind: 'video' },
    { configVersion: 'client-version' },
    { verified: true },
  ])('rejects invalid create fields before sending a request: %j', async (override) => {
    const { wrapper } = setup();
    const { result } = renderHook(useCreateMediaProfile, { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ ...createDto, ...override } as CreateImageProfileDto)).rejects.toBeDefined();
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('rejects missing create sizes', () => {
    expect(CreateImageProfileSchema.safeParse({ ...createDto, capabilities: { maxOutputs: 1 } }).success).toBe(false);
  });

  it('sends the expected version on updates and invalidates media caches only', async () => {
    const { client, wrapper } = setup();
    const mediaKey = qk.mediaConfig('enterprise-a');
    const availableKey = qk.availableMediaProfiles('enterprise-b');
    client.setQueryData(mediaKey, {});
    client.setQueryData(availableKey, []);
    client.setQueryData(qk.modelConfig('enterprise-a'), {});
    const { result } = renderHook(useUpdateMediaProfile, { wrapper });
    const dto = { expectedConfigVersion: 'version-7', enabled: true };
    await act(async () => { await result.current.mutateAsync({ profileId: 'image-basic', dto }); });
    expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/image-basic', dto);
    expect(client.getQueryState(mediaKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(availableKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.modelConfig('enterprise-a'))?.isInvalidated).toBe(false);
  });

  it.each([
    { enabled: true },
    { expectedConfigVersion: 'version-7' },
    { expectedConfigVersion: 'version-7', profileId: 'renamed', enabled: true },
    { expectedConfigVersion: 'version-7', configVersion: 'overridden', enabled: true },
    { expectedConfigVersion: 'version-7', verified: true },
  ])('rejects invalid update payloads: %j', (dto) => {
    expect(UpdateImageProfileSchema.safeParse(dto).success).toBe(false);
  });

  it.each(['', '   ', undefined])('omits a blank or absent connection key (%j)', async (apiKey) => {
    const { wrapper } = setup();
    const { result } = renderHook(useUpdateMediaConnection, { wrapper });
    await act(async () => { await result.current.mutateAsync({ baseUrl: 'https://relay.example/v1', apiKey }); });
    expect(api.put).toHaveBeenCalledWith('/admin/media/connection', { baseUrl: 'https://relay.example/v1' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends a new key only when supplied', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(useUpdateMediaConnection, { wrapper });
    await act(async () => { await result.current.mutateAsync({ baseUrl: 'https://relay.example/v1', apiKey: ' mock-only-key ' }); });
    expect(api.put).toHaveBeenCalledWith('/admin/media/connection', { baseUrl: 'https://relay.example/v1', apiKey: 'mock-only-key' });
  });

  it('discovers candidate models through the saved connection without sending a key', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ checkedAt: new Date().toISOString(), models: [
      { modelId: 'gpt-image-2', displayName: 'GPT Image 2', compatible: true, reason: null,
        suggested: { operations: ['generate'], executionMode: 'sync-response', capabilities: { supportsReferenceImage: false, maxOutputs: 4, sizes: ['1024x1024'] } } },
    ] });
    const { wrapper } = setup();
    const { result } = renderHook(useDiscoverMediaModels, { wrapper });
    await act(async () => { await result.current.mutateAsync(); });
    expect(api.post).toHaveBeenCalledWith('/admin/media/models/discover', {});
    expect(JSON.stringify(vi.mocked(api.post).mock.calls[0])).not.toContain('mock-only-key');
  });

  it('verifies a profile using the current version and invalidates runtime media caches', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      profile: { ...createDto, configVersion: 'version-8', verified: true },
      checkedAt: new Date().toISOString(), executionTested: false,
    });
    const { client, wrapper } = setup();
    const mediaKey = qk.mediaConfig('enterprise-a');
    const availableKey = qk.availableMediaProfiles('enterprise-a');
    client.setQueryData(mediaKey, {});
    client.setQueryData(availableKey, []);
    const { result } = renderHook(useVerifyMediaProfile, { wrapper });
    await act(async () => { await result.current.mutateAsync({ profileId: 'image-basic', dto: { expectedConfigVersion: 'version-7' } }); });
    expect(api.post).toHaveBeenCalledWith('/admin/media/profiles/image-basic/verify', { expectedConfigVersion: 'version-7' });
    expect(client.getQueryState(mediaKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(availableKey)?.isInvalidated).toBe(true);
  });
});
