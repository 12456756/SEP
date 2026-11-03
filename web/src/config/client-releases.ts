/**
 * 官网 Hero 下载菜单的客户端发行配置。
 *
 * 安装包不进入 Web 仓库。客户端发布后只需将对应平台的 HTTPS 地址填入 url，
 * Hero 菜单即可直接触发浏览器下载。
 */
export type ClientPlatform = 'macos-arm64' | 'macos-x64' | 'windows-x64';

export interface ClientArtifact {
  platform: ClientPlatform;
  label: string;
  fileName: string;
  url: string | null;
  architecture: string;
  minimumOsVersion: string;
}

export interface ClientRelease {
  version: string;
  artifacts: ClientArtifact[];
}

export const CLIENT_RELEASE: ClientRelease = {
  version: '0.3.3',
  artifacts: [
    {
      platform: 'macos-arm64',
      label: 'macOS · Apple 芯片',
      fileName: 'SEP-Client-0.3.3-mac-arm64.dmg',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.3.3/SEP-Client-0.3.3-mac-arm64.dmg',
      architecture: 'ARM64',
      minimumOsVersion: 'macOS 12 或更高版本',
    },
    {
      platform: 'macos-x64',
      label: 'macOS · Intel 芯片',
      fileName: 'SEP-Client-0.3.3-mac-x64.dmg',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.3.3/SEP-Client-0.3.3-mac-x64.dmg',
      architecture: 'x64',
      minimumOsVersion: 'macOS 12 或更高版本',
    },
    {
      platform: 'windows-x64',
      label: 'Windows · 64 位',
      fileName: 'SEP-Client-0.3.3-win-x64.exe',
      url: 'https://sep.longdaoec.com/sep-client/stable/0.3.3/SEP-Client-0.3.3-win-x64.exe',
      architecture: 'x64',
      minimumOsVersion: 'Windows 10 64 位或更高版本',
    },
  ],
};
