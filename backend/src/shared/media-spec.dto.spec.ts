import {
  MediaImageSpecV3Schema, MediaSpecErrorSchema, MediaSpecMetadataV3Schema,
  MediaVideoRuntimeV3Schema, MediaVideoSpecV3Schema,
} from './media-spec.dto';

describe('negotiated media V3 specification contract', () => {
  it('preserves omission and explicit audio false without business defaults', () => {
    expect(MediaImageSpecV3Schema.parse({})).toEqual({});
    expect(MediaVideoSpecV3Schema.parse({ audio: false })).toEqual({ audio: false });
    expect(MediaSpecMetadataV3Schema.parse({ protocolVersion: 3, specRevision: 1 }))
      .toEqual({ protocolVersion: 3, specRevision: 1 });
  });

  it('accepts extensible values outside legacy product lists', () => {
    expect(MediaImageSpecV3Schema.parse({ size: '2048x3072', count: 7, quality: 'ultra' }))
      .toEqual({ size: '2048x3072', count: 7, quality: 'ultra' });
    expect(MediaVideoSpecV3Schema.safeParse({
      durationSeconds: 901, frameRate: 144, resolution: '2160p', outputFormat: 'video/av1',
    }).success).toBe(true);
  });

  it.each([
    { size: '1024x2048', width: 1024, height: 1024 },
    { width: 1080, height: 1920, aspectRatio: '16:9' },
    { width: 1024 },
  ])('rejects conflicting image dimensions: %j', value => {
    const result = MediaImageSpecV3Schema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: { code: 'SPEC_CONFLICT' } }),
    ]));
  });

  it('rejects conflicting video resolution and preserves equivalent ratios', () => {
    expect(MediaVideoSpecV3Schema.safeParse({ width: 1080, height: 1920, resolution: '720p' }).success).toBe(false);
    expect(MediaVideoSpecV3Schema.safeParse({ width: 1080, height: 1920, aspectRatio: '18:32', resolution: '1080p' }).success).toBe(true);
  });

  it.each([
    { count: 0 }, { count: Number.MAX_SAFE_INTEGER + 1 }, { quality: '' },
    { size: '100000000000000000000x1' }, { aspectRatio: '0:9' }, { apiKey: 'not-a-spec' },
    { width: 1.5, height: 2, aspectRatio: '1:2' },
    { width: 1, height: 2, aspectRatio: `${'9'.repeat(40)}:2` },
  ])('rejects invalid values and uncontrolled provider fields: %j', value => {
    expect(MediaImageSpecV3Schema.safeParse(value).success).toBe(false);
  });

  it('exposes unknown capability evidence without inventing defaults', () => {
    const runtime = MediaVideoRuntimeV3Schema.parse({
      protocolVersion: 3, status: 'ready', executionMode: 'real', executionAvailable: true,
      defaultProfileId: 'video', tools: ['video_generate', 'video_get_job'], profiles: [{
        profileId: 'video', configVersion: 'cfg_3', kind: 'video', displayName: 'Video',
        modelId: 'video-model', modelDisplayName: 'video-model',
        operations: ['text-to-video'], executionMode: 'async-query', authorized: true,
        adapter: { id: 'sub2api-video', version: '3', available: true, operations: ['text-to-video'],
          referenceSupport: { maxCount: 1, maxInputBytes: 10485760, mimeTypes: ['image/png'] },
          supportsTaskQuery: true, supportsCancel: false }, parameters: {}, constraints: [],
        referenceRules: [{ operation: 'text-to-video', minCount: 0, maxCount: 0, maxInputBytes: 0, mimeTypes: [] }],
        unavailableReason: null, unavailableMessage: null,
      }],
    });
    expect(runtime.profiles[0].parameters).toEqual({});
    expect(JSON.stringify(runtime)).not.toContain('defaults');
    expect(MediaVideoRuntimeV3Schema.safeParse({ ...runtime, profiles: [], defaultProfileId: null }).success).toBe(false);
    expect(MediaVideoRuntimeV3Schema.safeParse({ ...runtime, status: 'unavailable', executionAvailable: false, tools: [] }).success).toBe(false);
    expect(MediaVideoRuntimeV3Schema.safeParse({ ...runtime, defaultProfileId: 'video.v3',
      profiles: [{ ...runtime.profiles[0], profileId: 'video.v3', configVersion: 'cfg.v3' }] }).success).toBe(true);
  });

  it('requires explicit unknown billing and submission state in error envelopes', () => {
    expect(MediaSpecErrorSchema.parse({ code: 'SUBMISSION_UNKNOWN', message: '查询原请求', source: 'upstream',
      stage: 'submit', retryable: true, submissionState: 'unknown', billingState: 'reconciling' }))
      .toMatchObject({ submissionState: 'unknown', billingState: 'reconciling' });
  });
});
