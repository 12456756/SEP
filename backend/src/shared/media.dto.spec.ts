import {
  CreateMediaProfileDtoSchema,
  MediaPolicyPreviewSchema,
  MediaRuntimeQuerySchema,
  MediaRuntimeSchema,
  MediaRuntimeV2Schema,
  UpdateMediaConnectionDtoSchema,
  UpdateMediaProfileDtoSchema,
} from './media.dto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const profile = {
  profileId: 'product-image', kind: 'image', displayName: '商品图片',
  modelId: 'test-image-model', operations: ['generate'], executionMode: 'sync-response',
  capabilities: { sizes: ['1024x1024'] },
};

describe('media configuration schemas', () => {
  it('accepts image quality suggestions and bounded reference counts, rejecting invalid settings', () => {
    const capabilities = { sizes: ['1024x1024'], maxOutputs: 2, supportsReferenceImage: true,
      qualities: ['auto', 'high'], maxReferenceCount: 2 };
    expect(CreateMediaProfileDtoSchema.parse({ ...profile, capabilities }).capabilities).toEqual(capabilities);
    for (const extra of [{ qualities: [''] }, { qualities: ['x'.repeat(129)] },
      { maxReferenceCount: -1 }, { maxReferenceCount: 33 }, { maxReferenceCount: 1.5 }, { maxOutputs: 5 }]) {
      expect(CreateMediaProfileDtoSchema.safeParse({ ...profile, capabilities: { ...capabilities, ...extra } }).success).toBe(false);
      expect(UpdateMediaProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1', capabilities: extra }).success).toBe(false);
    }
  });
  it('keeps client fixtures synchronized with the runtime schema', () => {
    const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures/media-runtime-v1.json'), 'utf8'));
    for (const fixture of fixtures) {
      const parsed = MediaRuntimeSchema.parse(fixture.media);
      expect(parsed).toEqual(fixture.media);
      expect(parsed.executionAvailable).toBe(false);
      expect(parsed.tools).toEqual([]);
      for (const profile of parsed.profiles) expect(profile).not.toHaveProperty('modelId');
    }
  });
  it('validates strict v2 quality fields and available defaults without exposing model IDs', () => {
    const wire = JSON.parse(readFileSync(join(__dirname, 'fixtures/media-runtime-v2.json'), 'utf8'));
    expect(MediaRuntimeV2Schema.parse(wire.media)).toEqual(wire.media);
    const runtime = MediaRuntimeV2Schema.parse({ protocolVersion: 2, executionAvailable: true,
      defaultProfileId: 'product-image', tools: [], profiles: [{ profileId: 'product-image', kind: 'image',
        displayName: 'Product image', configVersion: 'cfg_1', operations: ['generate'], executionMode: 'sync-response',
        capabilities: { supportsReferenceImage: false, maxOutputs: 1, sizes: ['1024x1024'], maxWidth: 1024,
          maxHeight: 1024, qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', defaultSize: '1024x1024' } }] });
    expect(runtime.profiles[0]).not.toHaveProperty('modelId');
    expect(MediaRuntimeV2Schema.safeParse({ ...runtime, extra: true }).success).toBe(false);
    expect(MediaRuntimeV2Schema.safeParse({ ...runtime, profiles: [{ ...runtime.profiles[0], capabilities: {
      ...runtime.profiles[0].capabilities, defaultSize: '1536x1024' } }] }).success).toBe(false);
  });
  it('requires at least one explicit size and defaults only known capabilities', () => {
    expect(CreateMediaProfileDtoSchema.parse(profile).capabilities).toEqual({
      sizes: ['1024x1024'], supportsReferenceImage: false, maxOutputs: 1, maxReferenceCount: 4,
    });
    for (const capabilities of [{}, { sizes: [] }, { sizes: ['auto'] }, { sizes: ['0x1024'] }]) {
      expect(CreateMediaProfileDtoSchema.safeParse({ ...profile, capabilities }).success).toBe(false);
    }
  });

  it('forbids video, arbitrary parameters and client-supplied verification/version', () => {
    for (const extra of [{ kind: 'video' }, { verified: true }, { configVersion: 'fake' }, { apiKey: 'fake' }]) {
      expect(CreateMediaProfileDtoSchema.safeParse({ ...profile, ...extra }).success).toBe(false);
    }
  });

  it('requires reference-image capability for editing', () => {
    expect(CreateMediaProfileDtoSchema.safeParse({ ...profile, operations: ['edit'] }).success).toBe(false);
    expect(CreateMediaProfileDtoSchema.safeParse({
      ...profile, operations: ['edit'], capabilities: { sizes: ['1024x1024'], supportsReferenceImage: true },
    }).success).toBe(true);
  });

  it('requires an expected version and at least one changed field', () => {
    expect(UpdateMediaProfileDtoSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(UpdateMediaProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1' }).success).toBe(false);
    expect(UpdateMediaProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1', enabled: true }).success).toBe(true);
    expect(UpdateMediaProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_1', verified: true }).success).toBe(false);
  });

  it('accepts only credential-free HTTP(S) connection addresses', () => {
    expect(UpdateMediaConnectionDtoSchema.safeParse({ baseUrl: 'https://relay.example/v1', apiKey: '' }).success).toBe(true);
    for (const baseUrl of ['not-a-url', 'file:///tmp/image', 'https://user:password@relay.example/v1', 'https://relay.example/?key=fake', 'https://relay.example/#key']) {
      expect(UpdateMediaConnectionDtoSchema.safeParse({ baseUrl }).success).toBe(false);
    }
  });

  it('parses optional protocol negotiation without accepting malformed query values', () => {
    expect(MediaRuntimeQuerySchema.parse({})).toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3 });
    expect(MediaRuntimeQuerySchema.parse({ mediaProtocolVersion: '3' })).toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3 });
    for (const mediaProtocolVersion of ['bad', '', '0', '1.5', ['1', '2']]) {
      expect(MediaRuntimeQuerySchema.safeParse({ mediaProtocolVersion }).success).toBe(false);
    }
  });

  it('negotiates artifact and media protocol versions independently', () => {
    expect(MediaRuntimeQuerySchema.parse({ skillArtifactProtocolVersion: '1' })).toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3, skillArtifactProtocolVersion: 1 });
    expect(MediaRuntimeQuerySchema.parse({ mediaProtocolVersion: '3', skillArtifactProtocolVersion: '2' }))
      .toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3, skillArtifactProtocolVersion: 2 });
    expect(MediaRuntimeQuerySchema.parse({ skillArtifactProtocolVersion: '99' })).toEqual({ mediaProtocolVersion: 3, videoProtocolVersion: 3, skillArtifactProtocolVersion: 99 });
  });

  it.each(['mediaProtocolVersion', 'skillArtifactProtocolVersion'])('rejects malformed %s even alongside valid other negotiation', (field) => {
    const other = field === 'mediaProtocolVersion' ? 'skillArtifactProtocolVersion' : 'mediaProtocolVersion';
    for (const value of ['bad', '', '0', '-1', '1.5', 'Infinity', ['1', '2'], { version: '1' }]) {
      expect(MediaRuntimeQuerySchema.safeParse({ [field]: value }).success).toBe(false);
      expect(MediaRuntimeQuerySchema.safeParse({ [field]: value, [other]: '1' }).success).toBe(false);
    }
  });

  it('rejects unknown runtime query fields instead of silently accepting client secrets', () => {
    for (const extra of [{ apiKey: 'mock-secret' }, { protocolVersion: '1' }, { skillArtifactVersion: '1' }]) {
      expect(MediaRuntimeQuerySchema.safeParse({ mediaProtocolVersion: '3', skillArtifactProtocolVersion: '1', ...extra }).success).toBe(false);
    }
  });

  it('accepts the full image admin preview profile budget', () => {
    const profile = { profileId: 'profile-1', configVersion: null, status: 'unavailable', effectiveProfile: null, reasons: ['profile-missing'] };
    expect(MediaPolicyPreviewSchema.safeParse({ protocolVersion: 2, executionMode: 'disabled', configured: false,
      executionAvailable: false, defaultProfileId: null, defaultProfileValid: false,
      profiles: Array.from({ length: 200 }, (_, index) => ({ ...profile, profileId: `profile-${index + 1}` })),
    }).success).toBe(true);
  });
});
