import path from 'node:path';
import { z } from 'zod';

import type { PortBlock } from './index';

import { PortoError } from './error';

const BLOCK_HOOK_SCHEMA = z.custom<(block: PortBlock, ports: number[]) => Promise<void> | void>(
  (hook) => typeof hook === 'function',
);

export const HOOKS_SCHEMA = z.object({ onReleased: BLOCK_HOOK_SCHEMA, onReserved: BLOCK_HOOK_SCHEMA });

export const OPTIONS_SCHEMA = z
  .object({
    host: z.string().trim().min(1).optional(),
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
    start: OPTIONS_SCHEMA.shape.start.default(10_000),
  })
  .pipe(OPTIONS_SCHEMA);

const RECORD_SCHEMA = OPTIONS_SCHEMA.safeExtend({
  index: z.int().nonnegative(),
  keep: z.boolean(),
  lastUsedAt: z.iso.datetime(),
  ports: z
    .array(z.int().min(1).max(65_535))
    .refine((ports) => new Set(ports).size === ports.length, { message: 'Assigned ports must be unique.' }),
  worktree: z.string().refine((worktree) => path.isAbsolute(worktree)),
  worktreeId: z.string().min(1),
})
  .refine((record) => record.start + (record.index + 1) * record.size - 1 <= 65_535, {
    message: 'Block must fit in the TCP port range.',
    path: ['index'],
  })
  .refine(
    (record) =>
      record.ports.every(
        (port) =>
          port >= record.start + record.index * record.size && port < record.start + (record.index + 1) * record.size,
      ),
    { message: 'Assigned ports must belong to the block.', path: ['ports'] },
  );

export const REGISTRY_SCHEMA = z
  .array(RECORD_SCHEMA)
  .refine(
    (records) =>
      new Set(records.map((record) => JSON.stringify([record.worktreeId, record.start, record.size]))).size ===
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
