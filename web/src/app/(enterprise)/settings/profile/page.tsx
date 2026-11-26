'use client';

import { Suspense, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, Loader2, Mail, Upload } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CenteredSpinner } from '@/components/ui/feedback';
import { useMe, useUpdateProfile, useUploadAvatar } from '@/features/user/use-user';
import {
  useLogout,
  useRequestEmailVerification,
  useRequestEmailChange,
} from '@/features/auth/use-auth';
import { ApiError } from '@/lib/api-client';
import { LeaveEnterprisePanel } from '@/features/auth/leave-enterprise-panel';

/** 头像上传的本地预检，与后端 MAX_USER_AVATAR_SIZE 保持一致；真正的校验在后端。 */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';

const profileSchema = z.object({
  name: z.string().min(1, '姓名不能为空'),
});

export default function SettingsPage() {
  const { data: me, isLoading } = useMe();
  const updateProfile = useUpdateProfile();
  const logout = useLogout();
  const uploadAvatar = useUploadAvatar();
  const requestEmailVerification = useRequestEmailVerification();
  const requestEmailChange = useRequestEmailChange();

  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSaved, setAvatarSaved] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const profileForm = useForm({
    resolver: zodResolver(profileSchema),
    values: me ? { name: me.name ?? '' } : undefined,
  });

  const onProfileSubmit = profileForm.handleSubmit((data) => {
    updateProfile.mutate(
      { name: data.name },
      {
        onSuccess: () => {
          profileForm.reset(data);
        },
      },
    );
  });

  /**
   * 头像是一次独立的 multipart 上传，成功后立即生效（不需要再点保存）。
   * 本地只做类型/大小预检给出即时反馈，服务端仍会按魔数与白名单复检。
   */
  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 清空 value：否则连续选择同一个文件不会再触发 change
    event.target.value = '';
    if (!file) return;
    setAvatarError(null);
    setAvatarSaved(false);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAvatarError('请选择 PNG、JPG 或 WebP 图片');
      return;
    }
    if (!file.size || file.size > AVATAR_MAX_BYTES) {
      setAvatarError('图片不能为空，且不能超过 2 MB');
      return;
    }
    try {
      await uploadAvatar.mutateAsync(file);
      setAvatarSaved(true);
      setTimeout(() => setAvatarSaved(false), 3000);
    } catch (cause) {
      setAvatarError(cause instanceof ApiError ? cause.message : '上传失败，请重试');
    }
  }

  function handleEmailChangeRequest() {
    setEmailMessage(null);
    requestEmailChange.mutate(newEmail, {
      onSuccess: ({ message }) => {
        setEmailMessage(message);
        setNewEmail('');
      },
    });
  }

  if (isLoading) return <CenteredSpinner label="加载中…" />;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">个人设置</h1>
        <p className="mt-1 text-sm text-fg-muted">管理你的账号信息和偏好</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onProfileSubmit} className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar
                name={profileForm.watch('name') || me?.email}
                src={me?.avatar || undefined}
                className="h-16 w-16 text-xl"
              />
              <div className="space-y-2">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept={AVATAR_ACCEPT}
                  aria-label="选择头像图片"
                  className="hidden"
                  disabled={uploadAvatar.isPending}
                  onChange={handleAvatarChange}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadAvatar.isPending}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {uploadAvatar.isPending
                      ? '正在上传…'
                      : me?.avatar
                        ? '更换头像'
                        : '上传头像'}
                  </Button>
                  {avatarSaved && (
                    <span role="status" className="flex items-center gap-1 text-sm text-success">
                      <Check className="h-4 w-4" />
                      头像已更新
                    </span>
                  )}
                </div>
                <p className="text-xs text-fg-muted">支持 PNG、JPG、WebP，最大 2 MB</p>
                {avatarError && (
                  <p role="alert" className="text-sm text-danger">
                    {avatarError}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="mb-1.5 block text-sm font-medium text-foreground">登录邮箱</label>
              <div className="flex flex-wrap items-center gap-2">
                <Input className="min-w-[240px] flex-1" value={me?.email ?? ''} disabled readOnly />
                {me?.emailVerifiedAt ? (
                  <span className="text-sm text-success">已验证</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => requestEmailVerification.mutate()}
                    disabled={requestEmailVerification.isPending}
                  >
                    <Mail className="mr-1.5 h-4 w-4" />
                    {requestEmailVerification.isPending ? '发送中…' : '发送验证邮件'}
                  </Button>
                )}
              </div>
              {requestEmailVerification.isSuccess && (
                <p className="text-sm text-success">验证邮件已发送，请检查收件箱。</p>
              )}
              {requestEmailVerification.error && (
                <p className="text-sm text-danger">{(requestEmailVerification.error as ApiError).message || '发送失败'}</p>
              )}
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <label className="mb-1.5 block text-sm font-medium text-foreground">修改登录邮箱</label>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-[240px] flex-1"
                  type="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="新的邮箱地址"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleEmailChangeRequest}
                  disabled={!newEmail || requestEmailChange.isPending}
                >
                  {requestEmailChange.isPending ? '发送中…' : '发送确认邮件'}
                </Button>
              </div>
              <p className="text-xs text-fg-muted">需要先验证当前邮箱；确认新邮箱后才会生效。</p>
              {emailMessage && <p className="text-sm text-success">{emailMessage}</p>}
              {requestEmailChange.error && (
                <p className="text-sm text-danger">{(requestEmailChange.error as ApiError).message || '发送失败'}</p>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">姓名</label>
              <Input {...profileForm.register('name')} />
              {profileForm.formState.errors.name && (
                <p className="mt-1 text-sm text-danger">
                  {profileForm.formState.errors.name.message}
                </p>
              )}
            </div>

            {updateProfile.error && (
              <p className="text-sm text-danger">
                {(updateProfile.error as ApiError).message || '保存失败'}
              </p>
            )}

            <Button
              type="submit"
              size="sm"
              disabled={updateProfile.isPending || !profileForm.formState.isDirty}
            >
              {updateProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>账号操作</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="danger"
            size="sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            退出登录
          </Button>
        </CardContent>
      </Card>

      <Suspense fallback={<CenteredSpinner label="加载中…" />}>
        <LeaveEnterpriseCard />
      </Suspense>
    </div>
  );
}

function LeaveEnterpriseCard() {
  const token = useSearchParams().get('invitationToken');
  return <LeaveEnterprisePanel invitationToken={token} />;
}
