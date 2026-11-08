import { remove, sortBy } from 'es-toolkit';

import { BusyPortsError } from './busy-ports-error';
import { fetchGitContext, listWorktreePaths } from './git';
import { buildBlock, listBusyPorts } from './ports';
import { updateRegistry } from './registry';
import { checkIsExpired, removeExpiredRecords } from './reserve';

export type PortBlock = ReturnType<typeof buildBlock>;
export type ReservationStats = Awaited<ReturnType<typeof stats>>[number];

export { BusyPortsError } from './busy-ports-error';
export { defineConfig } from './config';
export type { PortoConfig } from './config';
export { PortoError } from './error';
export { reserve } from './reserve';
export type { ReserveOptions } from './reserve';
export type { VarFactory, Vars } from './vars';

export async function stats() {
  const { commonDirectory } = await fetchGitContext();
  const worktreePathsById = await listWorktreePaths(commonDirectory);
  return updateRegistry(commonDirectory, (records) =>
    sortBy(
      records.map(({ worktreeId, ...record }) => {
        const { end, start } = buildBlock(record);
        const worktree = worktreePathsById.get(worktreeId) ?? record.worktree;
        return { ...record, end, isExpired: checkIsExpired(record, Date.now()), start, worktree };
      }),
      ['start', 'worktree'],
    ),
  );
}

export async function cleanup() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (records) => removeExpiredRecords(records, Date.now()));
}

export async function current() {
  const { commonDirectory, worktreeId } = await fetchGitContext();
  return updateRegistry(commonDirectory, (records) =>
    records.filter((record) => record.worktreeId === worktreeId).map((record) => buildBlock(record)),
  );
}

export async function release() {
  const { commonDirectory, worktreeId } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (records) => {
    const currentRecords = records.filter((record) => record.worktreeId === worktreeId);
    const portsByRecord = await Promise.all(
      currentRecords.map(async (record) => {
        const block = buildBlock(record);
        const ports = await listBusyPorts(block.start, block.end, { host: record.host });
        return ports.map((port) => ({ block: block.index, port }));
      }),
    );
    const busyPorts = portsByRecord.flat();
    if (busyPorts.length > 0) throw new BusyPortsError(busyPorts);
    remove(records, (record) => record.worktreeId === worktreeId);
    return currentRecords.map((record) => Object.assign(buildBlock(record), { ports: record.ports }));
  });
}
