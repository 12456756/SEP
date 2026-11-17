import {
  CreateMediaVideoProfileDtoSchema, MediaVideoPolicySchema, UpdateMediaVideoPolicyDtoSchema,
  MediaVideoPolicyPreviewSchema, UpdateMediaVideoProfileDtoSchema, VerifyMediaVideoProfileDtoSchema,
} from './media-video-config.dto';
import { MediaPolicySchema, MediaRuntimeQuerySchema } from './media.dto';
import fixture from './fixtures/media-video-v1.json';

describe('video configuration v1 boundary', () => {
  const create = () => {
    const { configVersion: _version, verified: _verified, ...input } = fixture.profile;
    return { ...input, enabled: false };
  };

  it('imports only the video business contract, without verification or connection credentials', () => {
    expect(CreateMediaVideoProfileDtoSchema.parse(create())).toMatchObject({ kind: 'video', enabled: false });
    for (const change of [{ kind: 'image' }, { verified: true }, { apiKey: 'synthetic' }, { baseUrl: 'https://invalid.example' }, { vendorPayload: {} }]) {
      expect(CreateMediaVideoProfileDtoSchema.safeParse({ ...create(), ...change }).success).toBe(false);
    }
  });

  it('requires an expected version on changes and excludes client-authored verification', () => {
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_v1' }).success).toBe(false);
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_v1', verified: true }).success).toBe(false);
    expect(VerifyMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_v1', execute: true }).success).toBe(false);
    expect(UpdateMediaVideoProfileDtoSchema.parse({ expectedConfigVersion: 'cfg_v1', enabled: false }).enabled).toBe(false);
  });

  it('validates positive integer video duration bounds on create and partial updates', () => {
    const durationRange = { minimum: 4, maximum: 10 };
    expect(CreateMediaVideoProfileDtoSchema.parse({ ...create(), capabilities: { ...create().capabilities, durationRange } })
      .capabilities.durationRange).toEqual(durationRange);
    for (const range of [{ minimum: 0, maximum: 10 }, { minimum: 4.5, maximum: 10 },
      { minimum: 10, maximum: 4 }, { minimum: 4 }, { maximum: 10 }, { minimum: 4, maximum: Infinity }]) {
      expect(CreateMediaVideoProfileDtoSchema.safeParse({ ...create(), capabilities: { ...create().capabilities, durationRange: range } }).success).toBe(false);
      expect(UpdateMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1', capabilities: { durationRange: range } }).success).toBe(false);
    }
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1', capabilities: {
      durationRange: { minimum: 5, maximum: 5 },
    } }).success).toBe(true);
  });

  it('defaults to no video grants, independently from existing image grants', () => {
    const image = { enabledProfileIds: ['product-image'], defaultProfileId: 'product-image' };
    const policy = MediaPolicySchema.parse({ ...image, video: { enabledProfileIds: ['video-a'], defaultProfileId: 'video-a' } });
    expect(policy.enabledProfileIds).toEqual(['product-image']);
    expect(policy.video?.enabledProfileIds).toEqual(['video-a']);
    expect(MediaVideoPolicySchema.parse({}).enabledProfileIds).toEqual([]);
    expect(MediaPolicySchema.parse(image)).not.toHaveProperty('video');
  });

  it.each([
    { maxDurationSeconds: 0 }, { maxConcurrentJobs: 0 },
    { periodBudget: -1 }, { periodBudget: Infinity }, { allowedAspectRatios: ['0:0'] },
    { allowedOperations: ['generate'] }, { apiKey: 'synthetic' },
  ])('rejects unsupported enterprise policy input %j', change => {
    expect(UpdateMediaVideoPolicyDtoSchema.safeParse(change).success).toBe(false);
  });

  it('preserves open-ended authorization values for runtime preflight', () => {
    expect(UpdateMediaVideoPolicyDtoSchema.parse({ maxDurationSeconds: 601, maxConcurrentJobs: Number.MAX_SAFE_INTEGER, maxResolution: '8k', allowedOperations: [] }))
      .toEqual({ maxDurationSeconds: 601, maxConcurrentJobs: Number.MAX_SAFE_INTEGER, maxResolution: '8k', allowedOperations: [] });
  });

  it('negotiates video independently while keeping old query inputs valid', () => {
    expect(MediaRuntimeQuerySchema.parse({})).toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3 });
    expect(MediaRuntimeQuerySchema.parse({ mediaProtocolVersion: '3', skillArtifactProtocolVersion: '1', videoProtocolVersion: '3' }))
      .toEqual({ mediaProtocolVersion: 3, skillArtifactProtocolVersion: 1, videoProtocolVersion: 3 });
    expect(MediaRuntimeQuerySchema.safeParse({ videoProtocolVersion: 'bad' }).success).toBe(false);
    expect(MediaRuntimeQuerySchema.safeParse({ videoProtocolVersion: '1', provider: 'upstream' }).success).toBe(false);
  });

  it('accepts the full video admin preview profile budget', () => {
    const profile = { profileId: 'video-profile-1', configVersion: null, status: 'unavailable', effectiveProfile: null, reasons: ['profile-missing'] };
    expect(MediaVideoPolicyPreviewSchema.safeParse({ protocolVersion: 2, executionMode: 'disabled', configured: false,
      executionAvailable: false, defaultProfileId: null, defaultProfileValid: false,
      profiles: Array.from({ length: 128 }, (_, index) => ({ ...profile, profileId: `video-profile-${index + 1}` })),
    }).success).toBe(true);
  });
});
