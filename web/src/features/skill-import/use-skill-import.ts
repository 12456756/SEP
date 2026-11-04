"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { useAuthStore } from "@/lib/auth-store";
import {
  SkillImportConfigSchema,
  SkillImportSessionCreateSchema,
  SkillImportConfirmDeviceSchema,
  SkillImportPreviewSchema,
  SkillImportSelectionSchema,
  SkillImportSessionViewSchema,
  SkillImportCandidatesResponseSchema,
  SkillImportPreviewResponseSchema,
  SkillImportFilesResponseSchema,
  SkillImportOperationResponseSchema,
  SkillImportDevicesResponseSchema,
  SkillImportDeviceQuerySchema,
} from "shared/skill-import-schema";
import type {
  SkillImportArtifact,
  SkillImportCompletedArtifact,
  SkillImportCandidate,
  SkillImportQueueItem,
  SkillImportSession,
} from "./types";

const terminal = new Set(["uploaded", "cancelled", "expired", "failed"]);
const id = () => crypto.randomUUID();
const interval = (failures: number, error?: unknown) =>
  Math.max(
    Math.min(10000, 2000 * 2 ** Math.min(failures, 3)) +
      (failures ? Math.floor(Math.random() * 250) : 0),
    error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
  );
const message = (error: unknown) =>
  error instanceof Error ? error.message : "导入请求失败";
const unrecoverable = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404, 410].includes(error.status);

