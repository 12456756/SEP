import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaVideoPolicyPreviewSchema } from 'shared/media-video-config.dto';
import fixture from '../../../../backend/test/fixtures/client-media-runtime-v3.json';
import { MediaPolicyPreview } from './media-policy-preview';

afterEach(cleanup);

function preview(effectiveProfile: unknown) {
  const profile = fixture.runtime.video.profiles[0];
  return MediaVideoPolicyPreviewSchema.parse({ protocolVersion: 3, executionMode: 'real', configured: true,
    executionAvailable: true, defaultProfileId: profile.profileId, defaultProfileValid: true,
    profiles: [{ profileId: profile.profileId, configVersion: profile.configVersion, status: 'effective',
      effectiveProfile, reasons: [] }] });
}

describe('V3 media authorization preview', () => {
  it('renders the new shared parameter contract including false and unsupported fields', () => {
    const profile = fixture.runtime.video.profiles[0];
    const parameters = { ...profile.parameters,
      audio: { label: '声音', type: 'boolean', support: 'supported', required: false, operations: profile.operations,
        valuesMode: 'suggested', values: [false, true], source: 'profile-config', confidence: 'declared', observedAt: null },
      frameRate: { label: '帧率', type: 'number', support: 'unsupported', required: false, operations: profile.operations,
        valuesMode: 'unknown', source: 'adapter', confidence: 'verified', observedAt: null } };
    render(<MediaPolicyPreview preview={preview({ ...profile, parameters })} />);
    const result = screen.getByLabelText('授权预览结果');
    expect(result).not.toHaveTextContent('V3 Profile 信息无效');
    expect(result).toHaveTextContent('durationSeconds: 4 / 8');
    expect(result).toHaveTextContent('audio: false / true');
    expect(result).toHaveTextContent('frameRate: 不支持');
    expect(result).toHaveTextContent('sub2api-video');
  });

  it('identifies invalid V3 metadata instead of silently treating it as an empty configuration', () => {
    render(<MediaPolicyPreview preview={preview({ ...fixture.runtime.video.profiles[0], parameters: null })} />);
    expect(screen.getByLabelText('授权预览结果')).toHaveTextContent('V3 Profile 信息无效');
  });
});
