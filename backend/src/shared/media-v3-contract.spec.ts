import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MediaRealQuoteRequestV3Schema } from './media-real.dto';
import { MediaVideoGatewayQuoteRequestV3Schema } from './media-video.dto';
import { MediaImageSpecV3Schema, MediaRuntimeV3Schema, MediaVideoRuntimeV3Schema, MediaVideoSpecV3Schema } from './media-spec.dto';

describe('shared media V3 client/server fixture', () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/media-v3-contract.json'), 'utf8'));

  it('parses image and video quote requests without changing execution fields', () => {
    expect(MediaRealQuoteRequestV3Schema.parse(fixture.imageQuoteRequest)).toEqual(fixture.imageQuoteRequest);
    expect(MediaVideoGatewayQuoteRequestV3Schema.parse(fixture.videoQuoteRequest)).toEqual(fixture.videoQuoteRequest);
  });

  it('keeps omitted specs and explicit false available for negotiation', () => {
    expect(MediaImageSpecV3Schema.parse(fixture.omittedImageSpec)).toEqual({});
    expect(MediaVideoSpecV3Schema.parse(fixture.omittedVideoSpec)).toEqual({ audio: false });
  });

  it('parses the client runtime handoff example using the same strict response contract', () => {
    const runtime = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/client-media-runtime-v3.json'), 'utf8'));
    expect(MediaRuntimeV3Schema.parse(runtime.runtime.media)).toEqual(runtime.runtime.media);
    expect(MediaVideoRuntimeV3Schema.parse(runtime.runtime.video)).toEqual(runtime.runtime.video);
    expect(runtime.runtime.video.profiles[0]).not.toHaveProperty('capabilityHints');
  });
});
