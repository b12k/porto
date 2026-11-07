import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;
const servers: ReturnType<typeof createServer>[] = [];

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

async function runGit(args: string[], cwd = repositoryPath) {
  return execFileAsync('git', args, { cwd });
}

async function createWorktree(name: string) {
  const worktreePath = path.join(directoryPath, name);
  await runGit(['worktree', 'add', '--detach', worktreePath]);
  return worktreePath;
}

async function expireRecords() {
  const registryPath = path.join(repositoryPath, '.git', 'porto');
  const fileNames = await readdir(registryPath);
  await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith('.json'))
      .map(async (fileName) => {
        const filePath = path.join(registryPath, fileName);
        const contents = await readFile(filePath, 'utf8');
        await writeFile(
          filePath,
          contents.replaceAll(/"lastUsedAt"\s*:\s*"[^"]+"/gu, '"lastUsedAt":"2000-01-01T00:00:00.000Z"'),
        );
      }),
  );
}

function reserveArgs(...args: string[]) {
  return ['reserve', '--start', String(start), '--size', '2', ...args];
}

async function runCli(args: string[], cwd = repositoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function runCliOutput(args: string[], cwd = repositoryPath) {
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
  await Promise.all(servers.splice(0).map(async (server) => closeListener(server)));
  const resolvedPath = path.resolve(directoryPath);
  if (path.dirname(resolvedPath) !== path.resolve(tmpdir()) || !path.basename(resolvedPath).startsWith('porto-test-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(resolvedPath, { force: true, recursive: true });
});

it('keeps a stable block and refreshes idle TTL before cleanup, even when ports are busy', async () => {
  const first = await runCli(reserveArgs('--json'));
  expect(JSON.parse(first.stdout)).toEqual({ end: start + 1, index: 0, start });
  await expireRecords();
  await createListener(start);
  expect(await runCliOutput(reserveArgs())).toBe('0\n');
  expect(await runCliOutput(['stats', '--json'])).toContain('"isExpired":false');
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
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toHaveLength(2);
});

it('persists a refreshed reservation even with a submillisecond idle TTL', async () => {
  await runCli(reserveArgs('--idle', '0.000000001'));
  await runCli(reserveArgs('--idle', '0.000000001'));
  expect(await runCliOutput(['current'])).toBe('0\n');
});

it('skips a candidate with a busy IPv4 port and avoids overlapping configurations', async () => {
  await createListener(start);
  expect(await runCliOutput(reserveArgs())).toBe('1\n');
  const worktreePath = await createWorktree('overlap');
  const result = await runCli(['reserve', '--start', String(start + 2), '--size', '1', '--json'], worktreePath);
  expect(JSON.parse(result.stdout)).toEqual({ end: start + 4, index: 2, start: start + 4 });
});

it('reads from subdirectories without refreshing timestamps or cleaning expired records', async () => {
  await runCli(reserveArgs());
  await expireRecords();
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  expect(await runCliOutput(['current'], nestedPath)).toBe('0\n');
  const result = await runCli(['stats', '--json']);
  expect(result.stdout).toContain('2000-01-01T00:00:00.000Z');
  expect(result.stdout).toContain('"isExpired":true');
  expect(await runCliOutput(['stats'])).toContain('WORKTREE');
});

it('cleans only idle blocks with every port free', async () => {
  const worktreePath = await createWorktree('cleanup');
  await runCli(reserveArgs());
  await runCli(reserveArgs(), worktreePath);
  await expireRecords();
  const { server } = await createListener(start);
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toHaveLength(1);
  await closeListener(server);
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toEqual([]);
});

it('keeps unexpired blocks and reuses the lowest block after idle cleanup', async () => {
  const worktreePath = await createWorktree('reuse');
  await runCli(reserveArgs());
  await runCli(['cleanup']);
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toHaveLength(1);
  await expireRecords();
  expect(await runCliOutput(reserveArgs(), worktreePath)).toBe('0\n');
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toHaveLength(1);
});

it('recovers a stale process lock', async () => {
  await runCli(reserveArgs());
  const lockPath = path.join(repositoryPath, '.git', 'porto', 'registry.lock');
  const staleAt = new Date(Date.now() - 20_000);
  await mkdir(lockPath);
  await utimes(lockPath, staleAt, staleAt);
  expect(await runCliOutput(['current'])).toBe('0\n');
});

it('releases all current ranges atomically or reports every busy port without deleting records', async () => {
  await runCli(reserveArgs());
  await runCli(['reserve', '--start', String(start + 20), '--size', '1']);
  const { server } = await createListener(start + 20);
  const failure = runCli(['release']);
  await expect(failure).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(failure).rejects.toThrow(String(start + 20));
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toHaveLength(2);
  await closeListener(server);
  await runCli(['release']);
  await expect(runCli(['current'])).rejects.toMatchObject({ code: 1, stdout: '' });
});

it('supports a worktree of a bare repository and rejects the bare directory itself', async () => {
  const barePath = path.join(directoryPath, 'bare.git');
  await runGit(['clone', '--bare', repositoryPath, barePath]);
  const worktreePath = path.join(directoryPath, 'bare-worktree');
  await runGit(['worktree', 'add', '--detach', worktreePath], barePath);
  expect(await runCliOutput(reserveArgs(), worktreePath)).toBe('0\n');
  const fileNames = await readdir(path.join(barePath, 'porto'));
  expect(fileNames.filter((fileName) => fileName.endsWith('.json'))).toHaveLength(1);
  await expect(runCli(reserveArgs(), barePath)).rejects.toThrow('working tree');
});

it('fails closed on a corrupt registry and leaves its contents intact', async () => {
  await runCli(reserveArgs());
  const registryPath = path.join(repositoryPath, '.git', 'porto');
  const fileNames = await readdir(registryPath);
  const fileName = fileNames.find((entry) => entry.endsWith('.json'));
  if (!fileName) throw new Error('Missing reservation.');
  const filePath = path.join(registryPath, fileName);
  await writeFile(filePath, '{broken');
  await expect(runCli(reserveArgs())).rejects.toThrow('Cannot read reservation');
  expect(await readFile(filePath, 'utf8')).toBe('{broken');
});
it('maps indexed templates and preserves JSON types', async () => {
  const vars = 'API_PORT;CLIENT_HOST:wt{{block}}.localhost;URL:http://localhost:{{port}}/{{port}}';
  const result = await runCli(reserveArgs('--size', '3', '--vars', vars, '--json', '--write=ports.json', '--env-file'));
  expect(JSON.parse(result.stdout)).toEqual({
    API_PORT: start,
    CLIENT_HOST: 'wt0.localhost',
    URL: `http://localhost:${start + 2}/${start + 2}`,
  });
  expect(await readFile(path.join(repositoryPath, 'ports.json'), 'utf8')).toBe(result.stdout);
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toContain(`API_PORT=${start}\n`);
});

it('creates exports only when requested, supports default filenames and PORTO_BLOCK', async () => {
  await runCli(reserveArgs());
  expect(await readdir(repositoryPath)).toEqual(['.git']);
  await runCli(reserveArgs('--write', '--env-file'));
  expect(await readFile(path.join(repositoryPath, 'porto.lock'), 'utf8')).toBe('0\n');
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
});

it('preserves JSON template strings without requiring env quoting', async () => {
  const title = 'Bob\'s "dev"';
  const result = await runCli(reserveArgs('--vars', `TITLE:${title}`, '--json', '--write=ports.json'));
  expect(JSON.parse(result.stdout)).toEqual({ TITLE: title });
  expect(await readFile(path.join(repositoryPath, 'ports.json'), 'utf8')).toBe(result.stdout);
});

it('updates existing env keys and appends missing ones, preserving comments and CRLF', async () => {
  const envPath = path.join(repositoryPath, '.env.local');
  await writeFile(envPath, '# config\r\nexport API_PORT = 1 # keep\r\nOTHER="untouched"\r\nAPI_PORT=2\r\n');
  await runCli(reserveArgs('--vars', 'API_PORT;HOST:wt{{block}}.localhost', '--env-file=.env.local'));
  expect(await readFile(envPath, 'utf8')).toBe(
    `# config\r\nexport API_PORT = ${start} # keep\r\nOTHER="untouched"\r\nAPI_PORT=${start}\r\nHOST=wt0.localhost\r\n`,
  );
});

it('preserves multiline env values and numeric filenames', async () => {
  const envPath = path.join(repositoryPath, '001');
  await writeFile(envPath, 'TEXT="line one\nPORTO_BLOCK=inside\nline three"\nPORTO_BLOCK=9 # keep\n');
  await runCli(reserveArgs('--write=000', '--env-file=001'));
  expect(await readFile(path.join(repositoryPath, '000'), 'utf8')).toBe('0\n');
  expect(await readFile(envPath, 'utf8')).toBe(
    'TEXT="line one\nPORTO_BLOCK=inside\nline three"\nPORTO_BLOCK=0 # keep\n',
  );
});

it('rejects bad arguments, unknown commands and invalid mapping before allocating', async () => {
  await Promise.all(
    [
      reserveArgs('--vars', 'A;B;C'),
      reserveArgs('--vars', 'A;A'),
      reserveArgs('--vars', 'BAD-NAME'),
      reserveArgs('--size', '0'),
      reserveArgs('--idle', 'NaN'),
      reserveArgs('--write='),
      ['unknown'],
      ['reserve', '--bogus'],
      ['current', 'extra'],
    ].map(async (args) => {
      await expect(runCli(args)).rejects.toMatchObject({ code: 1, stdout: '' });
    }),
  );
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toEqual([]);
  expect(await runCliOutput(['--help'])).toContain('reserve');
  expect(await runCliOutput(['--version'])).toContain('0.0.0');
});
