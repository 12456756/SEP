import sharp from 'sharp';

export async function referenceFixture(format: 'jpeg' | 'webp') {
  return sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 25, g: 140, b: 80 } } })
    .toFormat(format).toBuffer();
}
