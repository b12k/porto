import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { REGISTRY_SCHEMA } from '../src/schemas';
import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, '../src/cli.ts');
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let start: number;

async function readRecord() {
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const { slots } = REGISTRY_SCHEMA.parse(JSON.parse(await readFile(registryPath, 'utf8')));
  const [record] = Object.values(slots);
  if (record === undefined) throw new Error('Missing saved reservation.');
  return record;
}

async function runApi(source: string) {
  const script = `const { cleanupSlots, getAllSlots, getSlot, releaseSlot, reserve } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', script], {
    cwd: directoryPath,
  });
  return JSON.parse(stdout) as unknown;
}

function runCli(args: Array<string>) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd: directoryPath });
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-snapshot-'));
  directoryPath = await realpath(directoryPath);
  await execFileAsync('git', ['init', '-q'], { cwd: directoryPath });
  start = await fetchFreeRange(12);
});

afterEach(async () => {
  const targetPath = path.resolve(directoryPath);
  const tempPath = await realpath(tmpdir());
  if (path.dirname(targetPath) !== tempPath || !path.basename(targetPath).startsWith('porto-snapshot-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('stores resolved settings and variables and reads them without evaluating the config again', async () => {
  const configPath = path.join(directoryPath, 'porto.config.ts');
  await writeFile(
    configPath,
    `import { appendFileSync } from 'node:fs';
     export default {
       start: ${start}, size: 3, host: '127.0.0.1', idleTtlMinutes: 2, keep: false,
       env: true, envPath: '.env.local', jsonPath: 'env.json', silent: true,
       vars: ['CLIENT_PORT', (port, _slot) => {
         appendFileSync('factories.txt', 'called\\n');
         return { API_PORT: port, API_URL: 'http://localhost:' + port, ['__proto__']: port };
       }],
       onReserved() {},
       onReleased() {},
     };`,
  );
  const reserved = await runCli(['reserve']);
  expect(reserved.stdout).toBe('');
  const record = await readRecord();
  expect(record).toMatchObject({
    env: true,
    envPath: path.join(directoryPath, '.env.local'),
    firstPort: start,
    host: '127.0.0.1',
    idleTtlMinutes: 2,
    jsonPath: path.join(directoryPath, 'env.json'),
    keep: false,
    lastPort: start + 2,
    ports: [start, start + 1],
    silent: true,
    vars: { API_PORT: start + 1, API_URL: `http://localhost:${start + 1}`, CLIENT_PORT: start },
  });
  expect(Date.parse(record.expiresAt) - Date.parse(record.lastUsedAt)).toBe(120_000);
  expect(Object.hasOwn(record.vars, '__proto__')).toBe(true);
  expect(record).not.toHaveProperty('getPort');
  expect(record).not.toHaveProperty('onReserved');
  expect(record).not.toHaveProperty('onReleased');
  await writeFile(configPath, "throw new Error('Reading a saved slot must not load this config.');");
  expect(
    await runApi('const slot = await getSlot(); console.log(JSON.stringify({ slot, port: slot.getPort(1) }));'),
  ).toEqual({ port: start + 1, slot: { ...record, index: 0 } });
  expect(await readFile(path.join(directoryPath, 'factories.txt'), 'utf8')).toBe('called\n');
  expect(await runApi('console.log(JSON.stringify(await releaseSlot()));')).toEqual({ ...record, index: 0 });
});

it('stores range settings once and cleans up using the saved slot expiry', async () => {
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  try {
    await runCli(['reserve', '--start', String(start), '--size=3', '--vars=PORT']);
    const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
    const record = await readRecord();
    expect(record).toMatchObject({ firstPort: start + 3, lastPort: start + 5, vars: { PORT: start + 3 } });
    expect(
      await runApi('const slot = await getSlot(); console.log(JSON.stringify({ slot, port: slot.getPort() }));'),
    ).toEqual({ port: start + 3, slot: { ...record, index: 1 } });
    record.expiresAt = '2000-01-01T00:00:00.000Z';
    const registryContents = await readFile(registryPath, 'utf8');
    const registry = REGISTRY_SCHEMA.parse(JSON.parse(registryContents));
    expect(registry).toMatchObject({ portsPerSlot: 3, startPort: start });
    expect(registry.slots[0]).toBeUndefined();
    expect(record).not.toHaveProperty('index');
    expect(record).not.toHaveProperty('rangeStart');
    expect(record).not.toHaveProperty('size');
    registry.slots[1] = record;
    await writeFile(registryPath, JSON.stringify(registry));
    expect(await runApi('console.log(JSON.stringify(await cleanupSlots()));')).toEqual([{ ...record, index: 1 }]);
    expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toEqual([]);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

it('stores expiry for kept slots and skips them during idle cleanup', async () => {
  const args = ['reserve', '--start', String(start), '--size=1'];
  await runCli([...args, '--keep']);
  const keptSlot = await readRecord();
  expect(keptSlot).toMatchObject({ keep: true });
  expect(typeof keptSlot.expiresAt).toBe('string');
  expect(await runApi('console.log(JSON.stringify(await cleanupSlots()));')).toEqual([]);
  await runCli([...args, '--no-keep', '--idle=3']);
  const idleSlot = await readRecord();
  expect(Date.parse(idleSlot.expiresAt) - Date.parse(idleSlot.lastUsedAt)).toBe(180_000);
});

it('uses API options and saved range settings without loading a CLI config', async () => {
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    "throw new Error('The library API must not load this config.');",
  );
  const slot = await runApi(`console.log(JSON.stringify(await reserve({ start: ${start}, size: 2 })));`);
  const expectedSlot = { firstPort: start, index: 0, lastPort: start + 1, vars: { SLOT: 0 } };
  expect(slot).toMatchObject(expectedSlot);
  expect(await runApi('console.log(JSON.stringify(await reserve()));')).toMatchObject(expectedSlot);
  const { stdout } = await runCli(['show', '--json']);
  expect(JSON.parse(stdout)).toMatchObject({ firstPort: start, index: 0, lastPort: start + 1 });
  const all = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(all.stdout)).toMatchObject([{ firstPort: start, lastPort: start + 1 }]);
});
