'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  priority: number;
  startTime?: string;
  endTime?: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: {
    id: string;
    email: string;
    name: string | null;
  };
}

export interface CreateAnnouncementDto {
  title: string;
  content: string;
  type: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  priority?: number;
  startTime?: string;
  endTime?: string;
  published?: boolean;
}

export interface UpdateAnnouncementDto {
  title?: string;
  content?: string;
  type?: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  priority?: number;
  startTime?: string;
  endTime?: string;
  published?: boolean;
}

export interface AnnouncementListResponse {
  data: Announcement[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Public API - Get active announcements (no auth required)
export function useActiveAnnouncements() {
  return useQuery({
    queryKey: ['announcements', 'active'],
    queryFn: async () => {
      const response = await fetch('/api/announcements/active');
      if (!response.ok) {
        throw new Error('Failed to fetch active announcements');
      }
      return response.json() as Promise<Announcement[]>;
    },
  });
}

// Admin API - Get all announcements
export function useAnnouncements(page = 1, pageSize = 20, filters?: { keyword?: string; type?: Announcement['type']; published?: boolean; activeAt?: string }) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filters?.keyword) params.set('keyword', filters.keyword);
  if (filters?.type) params.set('type', filters.type);
  if (filters?.published !== undefined) params.set('published', String(filters.published));
  if (filters?.activeAt) params.set('activeAt', filters.activeAt);
  return useQuery({
    queryKey: ['admin', 'announcements', page, pageSize, filters],
    queryFn: async () => {
      return api.get<AnnouncementListResponse>(
        `/admin/announcements?${params.toString()}`
      );
    },
  });
}

// Admin API - Get single announcement
export function useAnnouncement(id: string) {
  return useQuery({
    queryKey: ['admin', 'announcements', id],
    queryFn: async () => {
      return api.get<Announcement>(`/admin/announcements/${id}`);
    },
    enabled: !!id,
  });
}

// Admin API - Create announcement
export function useCreateAnnouncement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateAnnouncementDto) => {
      return api.post<Announcement>('/admin/announcements', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      queryClient.invalidateQueries({ queryKey: ['announcements', 'active'] });
    },
  });
}

// Admin API - Update announcement
export function useUpdateAnnouncement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateAnnouncementDto }) => {
      return api.patch<Announcement>(`/admin/announcements/${id}`, data);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['announcements', 'active'] });
    },
  });
}

// Admin API - Delete announcement
export function useDeleteAnnouncement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/announcements/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      queryClient.invalidateQueries({ queryKey: ['announcements', 'active'] });
    },
  });
}

// Admin API - Toggle publish status
export function useTogglePublish() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, published }: { id: string; published: boolean }) => {
      return api.patch<Announcement>(
        `/admin/announcements/${id}/publish`,
        { published }
      );
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['announcements', 'active'] });
    },
  });
}
