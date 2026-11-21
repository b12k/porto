import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxUrl = import.meta.resolve('tsx');
const servers: Array<ReturnType<typeof createServer>> = [];
let directoryPath: string;
let repositoryPath: string;
let start: number;

function buildReserveSource(keep?: boolean) {
  return `await reserve(${JSON.stringify({ keep, size: 1, start })});`;
}

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function createListener(port = 0, host = '127.0.0.1') {
  const server = createServer();
  servers.push(server);
  server.listen({ host, port });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing server address.');
  return { port: address.port, server };
}

function getRegistryPath() {
  return path.join(repositoryPath, '.git', 'porto-registry.json');
}

async function expireRecords() {
  const registryPath = getRegistryPath();
  const contents = await readFile(registryPath, 'utf8');
  await writeFile(
    registryPath,
    contents
      .replaceAll(/"lastUsedAt"\s*:\s*"[^"]+"/gu, '"lastUsedAt":"2000-01-01T00:00:00.000Z"')
      .replaceAll(/"expiresAt"\s*:\s*"[^"]+"/gu, '"expiresAt":"2000-01-01T00:00:00.000Z"'),
  );
}

function runGit(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

async function createWorktree() {
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  return worktreePath;
}

async function runApi(source: string, cwd = repositoryPath) {
  const script = `const { cleanupSlots, getAllSlots, getSlot, releaseSlot, reserve } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxUrl, '--input-type=module', '-e', script], {
    cwd,
  });
  return stdout;
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-keep-'));
  repositoryPath = path.join(directoryPath, 'repository');
  await mkdir(repositoryPath);
  await runGit(['init', '-q']);
  await runGit([
    '-c',
    'user.name=Porto Test',
    '-c',
    'user.email=porto@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'initial',
  ]);
  start = await fetchFreeRange(5);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeListener(server)));
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-keep-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('uses the default range, idle limit and keep settings for new reservations', async () => {
  const stdout = await runApi('console.log(JSON.stringify(await reserve({ size: undefined, start: undefined })));');
  expect(JSON.parse(stdout)).toMatchObject({ idleTtlMinutes: 60, keep: false });
  const registryContents = await readFile(getRegistryPath(), 'utf8');
  expect(JSON.parse(registryContents)).toMatchObject({ portsPerSlot: 10, startPort: 10_000 });
});

it('returns named variables and evaluates each factory once', async () => {
  const stdout = await runApi(`
    let calls = 0;
    const slot = await reserve({
      start: ${start}, size: 2, vars: [
        'API_PORT',
        (port, _slot) => {
          calls += 1;
          return { DB_PORT: port, DB_URL: 'tcp://localhost:' + port };
        },
      ],
    });
    const reused = await reserve({ start: ${start}, size: 2 });
    process.stdout.write(JSON.stringify({ slot, calls, firstPort: slot.getPort(), reusedVars: reused.vars }));
  `);
  expect(JSON.parse(stdout)).toMatchObject({
    calls: 1,
    firstPort: start,
    reusedVars: { SLOT: 0 },
    slot: {
      firstPort: start,
      index: 0,
      lastPort: start + 1,
      ports: [start, start + 1],
      vars: { API_PORT: start, DB_PORT: start + 1, DB_URL: `tcp://localhost:${start + 1}` },
    },
  });
});

it('leaves the existing reservation unchanged when an API factory fails', async () => {
  await runApi(buildReserveSource());
  const registryPath = getRegistryPath();
  const previousContents = await readFile(registryPath, 'utf8');
  await expect(
    runApi(
      `await reserve({ start: ${start}, size: 1, keep: true, vars: [() => { throw new Error('broken factory'); }] });`,
    ),
  ).rejects.toThrow('Cannot create variables for entry 1');
  expect(await readFile(registryPath, 'utf8')).toBe(previousContents);
});

it('preserves kept reservations through idle cleanup and repeated reserve without keep', async () => {
  await runApi(buildReserveSource(true));
  await expireRecords();
  expect(
    JSON.parse(await runApi('await cleanupSlots(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toMatchObject([{ isExpired: false, keep: true }]);
  await runApi(buildReserveSource());
  await expireRecords();
  expect(
    JSON.parse(await runApi('await cleanupSlots(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toMatchObject([{ isExpired: false, keep: true }]);
});

it('does not recycle a kept slot during another checkout reserve', async () => {
  await runApi(buildReserveSource(true));
  await expireRecords();
  const worktreePath = await createWorktree();
  expect(
    await runApi(
      `const slot = await reserve({ size: 1, start: ${start} }); process.stdout.write(String(slot.index));`,
      worktreePath,
    ),
  ).toBe('1');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await getAllSlots()));'))).toMatchObject([
    { keep: true },
    { keep: false },
  ]);
});

it('reenables idle cleanup when keep is explicitly false', async () => {
  await runApi(buildReserveSource(true));
  await runApi(buildReserveSource(false));
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await getAllSlots()));'))).toMatchObject([
    { keep: false },
  ]);
  await expireRecords();
  expect(
    JSON.parse(await runApi('await cleanupSlots(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toEqual([]);
});

it('requires free ports for explicit release even when a reservation is kept', async () => {
  await runApi(buildReserveSource(true));
  const listener = await createListener(start);
  await expect(runApi('await releaseSlot();')).rejects.toThrow('Cannot release reservations while ports are in use.');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await getAllSlots()));'))).toMatchObject([
    { keep: true },
  ]);
  await closeListener(listener.server);
  expect(
    JSON.parse(await runApi('await releaseSlot(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toEqual([]);
});

it('uses the saved host for release and cleanup', async () => {
  const host = process.platform === 'win32' ? '127.0.0.2' : '127.0.0.1';
  await runApi(`await reserve(${JSON.stringify({ host, size: 1, start })});`);
  await expireRecords();
  const { server } = await createListener(start, host);
  await expect(runApi('await releaseSlot();')).rejects.toThrow('Cannot release reservations while ports are in use.');
  expect(
    JSON.parse(await runApi('await cleanupSlots(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toMatchObject([{ firstPort: start, host }]);
  await closeListener(server);
  expect(
    JSON.parse(await runApi('await cleanupSlots(); process.stdout.write(JSON.stringify(await getAllSlots()));')),
  ).toEqual([]);
});

it('rejects invalid keep values before storing a reservation', async () => {
  await expect(runApi(`await reserve({ keep: 'yes', size: 1, start: ${start} });`)).rejects.toThrow('keep');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await getAllSlots()));'))).toEqual([]);
});
