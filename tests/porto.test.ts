import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;
const servers: Array<ReturnType<typeof createServer>> = [];

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

function runGit(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

async function createWorktree(name: string) {
  const worktreePath = path.join(directoryPath, name);
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  return worktreePath;
}

async function expireRecords() {
  const registryPath = path.join(repositoryPath, '.git', 'porto-registry.json');
  const contents = await readFile(registryPath, 'utf8');
  await writeFile(
    registryPath,
    contents
      .replaceAll(/"lastUsedAt"\s*:\s*"[^"]+"/gu, '"lastUsedAt":"2000-01-01T00:00:00.000Z"')
      .replaceAll(/"expiresAt"\s*:\s*"[^"]+"/gu, '"expiresAt":"2000-01-01T00:00:00.000Z"'),
  );
}

function reserveArgs(...args: Array<string>) {
  return ['reserve', '--start', String(start), '--size', '2', ...args];
}

function runCli(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function runCliOutput(args: Array<string>, cwd = repositoryPath) {
  const { stdout } = await runCli(args, cwd);
  return stdout;
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-test-'));
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
  start = await fetchFreeRange(25);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeListener(server)));
  const resolvedPath = path.resolve(directoryPath);
  if (path.dirname(resolvedPath) !== path.resolve(tmpdir()) || !path.basename(resolvedPath).startsWith('porto-test-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(resolvedPath, { force: true, recursive: true });
});

it('keeps a stable slot and refreshes idle TTL before cleanup, even when ports are busy', async () => {
  const first = await runCli(reserveArgs('--json'));
  expect(JSON.parse(first.stdout)).toEqual({ firstPort: start, index: 0, lastPort: start + 1 });
  await expireRecords();
  await createListener(start);
  expect(await runCliOutput(reserveArgs())).toBe('0\n');
  expect(await runCliOutput(['show', '--all', '--json'])).toContain('"isExpired":false');
});

it('coordinates concurrent processes from the same and different worktrees', async () => {
  const worktreePath = await createWorktree('other');
  const results = await Promise.all([
    runCli(reserveArgs()),
    runCli(reserveArgs()),
    runCli(reserveArgs(), worktreePath),
    runCli(reserveArgs(), worktreePath),
  ]);
  expect(results[0].stdout).toBe(results[1].stdout);
  expect(results[2].stdout).toBe(results[3].stdout);
  expect(results[0].stdout).not.toBe(results[2].stdout);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toHaveLength(2);
});

it('keeps a reservation with a moved worktree and shows the new path', async () => {
  const worktreePath = await createWorktree('original');
  const movedPath = path.join(directoryPath, 'moved checkout');
  expect(await runCliOutput(reserveArgs('--keep'), worktreePath)).toBe('0\n');
  await runGit(['worktree', 'move', worktreePath, movedPath]);

  const movedShow = await runCliOutput(['show'], movedPath);
  expect(movedShow).toMatch(/SLOT.*VARS.*BUSY PORTS/su);
  expect(movedShow).toMatch(/│\s*0\s*│/u);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toMatchObject([
    { index: 0, keep: true, worktreePath: await realpath(movedPath) },
  ]);
  expect(await runCliOutput(reserveArgs(), movedPath)).toBe('0\n');
  await runCli(['release'], movedPath);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toEqual([]);
});

it('persists a refreshed reservation even with a submillisecond idle TTL', async () => {
  await runCli(reserveArgs('--idle', '0.000000001'));
  await runCli(reserveArgs('--idle', '0.000000001'));
  const showOutput = await runCliOutput(['show']);
  expect(showOutput).toMatch(/SLOT.*VARS.*BUSY PORTS/su);
});

it('skips busy and reserved slots within the repository range', async () => {
  await createListener(start);
  expect(await runCliOutput(reserveArgs())).toBe('1\n');
  const worktreePath = await createWorktree('overlap');
  const result = await runCli(reserveArgs('--json'), worktreePath);
  expect(JSON.parse(result.stdout)).toEqual({ firstPort: start + 4, index: 2, lastPort: start + 5 });
});

it('reads from subdirectories without refreshing timestamps or cleaning expired records', async () => {
  await runCli(reserveArgs());
  await expireRecords();
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  const nestedShow = await runCliOutput(['show'], nestedPath);
  expect(nestedShow).toMatch(/SLOT.*VARS.*BUSY PORTS/su);
  const worktreePath = await realpath(repositoryPath);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toMatchObject([
    { isExpired: true, lastUsedAt: '2000-01-01T00:00:00.000Z', worktreePath },
  ]);
  const table = await runCliOutput(['show', '--all']);
  expect(table).toMatch(/WORKTREE.*VARS.*BUSY PORTS/su);
  expect(table).toMatch(new RegExp(`repository.*${RegExp.escape(worktreePath)}.*years ago`, 'su'));
});

it('cleans only idle slots with every port free', async () => {
  const worktreePath = await createWorktree('cleanup');
  await runCli(reserveArgs());
  await runCli(reserveArgs(), worktreePath);
  await expireRecords();
  const { server } = await createListener(start);
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toHaveLength(1);
  await closeListener(server);
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toEqual([]);
});

it('keeps unexpired slots and reuses the lowest slot after idle cleanup', async () => {
  const worktreePath = await createWorktree('reuse');
  await runCli(reserveArgs());
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toHaveLength(1);
  await expireRecords();
  expect(await runCliOutput(reserveArgs(), worktreePath)).toBe('0\n');
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toHaveLength(1);
});

it('recovers a stale process lock', async () => {
  await runCli(reserveArgs());
  const lockPath = path.join(repositoryPath, '.git', 'porto-registry.json.lock');
  const staleAt = new Date(Date.now() - 20_000);
  await mkdir(lockPath);
  await utimes(lockPath, staleAt, staleAt);
  const showOutput = await runCliOutput(['show']);
  expect(showOutput).toMatch(/SLOT.*VARS.*BUSY PORTS/su);
});

it('keeps the current slot when a busy port prevents release', async () => {
  await runCli(reserveArgs());
  const { server } = await createListener(start + 1);
  const failure = runCli(['release']);
  await expect(failure).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(failure).rejects.toThrow(String(start + 1));
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toHaveLength(1);
  await closeListener(server);
  await runCli(['release']);
  await expect(runCli(['show'])).rejects.toMatchObject({ code: 1, stdout: '' });
});

it('supports a worktree of a bare repository and rejects the bare directory itself', async () => {
  const barePath = path.join(directoryPath, 'bare.git');
  await runGit(['clone', '--bare', repositoryPath, barePath]);
  const worktreePath = path.join(directoryPath, 'bare-worktree');
  await runGit(['worktree', 'add', '--detach', worktreePath], barePath);
  expect(await runCliOutput(reserveArgs(), worktreePath)).toBe('0\n');
  const records: unknown = JSON.parse(await readFile(path.join(barePath, 'porto-registry.json'), 'utf8'));
  expect(records).toHaveProperty('slots.0');
  await expect(runCli(reserveArgs(), barePath)).rejects.toThrow('working tree');
});

it('fails closed on a corrupt registry and leaves its contents intact', async () => {
  await runCli(reserveArgs());
  const filePath = path.join(repositoryPath, '.git', 'porto-registry.json');
  await writeFile(filePath, '{broken');
  await expect(runCli(reserveArgs())).rejects.toThrow('Cannot read reservation');
  expect(await readFile(filePath, 'utf8')).toBe('{broken');
});
it('maps grouped names and templates into stdout, JSON, and env files', async () => {
  const vars = 'API_PORT|CLIENT_HOST=wt{{slot}}.localhost;URL=http://localhost:{{port}}/?port={{port}}|DB_PORT';
  const result = await runCli(reserveArgs('--vars', vars, '--json-file=ports.json', '--env'));
  const output = `API_PORT=${start}\nCLIENT_HOST=wt0.localhost\nURL='http://localhost:${start + 1}/?port=${start + 1}'\nDB_PORT=${start + 1}\n`;
  expect(result.stdout).toBe(output);
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({
    API_PORT: start,
    CLIENT_HOST: 'wt0.localhost',
    DB_PORT: start + 1,
    URL: `http://localhost:${start + 1}/?port=${start + 1}`,
  });
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe(output);
});

it('preserves JSON template strings without requiring env quoting', async () => {
  const title = 'Bob\'s "dev"';
  const result = await runCli(reserveArgs('--vars', `TITLE=${title}`, '--json', '--json-file=ports.json'));
  expect(JSON.parse(result.stdout)).toEqual({ TITLE: title });
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ TITLE: title });
});

