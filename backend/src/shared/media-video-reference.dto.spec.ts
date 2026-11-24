import { MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayQuoteRequestV3Schema, MediaVideoProfileSchema } from './media-video.dto';
import { MediaVideoInputReferenceSchema } from './media-video-real.dto';
import { VIDEO_INPUT_MAX_BYTES } from './media-runtime-parameters';
import fixture from './fixtures/media-video-v1.json';

const request = { protocolVersion: 3, specRevision: 1, profileId: 'seedance', configVersion: 'cfg_1',
  operation: 'video-to-video', creativeBrief: 'Change the scene', referenceIds: [], videoReferenceIds: ['video-1'],
  requestedSpec: { durationSeconds: 5, resolution: '720p', audio: false } };
describe('video reference contracts', () => {
  it('accepts multiple videos and preserves explicit false', () => {
    expect(MediaVideoGatewayQuoteRequestV3Schema.parse({ ...request, videoReferenceIds: ['a', 'b', 'c'] })).toMatchObject({
      requestedSpec: { audio: false }, videoReferenceIds: ['a', 'b', 'c'],
    });
  });
  it.each([
    { videoReferenceIds: [] }, { videoReferenceIds: ['same', 'same'] }, { referenceIds: ['image'] },
    { videoReferenceIds: Array.from({ length: 11 }, (_, i) => `v-${i}`) },
    { operation: 'text-to-video' }, { operation: 'image-to-video', referenceIds: ['image'] },
    { audioReferenceIds: ['audio'] }, { requestedSpec: { durationSeconds: -1 } },
  ])('rejects invalid operation/material combinations: %j', patch => {
    expect(MediaVideoGatewayQuoteRequestV3Schema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it('keeps new execution out of legacy requests and leaves old V3 hashes normalizable', () => {
    expect(MediaVideoGatewayQuoteRequestSchema.safeParse(request).success).toBe(false);
    const old = MediaVideoGatewayQuoteRequestV3Schema.parse({ ...request, operation: 'text-to-video', videoReferenceIds: undefined });
    expect(old.videoReferenceIds).toBeUndefined();
    expect(MediaVideoProfileSchema.parse(fixture.profile).capabilities.supportsVideoToVideo).toBeUndefined();
  });
  it('requires explicit profile input limits and bounds the 90 MiB contract', () => {
    const profile = { ...fixture.profile, operations: ['video-to-video'], capabilities: {
      ...fixture.profile.capabilities, supportsVideoToVideo: true, maxVideoReferenceCount: 3,
      maxVideoReferenceBytes: VIDEO_INPUT_MAX_BYTES, videoReferenceMimeTypes: ['video/mp4', 'video/quicktime'],
    } };
    expect(MediaVideoProfileSchema.safeParse(profile).success).toBe(true);
    for (const patch of [{ maxVideoReferenceCount: 0 }, { maxVideoReferenceCount: 11 },
      { maxVideoReferenceBytes: VIDEO_INPUT_MAX_BYTES + 1 }, { videoReferenceMimeTypes: ['audio/mpeg'] }]) {
      expect(MediaVideoProfileSchema.safeParse({ ...profile, capabilities: { ...profile.capabilities, ...patch } }).success).toBe(false);
    }
    const reference = { mock: false, kind: 'video', referenceId: 'sep-video-1', profileId: 'seedance', configVersion: 'cfg_1',
      mimeType: 'video/mp4', byteLength: VIDEO_INPUT_MAX_BYTES, sha256: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00Z' };
    expect(MediaVideoInputReferenceSchema.safeParse(reference).success).toBe(true);
    expect(MediaVideoInputReferenceSchema.safeParse({ ...reference, byteLength: VIDEO_INPUT_MAX_BYTES + 1 }).success).toBe(false);
  });
});
