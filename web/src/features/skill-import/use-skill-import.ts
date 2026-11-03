'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import {
  SkillImportConfigSchema, SkillImportSessionCreateSchema, SkillImportConfirmDeviceSchema,
  SkillImportPreviewSchema, SkillImportSelectionSchema, SkillImportSessionViewSchema,
  SkillImportCandidatesResponseSchema, SkillImportPreviewResponseSchema,
  SkillImportFilesResponseSchema, SkillImportOperationResponseSchema, SkillImportDevicesResponseSchema, SkillImportDeviceQuerySchema,
} from 'shared/skill-import-schema';
import type { SkillImportArtifact, SkillImportCandidate, SkillImportSession } from './types';

const terminal = new Set(['uploaded', 'cancelled', 'expired', 'failed']);
const id = () => crypto.randomUUID();
const interval = (failures: number, error?: unknown) => Math.max(
  Math.min(10000, 2000 * 2 ** Math.min(failures, 3)) + (failures ? Math.floor(Math.random() * 250) : 0),
  error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
);
const message = (error: unknown) => error instanceof Error ? error.message : '导入请求失败';
const unrecoverable = (error: unknown) => error instanceof ApiError && [401, 403, 404, 410].includes(error.status);

export function safeClientDeepLink(session: SkillImportSession): string | null {
  try {
    if (session.deepLink.length > 2048) return null;
    const url = new URL(session.deepLink);
    return url.protocol === 'sep-import:' && url.hostname === 'skills' && url.pathname === '/v1'
      && !url.username && !url.password && !url.port && !url.hash
      && url.searchParams.get('instanceId') === session.instanceId && url.searchParams.get('sessionId') === session.id
      && [...url.searchParams.keys()].length === 2 ? url.href : null;
  } catch { return null; }
}

export function skillImportIdentity(userId: string | undefined, token: string | null): string {
  try {
    const payload = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sid?: unknown };
    if (typeof payload.sid === 'string' && payload.sid) return `${userId ?? 'anonymous'}:${payload.sid}`;
  } catch { /* A missing legacy sid is only a UI identity fallback, never authorization. */ }
  return userId ?? 'anonymous';
}

