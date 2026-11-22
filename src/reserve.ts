import type { z } from 'zod';

import { compact, range, union } from 'es-toolkit';

import type { PortoConfig } from './config';
import type { Registry, ReservationRecord } from './registry';
import type { KeepPredicate, KeepSlot, OPTIONS_SCHEMA } from './schemas';
import type { SlotVars, Vars, VarsResult } from './vars';

import { BusyPortsError } from './busy-ports-error';
import { applyReserveDefaults } from './config';
import { PortoError } from './error';
import { ensureWorktreeId, fetchGitContext } from './git';
import { buildSlot, checkHasBusyPort, listBusyPorts } from './ports';
import { checkIsExpired, slotEntries, updateRegistry } from './registry';
import { parseOptions } from './schemas';
import { assertVarsFit, formatEnvironment, mapSlotToVars, parseVarEntries } from './vars';

type ReservedSlot<Entries extends Vars = Vars> = Omit<ReturnType<typeof buildSlot<ReservationRecord>>, 'vars'> & {
  vars: Entries extends readonly [] ? { SLOT: number } : VarsResult<Entries>;
};
type ReserveOptions = Partial<z.output<typeof OPTIONS_SCHEMA>> & { vars?: undefined | Vars };

async function allocateRecord(registry: Registry, options: Omit<ReservationRecord, 'firstPort' | 'lastPort' | 'vars'>) {
  const { portsPerSlot, slots, startPort } = registry;
  const slotsCount = Math.floor((65_536 - startPort) / portsPerSlot);
  for (let index = 0; index < slotsCount; index += 1) {
    const firstPort = startPort + index * portsPerSlot;
    const lastPort = firstPort + portsPerSlot - 1;
    const isOccupied = slots[index] !== undefined;
    // Check candidates in order without opening thousands of sockets at once.
    // oxlint-disable-next-line no-await-in-loop
    if (!isOccupied && !(await checkHasBusyPort(firstPort, lastPort, options.host))) {
      const record = { ...options, firstPort, lastPort, vars: {} };
      slots[index] = record;
      return { index, record };
    }
  }
  throw new PortoError('slotUnavailable');
}

function isAddressUnavailableError(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EADDRNOTAVAIL' ||
      error.code === 'EAFNOSUPPORT' ||
      error.code === 'ENETUNREACH' ||
      error.code === 'EHOSTUNREACH' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN')
  );
}

function issuePorts(record: ReservationRecord, index: number, entries: Vars) {
  const { firstPort } = record;
  // SLOT is the default only when no other variables are mapped; otherwise map it explicitly.
  record.vars = entries.length === 0 ? { SLOT: index } : mapSlotToVars({ firstPort, index }, entries);
  record.ports = union(record.ports, range(firstPort, firstPort + entries.length));
  return buildSlot(record, index);
}

async function releaseRecord(registry: Registry, index: number, record: ReservationRecord, force = false) {
  if (!force) {
    const busyPorts = await listBusyPorts(record.firstPort, record.lastPort, { host: record.host });
    if (busyPorts.length > 0) throw new BusyPortsError(busyPorts.map((port) => ({ port, slot: index })));
  }
  // oxlint-disable-next-line typescript/no-dynamic-delete -- Slot indices are dynamic by design.
  delete registry.slots[index];
  return buildSlot(record, index);
}

async function removeExpiredRecords(registry: Registry, now: number, excludeIndex = -1) {
  const expiredSlots = compact(
    await Promise.all(
      slotEntries(registry.slots)
        .filter(({ index, record }) => index !== excludeIndex && checkIsExpired(record, now))
        .map(async ({ index, record }) => {
          const hasBusyPort = await checkHasBusyPort(record.firstPort, record.lastPort, record.host).catch(
            (error: unknown) => {
              // A slot whose saved host is gone from this machine must not block
              // Other worktrees: keep it and continue with the remaining slots.
              if (isAddressUnavailableError(error)) return true;
              throw error;
            },
          );
          return hasBusyPort ? undefined : buildSlot(record, index);
        }),
    ),
  );
  for (const { index } of expiredSlots) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- Slot indices are dynamic by design.
    delete registry.slots[index];
  }
  return expiredSlots;
}

