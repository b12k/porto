import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseOptions } from '../src/schemas';
import { fetchFreeRange } from './fixture';

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxUrl = import.meta.resolve('tsx');
const servers: ReturnType<typeof createServer>[] = [];
let directoryPath: string;
let repositoryPath: string;
let start: number;

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function createListener(port = 0) {
  const server = createServer();
  servers.push(server);
  server.listen({ host: '127.0.0.1', port });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing server address.');
  return { port: address.port, server };
}

async function runGit(args: string[], cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

async function createWorktree() {
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  return worktreePath;
}

async function runApi(source: string, cwd = repositoryPath) {
  const script = `const { cleanup, current, release, reserve, stats } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxUrl, '--input-type=module', '-e', script], {
    cwd,
  });
  return stdout;
}

function getRegistryPath() {
  return path.join(repositoryPath, '.git', 'porto', 'registry.json');
}

async function expireRecords() {
  const registryPath = getRegistryPath();
  const contents = await readFile(registryPath, 'utf8');
  await writeFile(
    registryPath,
    contents.replaceAll(/"lastUsedAt"\s*:\s*"[^"]+"/gu, '"lastUsedAt":"2000-01-01T00:00:00.000Z"'),
  );
}

function buildReserveSource(keep?: boolean) {
  return `await reserve(${JSON.stringify({ keep, size: 1, start })});`;
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
  await Promise.all(servers.splice(0).map(async (server) => closeListener(server)));
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-keep-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('defaults new reservations to keep false and centralizes optional numeric defaults', async () => {
  expect(parseOptions({})).toEqual({ idleTtlMinutes: 60, size: 10, start: 1000 });
  expect(parseOptions({ size: undefined, start: undefined })).toEqual({ idleTtlMinutes: 60, size: 10, start: 1000 });
  await runApi(buildReserveSource());
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toMatchObject([
    { keep: false },
  ]);
});

it('preserves kept reservations through idle cleanup and repeated reserve without keep', async () => {
  await runApi(buildReserveSource(true));
  await expireRecords();
  expect(
    JSON.parse(await runApi('await cleanup(); process.stdout.write(JSON.stringify(await stats()));')),
  ).toMatchObject([{ isExpired: false, keep: true }]);
  await runApi(buildReserveSource());
  await expireRecords();
  expect(
    JSON.parse(await runApi('await cleanup(); process.stdout.write(JSON.stringify(await stats()));')),
  ).toMatchObject([{ isExpired: false, keep: true }]);
});

it('does not recycle a kept block during another checkout reserve', async () => {
  await runApi(buildReserveSource(true));
  await expireRecords();
  const worktreePath = await createWorktree();
  expect(
    await runApi(
      `const block = await reserve({ size: 1, start: ${start} }); process.stdout.write(String(block.index));`,
      worktreePath,
    ),
  ).toBe('1');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toMatchObject([
    { keep: true },
    { keep: false },
  ]);
});

it('reenables idle cleanup when keep is explicitly false', async () => {
  await runApi(buildReserveSource(true));
  await runApi(buildReserveSource(false));
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toMatchObject([
    { keep: false },
  ]);
  await expireRecords();
  expect(JSON.parse(await runApi('await cleanup(); process.stdout.write(JSON.stringify(await stats()));'))).toEqual([]);
});

it('requires free ports for explicit release even when a reservation is kept', async () => {
  await runApi(buildReserveSource(true));
  const listener = await createListener(start);
  await expect(runApi('await release();')).rejects.toThrow('Cannot release reservations while ports are in use.');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toMatchObject([
    { keep: true },
  ]);
  await closeListener(listener.server);
  expect(JSON.parse(await runApi('await release(); process.stdout.write(JSON.stringify(await stats()));'))).toEqual([]);
});

it('loads old reservation records without keep as normal idle reservations', async () => {
  await runApi(buildReserveSource());
  const registryPath = getRegistryPath();
  const contents = await readFile(registryPath, 'utf8');
  await writeFile(registryPath, contents.replaceAll('"keep":false,', '').replaceAll(',"keep":false', ''));
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toMatchObject([
    { keep: false },
  ]);
  await expireRecords();
  expect(JSON.parse(await runApi('await cleanup(); process.stdout.write(JSON.stringify(await stats()));'))).toEqual([]);
});

it('rejects invalid keep values before storing a reservation', async () => {
  await expect(runApi(`await reserve({ keep: 'yes', size: 1, start: ${start} });`)).rejects.toThrow('keep');
  expect(JSON.parse(await runApi('process.stdout.write(JSON.stringify(await stats()));'))).toEqual([]);
});
