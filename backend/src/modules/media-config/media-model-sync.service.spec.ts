import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MediaModelProfile, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import { ManagedMediaCandidate, MediaModelSyncService, mediaConnectionFingerprint } from './media-model-sync.service';

const connection = { baseUrl: 'https://relay.example/v1', apiKey: 'test-key' };
const fingerprint = () => mediaConnectionFingerprint(connection);
const candidate = (modelId = 'model-a'): ManagedMediaCandidate => ({
  modelId, displayName: modelId, operations: ['generate'], executionMode: 'sync-response',
  capabilities: { sizes: ['1024x1024'], maxOutputs: 4 },
});
const profile = (overrides: Partial<MediaModelProfile> = {}): MediaModelProfile => ({
  id: 'row-a', profileId: 'manual-a', kind: 'image', modelId: 'model-a', displayName: 'Custom',
  operations: ['generate'], executionMode: 'sync-response', capabilities: { maxOutputs: 1 },
  configVersion: 'cfg_old', enabled: true, verified: true,
  createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
});
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError('private database detail', {
  code, clientVersion: 'test',
});

function memory(initial: MediaModelProfile[] = []) {
  let rows = structuredClone(initial);
  let working: MediaModelProfile[];
  const matches = (row: MediaModelProfile, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof MediaModelProfile] === value);
  const tx = {
    mediaModelProfile: {
      findMany: jest.fn(async ({ where }) => structuredClone(working.filter(row => matches(row, where)))),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = working.filter(row => matches(row, where));
        found.forEach(row => Object.assign(row, data));
        return { count: found.length };
      }),
      create: jest.fn(async ({ data }) => {
        if (working.some(row => row.profileId === data.profileId)) throw knownError('P2002');
        const row = profile({ ...data, id: `row-${working.length}` });
        working.push(row);
        return row;
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<void>, _options?: unknown) => {
      working = structuredClone(rows);
      await run(tx);
      rows = working;
    }),
  };
  const settings = { getMediaConnection: jest.fn(async (_kind: string, _client: unknown) => ({ ...connection })) };
  const service = new MediaModelSyncService(prisma as unknown as PrismaService, settings as unknown as SettingService);
  return { service, prisma, settings, tx, rows: () => structuredClone(rows) };
}

