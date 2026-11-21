import type { z } from 'zod';

import { range, union } from 'es-toolkit';

import type { PortoConfig } from './config';
import type { Registry, ReservationRecord } from './registry';
import type { OPTIONS_SCHEMA } from './schemas';
import type { Vars, VarsResult } from './vars';

import { BusyPortsError } from './busy-ports-error';
import { applyReserveDefaults } from './config';
import { PortoError } from './error';
import { fetchGitContext } from './git';
import { buildSlot, checkHasBusyPort, listBusyPorts } from './ports';
import { updateRegistry } from './registry';
import { parseOptions } from './schemas';
import { assertVarsFit, mapSlotToVars, parseVarEntries } from './vars';

type ReservedSlot<Entries extends Vars = Vars> = Omit<ReturnType<typeof buildSlot<ReservationRecord>>, 'vars'> & {
  vars: VarsResult<Entries> & { PORTO_SLOT: number };
};
type ReserveOptions = Partial<z.output<typeof OPTIONS_SCHEMA>> & { vars?: undefined | Vars };

async function allocateRecord(registry: Registry, options: Omit<ReservationRecord, 'firstPort' | 'lastPort' | 'vars'>) {
  const { portsPerSlot, slots, startPort } = registry;
  const slotsCount = Math.floor((65_536 - startPort) / portsPerSlot);
  for (let index = 0; index < slotsCount; index += 1) {
    const firstPort = startPort + index * portsPerSlot;
    const lastPort = firstPort + portsPerSlot - 1;
    // Check candidates in order without opening thousands of sockets at once.
    // oxlint-disable-next-line no-await-in-loop
    if (!slots[index] && !(await checkHasBusyPort(firstPort, lastPort, options.host))) {
      const record = { ...options, firstPort, lastPort, vars: { PORTO_SLOT: index } };
      slots[index] = record;
      return { index, record };
    }
  }
  throw new PortoError('slotUnavailable');
}

function checkIsExpired(record: Pick<ReservationRecord, 'expiresAt'>, now: number) {
  return record.expiresAt !== null && now > Date.parse(record.expiresAt);
}

function issuePorts(record: ReservationRecord, index: number, entries: Vars) {
  const { firstPort } = record;
  record.vars = { ...mapSlotToVars({ firstPort, index }, entries), PORTO_SLOT: index };
  record.ports = union(record.ports, range(firstPort, firstPort + entries.length));
  return buildSlot(record, index);
}

async function releaseRecord(registry: Registry, index: number, record: ReservationRecord) {
  const busyPorts = await listBusyPorts(record.firstPort, record.lastPort, { host: record.host });
  if (busyPorts.length > 0) throw new BusyPortsError(busyPorts.map((port) => ({ port, slot: index })));
  // oxlint-disable-next-line unicorn/no-null -- Removing a slot must preserve other slot indices.
  registry.slots[index] = null;
  return buildSlot(record, index);
}

async function removeExpiredRecords(registry: Registry, now: number) {
  const checkedSlots = await Promise.all(
    registry.slots.flatMap((record, index) => {
      if (record === null || !checkIsExpired(record, now)) return [];
      return [
        checkHasBusyPort(record.firstPort, record.lastPort, record.host).then((hasBusyPort) =>
          hasBusyPort ? undefined : buildSlot(record, index),
        ),
      ];
    }),
  );
  const expiredSlots = checkedSlots.filter((slot) => slot !== undefined);
  for (const { index } of expiredSlots) {
    // oxlint-disable-next-line unicorn/no-null -- Removing a slot must preserve other slot indices.
    registry.slots[index] = null;
  }
  return expiredSlots;
}

function commitReservation<Result>(
  { commonDirectory, worktreeId, worktreePath }: Awaited<ReturnType<typeof fetchGitContext>>,
  { vars = [], ...options }: Omit<PortoConfig, 'onReleased' | 'onReserved'>,
  prepare: (slot: ReturnType<typeof issuePorts>) => Promise<Result> | Result,
) {
  return updateRegistry(commonDirectory, async (registry) => {
    const { env, envFile, host, idleTtlMinutes, jsonFile, keep, silent, size, start } = applyReserveDefaults(
      options,
      registry,
    );
    assertVarsFit(vars.length, size);
    if (
      (registry.startPort !== start || registry.portsPerSlot !== size) &&
      registry.slots.some((record) => record !== null)
    ) {
      throw new PortoError('rangeMismatch');
    }
    registry.startPort = start;
    registry.portsPerSlot = size;
    const now = Date.now();
    const existingIndex = registry.slots.findIndex((record) => record?.worktreeId === worktreeId);
    const existingRecord = registry.slots[existingIndex];
    const lastUsedAt = new Date(now).toISOString();
    const isKept = keep ?? existingRecord?.keep ?? false;
    const settings = {
      env,
      envFile,
      // oxlint-disable-next-line unicorn/no-null -- JSON uses null for a slot with no expiry.
      expiresAt: isKept ? null : new Date(now + idleTtlMinutes * 60_000).toISOString(),
      host: host ?? existingRecord?.host,
      idleTtlMinutes,
      jsonFile,
      keep: isKept,
      lastUsedAt,
      silent,
      worktreePath,
    };
    if (existingRecord) {
      Object.assign(existingRecord, settings);
    }
    await removeExpiredRecords(registry, now);
    const { index, record } = existingRecord
      ? { index: existingIndex, record: existingRecord }
      : await allocateRecord(registry, { ...settings, ports: [], worktreeId });
    // A failed factory must leave the registry untouched.
    return prepare(issuePorts(record, index, vars));
  });
}

async function reserve<const Entries extends Vars>(
  options: ReserveOptions & { vars: Entries },
): Promise<ReservedSlot<Entries>>;
async function reserve(options?: ReserveOptions): Promise<ReservedSlot>;
async function reserve(options: ReserveOptions = {}) {
  const { vars: entries, ...optionsWithoutVars } = options;
  const vars = entries === undefined ? undefined : parseVarEntries(entries);
  const git = await fetchGitContext();
  return commitReservation(git, { ...parseOptions(optionsWithoutVars), vars }, (slot) => slot);
}

export { checkIsExpired, commitReservation, releaseRecord, removeExpiredRecords, reserve };
export type { ReserveOptions };
