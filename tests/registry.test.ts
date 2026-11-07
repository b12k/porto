import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ReservationRecord } from '../src/registry';

import { PortoError } from '../src/error';
import { updateRegistry } from '../src/registry';

let directoryPath: string;

function buildRecord() {
  return {
    idleTtlMinutes: 60,
    index: 0,
    keep: false,
    lastUsedAt: new Date().toISOString(),
    size: 2,
    start: 20_000,
    worktree: path.join(directoryPath, 'checkout'),
  };
}

async function readSnapshot() {
  const snapshot: unknown = JSON.parse(await readFile(path.join(directoryPath, 'porto', 'registry.json'), 'utf8'));
  return snapshot;
}

async function writeLegacyRecord(record: ReservationRecord) {
  const fileName = `${createHash('sha256')
    .update(JSON.stringify([record.worktree, record.start, record.size]))
    .digest('hex')}.json`;
  await writeFile(path.join(directoryPath, 'porto', fileName), JSON.stringify(record));
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-registry-'));
  await mkdir(path.join(directoryPath, 'porto'));
});

afterEach(async () => {
  const target = path.resolve(directoryPath);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('porto-registry-')) {
    throw new Error('Invalid fixture directory.');
  }
  await rm(target, { force: true, recursive: true });
});

it('imports existing reservations and treats an empty snapshot as authoritative', async () => {
  const record = buildRecord();
  await writeLegacyRecord(record);
  expect(await updateRegistry(directoryPath, (records) => records.length)).toBe(1);
  await updateRegistry(directoryPath, (records) => {
    for (const reservation of records) reservation.lastUsedAt = '2000-01-01T00:00:00.000Z';
  });
  expect(await readSnapshot()).toEqual([{ ...record, lastUsedAt: '2000-01-01T00:00:00.000Z' }]);
  await updateRegistry(directoryPath, (records) => {
    records.splice(0);
  });
  expect(await readSnapshot()).toEqual([]);
  expect(await updateRegistry(directoryPath, (records) => records.length)).toBe(0);
});

it('does not persist partial callback changes after a failed operation', async () => {
  const record = buildRecord();
  await updateRegistry(directoryPath, (records) => {
    records.push(record);
  });
  await expect(
    updateRegistry(directoryPath, (records) => {
      records.splice(0);
      records.push({ ...record, worktree: path.join(directoryPath, 'other') });
      throw new Error('Interrupted allocation.');
    }),
  ).rejects.toThrow('Interrupted allocation.');
  expect(await readSnapshot()).toEqual([record]);
  expect(await updateRegistry(directoryPath, (records) => records)).toEqual([record]);
});

it('rejects overlapping blocks imported from an interrupted older allocation', async () => {
  const record = buildRecord();
  await writeLegacyRecord(record);
  await writeLegacyRecord({ ...record, worktree: path.join(directoryPath, 'other') });
  await expect(updateRegistry(directoryPath, (records) => records)).rejects.toBeInstanceOf(PortoError);
});
