import { z } from 'zod';

export const CLIENT_RELEASE_URL =
  'https://sep.longdaoec.com/sep-client/stable/client-release.json';

export const ClientPlatformSchema = z.enum([
  'macos-arm64',
  'macos-x64',
  'windows-x64',
]);

const ClientArtifactSchema = z.object({
  platform: ClientPlatformSchema,
  label: z.string().trim().min(1).max(80),
  fileName: z.string().regex(/^SEP-Client-[A-Za-z0-9._-]+\.(dmg|exe)$/),
  url: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.hostname === 'sep.longdaoec.com' &&
          url.pathname.startsWith('/sep-client/stable/')
        );
      } catch {
        return false;
      }
    }, '客户端地址必须位于官方 stable 下载目录')
    .nullable(),
  architecture: z.string().trim().min(1).max(32),
  minimumOsVersion: z.string().trim().min(1).max(80),
});

export const ClientReleaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    artifacts: z.array(ClientArtifactSchema).length(3),
  })
  .superRefine((release, context) => {
    const platforms = release.artifacts.map((artifact) => artifact.platform);
    if (new Set(platforms).size !== platforms.length) {
      context.addIssue({
        code: 'custom',
        message: '每个平台只能配置一个客户端安装包',
        path: ['artifacts'],
      });
    }
  });

export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;
export type ClientArtifact = z.infer<typeof ClientArtifactSchema>;
export type ClientRelease = z.infer<typeof ClientReleaseSchema>;

export async function fetchClientRelease(
  fetcher: typeof fetch = fetch,
): Promise<ClientRelease> {
  const response = await fetcher(CLIENT_RELEASE_URL, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`客户端发行配置请求失败（${response.status}）`);
  }

  return ClientReleaseSchema.parse(await response.json());
}