describe('mediaConnectionFingerprint', () => {
  it('normalizes HTTPS host, default port, trailing slash and /v1 before hashing', () => {
    expect(mediaConnectionFingerprint({ ...connection, baseUrl: ' HTTPS://RELAY.EXAMPLE:443/ ' })).toBe(fingerprint());
    expect(mediaConnectionFingerprint({ ...connection, baseUrl: 'https://relay.example/v1///' })).toBe(fingerprint());
    expect(fingerprint()).toMatch(/^[a-f0-9]{64}$/);
    expect(mediaConnectionFingerprint({ ...connection, apiKey: 'another-key' })).not.toBe(fingerprint());
    expect(mediaConnectionFingerprint({ ...connection, baseUrl: 'https://relay.example/prefix' })).toBe(
      mediaConnectionFingerprint({ ...connection, baseUrl: 'https://relay.example/prefix/v1/' }),
    );
    expect(mediaConnectionFingerprint({ ...connection, baseUrl: 'https://relay.example/V1' })).not.toBe(fingerprint());
  });

  it.each([
    { baseUrl: 'not-a-url-secret' }, { baseUrl: 'http://relay.example' },
    { baseUrl: 'https://user:private-password@relay.example' },
    { baseUrl: 'https://relay.example?key=private' }, { baseUrl: 'https://relay.example#private' },
    { apiKey: '' }, { apiKey: ' ' }, { apiKey: 'private key' }, { apiKey: 'private\nkey' },
    { apiKey: 'private\rkey' }, { apiKey: 'private\u00e9' }, { apiKey: 'private\u007f' },
  ])('rejects invalid connections without sensitive exception details: %j', change => {
    let failure: unknown;
    try { mediaConnectionFingerprint({ ...connection, ...change }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(failure)).not.toMatch(/private|test-key|relay\.example|not-a-url/);
    expect((failure as Error).message).not.toMatch(/private|test-key|relay\.example|not-a-url/);
  });
});

describe('MediaModelSyncService', () => {
  it.each(['image', 'video'] as const)('preserves the administrator reference count across %s catalog synchronization', async kind => {
    const initial = profile({ kind, profileId: `auto-${kind}-model`, capabilities: { maxReferenceCount: 8 } });
    const m = memory([initial]);
    await m.service.sync(kind, [{ ...candidate(), capabilities: { maxReferenceCount: 1 } }], fingerprint(), () => true);
    expect(m.rows()).toEqual([initial]);
  });

  it('creates inert candidates in a bounded Serializable transaction', async () => {
    const m = memory();
    await m.service.sync('image', [candidate()], fingerprint(), row => row.modelId === 'model-a');
    expect(m.rows()).toEqual([expect.objectContaining({
      ...candidate(), kind: 'image', enabled: false, verified: false,
      profileId: 'auto-image-73f95cf180a19624e4be9a71', configVersion: expect.stringMatching(/^cfg_[a-f0-9-]{36}$/),
    })]);
    expect(m.settings.getMediaConnection).toHaveBeenCalledWith('image', m.tx);
    expect(m.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: expect.any(Number), timeout: expect.any(Number),
    });
  });

  it('deduplicates and sorts candidates deterministically without changing caller data or idempotent versions', async () => {
    const input = [candidate('model-z'), { ...candidate(), displayName: 'Z', operations: ['edit', 'generate', 'edit'] },
      { ...candidate(), displayName: 'A', operations: ['generate', 'edit'] }];
    const before = structuredClone(input);
    const a = memory();
    const b = memory();
    await a.service.sync('image', input, fingerprint(), () => true);
    await b.service.sync('image', [...input].reverse(), fingerprint(), () => true);
    expect(a.rows().map(({ configVersion: _v, ...row }) => row)).toEqual(b.rows().map(({ configVersion: _v, ...row }) => row));
    expect(a.rows().map(row => row.modelId)).toEqual(['model-a', 'model-z']);
    const first = a.rows();
    await a.service.sync('image', input, fingerprint(), () => true);
    expect(a.rows()).toEqual(first);
    expect(a.tx.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    expect(a.tx.mediaModelProfile.create).toHaveBeenCalledTimes(2);
    expect(input).toEqual(before);
  });

  it('preserves disabled, narrowed and multiple historical profiles without creating a replacement', async () => {
    const initial = [profile({ enabled: false, verified: false }),
      profile({ id: 'row-b', profileId: 'manual-b', verified: false, capabilities: { maxOutputs: 1 } })];
    const m = memory(initial);
    await m.service.sync('image', [candidate()], fingerprint(), row => row.capabilities !== null);
    expect(m.rows()).toEqual(initial);
    expect(m.rows()[0].enabled).toBe(false);
    expect(m.tx.mediaModelProfile.create).not.toHaveBeenCalled();
    for (const call of m.tx.mediaModelProfile.updateMany.mock.calls) {
      expect(Object.keys(call[0].data).sort()).toEqual(['configVersion', 'verified']);
      expect(call[0].where).toMatchObject({ kind: 'image', configVersion: 'cfg_old' });
    }
  });

  it('revokes disappeared or incompatible rows and restores visibility without re-enabling them', async () => {
    const m = memory([profile({ enabled: false }), profile({ id: 'bad', profileId: 'bad', modelId: 'unsupported' })]);
    await m.service.sync('image', [candidate('unsupported')], fingerprint(), () => false);
    expect(m.rows().map(row => [row.verified, row.enabled])).toEqual([[false, false], [false, true]]);
    const revoked = m.rows();
    await m.service.sync('image', [], fingerprint(), () => true);
    expect(m.rows()).toEqual(revoked);
    await m.service.sync('image', [candidate()], fingerprint(), () => true);
    expect(m.rows()[0]).toMatchObject({ verified: false, enabled: false });
    expect(m.rows()[0].configVersion).toBe(revoked[0].configVersion);
    expect(m.rows()[1]).toEqual(revoked[1]);
  });

  it('keeps invalid history unchanged except revoking verification; never expands its capabilities', async () => {
    const initial = [profile({ capabilities: ['invalid'], verified: true }),
      profile({ id: 'bad2', profileId: 'bad2', capabilities: null, verified: false })];
    const m = memory(initial);
    await m.service.sync('image', [candidate()], fingerprint(), row =>
      !!row.capabilities && !Array.isArray(row.capabilities) && typeof row.capabilities === 'object');
    expect(m.rows()[0]).toEqual({ ...initial[0], verified: false, configVersion: expect.stringMatching(/^cfg_/) });
    expect(m.rows()[1]).toEqual(initial[1]);
    expect(m.tx.mediaModelProfile.create).not.toHaveBeenCalled();
    expect(m.tx.mediaModelProfile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale connection before reading or writing profiles', async () => {
    const m = memory([profile()]);
    m.settings.getMediaConnection.mockResolvedValue({ ...connection, apiKey: 'rotated' });
    await expect(m.service.sync('image', [candidate()], fingerprint(), () => true)).rejects.toBeInstanceOf(ConflictException);
    expect(m.tx.mediaModelProfile.findMany).not.toHaveBeenCalled();
    expect(m.rows()).toEqual([profile()]);
  });

  it('rejects stale versions with CAS and rolls back earlier writes', async () => {
    const initial = [profile(), profile({ id: 'b', profileId: 'b' })];
    const m = memory(initial);
    const update = m.tx.mediaModelProfile.updateMany.getMockImplementation()!;
    m.tx.mediaModelProfile.updateMany.mockImplementationOnce(update).mockResolvedValueOnce({ count: 0 });
    await expect(m.service.sync('image', [], fingerprint(), () => true)).rejects.toBeInstanceOf(ConflictException);
    expect(m.rows()).toEqual(initial);
  });

  it.each(['P2034', 'P2002'])('maps Prisma %s to a sanitized 409', async code => {
    const m = memory();
    m.prisma.$transaction.mockRejectedValueOnce(knownError(code));
    await expect(m.service.sync('image', [], fingerprint(), () => true)).rejects.toBeInstanceOf(ConflictException);
  });

  it('propagates unknown errors unchanged', async () => {
    const m = memory();
    const failure = new Error('unexpected');
    m.prisma.$transaction.mockRejectedValueOnce(failure);
    await expect(m.service.sync('image', [], fingerprint(), () => true)).rejects.toBe(failure);
  });

  it('isolates kinds even when they share a model ID', async () => {
    const existing = profile();
    const m = memory([existing]);
    await m.service.sync('video', [candidate()], fingerprint(), () => true);
    expect(m.rows()[0]).toEqual(existing);
    expect(m.rows()[1]).toMatchObject({ kind: 'video', profileId: expect.stringMatching(/^auto-video-/) });
    expect(m.settings.getMediaConnection).toHaveBeenCalledWith('video', m.tx);
    await m.service.sync('image', [], fingerprint(), () => true);
    expect(m.rows()[1]).toMatchObject({ verified: false });
  });

  it('rejects an automatic ID owned by another kind and rolls back', async () => {
    const existing = profile({ kind: 'video', profileId: 'auto-image-73f95cf180a19624e4be9a71' });
    const m = memory([existing]);
    await expect(m.service.sync('image', [candidate()], fingerprint(), () => true)).rejects.toBeInstanceOf(ConflictException);
    expect(m.rows()).toEqual([existing]);
  });
});
