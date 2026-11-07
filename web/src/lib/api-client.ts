import { authAccessor, type AuthPayload } from './auth-store';

/**
 * All requests go through the Next.js rewrite proxy at /api/* → backend.
 * This keeps the browser same-origin so the __Host-sep_refresh httpOnly cookie
 * is sent automatically (credentials: 'include').
 */
export const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function enterpriseSuspendedError(status: number, data: unknown): ApiError | null {
  if (status !== 401 || !data || typeof data !== 'object' ||
      !('code' in data) || (data as { code?: unknown }).code !== 'ENTERPRISE_SUSPENDED') return null;
  authAccessor.clear();
  const message = 'message' in data ? String((data as { message: unknown }).message) : '所属企业已被冻结';
  return new ApiError(401, message, data);
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** skip the automatic 401→refresh→retry (used by the refresh call itself) */
  skipAuthRetry?: boolean;
}

async function rawRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRetry, headers, ...rest } = opts;
  const token = authAccessor.getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !skipAuthRetry) {
    if (typeof res.clone === 'function') {
      const responseText = await res.clone().text().catch(() => '');
      const suspended = enterpriseSuspendedError(401, responseText ? safeJson(responseText) : undefined);
      if (suspended) throw suspended;
    }
    // try to silently refresh the access token once, then retry
    const refreshed = await tryRefresh();
    if (refreshed) {
      return rawRequest<T>(path, { ...opts, skipAuthRetry: true });
    }
    authAccessor.clear();
    throw new ApiError(401, 'Unauthorized');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && 'message' in data
        ? Array.isArray((data as any).message)
          ? (data as any).message.join('; ')
          : String((data as any).message)
        : res.statusText) || '请求失败';
    throw new ApiError(res.status, message, data, readRetryAfter(res.headers?.get('Retry-After') ?? null));
  }

  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}

let refreshInFlight: Promise<boolean> | null = null;

/** Calls POST /auth/refresh; on success updates the store. Deduped. */
export async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as AuthPayload;
      authAccessor.setAuth(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) =>
    rawRequest<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    rawRequest<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    rawRequest<T>(path, { ...opts, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    rawRequest<T>(path, { ...opts, method: 'PUT', body }),
  delete: <T>(path: string, opts?: RequestOptions) =>
    rawRequest<T>(path, { ...opts, method: 'DELETE' }),
};

/**
 * 下载二进制文件（员工包 ZIP）。
 *
 * 不能用 <a href> 直接下载 —— 下载接口要 Authorization 头，
 * 而 access token 只存在内存里，浏览器的原生导航带不上它。
 * 故用 fetch 拿 blob 再触发一次本地下载。
 *
 * 返回服务端给的 X-SHA256，调用方可展示给用户核对完整性。
 */
export async function downloadBlob(
  path: string,
): Promise<{ blob: Blob; filename: string; sha256: string | null }> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const data = text ? safeJson(text) : undefined;
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : '下载失败';
    const suspended = enterpriseSuspendedError(res.status, data);
    if (suspended) throw suspended;
    throw new ApiError(res.status, message, data, readRetryAfter(res.headers?.get('Retry-After') ?? null));
  }

  return {
    blob: await res.blob(),
    filename: filenameFromContentDisposition(res.headers.get('content-disposition')),
    sha256: res.headers.get('x-sha256'),
  };
}

/**
 * 下载二进制文件（员工包 ZIP）。
 *
 * 不能用 <a href> 直接下载 —— 下载接口要 Authorization 头，
 * 而 access token 只存在内存里，浏览器的原生导航带不上它。
 * 故用 fetch 拿 blob 再触发一次本地下载。
 */
export async function downloadFile(
  path: string,
): Promise<{ filename: string; sha256: string | null }> {
  const { blob, filename, sha256 } = await downloadBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 不 revoke 的话 blob 会一直占着内存，直到页面卸载
  URL.revokeObjectURL(url);

  return { filename, sha256 };
}

function filenameFromContentDisposition(value: string | null): string {
  const disp = value ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disp);
  const plain = /filename="([^"]+)"/i.exec(disp);
  const raw = star?.[1] ?? plain?.[1] ?? 'package.zip';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 上传 multipart 表单。不设 Content-Type，让浏览器带 boundary。401 时仅刷新并重放一次。 */
export async function uploadForm<T>(
  path: string,
  form: FormData,
  opts: Pick<RequestOptions, 'headers' | 'skipAuthRetry'> | boolean = {},
): Promise<T> {
  const { headers, skipAuthRetry = false } = typeof opts === 'boolean' ? { skipAuthRetry: opts } : opts;
  const requestHeaders = new Headers(headers);
  // multipart 的 boundary 必须由浏览器生成。
  requestHeaders.delete('Content-Type');
  const token = authAccessor.getToken();
  if (token) requestHeaders.delete('Authorization');
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...Object.fromEntries(requestHeaders.entries()),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });

  if (res.status === 401 && !skipAuthRetry) {
    if (typeof res.clone === 'function') {
      const responseText = await res.clone().text().catch(() => '');
      const suspended = enterpriseSuspendedError(401, responseText ? safeJson(responseText) : undefined);
      if (suspended) throw suspended;
    }
    if (await tryRefresh()) return uploadForm<T>(path, form, { headers, skipAuthRetry: true });
    authAccessor.clear();
    throw new ApiError(401, 'Unauthorized');
  }

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? Array.isArray((data as { message: unknown }).message)
          ? (data as { message: string[] }).message.join('; ')
          : String((data as { message: unknown }).message)
        : '上传失败';
    const suspended = enterpriseSuspendedError(res.status, data);
    if (suspended) throw suspended;
    throw new ApiError(res.status, message, data, readRetryAfter(res.headers?.get('Retry-After') ?? null));
  }
  return data as T;
}
