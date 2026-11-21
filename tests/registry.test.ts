import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Registry, ReservationRecord } from '../src/registry';

import { PortoError } from '../src/error';
import { updateRegistry } from '../src/registry';

let directoryPath: string;

function buildRecord(index = 0, worktreeId = '.'): ReservationRecord {
  return {
    env: false,
    envFile: '.env',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    firstPort: 20_000 + index * 2,
    idleTtlMinutes: 60,
    jsonFile: false,
    keep: false,
    lastPort: 20_001 + index * 2,
    lastUsedAt: new Date().toISOString(),
    ports: [],
    silent: false,
    vars: { SLOT: index },
    worktreeId,
    worktreePath: path.join(directoryPath, worktreeId),
  };
}

function buildRegistry(slots: Registry['slots']): Registry {
  return { portsPerSlot: 2, slots, startPort: 20_000 };
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

it('stores repository range settings once without a permanent lock directory', async () => {
  const saved = buildRegistry({ 0: buildRecord() });
  await updateRegistry(directoryPath, (registry) => Object.assign(registry, saved));
  expect(await readdir(directoryPath)).toEqual(['porto-registry.json']);
  expect(await readSnapshot()).toEqual(saved);
});

it('preserves sparse slot indices without trailing cleanup', async () => {
  const record = buildRecord(1);
  await updateRegistry(directoryPath, (registry) => Object.assign(registry, buildRegistry({ 1: record })));
  expect(await readSnapshot()).toEqual(buildRegistry({ 1: record }));
  await updateRegistry(directoryPath, (registry) => {
    delete registry.slots[1];
  });
  expect(await readSnapshot()).toEqual(buildRegistry({}));
});

it('preserves sparse slots already in the file', async () => {
  const record = buildRecord(1);
  await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(buildRegistry({ 1: record })));
  await updateRegistry(directoryPath, (registry) => registry);
  expect(await readSnapshot()).toEqual(buildRegistry({ 1: record }));
});

it('fails on a corrupt porto-registry.json and preserves its contents', async () => {
  const filePath = path.join(directoryPath, 'porto-registry.json');
  await writeFile(filePath, '{broken');
  await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
  expect(await readFile(filePath, 'utf8')).toBe('{broken');
});

it('does not persist partial callback changes after a failed operation', async () => {
  const saved = buildRegistry({ 0: buildRecord() });
  await updateRegistry(directoryPath, (registry) => Object.assign(registry, saved));
  await expect(
    updateRegistry(directoryPath, (registry) => {
      delete registry.slots[0];
      registry.startPort += 10;
      throw new Error('Interrupted allocation.');
    }),
  ).rejects.toThrow('Interrupted allocation.');
  expect(await readSnapshot()).toEqual(saved);
  expect(await updateRegistry(directoryPath, (registry) => registry)).toEqual(saved);
});

it('rejects multiple slots for the same worktree', async () => {
  const saved = buildRegistry({ 0: buildRecord(), 1: buildRecord(1) });
  await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(saved));
  await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
});

it.each(['keep', 'ports', 'worktreeId'])('rejects a slot missing its required %s field', async (field) => {
  const record = { ...buildRecord(), [field]: undefined };
  await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(buildRegistry({ 0: record })));
  await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
});

it.each([{ firstPort: 19_999 }, { lastPort: 20_002 }, { vars: { 'BAD-NAME': 1000, SLOT: 0 } }, { keep: true }])(
  'rejects inconsistent saved slot fields: %j',
  async (fields) => {
    const record = { ...buildRecord(), ...fields };
    await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(buildRegistry({ 0: record })));
    await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
  },
);

it.each([{ ports: [19_999] }, { ports: [20_002] }, { ports: [20_000, 20_000] }])(
  'rejects invalid assigned ports: %s',
  async ({ ports }) => {
    const saved = buildRegistry({ 0: { ...buildRecord(), ports } });
    await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(saved));
    await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
  },
);

it.each([{ portsPerSlot: 0 }, { startPort: 0 }, { startPort: 65_535 }])(
  'rejects invalid repository settings or slot positions: %j',
  async (fields) => {
    await writeFile(
      path.join(directoryPath, 'porto-registry.json'),
      JSON.stringify({ ...buildRegistry({}), ...fields }),
    );
    await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
  },
);

it('rejects a slot stored at an incorrect index', async () => {
  const saved = buildRegistry({ 1: buildRecord() });
  await writeFile(path.join(directoryPath, 'porto-registry.json'), JSON.stringify(saved));
  await expect(updateRegistry(directoryPath, (registry) => registry)).rejects.toBeInstanceOf(PortoError);
});
