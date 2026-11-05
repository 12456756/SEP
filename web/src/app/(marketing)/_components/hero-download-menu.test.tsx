import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeroDownloadMenu } from './hero-download-menu';

const release = {
  version: '0.4.2',
  artifacts: [
    { platform: 'macos-arm64', label: 'macOS · Apple 芯片', fileName: 'SEP-Client-0.4.2-mac-arm64.dmg', url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-mac-arm64.dmg', architecture: 'ARM64', minimumOsVersion: 'macOS 12 或更高版本' },
    { platform: 'macos-x64', label: 'macOS · Intel 芯片', fileName: 'SEP-Client-0.4.2-mac-x64.dmg', url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-mac-x64.dmg', architecture: 'x64', minimumOsVersion: 'macOS 12 或更高版本' },
    { platform: 'windows-x64', label: 'Windows · 64 位', fileName: 'SEP-Client-0.4.2-win-x64.exe', url: 'https://sep.longdaoec.com/sep-client/stable/0.4.2/SEP-Client-0.4.2-win-x64.exe', architecture: 'x64', minimumOsVersion: 'Windows 10 64 位或更高版本' },
  ],
};

function stubReleaseCatalog() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(release), { status: 200 }),
  ));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('HeroDownloadMenu', () => {
  it('opens on the first focus + click and toggles closed on a second click', async () => {
    stubReleaseCatalog();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    const button = screen.getByRole('button', { name: /下载客户端/ });
    fireEvent.focus(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getAllByRole('menuitem')).toHaveLength(3));
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
  it('opens via keyboard and closes on Escape', () => {
    stubReleaseCatalog();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    const button = screen.getByRole('button', { name: /下载客户端/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
  it('offers exactly the three delivered stable installers as direct downloads', async () => {
    stubReleaseCatalog();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    fireEvent.click(screen.getByRole('button', { name: /下载客户端/ }));

    const expectedDownloads = [
      { label: /macOS · Apple 芯片/, fileName: 'SEP-Client-0.4.2-mac-arm64.dmg' },
      { label: /macOS · Intel 芯片/, fileName: 'SEP-Client-0.4.2-mac-x64.dmg' },
      { label: /Windows · 64 位/, fileName: 'SEP-Client-0.4.2-win-x64.exe' },
    ];
    await waitFor(() => expect(screen.getAllByRole('menuitem')).toHaveLength(expectedDownloads.length));
    expect(screen.getByRole('button', { name: '下载客户端' })).toHaveTextContent(/^下载客户端$/);
    expect(screen.queryByText(/v0\.1\.2|M1\/M2\/M3\/M4/)).not.toBeInTheDocument();
    for (const { label, fileName } of expectedDownloads) {
      const item = screen.getByRole('menuitem', { name: label });
      expect(item).toHaveAttribute('href', `https://sep.longdaoec.com/sep-client/stable/0.4.2/${fileName}`);
      expect(item).toHaveAttribute('download', fileName);
      expect(item).toHaveAttribute('aria-disabled', 'false');
    }
    expect(screen.queryByText('准备中')).not.toBeInTheDocument();
  });

});
