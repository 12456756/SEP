import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, tryRefresh, downloadFile, uploadForm } from '../api-client';
import { authAccessor } from '../auth-store';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock authAccessor
vi.mock('../auth-store', () => ({
  authAccessor: {
    getToken: vi.fn(),
    setAuth: vi.fn(),
    clear: vi.fn(),
  },
}));

describe('ApiError', () => {
  it('should create error with status and message', () => {
    const error = new ApiError(404, 'Not found');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not found');
    expect(error.name).toBe('ApiError');
  });

  it('should include body if provided', () => {
    const body = { details: 'Resource not found' };
    const error = new ApiError(404, 'Not found', body);
    expect(error.body).toEqual(body);
  });
});

describe('api.get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('should make GET request with authorization', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: 'test' }),
    });

    const result = await api.get('/test');

    expect(mockFetch).toHaveBeenCalledWith('/api/test', {
      method: 'GET',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer test-token',
      },
      body: undefined,
    });
    expect(result).toEqual({ data: 'test' });
  });

  it('should make GET request without token when not logged in', async () => {
    vi.mocked(authAccessor.getToken).mockReturnValue(null);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: 'public' }),
    });

    await api.get('/public');

    expect(mockFetch).toHaveBeenCalledWith('/api/public', {
      method: 'GET',
      credentials: 'include',
      headers: {},
      body: undefined,
    });
  });

  it('should handle 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    });

    const result = await api.get('/test');
    expect(result).toBeUndefined();
  });

  it('should throw ApiError on 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'Resource not found' }),
    });

    try {
      await api.get('/missing');
      expect.fail('Should have thrown ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe('Resource not found');
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('should handle array of error messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({ message: ['Field A is required', 'Field B is invalid'] }),
    });

    await expect(api.get('/validate')).rejects.toThrow(
      'Field A is required; Field B is invalid',
    );
  });

  it('should handle non-JSON response on error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Plain text error',
    });

    await expect(api.get('/error')).rejects.toThrow('Internal Server Error');
  });

  it.each(['12', new Date(Date.now() + 12000).toUTCString()])('preserves Retry-After %s for polling backoff', async (retryAfter) => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429, headers: { 'Retry-After': retryAfter } }));
    await expect(api.get('/limited')).rejects.toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
  });

  it('ignores invalid Retry-After values', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Unavailable' }), { status: 503, headers: { 'Retry-After': 'invalid' } }));
    await expect(api.get('/limited')).rejects.toMatchObject({ retryAfterSeconds: undefined });
  });
});

describe('api.post', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('should make POST request with body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: '123' }),
    });

    const body = { name: 'Test' };
    const result = await api.post('/create', body);

    expect(mockFetch).toHaveBeenCalledWith('/api/create', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify(body),
    });
    expect(result).toEqual({ id: '123' });
  });

  it('should make POST request without body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    });

    await api.post('/action');

    expect(mockFetch).toHaveBeenCalledWith('/api/action', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer test-token',
      },
      body: undefined,
    });
  });
});

describe('api.patch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('should make PATCH request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ updated: true }),
    });

    const updates = { name: 'Updated' };
    await api.patch('/update/123', updates);

    expect(mockFetch).toHaveBeenCalledWith('/api/update/123', {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify(updates),
    });
  });
});

describe('api.put', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('should make PUT request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ replaced: true }),
    });

    const data = { name: 'Replaced' };
    await api.put('/replace/123', data);

    expect(mockFetch).toHaveBeenCalledWith('/api/replace/123', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify(data),
    });
  });
});

describe('api.delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('should make DELETE request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    });

    await api.delete('/remove/123');

    expect(mockFetch).toHaveBeenCalledWith('/api/remove/123', {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer test-token',
      },
      body: undefined,
    });
  });
});

describe('401 auto-refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('old-token');
  });

  it('should refresh token and retry on 401', async () => {
    // First call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Unauthorized' }),
    });

    // Refresh call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'new-token',
        user: { id: 'user-1', email: 'test@example.com' },
      }),
    });

    // Retry succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: 'success' }),
    });

    const result = await api.get('/protected');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(authAccessor.setAuth).toHaveBeenCalled();
    expect(result).toEqual({ data: 'success' });
  });

  it('should clear auth if refresh fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '',
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '',
    });

    await expect(api.get('/protected')).rejects.toThrow('Unauthorized');
    expect(authAccessor.clear).toHaveBeenCalled();
  });

  it('clears auth and preserves the enterprise suspension error without trying refresh', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      statusCode: 401,
      code: 'ENTERPRISE_SUSPENDED',
      message: '所属企业已被冻结，暂无法使用平台服务，请联系平台管理员',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    await expect(api.get('/protected')).rejects.toMatchObject({
      status: 401,
      message: '所属企业已被冻结，暂无法使用平台服务，请联系平台管理员',
      body: expect.objectContaining({ code: 'ENTERPRISE_SUSPENDED' }),
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(authAccessor.clear).toHaveBeenCalledOnce();
  });

  it('should skip auto-refresh when skipAuthRetry is true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Invalid credentials' }),
    });

    await expect(api.post('/auth/login', {}, { skipAuthRetry: true })).rejects.toThrow(
      'Invalid credentials',
    );

    // Should not attempt refresh
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('tryRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should refresh token successfully', async () => {
    const newAuth = {
      token: 'refreshed-token',
      user: { id: 'user-1', email: 'test@example.com' },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => newAuth,
    });

    const result = await tryRefresh();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    expect(authAccessor.setAuth).toHaveBeenCalledWith(newAuth);
  });

  it('should return false on refresh failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const result = await tryRefresh();

    expect(result).toBe(false);
    expect(authAccessor.setAuth).not.toHaveBeenCalled();
  });

  it('should deduplicate concurrent refresh calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'new-token' }),
    });

    // Call tryRefresh multiple times concurrently
    const results = await Promise.all([tryRefresh(), tryRefresh(), tryRefresh()]);

    // Should only make one fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results).toEqual([true, true, true]);
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await tryRefresh();

    expect(result).toBe(false);
  });
});

