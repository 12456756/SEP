import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeroDownloadMenu } from './hero-download-menu';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('HeroDownloadMenu', () => {
  it('opens on the first focus + click and toggles closed on a second click', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    const button = screen.getByRole('button', { name: /下载客户端/ });
    fireEvent.focus(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
  it('opens via keyboard and closes on Escape', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    const button = screen.getByRole('button', { name: /下载客户端/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
  it('offers exactly the three delivered stable installers as direct downloads', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HeroDownloadMenu />);
    fireEvent.click(screen.getByRole('button', { name: /下载客户端/ }));

    const expectedDownloads = [
      { label: /macOS · Apple 芯片/, fileName: 'SEP-Client-0.3.3-mac-arm64.dmg' },
      { label: /macOS · Intel 芯片/, fileName: 'SEP-Client-0.3.3-mac-x64.dmg' },
      { label: /Windows · 64 位/, fileName: 'SEP-Client-0.3.3-win-x64.exe' },
    ];
    expect(screen.getAllByRole('menuitem')).toHaveLength(expectedDownloads.length);
    expect(screen.getByRole('button', { name: '下载客户端' })).toHaveTextContent(/^下载客户端$/);
    expect(screen.queryByText(/v0\.1\.2|M1\/M2\/M3\/M4/)).not.toBeInTheDocument();
    for (const { label, fileName } of expectedDownloads) {
      const item = screen.getByRole('menuitem', { name: label });
      expect(item).toHaveAttribute('href', `https://sep.longdaoec.com/sep-client/stable/0.3.3/${fileName}`);
      expect(item).toHaveAttribute('download', fileName);
      expect(item).toHaveAttribute('aria-disabled', 'false');
    }
    expect(screen.queryByText('准备中')).not.toBeInTheDocument();
  });

});