export function safeClientDeepLink(session: SkillImportSession): string | null {
  try {
    if (session.deepLink.length > 2048) return null;
    const url = new URL(session.deepLink);
    return url.protocol === "sep-import:" &&
      url.hostname === "skills" &&
      url.pathname === "/v1" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.searchParams.get("instanceId") === session.instanceId &&
      url.searchParams.get("sessionId") === session.id &&
      [...url.searchParams.keys()].length === 2
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function skillImportIdentity(
  userId: string | undefined,
  token: string | null,
): string {
  try {
    const payload = JSON.parse(
      atob((token ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sid?: unknown };
    if (typeof payload.sid === "string" && payload.sid)
      return `${userId ?? "anonymous"}:${payload.sid}`;
  } catch {
    /* A missing legacy sid is only a UI identity fallback, never authorization. */
  }
  return userId ?? "anonymous";
}

export function useSkillImport(
  onArtifact: (artifact: SkillImportArtifact | null) => void,
  onArtifacts?: (artifacts: SkillImportCompletedArtifact[]) => void,
) {
  const owner = useAuthStore((state) =>
    skillImportIdentity(state.user?.id, state.token),
  );
  const qc = useQueryClient();
  const [sessionBinding, setSessionBinding] = useState<{
    owner: string;
    session: SkillImportSession;
  } | null>(null);
  const session =
    sessionBinding?.owner === owner ? sessionBinding.session : null;
  const [scope, setScope] = useState<"user" | "project" | "all">("user");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<SkillImportCandidate | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<
    SkillImportCandidate[]
  >([]);
  const [queue, setQueue] = useState<SkillImportQueueItem[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
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
  const artifactsCallback = useRef(onArtifacts);
  const mutationAbort = useRef(new AbortController());
  const prefix = ["skill-import", owner] as const;
  const config = useQuery({
    queryKey: [...prefix, "config"],
    queryFn: async ({ signal }) =>
      SkillImportConfigSchema.parse(
        await api.get("/skill-import/config", { signal }),
      ),
    retry: false,
  });

  const cancelMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.delete(`/skill-import/sessions/${sessionId}`, { keepalive: true }),
    retry: false,
  });
  const cancelRef = useRef(cancelMutation.mutate);
  useLayoutEffect(() => {
    ownerRef.current = owner;
    callback.current = onArtifact;
    artifactsCallback.current = onArtifacts;
    cancelRef.current = cancelMutation.mutate;
  }, [owner, onArtifact, onArtifacts, cancelMutation.mutate]);
  const invalidate = useCallback(() => {
    epoch.current += 1;
    mutationAbort.current.abort();
    mutationAbort.current = new AbortController();
    setSelected(null);
    setPreviewRequestId(null);
    setOperationId(null);
    setSelectionUnknown(false);
    delivered.current = null;
    callback.current(null);
  }, []);
  const clear = useCallback(() => {
    const old = sessionRef.current;
    if (old) pendingCancel.current = old.id;
    sessionRef.current = null;
    invalidate();
    setSessionBinding(null);
    setError(null);
    setSelectedCandidates([]);
    setQueue([]);
    setQueueBusy(false);
    void qc.cancelQueries({ queryKey: ["skill-import", owner] });
    qc.removeQueries({ queryKey: ["skill-import", owner] });
    return old;
  }, [invalidate, owner, qc]);

  useEffect(() => {
    if (mutationAbort.current.signal.aborted)
      mutationAbort.current = new AbortController();
    return () => {
      epoch.current += 1;
      mutationAbort.current.abort();
      const old = sessionRef.current;
      sessionRef.current = null;
      const sessionId = old?.id ?? pendingCancel.current;
      if (sessionId) cancelRef.current(sessionId);
      pendingCancel.current = null;
      callback.current(null);
      void qc.cancelQueries({ queryKey: ["skill-import", owner] });
      qc.removeQueries({ queryKey: ["skill-import", owner] });
    };
  }, [owner, qc]);
  useEffect(
    () =>
      useAuthStore.subscribe((state, previous) => {
        if (
          skillImportIdentity(state.user?.id, state.token) ===
          skillImportIdentity(previous.user?.id, previous.token)
        )
          return;
        setSessionBinding(null);
        setSelected(null);
        setPreviewRequestId(null);
        setOperationId(null);
        setSelectionUnknown(false);
        setError(null);
      }),
    [],
  );
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  const status = useQuery({
    queryKey: [...prefix, session?.id, "status"],
    queryFn: async ({ signal }) =>
      SkillImportSessionViewSchema.parse(
        await api.get(`/skill-import/sessions/${session!.id}?view=status`, {
          signal,
        }),
      ),
    enabled: !!session && now < Date.parse(session.expiresAt),
    initialData: session ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      terminal.has(query.state.data?.status ?? "") ||
      unrecoverable(query.state.error) ||
      (query.state.data &&
        Date.now() >=
          Math.min(
            Date.parse(query.state.data.expiresAt),
            Date.parse(query.state.data.idleExpiresAt),
          ))
        ? false
        : interval(query.state.errorUpdateCount, query.state.error),
  });
  const current = session ? (status.data ?? session) : null;
  const expired =
    !!current &&
    now >=
      Math.min(
        Date.parse(current.expiresAt),
        Date.parse(current.idleExpiresAt),
      );
  const active =
    !!current &&
    !expired &&
    (!terminal.has(current.status) || current.status === "uploaded") &&
    !unrecoverable(status.error);
  const canBrowse =
    active &&
    ["results", "previewing", "packaging", "uploading", "uploaded"].includes(
      current.status,
    );
  const candidates = useInfiniteQuery({
    queryKey: [...prefix, session?.id, "candidates", search, source],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        view: "candidates",
        limit: "25",
        q: search,
        source,
      });
      if (pageParam) params.set("cursor", pageParam);
      return SkillImportCandidatesResponseSchema.parse(
        await api.get(`/skill-import/sessions/${session!.id}?${params}`, {
          signal,
        }),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canBrowse,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = useQuery({
    queryKey: [
      ...prefix,
      session?.id,
      "preview",
      selected?.candidateId,
      previewRequestId,
    ],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        view: "preview",
        candidateId: selected!.candidateId,
        requestId: previewRequestId!,
      });
      const result = SkillImportPreviewResponseSchema.parse(
        await api.get(`/skill-import/sessions/${session!.id}?${params}`, {
          signal,
        }),
      );
      if (
        result.preview &&
        (result.preview.requestId !== previewRequestId ||
          result.preview.candidateId !== selected!.candidateId)
      )
        throw new Error("预览上下文不匹配，请重新选择技能");
      return result;
    },
    enabled: active && !!selected && !!previewRequestId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      ["ready", "failed", "superseded"].includes(
        query.state.data?.previewStatus ?? "",
      ) || unrecoverable(query.state.error)
        ? false
        : interval(query.state.errorUpdateCount, query.state.error),
  });
  const snapshot = preview.data?.preview;
  const filesDeadline =
    snapshot && current
      ? Math.min(
          Date.parse(snapshot.expiresAt),
          Date.parse(current.expiresAt),
          Date.parse(current.idleExpiresAt),
        )
      : 0;
  const files = useInfiniteQuery({
    queryKey: [...prefix, session?.id, "files", snapshot?.snapshotId],
    queryFn: async ({ pageParam, signal }) => {
      if (!active || Date.now() >= filesDeadline)
        throw new ApiError(410, "文件预览已过期，请重新选择技能");
      const params = new URLSearchParams({
        view: "files",
        snapshotId: snapshot!.snapshotId,
        limit: "100",
        cursor: pageParam!,
      });
      const result = SkillImportFilesResponseSchema.parse(
        await api.get(`/skill-import/sessions/${session!.id}?${params}`, {
          signal,
        }),
      );
      if (result.snapshotId !== snapshot!.snapshotId)
        throw new Error("文件清单与预览不匹配");
      return result;
    },
    initialPageParam: snapshot?.nextFilesCursor ?? null,
    getNextPageParam: (page) => page.nextFilesCursor ?? undefined,
    enabled: active && current?.status !== "uploaded" && !!snapshot?.nextFilesCursor && filesDeadline > now,
    retry: (failures, error) =>
      failures < 2 &&
      !unrecoverable(error) &&
      (!(error instanceof ApiError) ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500) &&
      Date.now() < filesDeadline,
    retryDelay: (failures, error) => interval(failures, error),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const {
    hasNextPage: hasMoreFiles,
    isFetching: fetchingFiles,
    isError: filesFailed,
    fetchNextPage: fetchMoreFiles,
  } = files;
  useEffect(() => {
    if (
      active &&
      current?.status !== "uploaded" &&
      Date.now() < filesDeadline &&
      hasMoreFiles &&
      !fetchingFiles &&
      !filesFailed
    )
      void fetchMoreFiles();
  }, [
    active,
    current?.status,
    filesDeadline,
    hasMoreFiles,
    fetchingFiles,
    filesFailed,
    fetchMoreFiles,
  ]);
  const allFiles = [
    ...(snapshot?.files ?? []),
    ...(files.data?.pages.flatMap((page) => page.files) ?? []),
  ];
  const filesReady =
    !!snapshot &&
    allFiles.length === snapshot.fileCount &&
    (!snapshot.nextFilesCursor ||
      (!!files.data &&
        !files.hasNextPage &&
        !files.isFetching &&
        !files.isError));
  const canRetryFiles =
    active &&
    filesDeadline > now &&
    files.isError &&
    !files.isFetching &&
    !unrecoverable(files.error) &&
    (!(files.error instanceof ApiError) ||
      !files.error.retryAfterSeconds ||
      now >= files.errorUpdatedAt + files.error.retryAfterSeconds * 1000);
  const retryFiles = () => {
    if (!canRetryFiles || Date.now() >= filesDeadline) return;
    if (files.data) void files.fetchNextPage();
    else void files.refetch();
  };
  const operation = useQuery({
    queryKey: [...prefix, session?.id, "operation", operationId],
    queryFn: async ({ signal }) => {
      const result = SkillImportOperationResponseSchema.parse(
        await api.get(
          `/skill-import/sessions/${session!.id}?view=operation&operationId=${encodeURIComponent(operationId!)}`,
          { signal },
        ),
      );
      if (result.operation && result.operation.operationId !== operationId)
        throw new Error("导入操作上下文不匹配");
      return result;
    },
    enabled:
      !!session &&
      !!operationId &&
      !expired &&
      !["cancelled", "failed", "expired"].includes(current?.status ?? ""),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.operation?.status === "succeeded" ||
      (query.state.data?.operation?.status === "failed" &&
        !query.state.data.operation.retryable) ||
      unrecoverable(query.state.error)
        ? false
        : interval(query.state.errorUpdateCount, query.state.error),
  });
  useEffect(() => {
    const result = operation.data;
    if (
      result?.operation?.status === "succeeded" &&
      result.artifact &&
      operationId &&
      delivered.current !== operationId &&
      session &&
      sessionRef.current?.id === session.id
    ) {
      delivered.current = operationId;
      callback.current(result.artifact);
    }
  }, [operation.data, operationId, session]);
  useEffect(() => {
    if (
      unrecoverable(status.error) ||
      ["cancelled", "failed"].includes(current?.status ?? "") ||
      (!delivered.current && (expired || current?.status === "expired"))
    )
      callback.current(null);
  }, [expired, current?.status, status.error]);

  const create = useMutation({
    mutationFn: async (input: { requestId: string; scope: typeof scope }) =>
      SkillImportSessionViewSchema.parse(
        await api.post(
          "/skill-import/sessions",
          SkillImportSessionCreateSchema.parse({
            ...input,
            protocolVersion: 1,
          }),
          { signal: mutationAbort.current.signal },
        ),
      ),
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: (pairing: unknown) =>
      api.post(
        `/skill-import/sessions/${sessionRef.current!.id}/confirm-device`,
        SkillImportConfirmDeviceSchema.parse(pairing),
        { signal: mutationAbort.current.signal },
      ),
    retry: false,
  });
  const requestPreview = useMutation({
    mutationFn: (input: unknown) =>
      api.post(
        `/skill-import/sessions/${sessionRef.current!.id}/preview`,
        SkillImportPreviewSchema.parse(input),
        { signal: mutationAbort.current.signal },
      ),
    retry: false,
  });
  const selection = useMutation({
    mutationFn: (input: unknown) =>
      api.post(
        `/skill-import/sessions/${sessionRef.current!.id}/selection`,
        SkillImportSelectionSchema.parse(input),
        { signal: mutationAbort.current.signal },
      ),
    retry: false,
  });
  const devices = useInfiniteQuery({
    queryKey: [...prefix, "devices"],
    queryFn: async ({ pageParam, signal }) => {
      const input = SkillImportDeviceQuerySchema.parse({
        limit: 25,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      const params = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor) params.set("cursor", input.cursor);
      return SkillImportDevicesResponseSchema.parse(
        await api.get(`/skill-import/devices?${params}`, { signal }),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: showDevices && config.data?.enabled === true,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (input: { deviceId: string; owner: string }) =>
      api.delete(`/skill-import/devices/${encodeURIComponent(input.deviceId)}`),
    retry: false,
    onSuccess: (_result, input) => {
      if (input.owner !== ownerRef.current) return;
      void qc.invalidateQueries({ queryKey: [...prefix, "devices"] });
      if (sessionRef.current) {
        const old = clear();
        if (old) cancelRef.current(old.id);
      }
    },
  });

  const cancel = async () => {
    const old = clear();
    const sessionId = old?.id ?? pendingCancel.current;
    const generation = epoch.current;
    if (!sessionId) return;
    try {
      await cancelMutation.mutateAsync(sessionId);
      if (pendingCancel.current === sessionId) pendingCancel.current = null;
    } catch (err) {
      if (generation === epoch.current)
        setError(`本地已停止导入；服务器取消结果未知：${message(err)}`);
    }
  };
  const start = async () => {
    const old = clear();
    const generation = epoch.current;
    const sessionId = old?.id ?? pendingCancel.current;
    if (sessionId) {
      try {
        await cancelMutation.mutateAsync(sessionId);
        if (pendingCancel.current === sessionId) pendingCancel.current = null;
      } catch (err) {
        if (generation === epoch.current)
          setError(`旧会话取消失败，请重试：${message(err)}`);
        return;
      }
    }
    try {
      const settings = await config.refetch({ throwOnError: true });
      if (generation !== epoch.current) return;
      if (!settings.data?.enabled) {
        setError("本机扫描暂未开放，请使用 ZIP 上传");
        return;
      }
      const result = await create.mutateAsync({ requestId: id(), scope });
      if (generation !== epoch.current) {
        cancelRef.current(result.id);
        return;
      }
      sessionRef.current = result;
      setSessionBinding({ owner, session: result });
      setNow(Date.now());
    } catch (err) {
      if (generation === epoch.current) setError(message(err));
    }
  };
  const choose = async (candidate: SkillImportCandidate) => {
    if (!active || candidate.availability === "blocked") return;
    invalidate();
    setError(null);
    setSelected(candidate);
    const requestId = id();
    const generation = epoch.current;
    try {
      await requestPreview.mutateAsync({
        requestId,
        candidateId: candidate.candidateId,
        revision: candidate.revision,
      });
      if (generation === epoch.current) setPreviewRequestId(requestId);
    } catch (err) {
      if (generation === epoch.current) setError(message(err));
    }
  };
  const toggleCandidate = (candidate: SkillImportCandidate) => {
    if (!active || candidate.availability === "blocked") return;
    setSelectedCandidates((items) =>
      items.some((item) => item.candidateId === candidate.candidateId)
        ? items.filter((item) => item.candidateId !== candidate.candidateId)
        : items.length >= 20
          ? items
          : [...items, candidate],
    );
  };
  const clearSelectedCandidates = () => setSelectedCandidates([]);
  const removeSelectedCandidate = (candidateId: string) =>
    setSelectedCandidates((items) =>
      items.filter((item) => item.candidateId !== candidateId),
    );
  const importSelected = async (retryCandidateId?: string) => {
    if (!active || queueBusy || !session) return;
    const items: SkillImportQueueItem[] = retryCandidateId
      ? queue
          .filter((item) => item.candidate.candidateId === retryCandidateId)
          .map((item) => ({ ...item, status: "queued", error: undefined }))
      : selectedCandidates.map((candidate) => ({
          candidate,
          status: "queued",
        }));
    if (items.length === 0 || items.length > 20) return;
    if (!retryCandidateId) setSelectedCandidates([]);
    const existingQueue = retryCandidateId ? queue : [];
    setQueue(
      retryCandidateId
        ? existingQueue.map((entry) =>
            entry.candidate.candidateId === retryCandidateId
              ? { ...entry, status: "queued", error: undefined }
              : entry,
          )
        : items,
    );
    setQueueBusy(true);
    setError(null);
    const completedArtifacts: SkillImportCompletedArtifact[] = [];
    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const candidateId = item.candidate.candidateId;
        setQueue((current) =>
          current.map((entry) =>
            entry.candidate.candidateId === candidateId
              ? { ...entry, status: "processing", error: undefined }
              : entry,
          ),
        );
        try {
          const requestId = id();
          await api.post(
            `/skill-import/sessions/${session.id}/preview`,
            SkillImportPreviewSchema.parse({
              requestId,
              candidateId: item.candidate.candidateId,
              revision: item.candidate.revision,
            }),
            { signal: mutationAbort.current.signal },
          );
          let previewResult: z.infer<
            typeof SkillImportPreviewResponseSchema
          > | null = null;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            previewResult = SkillImportPreviewResponseSchema.parse(
              await api.get(
                `/skill-import/sessions/${session.id}?view=preview&candidateId=${encodeURIComponent(item.candidate.candidateId)}&requestId=${encodeURIComponent(requestId)}`,
                { signal: mutationAbort.current.signal },
              ),
            );
            if (
              previewResult.previewStatus === "ready" &&
              previewResult.preview
            )
              break;
            if (["failed", "superseded"].includes(previewResult.previewStatus))
              throw new Error(previewResult.errorCode ?? "预览失败");
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
          const snapshot = previewResult?.preview;
          if (!snapshot || snapshot.requestId !== requestId)
            throw new Error("预览未就绪");
          const allFiles = [...snapshot.files];
          let cursor = snapshot.nextFilesCursor;
          while (cursor) {
            const page = SkillImportFilesResponseSchema.parse(
              await api.get(
                `/skill-import/sessions/${session.id}?view=files&snapshotId=${encodeURIComponent(snapshot.snapshotId)}&limit=100&cursor=${encodeURIComponent(cursor)}`,
                { signal: mutationAbort.current.signal },
              ),
            );
            allFiles.push(...page.files);
            cursor = page.nextFilesCursor;
          }
          if (allFiles.length !== snapshot.fileCount)
            throw new Error("文件清单未完整读取");
          const operationId = id();
          await api.post(
            `/skill-import/sessions/${session.id}/selection`,
            SkillImportSelectionSchema.parse({
              candidateId: item.candidate.candidateId,
              snapshotId: snapshot.snapshotId,
              operationId,
            }),
            { signal: mutationAbort.current.signal },
          );
          let operationResult: z.infer<
            typeof SkillImportOperationResponseSchema
          > | null = null;
          for (let attempt = 0; attempt < 90; attempt += 1) {
            operationResult = SkillImportOperationResponseSchema.parse(
              await api.get(
                `/skill-import/sessions/${session.id}?view=operation&operationId=${encodeURIComponent(operationId)}`,
                { signal: mutationAbort.current.signal },
              ),
            );
            if (
              operationResult.operation?.status === "succeeded" &&
              operationResult.artifact
            )
              break;
            if (
              operationResult.operation?.status === "failed" &&
              !operationResult.operation.retryable
            )
              throw new Error(
                operationResult.operation.errorCode ?? "上传失败",
              );
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
          if (
            !operationResult?.artifact ||
            operationResult.operation?.status !== "succeeded"
          )
            throw new Error("上传结果未确认");
          setQueue((current) =>
            current.map((entry) =>
              entry.candidate.candidateId === candidateId
                ? {
                    ...entry,
                    status: "succeeded",
                    artifact: operationResult!.artifact!,
                  }
                : entry,
            ),
          );
          completedArtifacts.push({ candidateId, candidateName: item.candidate.name, artifact: operationResult.artifact });
        } catch (err) {
          const reason = message(err);
          setQueue((current) =>
            current.map((entry) =>
              entry.candidate.candidateId === candidateId
                ? { ...entry, status: "failed", error: reason }
                : entry,
            ),
          );
        }
      }
    } finally {
      setQueueBusy(false);
      if (completedArtifacts.length) {
        if (artifactsCallback.current) artifactsCallback.current(completedArtifacts);
        else callback.current(completedArtifacts[completedArtifacts.length - 1].artifact);
      }
    }
  };
  const select = async () => {
    if (
      !selected ||
      !snapshot ||
      !filesReady ||
      expired ||
      Date.parse(snapshot.expiresAt) <= Date.now()
    )
      return;
    const key = operationId ?? id();
    const generation = epoch.current;
    setError(null);
    try {
      await selection.mutateAsync({
        candidateId: selected.candidateId,
        snapshotId: snapshot.snapshotId,
        operationId: key,
      });
      if (generation === epoch.current) {
        setSelectionUnknown(false);
        setOperationId(key);
        void qc.invalidateQueries({
          queryKey: [...prefix, session?.id, "operation", key],
        });
      }
    } catch (err) {
      if (generation !== epoch.current) return;
      const unknown =
        !(err instanceof ApiError) || err.status >= 500 || err.status === 408;
      if (unknown) {
        setSelectionUnknown(true);
        setOperationId(key);
      }
      setError(
        unknown
          ? `导入提交结果待确认：${message(err)}。正在查询同一操作，请勿重复创建。`
          : message(err),
      );
    }
  };
  const confirmDevice = async (input: unknown) => {
    const generation = epoch.current;
    try {
      await confirm.mutateAsync(input);
      if (generation === epoch.current) void status.refetch();
    } catch (err) {
      if (generation === epoch.current) setError(message(err));
    }
  };
  return {
    session: current,
    now,
    scope,
    setScope: (value: typeof scope) => {
      invalidate();
      setScope(value);
    },
    search,
    setSearch: (value: string) => {
      invalidate();
      setSearch(value);
    },
    source,
    setSource: (value: string) => {
      invalidate();
      setSource(value);
    },
    selected: current ? selected : null,
    preview: snapshot,
    allFiles,
    filesReady,
    candidates,
    files,
    canRetryFiles,
    retryFiles,
    operation,
    operationId,
    selectionUnknown: selectionUnknown && !operation.data?.operation,
    start,
    cancel,
    choose,
    select,
    toggleCandidate,
    clearSelectedCandidates,
    removeSelectedCandidate,
    importSelected,
    selectedCandidates,
    queue,
    queueBusy,
    confirmDevice,
    confirm,
    create,
    selection,
    requestPreview,
    devices,
    revoke,
    revokeDevice: (deviceId: string) => revoke.mutate({ deviceId, owner }),
    showDevices,
    setShowDevices,
    config,
    expired,
    active,
    error:
      (selectionUnknown && operation.data?.operation ? null : error) ??
      (status.error
        ? message(status.error)
        : preview.error
          ? message(preview.error)
          : candidates.error
            ? message(candidates.error)
            : operation.error
              ? message(operation.error)
              : files.error
                ? message(files.error)
                : (preview.data?.errorCode ?? null)),
    invalidate,
    previewFailed: ["failed", "superseded"].includes(
      preview.data?.previewStatus ?? "",
    ),
    snapshotExpired: !!snapshot && Date.parse(snapshot.expiresAt) <= now,
  };
}
