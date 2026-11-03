import {
  SkillImportCandidateSchema,
  SkillImportEventSchema,
  SkillImportSelectionSchema,
  SkillImportSessionCreateSchema,
  SkillImportRelativePathSchema,
  SkillImportChallengeSchema,
  SkillImportPreviewResultSchema,
  SkillImportDeviceQuerySchema,
  SkillImportDevicesResponseSchema,
} from './skill-import-schema';

describe('skill import schemas', () => {
  it('accepts the versioned session and selection contracts', () => {
    expect(SkillImportSessionCreateSchema.parse({ requestId: 'r1', protocolVersion: 1, scope: 'user' })).toEqual({
      requestId: 'r1', protocolVersion: 1, scope: 'user',
    });
    expect(SkillImportSelectionSchema.parse({ candidateId: 'c1', snapshotId: 's1', operationId: 'o1' })).toEqual({
      candidateId: 'c1', snapshotId: 's1', operationId: 'o1',
    });
  });

  it('rejects unknown fields and invalid hashes', () => {
    expect(() => SkillImportSessionCreateSchema.parse({ requestId: 'r1', protocolVersion: 1, extra: true })).toThrow();
    expect(() => SkillImportCandidateSchema.parse({
      candidateId: 'c1', revision: 1, name: 'demo', description: null, sources: ['codex'], scope: 'user',
      locations: [{ rootId: 'r', rootLabel: 'Home', relativePath: 'demo' }], treeHash: 'bad', availability: 'previewable', warnings: [],
    })).toThrow();
  });

  it('bounds event payload through its runtime shape', () => {
    expect(SkillImportEventSchema.parse({ eventId: 'e1', commandId: null, sequence: 1, type: 'progress', payload: { phase: 'scanning', completed: 1 } }).payload).toEqual({ phase: 'scanning', completed: 1 });
    expect(() => SkillImportEventSchema.parse({ eventId: 'e1', commandId: null, sequence: 1, type: 'progress', payload: { arbitrary: 'code' } })).toThrow();
  });

  it.each(['/etc/passwd', '../secrets', 'a/../secrets', 'C:/users', 'C:\\users', 'a//b', './SKILL.md', 'a\u0000b'])('rejects unsafe relative paths: %s', (path) => {
    expect(SkillImportRelativePathSchema.safeParse(path).success).toBe(false);
  });

  it('requires exactly one challenge target and forbids session context for revoke', () => {
    expect(SkillImportChallengeSchema.safeParse({ purpose: 'session-grant', sessionId: 's', pairingId: 'p', deviceId: 'd' }).success).toBe(false);
    expect(SkillImportChallengeSchema.safeParse({ purpose: 'device-revoke', sessionId: 's', deviceId: 'd' }).success).toBe(false);
    expect(SkillImportChallengeSchema.safeParse({ purpose: 'device-revoke', deviceId: 'd' }).success).toBe(true);
  });

  it('validates bounded device pagination and requires an explicit next cursor', () => {
    expect(SkillImportDeviceQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(SkillImportDeviceQuerySchema.parse({ limit: '100', cursor: 'device-id' })).toEqual({ limit: 100, cursor: 'device-id' });
    for (const query of [{ limit: '101' }, { limit: '0' }, { cursor: '/foreign/path' }, { unexpected: 'value' }]) expect(SkillImportDeviceQuerySchema.safeParse(query).success).toBe(false);
    expect(SkillImportDevicesResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(SkillImportDevicesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('uses UTF-8 bytes for the preview content limit and bounds file batches', () => {
    const preview = { requestId: 'r', candidateId: 'c', snapshotId: 's', expiresAt: new Date().toISOString(), content: '好'.repeat(700000), treeHash: 'a'.repeat(64), fileCount: 1, totalUncompressedBytes: 1, estimatedPackageBytes: 1, files: [], nextFilesCursor: null, warnings: [] };
    expect(SkillImportPreviewResultSchema.safeParse(preview).success).toBe(false);
    expect(SkillImportPreviewResultSchema.safeParse({ ...preview, content: '# Skill', files: Array.from({ length: 101 }, () => ({ relativePath: 'SKILL.md', bytes: 1 })) }).success).toBe(false);
  });
});
