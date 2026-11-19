import sharp from 'sharp';
import { inspectReferenceImage } from './media-reference-image';
import { referenceFixture } from './media-reference.test-support';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';

const MAX_BYTES = 5 * 1024 * 1024;

describe('reference images (original bytes)', () => {
  it.each(['jpeg', 'webp'] as const)('fully inspects %s without changing the input bytes', async format => {
    const bytes = await referenceFixture(format);
    const original = Buffer.from(bytes);
    await expect(inspectReferenceImage(bytes, MAX_BYTES, `image/${format}`)).resolves.toEqual({
      mimeType: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : 'webp', width: 3, height: 2,
    });
    expect(bytes).toEqual(original);
  });

  it('continues validating PNG bytes and limits', async () => {
    await expect(inspectReferenceImage(MEDIA_MOCK_PNG, MAX_BYTES, 'image/png')).resolves.toMatchObject({
      mimeType: 'image/png', extension: 'png', width: 1, height: 1,
    });
    const corrupt = Buffer.from(MEDIA_MOCK_PNG); corrupt[corrupt.length - 1] ^= 1;
    await expect(inspectReferenceImage(corrupt, MAX_BYTES)).rejects.toMatchObject({ status: 400 });
    await expect(inspectReferenceImage(MEDIA_MOCK_PNG, 1)).rejects.toMatchObject({ status: 400 });
  });

  it.each(['jpeg', 'webp'] as const)('rejects MIME spoofing and corrupted %s pixels', async format => {
    const bytes = await referenceFixture(format);
    await expect(inspectReferenceImage(bytes, MAX_BYTES, 'image/png')).rejects.toMatchObject({ status: 400 });
    await expect(inspectReferenceImage(bytes.subarray(0, Math.floor(bytes.length / 2)), MAX_BYTES))
      .rejects.toMatchObject({ status: 400 });
    const corrupt = Buffer.from(bytes.subarray(0, Math.floor(bytes.length / 2)));
    // A matching RIFF length must not let a truncated WebP payload pass.
    if (format === 'webp') corrupt.writeUInt32LE(corrupt.length - 8, 4);
    await expect(inspectReferenceImage(corrupt, MAX_BYTES)).rejects.toMatchObject({ status: 400 });
  });

  it.each(['jpeg', 'webp'] as const)('rejects oversized %s dimensions before decoding pixels', async format => {
    const bytes = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } })
      .toFormat(format).toBuffer();
    await expect(inspectReferenceImage(bytes, MAX_BYTES)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects HEIC, GIF and arbitrary renamed files', async () => {
    for (const bytes of [Buffer.from('GIF89a'), Buffer.from('\0\0\0\x18ftypheic'), Buffer.from('not an image')]) {
      await expect(inspectReferenceImage(bytes, MAX_BYTES, 'image/png')).rejects.toMatchObject({ status: 400 });
    }
  });

  it('rejects animated WebP rather than silently selecting its first frame', async () => {
    const pixels = Buffer.alloc(3 * 4 * 3);
    pixels.fill(255, pixels.length / 2);
    const bytes = await sharp(pixels, { raw: { width: 3, height: 4, pageHeight: 2, channels: 3 } })
      .webp({ delay: [100, 100] }).toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    await expect(inspectReferenceImage(bytes, MAX_BYTES)).rejects.toMatchObject({ status: 400 });
  });

  it('bounds inspection work under a burst and releases capacity after completion', async () => {
    const bytes = await referenceFixture('jpeg');
    const results = await Promise.allSettled(Array.from({ length: 19 }, () => inspectReferenceImage(bytes, MAX_BYTES)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(18);
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 503, response: { error: { code: 'REFERENCE_INSPECTOR_BUSY' } } });
    await expect(inspectReferenceImage(bytes, MAX_BYTES)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  });
});
