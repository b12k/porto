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
    return Object.entries(slots).flatMap(([key, record]) => {
      const index = Number(key);
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
    if (slotIndex !== undefined) {
      const record = slots[slotIndex];
      return record ? buildSlot(record, slotIndex) : undefined;
    }
    const found = Object.entries(slots).find(([, record]) => record.worktreeId === worktreeId);
    return found ? buildSlot(found[1], Number(found[0])) : undefined;
  });
}

async function releaseAllSlots() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, async (registry) => {
    const releasedSlots: Array<PortSlot> = [];
    for (const [key, record] of Object.entries(registry.slots)) {
      const index = Number(key);
      // Keep every release in one transaction; a busy slot leaves the file unchanged.
      // oxlint-disable-next-line no-await-in-loop
      releasedSlots.push(await releaseRecord(registry, index, record));
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
    if (slotIndex !== undefined) {
      const record = registry.slots[slotIndex];
      return record ? releaseRecord(registry, slotIndex, record) : undefined;
    }
    const found = Object.entries(registry.slots).find(([, record]) => record.worktreeId === worktreeId);
    return found ? releaseRecord(registry, Number(found[0]), found[1]) : undefined;
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
