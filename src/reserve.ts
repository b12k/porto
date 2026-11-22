import type { z } from 'zod';

import { compact, range, union } from 'es-toolkit';

import type { PortoConfig } from './config';
import type { PortSlot } from './ports';
import type { Registry, ReservationRecord } from './registry';
import type { KeepPredicate, OPTIONS_SCHEMA } from './schemas';
import type { Vars, VarsResult } from './vars';

import { BusyPortsError } from './busy-ports-error';
import { applyReserveDefaults } from './config';
import { PortoError } from './error';
import { fetchGitContext } from './git';
import { buildSlot, checkHasBusyPort, listBusyPorts } from './ports';
import { slotEntries, updateRegistry } from './registry';
import { parseOptions } from './schemas';
import { assertVarsFit, mapSlotToVars, parseVarEntries } from './vars';

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

function checkIsExpired(record: Pick<ReservationRecord, 'expiresAt' | 'keep'>, now: number) {
  return !record.keep && now > Date.parse(record.expiresAt);
}

function issuePorts(record: ReservationRecord, index: number, entries: Vars) {
  const { firstPort } = record;
  // SLOT is the default only when no other variables are mapped; otherwise map it explicitly.
  record.vars = entries.length === 0 ? { SLOT: index } : mapSlotToVars({ firstPort, index }, entries);
  record.ports = union(record.ports, range(firstPort, firstPort + entries.length));
  return buildSlot(record, index);
}

async function removeExpiredRecords(registry: Registry, now: number) {
  const expiredSlots = compact(
    await Promise.all(
      slotEntries(registry.slots)
        .filter(({ record }) => checkIsExpired(record, now))
        .map(async ({ index, record }) =>
          (await checkHasBusyPort(record.firstPort, record.lastPort, record.host))
            ? undefined
            : buildSlot(record, index),
        ),
    ),
  );
  for (const { index } of expiredSlots) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- Slot indices are dynamic by design.
    delete registry.slots[index];
  }
  return expiredSlots;
}

async function resolveKeep(keep: boolean | KeepPredicate | undefined, slot: PortSlot, fallback: () => boolean) {
  if (typeof keep === 'function') {
    const kept = await keep(slot);
    if (typeof kept !== 'boolean') {
      throw new PortoError('optionsInvalid', 'keep: keep predicate must return a boolean.');
    }
    return kept;
  }
  return keep ?? fallback();
}

function commitReservation(
  { commonDirectory, worktreeId, worktreePath }: Awaited<ReturnType<typeof fetchGitContext>>,
  { vars = [], ...options }: Omit<PortoConfig, 'onReleased' | 'onReserved'>,
) {
  return updateRegistry(commonDirectory, async (registry) => {
    const { env, envFile, host, idleTtlMinutes, jsonFile, keep, silent, size, start } = applyReserveDefaults(
      options,
      registry,
    );
    assertVarsFit(vars.length, size);
    if ((registry.startPort !== start || registry.portsPerSlot !== size) && Object.keys(registry.slots).length > 0) {
      throw new PortoError('rangeMismatch');
    }
    registry.startPort = start;
    registry.portsPerSlot = size;
    const now = Date.now();
    const existingEntry = slotEntries(registry.slots).find(({ record }) => record.worktreeId === worktreeId);
    const existingIndex = existingEntry === undefined ? -1 : existingEntry.index;
    const existingRecord = existingEntry?.record;
    const lastUsedAt = new Date(now).toISOString();
    const previousKeep = existingRecord?.keep ?? false;
    const baseSettings = {
      env,
      envFile,
      host: host ?? existingRecord?.host,
      idleTtlMinutes,
      jsonFile,
      lastUsedAt,
      silent,
      worktreePath,
    };
    if (existingRecord) {
      // Guard the slot being reserved against idle cleanup; the final value is resolved below.
      Object.assign(existingRecord, baseSettings, {
        expiresAt: new Date(now + idleTtlMinutes * 60_000).toISOString(),
        keep: true,
      });
    }
    await removeExpiredRecords(registry, now);
    const { index, record } = existingRecord
      ? { index: existingIndex, record: existingRecord }
      : await allocateRecord(registry, {
          ...baseSettings,
          expiresAt: new Date(now + idleTtlMinutes * 60_000).toISOString(),
          keep: false,
          ports: [],
          worktreeId,
        });
    // A failed factory must leave the registry untouched.
    const slot = issuePorts(record, index, vars);
    // Keep is resolved after variables are mapped so predicates can use slot.vars.
    record.keep = await resolveKeep(keep, slot, () => previousKeep);
    return slot;
  });
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
export { checkIsExpired, commitReservation, releaseRecord, removeExpiredRecords, reserve };
export type { ReserveOptions };
