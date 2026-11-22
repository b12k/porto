import { rm } from 'node:fs/promises';

import type { BusyPort } from './busy-ports-error';
import type { PortSlot } from './ports';
import type { Registry, ReservationRecord } from './registry';

import { BusyPortsError } from './busy-ports-error';
import { LOOPBACK_HOST } from './config';
import { PortoError } from './error';
import { fetchGitContext, listWorktreePaths } from './git';
import { PartialReleaseError } from './partial-release-error';
import { buildSlot, listBusyPorts } from './ports';
import {
  assertRegistryWriteAllowed,
  checkIsExpired,
  fetchRegistry,
  getRegistryPath,
  lockRegistryFile,
  slotEntries,
  updateRegistry,
} from './registry';
import { isAddressUnavailableError, releaseRecord, removeExpiredRecords } from './reserve';

type ReservationStats = Omit<ReservationRecord, 'worktreeId'> & { index: number; isExpired: boolean };

function assertSlotIndexValid(slotIndex: number) {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new PortoError('slotIndexInvalid');
  }
}

async function cleanupSlots() {
  const { commonDirectory } = await fetchGitContext();
  return updateRegistry(commonDirectory, (registry) => removeExpiredRecords(registry, Date.now()));
}

async function destroy(force = false) {
  const { commonDirectory } = await fetchGitContext();
  const filePath = getRegistryPath(commonDirectory);
  assertRegistryWriteAllowed(filePath);
  const unlock = await lockRegistryFile(filePath);
  try {
    const registry = await fetchRegistry(filePath);
    if (!force) {
      const busyPorts: Array<BusyPort> = [];
      for (const { index, record } of slotEntries(registry.slots)) {
        // Report every busy slot at once instead of failing on the first one.
        // oxlint-disable-next-line no-await-in-loop
        const busy = await listBusyPorts(record.firstPort, record.lastPort, { host: record.host ?? LOOPBACK_HOST });
        busyPorts.push(...busy.map((port) => ({ port, slot: index })));
      }
      if (busyPorts.length > 0) throw new BusyPortsError(busyPorts);
    }
    await rm(filePath, { force: true });
  } finally {
    await unlock();
  }
}

function findWorktreeSlot(slots: Registry['slots'], worktreeId: string) {
  return slotEntries(slots).find(({ record }) => record.worktreeId === worktreeId);
}

async function getAllSlots() {
  const { commonDirectory } = await fetchGitContext();
  const worktreePathsById = await listWorktreePaths(commonDirectory);
  // Atomic snapshot read without the registry lock, so a keep predicate
  // Awaiting getSlot() cannot deadlock on its own update.
  const { slots } = await fetchRegistry(getRegistryPath(commonDirectory));
  const now = Date.now();
  return slotEntries(slots).flatMap(({ index, record }) => {
    const { worktreeId, ...slotFields } = record;
    const worktreePath = worktreePathsById.get(worktreeId) ?? record.worktreePath;
    return [{ ...slotFields, index, isExpired: checkIsExpired(record, now), worktreePath } satisfies ReservationStats];
  });
}

async function getSlot(slotIndex?: number) {
  if (slotIndex !== undefined) assertSlotIndexValid(slotIndex);
  const { commonDirectory, worktreeId } = await fetchGitContext();
  const { slots } = await fetchRegistry(getRegistryPath(commonDirectory));
  if (slotIndex !== undefined) {
    const record = slots[slotIndex];
    return record ? buildSlot(record, slotIndex) : undefined;
  }
  const found = worktreeId === undefined ? undefined : findWorktreeSlot(slots, worktreeId);
  return found ? buildSlot(found.record, found.index) : undefined;
}

async function releaseAllSlots(force = false) {
  const { commonDirectory } = await fetchGitContext();
  const {
    busyPorts,
    releasedSlots,
    skippedSlots: unresolvedSlots,
  } = await updateRegistry(commonDirectory, async (registry) => {
    const freedSlots: Array<PortSlot> = [];
    const occupiedPorts: Array<BusyPort> = [];
    const skippedSlots: Array<number> = [];
    for (const { index, record } of slotEntries(registry.slots)) {
      try {
        // Free every releasable slot instead of failing on the first busy one.
        // oxlint-disable-next-line no-await-in-loop
        freedSlots.push(await releaseRecord(registry, index, record, force));
      } catch (error) {
        if (error instanceof BusyPortsError) {
          occupiedPorts.push(...error.ports);
        } else if (isAddressUnavailableError(error)) {
          // A slot whose saved host cannot be resolved must not cancel the
          // Verified releases: keep it and report its number afterwards.
          skippedSlots.push(index);
        } else {
          throw error;
        }
      }
    }
    return { busyPorts: occupiedPorts, releasedSlots: freedSlots, skippedSlots };
  });
  if (busyPorts.length > 0) throw new BusyPortsError(busyPorts, releasedSlots, unresolvedSlots);
  if (unresolvedSlots.length > 0) {
    throw new PartialReleaseError('hostUnresolved', releasedSlots, unresolvedSlots);
  }
  return releasedSlots;
}

async function releaseSlot(force?: boolean): Promise<PortSlot | undefined>;
async function releaseSlot(slotIndex: number | undefined, force?: boolean): Promise<PortSlot | undefined>;
async function releaseSlot(slotIndex?: boolean | number, force = false) {
  const selected = typeof slotIndex === 'boolean' ? undefined : slotIndex;
  const forced = typeof slotIndex === 'boolean' ? slotIndex : force;
  if (selected !== undefined) assertSlotIndexValid(selected);
  const { commonDirectory, worktreeId } = await fetchGitContext();
  return updateRegistry(commonDirectory, (registry) => {
    if (selected !== undefined) {
      const record = registry.slots[selected];
      return record ? releaseRecord(registry, selected, record, forced) : undefined;
    }
    const found = worktreeId === undefined ? undefined : findWorktreeSlot(registry.slots, worktreeId);
    return found ? releaseRecord(registry, found.index, found.record, forced) : undefined;
  });
}

export { cleanupSlots, destroy, getAllSlots, getSlot, releaseAllSlots, releaseSlot };
export type { ReservationStats };
export { BusyPortsError } from './busy-ports-error';
export { defineConfig } from './config';
export type { PortoConfig } from './config';
export { PortoError } from './error';
export { PartialReleaseError } from './partial-release-error';
export type { PortSlot } from './ports';
export { reserve } from './reserve';
export type { ReserveOptions } from './reserve';
export type { KeepPredicate, KeepSlot } from './schemas';
export type { VarFactory, Vars } from './vars';
