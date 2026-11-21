import path from 'node:path';
import { z } from 'zod';

import type { PortSlot } from './index';

import { PortoError } from './error';
import { VAR_VALUES_SCHEMA } from './vars';

const SLOT_HOOK_SCHEMA = z.custom<(slot: PortSlot, ports: Array<number>) => Promise<void> | void>(
  (hook) => typeof hook === 'function',
);

const HOOKS_SCHEMA = z.object({ onReleased: SLOT_HOOK_SCHEMA, onReserved: SLOT_HOOK_SCHEMA });

const OUTPUT_OPTIONS_SCHEMA = z.object({
  env: z.boolean(),
  envFile: z.string().min(1),
  jsonFile: z.union([z.literal(false), z.string().min(1)]),
  silent: z.boolean(),
});

const PORT_SCHEMA = z.int().min(1).max(65_535);
const OPTIONS_SCHEMA = z.object({
  host: z.string().trim().min(1).optional(),
  idleTtlMinutes: z.number().positive(),
  keep: z.boolean().optional(),
  size: PORT_SCHEMA,
  start: PORT_SCHEMA,
});
const INPUT_OPTIONS_SCHEMA = OPTIONS_SCHEMA.partial();

const RECORD_SCHEMA = z
  .object({
    ...OUTPUT_OPTIONS_SCHEMA.shape,
    expiresAt: z.iso.datetime().nullable(),
    firstPort: PORT_SCHEMA,
    host: OPTIONS_SCHEMA.shape.host,
    idleTtlMinutes: OPTIONS_SCHEMA.shape.idleTtlMinutes,
    keep: z.boolean(),
    lastPort: PORT_SCHEMA,
    lastUsedAt: z.iso.datetime(),
    ports: z
      .array(z.int())
      .refine((ports) => new Set(ports).size === ports.length, { message: 'Assigned ports must be unique.' }),
    vars: VAR_VALUES_SCHEMA,
    worktreeId: z.string().min(1),
    worktreePath: z.string().refine((worktreePath) => path.isAbsolute(worktreePath)),
  })
  .refine((record) => record.ports.every((port) => port >= record.firstPort && port <= record.lastPort), {
    message: 'Assigned ports must belong to the slot.',
    path: ['ports'],
  })
  .refine((record) => record.keep === (record.expiresAt === null), {
    message: 'Kept slots must have no expiry time.',
    path: ['expiresAt'],
  });

type ReservationRecord = z.output<typeof RECORD_SCHEMA>;

const REGISTRY_SCHEMA = z
  .object({ portsPerSlot: PORT_SCHEMA, slots: z.array(RECORD_SCHEMA.nullable()), startPort: PORT_SCHEMA })
  .refine(({ portsPerSlot, slots, startPort }) => startPort + Math.max(slots.length, 1) * portsPerSlot - 1 <= 65_535, {
    message: 'Port slots must fit in the TCP port range.',
  })
  .refine(
    ({ slots }) => {
      const records = slots.filter((record) => record !== null);
      return new Set(records.map((record) => record.worktreeId)).size === records.length;
    },
    { message: 'Each worktree can have only one slot.' },
  )
  .refine(
    ({ portsPerSlot, slots, startPort }) =>
      slots.every(
        (record, index) =>
          record === null ||
          (record.firstPort === startPort + index * portsPerSlot &&
            record.lastPort === record.firstPort + portsPerSlot - 1 &&
            record.vars.PORTO_SLOT === index),
      ),
    { message: 'Slot bounds and PORTO_SLOT must match its array index and the repository range.' },
  );

type Registry = z.output<typeof REGISTRY_SCHEMA>;

function parseOptions(options: unknown) {
  const result = INPUT_OPTIONS_SCHEMA.safeParse(options);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new PortoError('optionsInvalid', details, { cause: result.error });
  }
  return result.data;
}

export { HOOKS_SCHEMA, OPTIONS_SCHEMA, OUTPUT_OPTIONS_SCHEMA, parseOptions, REGISTRY_SCHEMA };
export type { Registry, ReservationRecord };
