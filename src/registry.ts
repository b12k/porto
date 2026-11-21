import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { Registry, ReservationRecord } from './schemas';

import { DEFAULT_CONFIG } from './config';
import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';
import { REGISTRY_SCHEMA } from './schemas';

async function fetchRegistry(filePath: string): Promise<Registry> {
  try {
    return REGISTRY_SCHEMA.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (checkIsFileMissing(error)) {
      return { portsPerSlot: DEFAULT_CONFIG.size, slots: {}, startPort: DEFAULT_CONFIG.start };
    }
    throw new PortoError('registryInvalid', filePath, { cause: error });
  }
}

function getRegistryPath(commonDirectory: string) {
  return path.join(commonDirectory, 'porto-registry.json');
}

function lockRegistryFile(filePath: string) {
  return lockfile.lock(filePath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
}

function slotEntries(slots: Registry['slots']): Array<{ index: number; record: ReservationRecord }> {
  return Object.entries(slots).map(([key, record]) => ({ index: Number(key), record }));
}

async function writeRegistry(filePath: string, registry: Registry, previousContents: string) {
  const contents = JSON.stringify(registry);
  if (contents !== previousContents) {
    await writeFileAtomically(filePath, `${contents}\n`);
  }
}

async function updateRegistry<Result>(
  commonDirectory: string,
  handleRegistry: (registry: Registry) => Promise<Result> | Result,
) {
  const filePath = getRegistryPath(commonDirectory);
  const unlock = await lockRegistryFile(filePath);
  try {
    const registry = await fetchRegistry(filePath);
    const previousContents = JSON.stringify(registry);
    const result = await handleRegistry(registry);
    await writeRegistry(filePath, registry, previousContents);
    return result;
  } finally {
    await unlock();
  }
}

export { fetchRegistry, getRegistryPath, lockRegistryFile, slotEntries, updateRegistry };
export type { Registry, ReservationRecord } from './schemas';
