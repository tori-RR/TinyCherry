import * as z from 'zod'

import { FileEntrySchema } from '@shared/data/types/file'
import { UniqueModelIdSchema } from '@shared/data/types/model'
import { PaintingSchema } from '@shared/data/types/painting'

import { defineRoute } from '../define'

/** Painting work is asynchronous: no billable request lives on the UI RPC timeout. */
export const PaintingJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  uniqueModelId: UniqueModelIdSchema,
  prompt: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  paintingId: z.string().optional(),
  error: z.string().optional()
})
export type PaintingJob = z.infer<typeof PaintingJobSchema>

export const PaintingModelSchema = z.object({
  id: UniqueModelIdSchema,
  name: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  protocol: z.enum(['openai', 'gemini', 'zhipu', 'silicon']),
  canEdit: z.boolean(),
  maxImages: z.int().positive(),
  maxInputs: z.int().nonnegative(),
  sizes: z.array(z.string()),
  qualities: z.array(z.string()),
  formats: z.array(z.string()),
  aspectRatios: z.array(z.string())
})
export type PaintingModel = z.infer<typeof PaintingModelSchema>

export const paintingRequestSchemas = {
  'painting.models': defineRoute({ input: z.void(), output: z.array(PaintingModelSchema) }),
  'painting.generate.start': defineRoute({
    input: z.strictObject({
      requestId: z.uuid(),
      uniqueModelId: UniqueModelIdSchema,
      prompt: z.string().trim().min(1).max(32_000),
      inputFileIds: z.array(z.uuid()).max(4).default([]),
      params: z.strictObject({
        size: z.string().max(40).optional(),
        quality: z.enum(['auto', 'low', 'medium', 'high', 'standard', 'hd']).optional(),
        n: z.int().min(1).max(4).default(1),
        outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(),
        aspectRatio: z.string().max(10).optional()
      })
    }),
    output: PaintingJobSchema
  }),
  'painting.generate.list': defineRoute({ input: z.void(), output: z.array(PaintingJobSchema) }),
  'painting.generate.abort': defineRoute({
    input: z.strictObject({ requestId: z.uuid() }),
    output: PaintingJobSchema
  }),
  'painting.file.upload.begin': defineRoute({
    input: z.strictObject({
      name: z.string().min(1).max(200),
      size: z
        .int()
        .positive()
        .max(20 * 1024 * 1024)
    }),
    output: z.object({ uploadId: z.uuid() })
  }),
  'painting.file.upload.chunk': defineRoute({
    input: z.strictObject({ uploadId: z.uuid(), offset: z.int().nonnegative(), data: z.string().max(256 * 1024) }),
    output: z.object({ offset: z.int().nonnegative() })
  }),
  'painting.file.upload.finish': defineRoute({
    input: z.strictObject({ uploadId: z.uuid() }),
    output: FileEntrySchema
  }),
  'painting.file.upload.abort': defineRoute({
    input: z.strictObject({ uploadId: z.uuid() }),
    output: z.void()
  }),
  'painting.file.read': defineRoute({
    input: z.strictObject({
      fileId: z.uuid(),
      offset: z.int().nonnegative().default(0),
      thumbnail: z.boolean().optional()
    }),
    output: z.object({
      data: z.string(),
      mime: z.string(),
      size: z.int().nonnegative(),
      nextOffset: z.int().nonnegative(),
      done: z.boolean(),
      name: z.string()
    })
  }),
  'painting.file.release': defineRoute({
    input: z.strictObject({ fileId: z.uuid() }),
    output: z.void()
  }),
  // The host alone consumes path; renderer export goes through a native Save dialog.
  'painting.file.path': defineRoute({
    input: z.strictObject({ fileId: z.uuid() }),
    output: z.object({ path: z.string(), name: z.string(), mime: z.string(), size: z.int().nonnegative() })
  }),
  'painting.file.export': defineRoute({
    input: z.strictObject({ fileId: z.uuid() }),
    output: z.object({ saved: z.boolean() })
  })
}

export { PaintingSchema }
