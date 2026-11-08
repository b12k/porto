import type { SetRequired } from 'type-fest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { ReserveOptions } from './index';

import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';
import { REGISTRY_SCHEMA } from './schemas';

export type ReservationRecord = SetRequired<Omit<ReserveOptions, 'vars'>, 'idleTtlMinutes' | 'size' | 'start'> & {
  index: number;
  keep: boolean;
  lastUsedAt: string;
  ports: number[];
  worktree: string;
  worktreeId: string;
};

async function listReservations(filePath: string) {
  try {
    return REGISTRY_SCHEMA.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (checkIsFileMissing(error)) return [];
    throw new PortoError('registryInvalid', filePath, { cause: error });
  }
}

async function writeReservations(filePath: string, records: ReservationRecord[], previousContents: string) {
  const contents = JSON.stringify(records);
  if (contents !== previousContents) {
    await writeFileAtomically(filePath, `${contents}\n`);
  }
}

export function getRegistryPath(commonDirectory: string) {
  return path.join(commonDirectory, 'porto-registry.json');
}

export async function updateRegistry<Result>(
  commonDirectory: string,
  handleRecords: (records: ReservationRecord[]) => Promise<Result> | Result,
) {
  const filePath = getRegistryPath(commonDirectory);
  const unlock = await lockfile.lock(filePath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
  try {
    const records = await listReservations(filePath);
    const previousContents = JSON.stringify(records);
    const result = await handleRecords(records);
    await writeReservations(filePath, records, previousContents);
    return result;
  } finally {
    await unlock();
  }
}
