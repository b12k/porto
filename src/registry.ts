import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { Registry, ReservationRecord } from './schemas';

import { DEFAULT_CONFIG } from './config';
import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';
import { REGISTRY_SCHEMA } from './schemas';

interface RegistryUpdateToken {
  filePath: string;
  id: symbol;
}

const registryUpdateContext = new AsyncLocalStorage<RegistryUpdateToken>();
const activeRegistryUpdates = new Set<symbol>();

function assertRegistryWriteAllowed(filePath?: string) {
  const store = registryUpdateContext.getStore();
  if (store && activeRegistryUpdates.has(store.id) && (filePath === undefined || store.filePath === filePath)) {
    const error = new Error('Registry update cannot be started from inside a registry update callback.') as Error & {
      code?: string;
    };
    error.code = 'ELOCKED';
    throw error;
  }
}

function checkIsExpired(record: Pick<ReservationRecord, 'expiresAt' | 'keep'>, now: number) {
  return !record.keep && now > Date.parse(record.expiresAt);
}

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
  options?: { afterSave?: (registry: Registry, result: Result) => Promise<void> | void },
) {
  const filePath = getRegistryPath(commonDirectory);
  assertRegistryWriteAllowed(filePath);
  const unlock = await lockRegistryFile(filePath);
  const token: RegistryUpdateToken = { filePath, id: Symbol('porto-registry-update') };
  activeRegistryUpdates.add(token.id);
  try {
    const registry = await fetchRegistry(filePath);
    const previousContents = JSON.stringify(registry);
    // Save the registry before running exports so a failed export leaves
    // The reservation in place; exports still run under the same lock so
    // Concurrent reserves cannot interleave registry and file contents.
    const result = await registryUpdateContext.run(token, async () => {
      const handlerResult = await handleRegistry(registry);
      await writeRegistry(filePath, registry, previousContents);
      if (options?.afterSave) await options.afterSave(registry, handlerResult);
      return handlerResult;
    });
    return result;
  } finally {
    activeRegistryUpdates.delete(token.id);
    await unlock();
  }
}

export {
  assertRegistryWriteAllowed,
  checkIsExpired,
  fetchRegistry,
  getRegistryPath,
  lockRegistryFile,
  slotEntries,
  updateRegistry,
  writeRegistry,
};
export type { Registry, ReservationRecord } from './schemas';
