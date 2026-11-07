import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useLogin,
  useSendRegistrationEmailCode,
  useRegister,
  useLogout,
  useVerifyInvitation,
  useRegisterByInvitation,
  useAcceptInvitation,
  useCreateEnterprise,
  useLeaveEnterprise,
  useRequestEmailChange,
  safeRedirect,
} from '../use-auth';
import { useAuthStore } from '@/lib/auth-store';
import { api } from '@/lib/api-client';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

// Mock dependencies
vi.mock('@/lib/api-client', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper(props: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

describe('useRequestEmailChange', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    ['new@example.com', { newEmail: 'new@example.com' }],
    [{ newEmail: 'new@example.com', currentPassword: 'admin-password' }, { newEmail: 'new@example.com', currentPassword: 'admin-password' }],
  ])('支持现有邮箱参数和管理员密码确认参数：%j', async (input, body) => {
    vi.mocked(api.post).mockResolvedValueOnce({ message: '确认邮件已发送到新邮箱' });
    const { result } = renderHook(() => useRequestEmailChange(), { wrapper: createWrapper() });
    await result.current.mutateAsync(input);
    expect(api.post).toHaveBeenCalledWith('/auth/email/change/request', body);
  });
});

describe('safeRedirect', () => {
  it('should return null for null/undefined input', () => {
    expect(safeRedirect(null)).toBeNull();
    expect(safeRedirect(undefined)).toBeNull();
  });

  it('should return null for protocol-relative URLs', () => {
    expect(safeRedirect('//evil.com')).toBeNull();
    expect(safeRedirect('//example.org/path')).toBeNull();
  });

  it('should return null for absolute URLs', () => {
    expect(safeRedirect('https://evil.com')).toBeNull();
    expect(safeRedirect('http://example.com')).toBeNull();
  });

  it('should allow valid internal paths', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard');
    expect(safeRedirect('/path/to/page')).toBe('/path/to/page');
  });
});

describe('useLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clear();
  });

  it('should login successfully and set auth state', async () => {
    const mockResponse = {
      token: 'test-token',
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-1', name: 'Test Enterprise' },
      roleInEnterprise: 'ENTERPRISE_ADMIN' as const,
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useLogin(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      email: 'test@example.com',
      password: 'password123',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith(
      '/auth/login',
      { email: 'test@example.com', password: 'password123' },
      { skipAuthRetry: true },
    );

    const store = useAuthStore.getState();
    expect(store.token).toBe('test-token');
    expect(store.user?.email).toBe('test@example.com');
  });

  it('should handle login errors', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Invalid credentials'));

    const { result } = renderHook(() => useLogin(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      email: 'wrong@example.com',
      password: 'wrongpass',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeDefined();
  });

  it('should redirect to safe internal path', async () => {
    const mockResponse = {
      token: 'test-token',
      user: { id: 'user-1', email: 'test@example.com', name: 'Test', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-1', name: 'Test Ent' },
      roleInEnterprise: 'ENTERPRISE_ADMIN' as const,
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useLogin('/dashboard'), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      email: 'test@example.com',
      password: 'password123',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });
});

describe('useRegister', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clear();
  });

  it('should register successfully and create enterprise', async () => {
    const mockResponse = {
      token: 'new-token',
      user: { id: 'user-2', email: 'new@example.com', name: 'New User', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-2', name: 'New Enterprise' },
      roleInEnterprise: 'ENTERPRISE_ADMIN' as const,
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useRegister(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      email: 'new@example.com',
      emailCode: '123456',
      password: 'password123',
      enterpriseName: 'New Enterprise',
      name: 'New User',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith(
      '/auth/register',
      {
        email: 'new@example.com',
        emailCode: '123456',
        password: 'password123',
        enterpriseName: 'New Enterprise',
        name: 'New User',
      },
      { skipAuthRetry: true },
    );

    const store = useAuthStore.getState();
    expect(store.enterprise?.name).toBe('New Enterprise');
  });

  it('should handle registration errors', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Email already exists'));

    const { result } = renderHook(() => useRegister(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      email: 'existing@example.com',
      emailCode: '123456',
      password: 'password123',
      enterpriseName: 'Test',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set initial auth state
    useAuthStore.getState().setAuth({
      token: 'test-token',
      user: { id: 'user-1', email: 'test@example.com', name: 'Test', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-1', name: 'Test Ent' },
      roleInEnterprise: 'ENTERPRISE_ADMIN',
    });
  });

  it('should logout and clear auth state', async () => {
    vi.mocked(api.post).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useLogout(), {
      wrapper: createWrapper(),
    });

    expect(useAuthStore.getState().token).toBe('test-token');

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith('/auth/logout');

    const store = useAuthStore.getState();
    expect(store.token).toBeNull();
    expect(store.user).toBeNull();
    expect(store.enterprise).toBeNull();
  });

  it('should clear state even if API call fails', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useLogout(), {
      wrapper: createWrapper(),
    });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isError || result.current.isSuccess).toBe(true);
    });

    // onSettled runs regardless of success/error
    const store = useAuthStore.getState();
    expect(store.token).toBeNull();
  });
});

