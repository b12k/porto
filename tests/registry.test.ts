import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PortoError } from '../src/error';
import { updateRegistry } from '../src/registry';

let directoryPath: string;

function buildRecord() {
  return {
    idleTtlMinutes: 60,
    index: 0,
    keep: false,
    lastUsedAt: new Date().toISOString(),
    ports: [],
    size: 2,
    start: 20_000,
    worktree: path.join(directoryPath, 'checkout'),
    worktreeId: '.',
  };
}

async function readSnapshot() {
  const snapshot: unknown = JSON.parse(await readFile(path.join(directoryPath, 'porto-registry.json'), 'utf8'));
  return snapshot;
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-registry-'));
});

afterEach(async () => {
  const target = path.resolve(directoryPath);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('porto-registry-')) {
    throw new Error('Invalid fixture directory.');
  }
  await rm(target, { force: true, recursive: true });
});

it('stores new reservations in one JSON file without a permanent lock directory', async () => {
  const record = buildRecord();
  await updateRegistry(directoryPath, (records) => {
    records.push(record);
  });
  expect(await readdir(directoryPath)).toEqual(['porto-registry.json']);
  expect(await readSnapshot()).toEqual([record]);
});

it('fails on a corrupt porto-registry.json and preserves its contents', async () => {
  const filePath = path.join(directoryPath, 'porto-registry.json');
  await writeFile(filePath, '{broken');
  await expect(updateRegistry(directoryPath, (records) => records)).rejects.toBeInstanceOf(PortoError);
  expect(await readFile(filePath, 'utf8')).toBe('{broken');
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

it('rejects overlapping blocks in the registry', async () => {
  const record = buildRecord();
  await writeFile(
    path.join(directoryPath, 'porto-registry.json'),
    JSON.stringify([record, { ...record, worktree: path.join(directoryPath, 'other'), worktreeId: 'worktrees/other' }]),
  );
  await expect(updateRegistry(directoryPath, (records) => records)).rejects.toBeInstanceOf(PortoError);
});

it.each(['keep', 'ports', 'worktreeId'])('rejects a reservation missing its required %s field', async (field) => {
  await writeFile(
    path.join(directoryPath, 'porto-registry.json'),
    JSON.stringify([{ ...buildRecord(), [field]: undefined }]),
  );
  await expect(updateRegistry(directoryPath, (records) => records)).rejects.toBeInstanceOf(PortoError);
});

it.each([{ ports: [19_999] }, { ports: [20_002] }, { ports: [20_000, 20_000] }])(
  'rejects invalid assigned ports: %s',
  async ({ ports }) => {
    await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify([{ ...buildRecord(), ports }]));
    await expect(updateRegistry(directoryPath, (records) => records)).rejects.toBeInstanceOf(PortoError);
  },
);
