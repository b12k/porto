import type { SetRequired } from 'type-fest';

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { ReserveOptions } from './index';

import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';
import { RECORD_SCHEMA, REGISTRY_SCHEMA } from './schemas';

export type ReservationRecord = SetRequired<ReserveOptions, keyof ReserveOptions> & {
  index: number;
  keep: boolean;
  lastUsedAt: string;
  worktree: string;
};

function getReservationFileName(record: ReservationRecord) {
  return `${createHash('sha256')
    .update(JSON.stringify([record.worktree, record.start, record.size]))
    .digest('hex')}.json`;
}

async function fetchLegacyReservation(directoryPath: string, fileName: string) {
  const filePath = path.join(directoryPath, fileName);
  try {
    const record = RECORD_SCHEMA.parse(JSON.parse(await readFile(filePath, 'utf8')));
    if (fileName !== getReservationFileName(record)) {
      throw new PortoError('registryInvalid', 'Filename does not match its contents.');
    }
    return record;
  } catch (error) {
    throw new PortoError('registryInvalid', filePath, { cause: error });
  }
}

async function listReservations(directoryPath: string) {
  const registryPath = path.join(directoryPath, 'registry.json');
  try {
    return REGISTRY_SCHEMA.parse(JSON.parse(await readFile(registryPath, 'utf8')));
  } catch (error) {
    if (!checkIsFileMissing(error)) throw new PortoError('registryInvalid', registryPath, { cause: error });
  }
  // Import older per-reservation files only until an atomic snapshot exists.
  const fileNames = await readdir(directoryPath);
  const records = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith('.json'))
      .map(async (fileName) => fetchLegacyReservation(directoryPath, fileName)),
  );
  try {
    return REGISTRY_SCHEMA.parse(records);
  } catch (error) {
    throw new PortoError('registryInvalid', directoryPath, { cause: error });
  }
}

async function writeReservations(directoryPath: string, records: ReservationRecord[], previousContents: string) {
  const contents = JSON.stringify(records);
  if (contents !== previousContents) {
    await writeFileAtomically(path.join(directoryPath, 'registry.json'), `${contents}\n`);
  }
}

export async function updateRegistry<Result>(
  commonDirectory: string,
  handleRecords: (records: ReservationRecord[]) => Promise<Result> | Result,
) {
  const directoryPath = path.join(commonDirectory, 'porto');
  await mkdir(directoryPath, { recursive: true });
  const unlock = await lockfile.lock(directoryPath, {
    lockfilePath: path.join(directoryPath, 'registry.lock'),
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
  try {
    const records = await listReservations(directoryPath);
    const previousContents = JSON.stringify(records);
    const result = await handleRecords(records);
    await writeReservations(directoryPath, records, previousContents);
    return result;
  } finally {
    await unlock();
  }
}