async function resolveKeep(keep: boolean | KeepPredicate | undefined, slot: KeepSlot, fallback: () => boolean) {
  if (typeof keep === 'function') {
    const kept = await keep(slot);
    if (typeof kept !== 'boolean') {
      throw new PortoError('optionsInvalid', 'keep: keep predicate must return a boolean.');
    }
    return kept;
  }
  return keep ?? fallback();
}
function snapshotSlotForKeep(slot: Parameters<KeepPredicate>[0]): KeepSlot {
  // The predicate only observes the slot: any mutation must not reach the saved record.
  const snapshot = { ...slot, ports: [...slot.ports], vars: { ...slot.vars } };
  Object.freeze(snapshot.ports);
  Object.freeze(snapshot.vars);
  return Object.freeze(snapshot) as KeepSlot;
}
function commitReservation(
  { commonDirectory, gitDirectory, worktreeId, worktreePath }: Awaited<ReturnType<typeof fetchGitContext>>,
  { vars: entries, ...options }: Omit<PortoConfig, 'onReleased' | 'onReserved'>,
  validation?: { envFormat?: boolean },
  onSaved?: (vars: SlotVars) => Promise<void> | void,
) {
  return updateRegistry(
    commonDirectory,
    async (registry) => {
      const vars = entries ?? [];
      const { env, envPath, host, idleTtlMinutes, jsonPath, keep, silent, size, start } = applyReserveDefaults(
        options,
        registry,
      );
      assertVarsFit(vars.length, size);
      // Created under the registry lock so parallel first calls share one ID.
      // Created after cheap validation so invalid options leave no ID file behind.
      const resolvedWorktreeId = worktreeId ?? (await ensureWorktreeId(gitDirectory));
      if ((registry.startPort !== start || registry.portsPerSlot !== size) && Object.keys(registry.slots).length > 0) {
        throw new PortoError('rangeMismatch');
      }
      registry.startPort = start;
      registry.portsPerSlot = size;
      const now = Date.now();
      const existingEntry = slotEntries(registry.slots).find(({ record }) => record.worktreeId === resolvedWorktreeId);
      const existingIndex = existingEntry === undefined ? -1 : existingEntry.index;
      const existingRecord = existingEntry?.record;
      const lastUsedAt = new Date(now).toISOString();
      const previousKeep = existingRecord?.keep ?? false;
      const baseSettings = {
        env,
        envPath,
        host: host ?? existingRecord?.host,
        idleTtlMinutes,
        jsonPath,
        lastUsedAt,
        silent,
        worktreePath,
      };
      if (existingRecord) {
        Object.assign(existingRecord, baseSettings, {
          expiresAt: new Date(now + idleTtlMinutes * 60_000).toISOString(),
        });
      }
      // The slot being reserved is touched above, so it must survive idle cleanup by index.
      await removeExpiredRecords(registry, now, existingIndex);
      const { index, record } = existingRecord
        ? { index: existingIndex, record: existingRecord }
        : await allocateRecord(registry, {
            ...baseSettings,
            expiresAt: new Date(now + idleTtlMinutes * 60_000).toISOString(),
            keep: false,
            ports: [],
            worktreeId: resolvedWorktreeId,
          });
      // A failed factory must leave the registry untouched.
      const slot = issuePorts(record, index, vars);
      if (validation?.envFormat) {
        // Fail before the registry is written: env output must be able to render every value.
        formatEnvironment(record.vars);
      }
      // Keep is resolved after variables are mapped so predicates can use slot.vars.
      record.keep = await resolveKeep(keep, snapshotSlotForKeep(slot), () => previousKeep);
      // The returned slot must carry the resolved keep value instead of the pre-resolution one.
      return buildSlot(record, index);
    },
    {
      afterSave: async (_registry, slot) => {
        // Registry is already saved; exports run under the same lock so a
        // Concurrent reserve cannot interleave registry and file contents.
        // If an export fails the reservation stays and the command reports it.
        if (onSaved) await onSaved(slot.vars);
      },
    },
  );
}
async function reserve<const Entries extends Vars>(
  options: ReserveOptions & { vars: Entries },
): Promise<ReservedSlot<Entries>>;
async function reserve(options?: ReserveOptions): Promise<ReservedSlot>;
async function reserve(options: ReserveOptions = {}) {
  const { vars: entries, ...optionsWithoutVars } = options;
  const vars = entries === undefined ? undefined : parseVarEntries(entries);
  const git = await fetchGitContext();
  return commitReservation(git, { ...parseOptions(optionsWithoutVars), vars });
}
export { commitReservation, releaseRecord, removeExpiredRecords, reserve };
export type { ReserveOptions };