export function useSkillImport(onArtifact: (artifact: SkillImportArtifact | null) => void) {
  const owner = useAuthStore((state) => skillImportIdentity(state.user?.id, state.token));
  const qc = useQueryClient();
  const [sessionBinding, setSessionBinding] = useState<{ owner: string; session: SkillImportSession } | null>(null);
  const session = sessionBinding?.owner === owner ? sessionBinding.session : null;
  const [scope, setScope] = useState<'user' | 'project' | 'all'>('user');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<SkillImportCandidate | null>(null);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [selectionUnknown, setSelectionUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showDevices, setShowDevices] = useState(false);
  const sessionRef = useRef<SkillImportSession | null>(null);
  const pendingCancel = useRef<string | null>(null);
  const ownerRef = useRef(owner);
  const epoch = useRef(0);
  const delivered = useRef<string | null>(null);
  const callback = useRef(onArtifact);
  const mutationAbort = useRef(new AbortController());
  const prefix = ['skill-import', owner] as const;
  const config = useQuery({ queryKey: [...prefix, 'config'], queryFn: async ({ signal }) => SkillImportConfigSchema.parse(await api.get('/skill-import/config', { signal })), retry: false });

  const cancelMutation = useMutation({ mutationFn: (sessionId: string) => api.delete(`/skill-import/sessions/${sessionId}`, { keepalive: true }), retry: false });
  const cancelRef = useRef(cancelMutation.mutate);
  useLayoutEffect(() => {
    ownerRef.current = owner;
    callback.current = onArtifact;
    cancelRef.current = cancelMutation.mutate;
  }, [owner, onArtifact, cancelMutation.mutate]);
  const invalidate = useCallback(() => {
    epoch.current += 1;
    mutationAbort.current.abort();
    mutationAbort.current = new AbortController();
    setSelected(null); setPreviewRequestId(null); setOperationId(null); setSelectionUnknown(false);
    delivered.current = null;
    callback.current(null);
  }, []);
  const clear = useCallback(() => {
    const old = sessionRef.current;
    if (old) pendingCancel.current = old.id;
    sessionRef.current = null;
    invalidate(); setSessionBinding(null); setError(null);
    void qc.cancelQueries({ queryKey: ['skill-import', owner] });
    qc.removeQueries({ queryKey: ['skill-import', owner] });
    return old;
  }, [invalidate, owner, qc]);

  useEffect(() => {
    if (mutationAbort.current.signal.aborted) mutationAbort.current = new AbortController();
    return () => {
      epoch.current += 1;
      mutationAbort.current.abort();
      const old = sessionRef.current;
      sessionRef.current = null;
      const sessionId = old?.id ?? pendingCancel.current;
      if (sessionId) cancelRef.current(sessionId);
      pendingCancel.current = null;
      callback.current(null);
      void qc.cancelQueries({ queryKey: ['skill-import', owner] });
      qc.removeQueries({ queryKey: ['skill-import', owner] });
    };
  }, [owner, qc]);
  useEffect(() => useAuthStore.subscribe((state, previous) => {
    if (skillImportIdentity(state.user?.id, state.token) === skillImportIdentity(previous.user?.id, previous.token)) return;
    setSessionBinding(null);
    setSelected(null);
    setPreviewRequestId(null);
    setOperationId(null);
    setSelectionUnknown(false);
    setError(null);
  }), []);
  useEffect(() => { if (!session) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [session]);

  const status = useQuery({
    queryKey: [...prefix, session?.id, 'status'],
    queryFn: async ({ signal }) => SkillImportSessionViewSchema.parse(await api.get(`/skill-import/sessions/${session!.id}?view=status`, { signal })),
    enabled: !!session && now < Date.parse(session.expiresAt),
    initialData: session ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => terminal.has(query.state.data?.status ?? '') || unrecoverable(query.state.error)
      || (query.state.data && Date.now() >= Math.min(Date.parse(query.state.data.expiresAt), Date.parse(query.state.data.idleExpiresAt))) ? false : interval(query.state.errorUpdateCount, query.state.error),
  });
  const current = session ? status.data ?? session : null;
  const expired = !!current && now >= Math.min(Date.parse(current.expiresAt), Date.parse(current.idleExpiresAt));
  const active = !!current && !expired && !terminal.has(current.status) && !unrecoverable(status.error);
  const canBrowse = active && ['results', 'previewing', 'packaging', 'uploading'].includes(current.status);
  const candidates = useInfiniteQuery({
    queryKey: [...prefix, session?.id, 'candidates', search, source],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ view: 'candidates', limit: '25', q: search, source });
      if (pageParam) params.set('cursor', pageParam);
      return SkillImportCandidatesResponseSchema.parse(await api.get(`/skill-import/sessions/${session!.id}?${params}`, { signal }));
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canBrowse, retry: false, refetchOnWindowFocus: false,
  });
  const preview = useQuery({
    queryKey: [...prefix, session?.id, 'preview', selected?.candidateId, previewRequestId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ view: 'preview', candidateId: selected!.candidateId, requestId: previewRequestId! });
      const result = SkillImportPreviewResponseSchema.parse(await api.get(`/skill-import/sessions/${session!.id}?${params}`, { signal }));
      if (result.preview && (result.preview.requestId !== previewRequestId || result.preview.candidateId !== selected!.candidateId)) throw new Error('预览上下文不匹配，请重新选择技能');
      return result;
    },
    enabled: active && !!selected && !!previewRequestId, retry: false, refetchOnWindowFocus: false,
    refetchInterval: (query) => ['ready', 'failed', 'superseded'].includes(query.state.data?.previewStatus ?? '') || unrecoverable(query.state.error) ? false : interval(query.state.errorUpdateCount, query.state.error),
  });
  const snapshot = preview.data?.preview;
  const files = useInfiniteQuery({
    queryKey: [...prefix, session?.id, 'files', snapshot?.snapshotId],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ view: 'files', snapshotId: snapshot!.snapshotId, limit: '100', cursor: pageParam! });
      const result = SkillImportFilesResponseSchema.parse(await api.get(`/skill-import/sessions/${session!.id}?${params}`, { signal }));
      if (result.snapshotId !== snapshot!.snapshotId) throw new Error('文件清单与预览不匹配');
      return result;
    },
    initialPageParam: snapshot?.nextFilesCursor ?? null,
    getNextPageParam: (page) => page.nextFilesCursor ?? undefined,
    enabled: active && !!snapshot?.nextFilesCursor, retry: false, refetchOnWindowFocus: false,
  });
  const { hasNextPage: hasMoreFiles, isFetching: fetchingFiles, isError: filesFailed, fetchNextPage: fetchMoreFiles } = files;
  useEffect(() => { if (hasMoreFiles && !fetchingFiles && !filesFailed) void fetchMoreFiles(); }, [hasMoreFiles, fetchingFiles, filesFailed, fetchMoreFiles]);
  const allFiles = [...(snapshot?.files ?? []), ...(files.data?.pages.flatMap((page) => page.files) ?? [])];
  const filesReady = !!snapshot && allFiles.length === snapshot.fileCount && (!snapshot.nextFilesCursor || (!!files.data && !files.hasNextPage && !files.isFetching && !files.isError));
  const operation = useQuery({
    queryKey: [...prefix, session?.id, 'operation', operationId],
    queryFn: async ({ signal }) => {
      const result = SkillImportOperationResponseSchema.parse(await api.get(`/skill-import/sessions/${session!.id}?view=operation&operationId=${encodeURIComponent(operationId!)}`, { signal }));
      if (result.operation && result.operation.operationId !== operationId) throw new Error('导入操作上下文不匹配');
      return result;
    },
    enabled: !!session && !!operationId && !expired && !['cancelled', 'failed', 'expired'].includes(current?.status ?? ''), retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => query.state.data?.operation?.status === 'succeeded'
      || (query.state.data?.operation?.status === 'failed' && !query.state.data.operation.retryable)
      || unrecoverable(query.state.error) ? false : interval(query.state.errorUpdateCount, query.state.error),
  });
  useEffect(() => {
    const result = operation.data;
    if (result?.operation?.status === 'succeeded' && result.artifact && operationId && delivered.current !== operationId && session && sessionRef.current?.id === session.id) {
      delivered.current = operationId;
      callback.current(result.artifact);
    }
  }, [operation.data, operationId, session]);
  useEffect(() => { if (expired || ['cancelled', 'expired', 'failed'].includes(current?.status ?? '') || unrecoverable(status.error)) callback.current(null); }, [expired, current?.status, status.error]);

  const create = useMutation({
    mutationFn: async (input: { requestId: string; scope: typeof scope }) => SkillImportSessionViewSchema.parse(await api.post('/skill-import/sessions', SkillImportSessionCreateSchema.parse({ ...input, protocolVersion: 1 }), { signal: mutationAbort.current.signal })), retry: false,
  });
  const confirm = useMutation({ mutationFn: (pairing: unknown) => api.post(`/skill-import/sessions/${sessionRef.current!.id}/confirm-device`, SkillImportConfirmDeviceSchema.parse(pairing), { signal: mutationAbort.current.signal }), retry: false });
  const requestPreview = useMutation({ mutationFn: (input: unknown) => api.post(`/skill-import/sessions/${sessionRef.current!.id}/preview`, SkillImportPreviewSchema.parse(input), { signal: mutationAbort.current.signal }), retry: false });
  const selection = useMutation({ mutationFn: (input: unknown) => api.post(`/skill-import/sessions/${sessionRef.current!.id}/selection`, SkillImportSelectionSchema.parse(input), { signal: mutationAbort.current.signal }), retry: false });
  const devices = useInfiniteQuery({
    queryKey: [...prefix, 'devices'],
    queryFn: async ({ pageParam, signal }) => {
      const input = SkillImportDeviceQuerySchema.parse({ limit: 25, ...(pageParam ? { cursor: pageParam } : {}) });
      const params = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor) params.set('cursor', input.cursor);
      return SkillImportDevicesResponseSchema.parse(await api.get(`/skill-import/devices?${params}`, { signal }));
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: showDevices && config.data?.enabled === true, retry: false,
  });
  const revoke = useMutation({
    mutationFn: (input: { deviceId: string; owner: string }) => api.delete(`/skill-import/devices/${encodeURIComponent(input.deviceId)}`),
    retry: false,
    onSuccess: (_result, input) => {
      if (input.owner !== ownerRef.current) return;
      void qc.invalidateQueries({ queryKey: [...prefix, 'devices'] });
      if (sessionRef.current) { const old = clear(); if (old) cancelRef.current(old.id); }
    },
  });

  const cancel = async () => {
    const old = clear(); const sessionId = old?.id ?? pendingCancel.current;
    const generation = epoch.current;
    if (!sessionId) return;
    try { await cancelMutation.mutateAsync(sessionId); if (pendingCancel.current === sessionId) pendingCancel.current = null; }
    catch (err) { if (generation === epoch.current) setError(`本地已停止导入；服务器取消结果未知：${message(err)}`); }
  };
  const start = async () => {
    const old = clear();
    const generation = epoch.current;
    const sessionId = old?.id ?? pendingCancel.current;
    if (sessionId) {
      try { await cancelMutation.mutateAsync(sessionId); if (pendingCancel.current === sessionId) pendingCancel.current = null; }
      catch (err) { if (generation === epoch.current) setError(`旧会话取消失败，请重试：${message(err)}`); return; }
    }
    try {
      const settings = await config.refetch({ throwOnError: true });
      if (generation !== epoch.current) return;
      if (!settings.data?.enabled) { setError('本机扫描暂未开放，请使用 ZIP 上传'); return; }
      const result = await create.mutateAsync({ requestId: id(), scope });
      if (generation !== epoch.current) { cancelRef.current(result.id); return; }
      sessionRef.current = result; setSessionBinding({ owner, session: result }); setNow(Date.now());
    } catch (err) { if (generation === epoch.current) setError(message(err)); }
  };
  const choose = async (candidate: SkillImportCandidate) => {
    if (!active || candidate.availability === 'blocked') return;
    invalidate(); setError(null); setSelected(candidate);
    const requestId = id(); const generation = epoch.current;
    try { await requestPreview.mutateAsync({ requestId, candidateId: candidate.candidateId, revision: candidate.revision }); if (generation === epoch.current) setPreviewRequestId(requestId); }
    catch (err) { if (generation === epoch.current) setError(message(err)); }
  };
  const select = async () => {
    if (!selected || !snapshot || !filesReady || expired || Date.parse(snapshot.expiresAt) <= Date.now()) return;
    const key = operationId ?? id(); const generation = epoch.current; setError(null);
    try {
      await selection.mutateAsync({ candidateId: selected.candidateId, snapshotId: snapshot.snapshotId, operationId: key });
      if (generation === epoch.current) { setSelectionUnknown(false); setOperationId(key); void qc.invalidateQueries({ queryKey: [...prefix, session?.id, 'operation', key] }); }
    } catch (err) {
      if (generation !== epoch.current) return;
      const unknown = !(err instanceof ApiError) || err.status >= 500 || err.status === 408;
      if (unknown) { setSelectionUnknown(true); setOperationId(key); }
      setError(unknown ? `导入提交结果待确认：${message(err)}。正在查询同一操作，请勿重复创建。` : message(err));
    }
  };
  const confirmDevice = async (input: unknown) => {
    const generation = epoch.current;
    try { await confirm.mutateAsync(input); if (generation === epoch.current) void status.refetch(); }
    catch (err) { if (generation === epoch.current) setError(message(err)); }
  };
  return { session: current, now, scope, setScope: (value: typeof scope) => { invalidate(); setScope(value); }, search, setSearch: (value: string) => { invalidate(); setSearch(value); }, source, setSource: (value: string) => { invalidate(); setSource(value); }, selected: current ? selected : null, preview: snapshot, allFiles, filesReady,
    candidates, operation, operationId, selectionUnknown: selectionUnknown && !operation.data?.operation, start, cancel, choose, select, confirmDevice, confirm, create, selection, requestPreview, devices, revoke,
    revokeDevice: (deviceId: string) => revoke.mutate({ deviceId, owner }), showDevices, setShowDevices, config,
    expired, active, error: (selectionUnknown && operation.data?.operation ? null : error) ?? (status.error ? message(status.error) : preview.error ? message(preview.error) : candidates.error ? message(candidates.error) : operation.error ? message(operation.error) : files.error ? message(files.error) : preview.data?.errorCode ?? null),
    invalidate, previewFailed: ['failed', 'superseded'].includes(preview.data?.previewStatus ?? ''), snapshotExpired: !!snapshot && Date.parse(snapshot.expiresAt) <= now };
}
