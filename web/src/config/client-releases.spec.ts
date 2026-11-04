import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_RELEASE_URL,
  ClientReleaseSchema,
  fetchClientRelease,
} from './client-releases';

const release = {
  version: '0.4.2',
  artifacts: [
    {
      platform: 'macos-arm64',
      label: 'macOS · Apple 芯片',
      fileName: 'SEP-Client-0.4.2-mac-arm64.dmg',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-mac-arm64.dmg',
      architecture: 'ARM64',
      minimumOsVersion: 'macOS 12 或更高版本',
    },
    {
      platform: 'macos-x64',
      label: 'macOS · Intel 芯片',
      fileName: 'SEP-Client-0.4.2-mac-x64.dmg',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-mac-x64.dmg',
      architecture: 'x64',
      minimumOsVersion: 'macOS 12 或更高版本',
    },
    {
      platform: 'windows-x64',
      label: 'Windows · 64 位',
      fileName: 'SEP-Client-0.4.2-win-x64.exe',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-win-x64.exe',
      architecture: 'x64',
      minimumOsVersion: 'Windows 10 64 位或更高版本',
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('client release configuration', () => {
  it('accepts the three supported client platforms', () => {
    expect(ClientReleaseSchema.parse(release)).toEqual(release);
  });

  it('rejects duplicate platforms and non-official download URLs', () => {
    expect(() =>
      ClientReleaseSchema.parse({
        ...release,
        artifacts: [
          release.artifacts[0],
          { ...release.artifacts[1], platform: 'macos-arm64' },
          release.artifacts[2],
        ],
      }),
    ).toThrow();
    expect(() =>
      ClientReleaseSchema.parse({
        ...release,
        artifacts: [
          { ...release.artifacts[0], url: 'https://attacker.example/client.dmg' },
          release.artifacts[1],
          release.artifacts[2],
        ],
      }),
    ).toThrow();
  });

  it('fetches the runtime catalog without caching and validates the response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(release), { status: 200 }),
    );

    await expect(fetchClientRelease(fetcher)).resolves.toEqual(release);
    expect(fetcher).toHaveBeenCalledWith(CLIENT_RELEASE_URL, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  });

  it('rejects a missing runtime catalog', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    await expect(fetchClientRelease(fetcher)).rejects.toThrow('404');
  });
});
