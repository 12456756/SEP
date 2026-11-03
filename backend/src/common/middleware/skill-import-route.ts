export function skillImportSessionRoute(path: string, action: 'events' | 'package'): string | null {
  const match = /^\/api\/skill-import\/connector\/sessions\/([^/]+)\/(events|package)\/?$/i.exec(path);
  if (!match || match[2].toLowerCase() !== action) return null;
  try {
    const sessionId = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9_-]{1,160}$/.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}
