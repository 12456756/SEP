'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadForm } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useAuthStore } from '@/lib/auth-store';
import type { UserProfile } from '@/lib/types';
import type { PasswordUpdateResult } from 'shared/compute-integration.dto';

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => api.get<UserProfile>('/users/me'),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; avatar?: string }) =>
      api.patch<UserProfile>('/users/me', body),
    onSuccess: (user) => {
      qc.setQueryData(qk.me, user);
      // keep the in-memory auth user's display name in sync.
      // 保留 enterprise / roleInEnterprise —— 改个人资料不该动企业归属，
      // 漏传会把侧边栏的企业名和角色过滤一起清空。
      // avatar 同理：后端返回的是权威值，漏传会让侧边栏头像在改名后消失。
      const store = useAuthStore.getState();
      if (store.token) {
        store.setAuth({
          token: store.token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            role: user.role,
          },
          enterprise: store.enterprise,
          roleInEnterprise: store.roleInEnterprise,
        });
      }
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.post<PasswordUpdateResult>('/auth/password/change', body),
  });
}

/** 上传头像（multipart），成功后把返回的稳定地址写回 me 缓存与认证用户。 */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return uploadForm<{ avatar: string }>('/users/me/avatar', form);
    },
    onSuccess: ({ avatar }) => {
      qc.setQueryData<UserProfile>(qk.me, (current) =>
        current ? { ...current, avatar } : current,
      );
      // 侧边栏读的是 auth store 里的 user，不写回的话上传后要刷新才看得到
      const store = useAuthStore.getState();
      if (store.token && store.user) {
        store.setAuth({
          token: store.token,
          user: { ...store.user, avatar },
          enterprise: store.enterprise,
          roleInEnterprise: store.roleInEnterprise,
        });
      }
    },
  });
}
