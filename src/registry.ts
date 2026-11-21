import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { Registry } from './schemas';

import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';
import { REGISTRY_SCHEMA } from './schemas';

const DEFAULT_START_PORT = 10_000;
const DEFAULT_PORTS_PER_SLOT = 10;

async function fetchRegistry(filePath: string): Promise<Registry> {
  try {
    return REGISTRY_SCHEMA.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (checkIsFileMissing(error)) {
      return { portsPerSlot: DEFAULT_PORTS_PER_SLOT, slots: [], startPort: DEFAULT_START_PORT };
    }
    throw new PortoError('registryInvalid', filePath, { cause: error });
  }
}

function getRegistryPath(commonDirectory: string) {
  return path.join(commonDirectory, 'porto-registry.json');
}

async function writeRegistry(filePath: string, registry: Registry, previousContents: string) {
  while (registry.slots.at(-1) === null) registry.slots.pop();
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
  const unlock = await lockfile.lock(filePath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
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

export { getRegistryPath, updateRegistry };
export type { Registry, ReservationRecord } from './schemas';