describe('downloadFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');

    // Mock DOM APIs
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
    document.createElement = vi.fn((tag) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: vi.fn(),
          remove: vi.fn(),
        } as any;
      }
      return {} as any;
    });
    document.body.appendChild = vi.fn();
  });

  it('should download file with extracted filename', async () => {
    const blob = new Blob(['file content'], { type: 'application/zip' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (key: string) => {
          if (key === 'content-disposition')
            return 'attachment; filename="package-v1.0.zip"';
          if (key === 'x-sha256') return 'abc123';
          return null;
        },
      },
      blob: async () => blob,
    });

    const result = await downloadFile('/download/123');

    expect(result.filename).toBe('package-v1.0.zip');
    expect(result.sha256).toBe('abc123');
    expect(global.URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('should handle UTF-8 encoded filename', async () => {
    const blob = new Blob(['content']);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (key: string) =>
          key === 'content-disposition'
            ? "attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.zip"
            : null,
      },
      blob: async () => blob,
    });

    const result = await downloadFile('/download/123');
    expect(result.filename).toBe('文件.zip');
  });

  it('should throw ApiError on download failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'File not found' }),
    });

    await expect(downloadFile('/download/missing')).rejects.toThrow('File not found');
  });
});

describe('uploadForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authAccessor.getToken).mockReturnValue('test-token');
  });

  it('preserves revision and idempotency headers across auth replay without a multipart content type', async () => {
    const form = new FormData();
    form.append('file', new Blob(['version']), 'version.txt');
    mockFetch.mockResolvedValueOnce({ status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-token' }) });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ id: 'doc', unchanged: true }) });

    await uploadForm('/knowledge-bases/kb/documents/doc/versions', form, {
      headers: { 'If-Match': '"kbdoc-opaque-safe-snapshot"', 'Idempotency-Key': 'same-operation', 'Content-Type': 'multipart/form-data' },
    });

    for (const index of [0, 2]) {
      const request = mockFetch.mock.calls[index][1];
      const headers = new Headers(request.headers);
      expect(request.body).toBe(form);
      expect(headers.get('If-Match')).toBe('"kbdoc-opaque-safe-snapshot"');
      expect(headers.get('Idempotency-Key')).toBe('same-operation');
      expect(headers.has('Content-Type')).toBe(false);
    }
  });

  it('should upload FormData successfully', async () => {
    const form = new FormData();
    form.append('file', new Blob(['content']), 'test.zip');
    form.append('name', 'Test Package');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ id: 'pkg-123', uploaded: true }),
    });

    const result = await uploadForm('/upload', form);

    expect(mockFetch).toHaveBeenCalledWith('/api/upload', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Authorization: 'Bearer test-token',
      },
      body: form,
    });
    expect(result).toEqual({ id: 'pkg-123', uploaded: true });
  });

  it('refreshes once and replays the same form with the new token', async () => {
    const form = new FormData();
    form.append('file', new Blob(['content']), 'knowledge.txt');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-token' }) });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, text: async () => '{"id":"doc-1"}' });
    vi.mocked(authAccessor.getToken).mockReturnValueOnce('old-token').mockReturnValue('new-token');

    await expect(uploadForm('/knowledge-bases/kb-1/documents/upload', form)).resolves.toEqual({ id: 'doc-1' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][1]).toMatchObject({ headers: { Authorization: 'Bearer new-token' }, body: form });
    expect(mockFetch.mock.calls[2][1].headers).not.toHaveProperty('Content-Type');
  });

  it('clears authentication when upload refresh fails without resending the file', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(uploadForm('/upload', new FormData())).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(authAccessor.clear).toHaveBeenCalledOnce();
  });

  it('does not refresh indefinitely if the retried upload is unauthorized', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'new-token' }) });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' });
    await expect(uploadForm('/upload', new FormData())).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should throw ApiError on upload failure', async () => {
    const form = new FormData();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: ['File too large', 'Invalid format'] }),
    });

    await expect(uploadForm('/upload', form)).rejects.toThrow(
      'File too large; Invalid format',
    );
  });
});
