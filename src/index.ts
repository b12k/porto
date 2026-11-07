import { remove, sortBy } from 'es-toolkit';

import type { ReservationRecord } from './registry';

import { BusyPortsError } from './busy-ports-error';
import { PortoError } from './error';
import { fetchGitContext } from './git';
import { buildBlock, listBusyPorts } from './ports';
import { updateRegistry } from './registry';
import { parseOptions } from './schemas';

export type PortBlock = ReturnType<typeof buildBlock>;
export type ReservationStats = Awaited<ReturnType<typeof stats>>[number];
export type ReserveOptions = Partial<ReturnType<typeof parseOptions>>;

export { BusyPortsError } from './busy-ports-error';
export { defineConfig } from './config';
export type { PortoConfig } from './config';
export { PortoError } from './error';
export type { VarFactory, Vars } from './vars';

function checkIsExpired(record: ReservationRecord, now: number) {
  return !record.keep && now - Date.parse(record.lastUsedAt) > record.idleTtlMinutes * 60_000;
}

export async function stats() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, (records) =>
    sortBy(
      records.map((record) => {
        const { end, start } = buildBlock(record);
        return { ...record, end, isExpired: checkIsExpired(record, Date.now()), start };
      }),
      ['start', 'worktree'],
    ),
  );
}

async function removeExpiredRecords(records: ReservationRecord[], now: number) {
  const candidates = await Promise.all(
    records
      .filter((record) => checkIsExpired(record, now))
      .map(async (record) => {
        const { end, start } = buildBlock(record);
        return { busyPorts: await listBusyPorts(start, end), record };
      }),
  );
  const expiredRecords = candidates.filter(({ busyPorts }) => busyPorts.length === 0).map(({ record }) => record);
  remove(records, (record) => expiredRecords.includes(record));
  return expiredRecords.map((record) => buildBlock(record));
}

export async function cleanup() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (records) => removeExpiredRecords(records, Date.now()));
}

export async function current() {
  const { commonDirectory, worktree } = await fetchGitContext();
  return updateRegistry(commonDirectory, (records) =>
    records.filter((record) => record.worktree === worktree).map((record) => buildBlock(record)),
  );
}

export async function release() {
  const { commonDirectory, worktree } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (records) => {
    const currentRecords = records.filter((record) => record.worktree === worktree);
    const portsByRecord = await Promise.all(
      currentRecords.map(async (record) => {
        const block = buildBlock(record);
        const ports = await listBusyPorts(block.start, block.end);
        return ports.map((port) => ({ block: block.index, port }));
      }),
    );
    const busyPorts = portsByRecord.flat();
    if (busyPorts.length > 0) throw new BusyPortsError(busyPorts);
    remove(records, (record) => record.worktree === worktree);
    return currentRecords.map((record) => buildBlock(record));
  });
}

async function allocateRecord(records: ReservationRecord[], options: Omit<ReservationRecord, 'index'>) {
  for (let index = 0; options.start + (index + 1) * options.size - 1 <= 65_535; index += 1) {
    const record = { ...options, index };
    const block = buildBlock(record);
    const hasOverlap = records.some((reserved) => {
      const reservedBlock = buildBlock(reserved);
      return block.start <= reservedBlock.end && block.end >= reservedBlock.start;
    });
    if (!hasOverlap) {
      // Probe candidates in order without opening thousands of sockets at once.
      // oxlint-disable-next-line no-await-in-loop
      const busyPorts = await listBusyPorts(block.start, block.end);
      if (busyPorts.length === 0) return record;
    }
  }
  throw new PortoError('blockUnavailable');
}

export async function reserve(options: ReserveOptions = {}) {
  const { idleTtlMinutes, keep, size, start } = parseOptions(options);
  const { commonDirectory, worktree } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (records) => {
    const now = Date.now();
    const existingRecord = records.find(
      (record) => record.worktree === worktree && record.start === start && record.size === size,
    );
    const lastUsedAt = new Date(now).toISOString();
    if (existingRecord) {
      Object.assign(existingRecord, { idleTtlMinutes, keep: keep ?? existingRecord.keep, lastUsedAt });
    }
    await removeExpiredRecords(records, now);
    const record =
      existingRecord ??
      (await allocateRecord(records, { idleTtlMinutes, keep: keep ?? false, lastUsedAt, size, start, worktree }));
    if (!existingRecord) records.push(record);
    return buildBlock(record);
  });
}
