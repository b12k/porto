import type { ReservationRecord } from './registry';

import { PortoError } from './error';
import { fetchGitContext, listWorktreePaths } from './git';
import { buildSlot } from './ports';
import { updateRegistry } from './registry';
import { checkIsExpired, releaseRecord, removeExpiredRecords } from './reserve';

type PortSlot = ReturnType<typeof buildSlot<ReservationRecord>>;
type ReservationStats = Omit<ReservationRecord, 'worktreeId'> & { index: number; isExpired: boolean };

async function cleanupSlots() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, (registry) => removeExpiredRecords(registry, Date.now()));
}

async function getAllSlots() {
  const { commonDirectory } = await fetchGitContext();
  const worktreePathsById = await listWorktreePaths(commonDirectory);
  return updateRegistry(commonDirectory, ({ slots }) => {
    const now = Date.now();
    return slots.flatMap((record, index) => {
      if (record === null) return [];
      const { worktreeId, ...slotFields } = record;
      const worktreePath = worktreePathsById.get(worktreeId) ?? record.worktreePath;
      return [
        { ...slotFields, index, isExpired: checkIsExpired(record, now), worktreePath } satisfies ReservationStats,
      ];
    });
  });
}

async function getSlot(slotIndex?: number) {
  if (slotIndex !== undefined && (!Number.isSafeInteger(slotIndex) || slotIndex < 0)) {
    throw new PortoError('slotIndexInvalid');
  }
  const { commonDirectory, worktreeId } = await fetchGitContext();
  return updateRegistry(commonDirectory, ({ slots }) => {
    const index = slotIndex ?? slots.findIndex((record) => record?.worktreeId === worktreeId);
    const record = index === -1 ? undefined : slots[index];
    return record ? buildSlot(record, index) : undefined;
  });
}

async function releaseAllSlots() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (registry) => {
    const releasedSlots: Array<PortSlot> = [];
    for (const [index, record] of registry.slots.entries()) {
      if (record !== null) {
        // Keep every release in one transaction; a busy slot leaves the file unchanged.
        // oxlint-disable-next-line no-await-in-loop
        releasedSlots.push(await releaseRecord(registry, index, record));
      }
    }
    return releasedSlots;
  });
}

async function releaseSlot(slotIndex?: number) {
  if (slotIndex !== undefined && (!Number.isSafeInteger(slotIndex) || slotIndex < 0)) {
    throw new PortoError('slotIndexInvalid');
  }
  const { commonDirectory, worktreeId } = await fetchGitContext();
  return updateRegistry(commonDirectory, (registry) => {
    const index = slotIndex ?? registry.slots.findIndex((record) => record?.worktreeId === worktreeId);
    const record = index === -1 ? undefined : registry.slots[index];
    return record ? releaseRecord(registry, index, record) : undefined;
  });
}

export { cleanupSlots, getAllSlots, getSlot, releaseAllSlots, releaseSlot };
export type { PortSlot, ReservationStats };
export { BusyPortsError } from './busy-ports-error';
export { defineConfig } from './config';
export type { PortoConfig } from './config';
export { PortoError } from './error';
export { reserve } from './reserve';
export type { ReserveOptions } from './reserve';
export type { VarFactory, Vars } from './vars';
