import path from 'node:path';
import { z } from 'zod';

import { PortoError } from './error';

export const OPTIONS_SCHEMA = z
  .object({
    idleTtlMinutes: z.number().positive(),
    keep: z.boolean().optional(),
    size: z.int().min(1).max(65_535),
    start: z.int().min(1).max(65_535),
  })
  .refine((options) => options.start + options.size - 1 <= 65_535, {
    message: 'size must fit in the TCP port range.',
    path: ['size'],
  });

const INPUT_OPTIONS_SCHEMA = z
  .object({
    ...OPTIONS_SCHEMA.shape,
    idleTtlMinutes: OPTIONS_SCHEMA.shape.idleTtlMinutes.default(60),
    size: OPTIONS_SCHEMA.shape.size.default(10),
    start: OPTIONS_SCHEMA.shape.start.default(1000),
  })
  .pipe(OPTIONS_SCHEMA);

export const RECORD_SCHEMA = OPTIONS_SCHEMA.safeExtend({
  index: z.int().nonnegative(),
  keep: z.boolean().default(false),
  lastUsedAt: z.iso.datetime(),
  worktree: z.string().refine((worktree) => path.isAbsolute(worktree)),
}).refine((record) => record.start + (record.index + 1) * record.size - 1 <= 65_535, {
  message: 'Block must fit in the TCP port range.',
  path: ['index'],
});

export const REGISTRY_SCHEMA = z
  .array(RECORD_SCHEMA)
  .refine(
    (records) =>
      new Set(records.map((record) => JSON.stringify([record.worktree, record.start, record.size]))).size ===
      records.length,
    { message: 'Each checkout can have only one reservation per range.' },
  )
  .refine(
    (records) => {
      const sortedRecords = records.toSorted(
        (first, second) => first.start + first.index * first.size - second.start - second.index * second.size,
      );
      return sortedRecords.every((record, index) => {
        const previousRecord = sortedRecords[index - 1];
        return (
          !previousRecord ||
          previousRecord.start + (previousRecord.index + 1) * previousRecord.size <=
            record.start + record.index * record.size
        );
      });
    },
    { message: 'Reserved port blocks must not overlap.' },
  );

export function parseOptions(options: unknown) {
  const result = INPUT_OPTIONS_SCHEMA.safeParse(options);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new PortoError('optionsInvalid', details, { cause: result.error });
  }
  return result.data;
}
