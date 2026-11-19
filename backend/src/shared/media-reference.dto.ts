import { z } from 'zod';

export const MEDIA_REFERENCE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MediaReferenceMimeTypeSchema = z.enum(MEDIA_REFERENCE_MIME_TYPES);
export type MediaReferenceMimeType = z.infer<typeof MediaReferenceMimeTypeSchema>;

export const MAX_MEDIA_REFERENCE_COUNT = 32;
export const MAX_MEDIA_REFERENCE_TOTAL_BYTES = 100 * 1024 * 1024;
export const MediaReferenceCountSchema = z.number().int().min(0).max(MAX_MEDIA_REFERENCE_COUNT);
export type MediaJsonValue = string | number | boolean | null | MediaJsonValue[] | { [key: string]: MediaJsonValue };
export const MediaJsonValueSchema: z.ZodType<MediaJsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(MediaJsonValueSchema), z.record(MediaJsonValueSchema),
]));
export const MediaUpstreamErrorSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: MediaJsonValueSchema,
  headers: z.record(z.string()).optional(),
}).strict();
export type MediaUpstreamError = z.infer<typeof MediaUpstreamErrorSchema>;
