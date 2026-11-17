import { MediaProfileSchema, MediaVideoProfileSchema, validateMediaParameterConstraints } from 'shared';
import { imageRuntimeCapabilities, imageRuntimePolicy, mediaRuntimeStatus, videoRuntimeCapabilities, videoRuntimePolicy } from './media-runtime-capabilities';
import fixture from '../../shared/fixtures/media-video-v1.json';

describe('effective runtime capabilities', () => {
  it('publishes an explicit continuous video duration range without treating endpoint suggestions as an enum', () => {
    const profile = MediaVideoProfileSchema.parse({ ...fixture.profile,
      capabilities: { ...fixture.profile.capabilities, durationsSeconds: [4, 10], durationRange: { minimum: 4, maximum: 10 } } });
    const result = videoRuntimeCapabilities(profile, profile.operations);
    expect(result.parameters.durationSeconds).toMatchObject({ minimum: 4, maximum: 10, step: 1,
      valuesMode: 'unknown', source: 'profile-config', confidence: 'declared' });
    expect(result.parameters.durationSeconds).not.toHaveProperty('values');
    expect(result.parameters.frameRate.support).toBe('unsupported');
  });
  it('reads image output and reference limits plus quality suggestions from the profile', () => {
    const profile = MediaProfileSchema.parse({ profileId: 'image-limited', kind: 'image', modelId: 'image-model', displayName: 'Image',
      configVersion: '1', operations: ['generate', 'edit'], executionMode: 'sync-response', enabled: true, verified: true,
      capabilities: { sizes: ['1024x1024'], maxOutputs: 2, supportsReferenceImage: true,
        qualities: ['auto', 'high'], maxReferenceCount: 2 } });
    const result = imageRuntimeCapabilities(profile, profile.operations);
    expect(result.parameters.count).toMatchObject({ minimum: 1, maximum: 2 });
    expect(result.parameters.quality).toMatchObject({ values: ['auto', 'high'], valuesMode: 'suggested' });
    expect(result.referenceSupport.maxCount).toBe(2);
    expect(result.referenceRules).toContainEqual({ operation: 'edit', minCount: 1, maxCount: 2,
      maxInputBytes: 5242880, mimeTypes: ['image/png'] });
  });
  it('publishes adapter limits without turning profile suggestions into fixed options', () => {
    const profile = MediaProfileSchema.parse({ profileId: 'image-test', kind: 'image', modelId: 'future-image', displayName: '图片',
      configVersion: '1', operations: ['generate', 'edit'], executionMode: 'sync-response', enabled: true, verified: true,
      capabilities: { sizes: ['2048x3072'], maxOutputs: 8, supportsReferenceImage: true } });
    const result = imageRuntimeCapabilities(profile, profile.operations);
    expect(result.parameters.count).toMatchObject({ maximum: 4, required: true });
    expect(result.parameters.size).toMatchObject({ valuesMode: 'suggested', values: ['2048x3072'] });
    expect(result.parameters.quality).not.toHaveProperty('default');
    expect(result.referenceRules).toEqual([
      { operation: 'generate', minCount: 0, maxCount: 0, maxInputBytes: 0, mimeTypes: [] },
      { operation: 'edit', minCount: 1, maxCount: 4, maxInputBytes: 5242880, mimeTypes: ['image/png'] },
    ]);
    expect(validateMediaParameterConstraints({ width: 2048, height: 3072 }, 'generate', result.constraints)).toEqual([]);
    expect(validateMediaParameterConstraints({ width: 2048 }, 'generate', result.constraints)).toHaveLength(2);
  });
  it('uses per-operation references, the profile byte limit, MP4 only, and no selectable fps', () => {
    const profile = MediaVideoProfileSchema.parse({ ...fixture.profile, operations: ['text-to-video', 'image-to-video'],
      capabilities: { ...fixture.profile.capabilities, supportsTextToVideo: true, maxInputBytes: 4096, outputFormats: ['video/mp4', 'video/webm'] } });
    const result = videoRuntimeCapabilities(profile, profile.operations);
    expect(result.referenceSupport).toEqual({ maxCount: 1, maxInputBytes: 4096, mimeTypes: ['image/png'] });
    expect(result.referenceRules).toContainEqual({ operation: 'text-to-video', minCount: 0, maxCount: 0, maxInputBytes: 0, mimeTypes: [] });
    expect(result.parameters.outputFormat).toMatchObject({ valuesMode: 'allowed', values: ['video/mp4'] });
    expect(result.parameters.frameRate.support).toBe('unsupported');
    expect(result.parameters.durationSeconds).toMatchObject({ valuesMode: 'suggested', values: fixture.profile.capabilities.durationsSeconds });
    const textOnly = videoRuntimeCapabilities(profile, ['text-to-video']);
    expect(textOnly.referenceSupport).toEqual({ maxCount: 0, maxInputBytes: 0, mimeTypes: [] });
  });
  it('rejects malformed current authorizations without treating retired limits as grants', () => {
    expect(imageRuntimePolicy({ enabledProfileIds: ['image-test'], maxWidth: -1 }).enabledProfileIds).toEqual(['image-test']);
    expect(() => imageRuntimePolicy({ enabledProfileIds: 'bad' })).toThrow();
    expect(() => videoRuntimePolicy({ video: { enabledProfileIds: 'bad' } })).toThrow();
    expect(() => videoRuntimePolicy('bad')).toThrow();
    expect(videoRuntimePolicy(null).enabledProfileIds).toEqual([]);
  });
  it.each([[0, false, false, 'empty'], [1, false, false, 'disabled'], [1, true, false, 'unavailable'], [1, true, true, 'ready']] as const)
  ('distinguishes empty, disabled, unavailable and ready (%s, %s, %s)', (count, enabled, available, expected) => {
    expect(mediaRuntimeStatus(count, enabled, available)).toBe(expected);
  });
});
