import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let start: number;

function runCli(args: Array<string>, cwd = directoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

function reserveSlot(size: number, cwd = directoryPath, rangeStart = start) {
  return runCli(['reserve', '--start', String(rangeStart), '--size', String(size), '--host', '127.0.0.1'], cwd);
}

async function runApi(source: string, cwd = directoryPath) {
  const script = `const { getAllSlots, getSlot, releaseSlot } = await import(${JSON.stringify(apiUrl)}); ${source}`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', script], {
    cwd,
  });
  return JSON.parse(stdout) as unknown;
}

async function runCliOutput(args: Array<string>, cwd = directoryPath) {
  const { stdout } = await runCli(args, cwd);
  return stdout;
}

function runGit(args: Array<string>) {
  return execFileAsync('git', args, { cwd: directoryPath });
}

async function createWorktree() {
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
  const worktreePath = path.join(directoryPath, 'other');
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  return worktreePath;
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-release-'));
  await runGit(['init', '-q']);
  start = await fetchFreeRange(12);
});

afterEach(async () => {
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-release-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('releases the selected slot, including index zero, and allows retries', async () => {
  await reserveSlot(2);
  await runCli(['release', '1']);
  expect(JSON.parse(await runCliOutput(['show', '--json']))).toMatchObject({ firstPort: start, index: 0 });
  await runCli(['release', '0']);
  await runCli(['release', '0']);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toEqual([]);
});

it('returns one current or released slot, or undefined when no slot matches', async () => {
  await reserveSlot(2);
  expect(
    await runApi('console.log(JSON.stringify({ releaseSlot: await releaseSlot(1), slot: await getSlot() }));'),
  ).toMatchObject({ slot: { firstPort: start, index: 0, lastPort: start + 1 } });
  expect(await runApi('console.log(JSON.stringify(await releaseSlot()));')).toMatchObject({ index: 0, ports: [] });
  expect(
    await runApi('console.log(JSON.stringify({ slot: await getSlot(), releaseSlot: await releaseSlot() }));'),
  ).toEqual({});
});

it('reads the checkout slot or a slot by index from any worktree without changing reservations', async () => {
  const worktreePath = await createWorktree();
  await reserveSlot(2);
  await reserveSlot(2, worktreePath);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const registry = await readFile(registryPath, 'utf8');
  expect(await runApi('console.log(JSON.stringify(await getSlot()));')).toMatchObject({ firstPort: start, index: 0 });
  expect(await runApi('console.log(JSON.stringify(await getSlot()));', worktreePath)).toMatchObject({ index: 1 });
  expect(
    await runApi('const slot = await getSlot(1); console.log(JSON.stringify([slot.index, slot.getPort(1)]));'),
  ).toEqual([1, start + 3]);
  expect(await runApi('console.log(JSON.stringify(await getSlot(0)));', worktreePath)).toMatchObject({ index: 0 });
  expect(await runApi('console.log(JSON.stringify({ missing: await getSlot(99) }));')).toEqual({});
  expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toMatchObject([{ index: 0 }, { index: 1 }]);
  const showOneOutput = await runCliOutput(['show', '1']);
  expect(showOneOutput).toMatch(/SLOT.*PORTS.*WORKTREE/su);
  expect(showOneOutput).toMatch(/VARS.*BUSY PORTS/su);
  expect(showOneOutput).toMatch(/│\s*1\s*│/u);
  expect(JSON.parse(await runCliOutput(['show', '0', '--json'], worktreePath))).toMatchObject({ index: 0 });
  await expect(runCli(['show', '99'])).rejects.toMatchObject({ code: 1, stdout: '' });
  expect(await readFile(registryPath, 'utf8')).toBe(registry);
});

it('shares one range across worktrees, preserves indices and reuses free slots', async () => {
  const worktreePath = await createWorktree();
  await reserveSlot(1);
  await expect(reserveSlot(1, worktreePath, start + 5)).rejects.toThrow('Port range settings differ');
  await runCli(['reserve'], worktreePath);
  const showOne = await runCliOutput(['show', '1']);
  expect(showOne).toMatch(/SLOT.*PORTS.*WORKTREE/su);
  expect(showOne).toMatch(/VARS.*BUSY PORTS/su);
  expect(showOne).toMatch(/│\s*1\s*│/u);
  const showCurrent = await runCliOutput(['show']);
  expect(showCurrent).toMatch(/SLOT.*PORTS.*WORKTREE/su);
  expect(showCurrent).toMatch(/VARS.*BUSY PORTS/su);
  expect(showCurrent).toMatch(/│\s*0\s*│/u);
  await runCli(['release', '0']);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toMatchObject([
    { firstPort: start + 1, index: 1 },
  ]);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const contents = await readFile(registryPath, 'utf8');
  expect(JSON.parse(contents)).toMatchObject({
    portsPerSlot: 1,
    slots: { 1: { vars: { SLOT: 1 } } },
    startPort: start,
  });
  await runCli(['reserve']);
  const reusedOutput = await runCliOutput(['show']);
  expect(reusedOutput).toMatch(/SLOT.*PORTS.*WORKTREE/su);
  expect(reusedOutput).toMatch(/VARS.*BUSY PORTS/su);
  expect(reusedOutput).toMatch(/│\s*0\s*│/u);
  await runCli(['release']);
  await runCli(['release', '1']);
  const emptyRegistry = await readFile(registryPath, 'utf8');
  expect(JSON.parse(emptyRegistry)).toEqual({ portsPerSlot: 1, slots: {}, startPort: start });
});

it('releases the current slot by default and another checkout slot by index with busy-port checks', async () => {
  const worktreePath = await createWorktree();
  await reserveSlot(1);
  await reserveSlot(1, worktreePath);
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start + 1 });
  await once(server, 'listening');
  try {
    const failure = 'try { await releaseSlot(1); } catch (error) { console.log(JSON.stringify(error.ports)); }';
    expect(await runApi(failure)).toEqual([{ port: start + 1, slot: 1 }]);
    expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toMatchObject([
      { index: 0 },
      { index: 1 },
    ]);
    expect(await runApi('console.log(JSON.stringify(await releaseSlot()));')).toMatchObject({
      firstPort: start,
      index: 0,
    });
    expect(await runApi('console.log(JSON.stringify(await getAllSlots()));')).toMatchObject([{ index: 1 }]);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  const source = 'const slot = await releaseSlot(1); console.log(JSON.stringify({ slot, port: slot.getPort() }));';
  expect(await runApi(source)).toMatchObject({ port: start + 1, slot: { index: 1 } });
  expect(
    await runApi('console.log(JSON.stringify({ slot: await releaseSlot(1), current: await getSlot() }));'),
  ).toEqual({});
});

it('rejects changes to the repository range while any slot is reserved', async () => {
  await reserveSlot(1);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const contents = await readFile(registryPath, 'utf8');
  await expect(reserveSlot(2)).rejects.toThrow('Port range settings differ');
  await expect(reserveSlot(1, directoryPath, start + 5)).rejects.toThrow('Port range settings differ');
  await expect(
    runApi(`await import(${JSON.stringify(apiUrl)}).then(({ reserve }) => reserve({ size: 2 }));`),
  ).rejects.toThrow('Port range settings differ');
  expect(await readFile(registryPath, 'utf8')).toBe(contents);
});

it('checks busy ports only in selected slots and keeps failed releases atomic', async () => {
  await reserveSlot(1);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const registry = await readFile(registryPath, 'utf8');
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  try {
    await expect(runCli(['release', '0'])).rejects.toThrow('Cannot release reservations while ports are in use.');
    expect(await readFile(registryPath, 'utf8')).toBe(registry);
    await runCli(['release', '1']);
    expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toMatchObject([{ index: 0 }]);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

it('respects an explicitly mapped SLOT variable instead of forcing the slot index', async () => {
  const args = [
    'reserve',
    '--start',
    String(start),
    '--size=3',
    '--vars=SLOT=wrong|API_PORT',
    '--env-file=.env.local',
    '--json-file=env.json',
  ];
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  try {
    await runCli(args);
    await runCli(args);
    expect(await readFile(path.join(directoryPath, '.env.local'), 'utf8')).toBe(`SLOT=wrong\nAPI_PORT=${start + 3}\n`);
    const jsonOutput = await readFile(path.join(directoryPath, 'env.json'), 'utf8');
    expect(JSON.parse(jsonOutput)).toEqual({ API_PORT: start + 3, SLOT: 'wrong' });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

it('allows a new repository range only after every slot is released', async () => {
  await reserveSlot(1);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  const registry = await readFile(registryPath, 'utf8');
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  try {
    await expect(reserveSlot(2, directoryPath, start + 5)).rejects.toThrow('Port range settings differ');
    expect(await readFile(registryPath, 'utf8')).toBe(registry);
    expect(await runApi('console.log(JSON.stringify(await getSlot()));')).toMatchObject({ firstPort: start, index: 0 });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await expect(reserveSlot(2, directoryPath, start + 5)).rejects.toThrow('Port range settings differ');
  await runCli(['release']);
  await reserveSlot(2, directoryPath, start + 5);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toMatchObject([
    { firstPort: start + 5, lastPort: start + 6 },
  ]);
});

it('runs release hooks only for slots removed by each call', async () => {
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    `import { appendFileSync } from 'node:fs';
     export default { onReleased(slot, ports) {
       appendFileSync('released.jsonl', JSON.stringify({ index: slot.index, ports }) + '\\n');
     } };`,
  );
  await reserveSlot(1);
  await reserveSlot(1);
  await runCli(['release', '1']);
  await runCli(['release', '1']);
  await expect(readFile(path.join(directoryPath, 'released.jsonl'))).rejects.toThrow(/ENOENT/u);
  await runCli(['release']);
  await runCli(['release', '0']);
  expect(await readFile(path.join(directoryPath, 'released.jsonl'), 'utf8')).toBe('{"index":0,"ports":[]}\n');
});

it.each([
  { args: ['-1'] },
  { args: ['0.5'] },
  { args: ['NaN'] },
  { args: ['Infinity'] },
  { args: [''] },
  { args: [' '] },
  { args: ['9007199254740992'] },
  { args: ['1oops'] },
  { args: ['1', '2'] },
])('rejects invalid slot and release arguments before changing reservations: %j', async ({ args }) => {
  await expect(runCli(['show', '--', ...args])).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(runCli(['release', '--', ...args])).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(readFile(path.join(directoryPath, '.git', 'porto-registry.json'))).rejects.toThrow(/ENOENT/u);
});