it('updates existing env keys and appends missing ones, preserving comments and CRLF', async () => {
  const envPath = path.join(repositoryPath, '.env.local');
  await writeFile(envPath, '# config\r\nexport API_PORT = 1 # keep\r\nOTHER="untouched"\r\nAPI_PORT=2\r\n');
  await runCli(reserveArgs('--vars', 'API_PORT;HOST=wt{{slot}}.localhost', '--env-file=.env.local'));
  expect(await readFile(envPath, 'utf8')).toBe(
    `# config\r\nexport API_PORT = ${start} # keep\r\nOTHER="untouched"\r\nAPI_PORT=${start}\r\nHOST=wt0.localhost\r\n`,
  );
});

it('preserves multiline env values and numeric filenames', async () => {
  const envPath = path.join(repositoryPath, '001');
  await writeFile(envPath, 'TEXT="line one\nSLOT=inside\nline three"\nSLOT=9 # keep\n');
  await runCli(reserveArgs('--json-file=000', '--env-file=001'));
  const jsonOutput = await readFile(path.join(repositoryPath, '000'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ SLOT: 0 });
  expect(await readFile(envPath, 'utf8')).toBe('TEXT="line one\nSLOT=inside\nline three"\nSLOT=0 # keep\n');
});

it('rejects bad arguments, unknown commands and invalid mapping before allocating', async () => {
  await Promise.all(
    [
      reserveArgs('--vars', 'A;B;C'),
      reserveArgs('--vars', 'A;A'),
      reserveArgs('--vars', 'BAD-NAME'),
      reserveArgs('--size', '0'),
      reserveArgs('--idle', 'NaN'),
      reserveArgs('--json-file='),
      reserveArgs('--json-file'),
      reserveArgs('--write=ports.json'),
      reserveArgs('--no-json'),
      reserveArgs('--env-file='),
      reserveArgs('--env-file'),
      ['unknown'],
      ['reserve', '--bogus'],
      ['show', 'extra'],
    ].map(async (args) => {
      await expect(runCli(args)).rejects.toMatchObject({ code: 1, stdout: '' });
    }),
  );
  expect(JSON.parse(await runCliOutput(['show', '--all', '--json']))).toEqual([]);
  expect(await runCliOutput(['--help'])).toContain('reserve');
  const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = await runCliOutput(['--version']);
  expect(manifest).toHaveProperty('version', version.trim());
});
