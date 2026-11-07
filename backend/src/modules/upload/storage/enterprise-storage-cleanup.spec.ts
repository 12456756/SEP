import { OssStorageDriver } from './oss-storage.driver';

describe('OssStorageDriver.deletePrefix', () => {
  let driver: OssStorageDriver;
  let listV2: jest.Mock;
  let deleteMulti: jest.Mock;

  beforeEach(() => {
    driver = new OssStorageDriver({
      region: 'oss-test',
      accessKeyId: 'test-id',
      accessKeySecret: 'test-secret',
      bucket: 'test-bucket',
    });
    listV2 = jest.fn();
    deleteMulti = jest.fn().mockResolvedValue({});
    const client = (driver as unknown as { client: Record<string, unknown> }).client;
    client.listV2 = listV2;
    client.deleteMulti = deleteMulti;
  });

  it('follows continuation tokens and deletes only keys under the exact prefix', async () => {
    listV2
      .mockResolvedValueOnce({
        objects: [{ name: 'ent-a/a.txt' }, { name: 'ent-a2/keep.txt' }],
        isTruncated: true,
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        objects: [{ name: 'ent-a/sub/b.txt' }],
        isTruncated: false,
        nextContinuationToken: '',
      });

    await driver.deletePrefix('ent-a/');

    expect(listV2).toHaveBeenNthCalledWith(1, { prefix: 'ent-a/', 'max-keys': 1000 });
    expect(listV2).toHaveBeenNthCalledWith(2, {
      prefix: 'ent-a/',
      'max-keys': 1000,
      'continuation-token': 'page-2',
    });
    expect(deleteMulti).toHaveBeenNthCalledWith(1, ['ent-a/a.txt'], { quiet: true });
    expect(deleteMulti).toHaveBeenNthCalledWith(2, ['ent-a/sub/b.txt'], { quiet: true });
  });

  it('retries a failed batch and propagates after the retry limit', async () => {
    listV2.mockResolvedValue({
      objects: [{ name: 'ent-a/a.txt' }],
      isTruncated: false,
      nextContinuationToken: '',
    });
    deleteMulti
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({});

    await expect(driver.deletePrefix('ent-a/')).resolves.toBeUndefined();
    expect(deleteMulti).toHaveBeenCalledTimes(2);

    deleteMulti.mockReset().mockRejectedValue(new Error('persistent'));
    await expect(driver.deletePrefix('ent-a/')).rejects.toThrow('persistent');
    expect(deleteMulti).toHaveBeenCalledTimes(3);
  });
});
