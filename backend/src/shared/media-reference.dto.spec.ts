import { MediaCapabilitiesSchema } from './media.dto';
import { MediaRealQuoteRequestV3Schema } from './media-real.dto';
import { MediaVideoGatewayQuoteRequestV3Schema } from './media-video.dto';
import { MAX_MEDIA_REFERENCE_COUNT } from './media-reference.dto';

describe('configurable media references', () => {
  const common = { protocolVersion: 3, specRevision: 1, profileId: 'multi-image', configVersion: 'cfg_1', creativeBrief: 'Product views' };
  it('preserves the old image default and supports configured limits above four', () => {
    expect(MediaCapabilitiesSchema.parse({ sizes: ['1024x1024'] }).maxReferenceCount).toBe(4);
    expect(MediaCapabilitiesSchema.parse({ sizes: ['1024x1024'], maxReferenceCount: 8 }).maxReferenceCount).toBe(8);
    expect(MediaCapabilitiesSchema.safeParse({ sizes: ['1024x1024'], maxReferenceCount: MAX_MEDIA_REFERENCE_COUNT + 1 }).success).toBe(false);
  });
  it.each(['image', 'video'])('accepts multiple unique V3 %s references within the system bound', kind => {
    const schema = kind === 'image' ? MediaRealQuoteRequestV3Schema : MediaVideoGatewayQuoteRequestV3Schema;
    const input = { ...common, operation: kind === 'image' ? 'edit' : 'image-to-video',
      requestedSpec: kind === 'image' ? { size: '1024x1024', count: 1, quality: 'medium' } : { durationSeconds: 4, resolution: '720p' },
      referenceIds: Array.from({ length: 8 }, (_, i) => `reference-${i}`) };
    expect(schema.safeParse(input).success).toBe(true);
    for (const referenceIds of [[], ['duplicate', 'duplicate'], Array.from({ length: MAX_MEDIA_REFERENCE_COUNT + 1 }, (_, i) => `ref-${i}`)]) {
      expect(schema.safeParse({ ...input, referenceIds }).success).toBe(false);
    }
  });
});