describe('useVerifyInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should verify valid invitation token', async () => {
    const mockPreview = {
      email: 'invited@example.com',
      enterpriseName: 'Test Enterprise',
      inviterName: 'Admin User',
      role: 'ENTERPRISE_MEMBER' as const,
    };

    vi.mocked(api.get).mockResolvedValueOnce(mockPreview);

    const { result } = renderHook(() => useVerifyInvitation('valid-token'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.get).toHaveBeenCalledWith(
      '/auth/invitations/verify?token=valid-token',
    );
    expect(result.current.data).toEqual(mockPreview);
  });

  it('should handle invalid invitation token', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Invalid token'));

    const { result } = renderHook(() => useVerifyInvitation('invalid-token'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeDefined();
  });

  it('should not query when token is null', () => {
    const { result } = renderHook(() => useVerifyInvitation(null), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('useRegisterByInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().clear();
  });

  it('should register by invitation successfully', async () => {
    const mockResponse = {
      token: 'new-token',
      user: { id: 'user-3', email: 'invited@example.com', name: 'Invited User', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-1', name: 'Existing Enterprise' },
      roleInEnterprise: 'ENTERPRISE_MEMBER' as const,
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useRegisterByInvitation(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      token: 'invitation-token',
      email: 'invited@example.com',
      emailCode: '123456',
      password: 'password123',
      name: 'Invited User',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith(
      '/auth/register-by-invitation',
      {
        token: 'invitation-token',
        email: 'invited@example.com',
        emailCode: '123456',
        password: 'password123',
        name: 'Invited User',
      },
      { skipAuthRetry: true },
    );

    const store = useAuthStore.getState();
    expect(store.roleInEnterprise).toBe('ENTERPRISE_MEMBER');
  });
});

describe('useSendRegistrationEmailCode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests a public registration email code without auth retry', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ message: '如果该邮箱可用于注册，验证码将发送至该邮箱' });
    const { result } = renderHook(() => useSendRegistrationEmailCode(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ email: 'new@example.com' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith(
      '/auth/registration/email-code',
      { email: 'new@example.com' },
      { skipAuthRetry: true },
    );
  });
});

describe('useAcceptInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set initial auth state (logged in user without enterprise)
    useAuthStore.getState().setAuth({
      token: 'existing-token',
      user: { id: 'user-4', email: 'existing@example.com', name: 'Existing User', avatar: null, role: 'USER' },
      enterprise: null,
      roleInEnterprise: null,
    });
  });

  it('should accept invitation for logged-in user', async () => {
    const mockResponse = {
      member: { id: 'member-1', role: 'ENTERPRISE_MEMBER' as const },
      enterprise: { id: 'ent-2', name: 'New Enterprise' },
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useAcceptInvitation(), {
      wrapper: createWrapper(),
    });

    result.current.mutate('invitation-token');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith('/auth/accept-invitation', {
      token: 'invitation-token',
    });

    const store = useAuthStore.getState();
    expect(store.enterprise?.name).toBe('New Enterprise');
    expect(store.roleInEnterprise).toBe('ENTERPRISE_MEMBER');
  });
});

describe('useCreateEnterprise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // User logged in but no enterprise
    useAuthStore.getState().setAuth({
      token: 'user-token',
      user: { id: 'user-5', email: 'solo@example.com', name: 'Solo User', avatar: null, role: 'USER' },
      enterprise: null,
      roleInEnterprise: null,
    });
  });

  it('should create enterprise for user without one', async () => {
    const mockResponse = {
      token: 'user-token',
      user: { id: 'user-5', email: 'solo@example.com', name: 'Solo User', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-new', name: 'My New Enterprise' },
      roleInEnterprise: 'ENTERPRISE_ADMIN' as const,
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateEnterprise(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ name: 'My New Enterprise' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith('/auth/create-enterprise', {
      name: 'My New Enterprise',
    });

    const store = useAuthStore.getState();
    expect(store.enterprise?.name).toBe('My New Enterprise');
    expect(store.roleInEnterprise).toBe('ENTERPRISE_ADMIN');
  });
});

describe('useLeaveEnterprise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // User in an enterprise
    useAuthStore.getState().setAuth({
      token: 'user-token',
      user: { id: 'user-6', email: 'member@example.com', name: 'Member', avatar: null, role: 'USER' },
      enterprise: { id: 'ent-old', name: 'Old Enterprise' },
      roleInEnterprise: 'ENTERPRISE_MEMBER',
    });
  });

  it('should leave enterprise and clear enterprise state', async () => {
    const mockResponse = {
      removed: true,
      reclaimedGrants: 2,
      canceledRequests: 1,
      vacatedDepartments: [{ id: 'dept-1', name: 'Engineering' }],
      enterprise: { id: 'ent-old', name: 'Old Enterprise' },
    };

    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useLeaveEnterprise(), {
      wrapper: createWrapper(),
    });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.post).toHaveBeenCalledWith('/auth/leave-enterprise', {});

    const store = useAuthStore.getState();
    expect(store.enterprise).toBeNull();
    expect(store.roleInEnterprise).toBeNull();
    expect(store.user).toBeDefined(); // User still exists
    expect(navigation.replace).toHaveBeenCalledWith('/no-enterprise');
  });

  it('returns to the same invitation after leaving and clears enterprise query data', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ removed: true });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(['enterprise', 'members'], ['old-private-data']);
    const { result } = renderHook(() => useLeaveEnterprise('invite&token=second'), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(navigation.replace).toHaveBeenCalledWith('/join?token=invite%26token%3Dsecond');
    expect(client.getQueryData(['enterprise', 'members'])).toBeUndefined();
    expect(useAuthStore.getState().enterprise).toBeNull();
    expect(useAuthStore.getState().token).toBe('user-token');
  });

  it('does not navigate or discard the current enterprise if leaving is refused', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('last administrator'));
    const { result } = renderHook(() => useLeaveEnterprise('invite-token'), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().enterprise?.id).toBe('ent-old');
  });
});
