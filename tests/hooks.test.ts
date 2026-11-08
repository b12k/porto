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

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const apiUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
const BROKEN_VARS = "vars: ['API_PORT', { BAD_PORT() { throw new Error('broken factory'); } }]";
const servers: ReturnType<typeof createServer>[] = [];
let directoryPath: string;
let start: number;

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function runCli(args: string[], cwd = directoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function writeConfig(properties: string, configStart = start) {
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    `import { current, defineConfig } from ${JSON.stringify(apiUrl)};
     import { appendFile, readFile } from 'node:fs/promises';
     import { writeFileSync } from 'node:fs';
     export default defineConfig({ start: ${configStart}, size: 2, ${properties} });`,
  );
}

async function createWorktree() {
  await execFileAsync(
    'git',
    ['-c', 'user.name=Porto Test', '-c', 'user.email=porto@example.test', 'commit', '--allow-empty', '-qm', 'initial'],
    { cwd: directoryPath },
  );
  const worktreePath = path.join(directoryPath, 'other');
  await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath], { cwd: directoryPath });
  return worktreePath;
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-hooks-'));
  await execFileAsync('git', ['init', '-q'], { cwd: directoryPath });
  start = await fetchFreeRange(12);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => closeListener(server)));
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-hooks-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('awaits onReserved after exports and registry unlock, including reused blocks', async () => {
  await writeConfig(`env: true, jsonFile: 'ports.json',
    async onReserved(block, ports) {
      const [reserved] = await current();
      const env = await readFile('.env', 'utf8');
      const json = JSON.parse(await readFile('ports.json', 'utf8'));
      if (reserved?.start !== block.start || json.index !== block.index || env !== 'PORTO_BLOCK=' + block.index + '\\n') {
        throw new Error('Hook ran before reservation or exports completed.');
      }
      await appendFile('reserved.txt', block.index + ':' + ports.join(',') + '\\n');
    }`);
  const first = await runCli(['reserve']);
  const second = await runCli(['reserve']);
  expect(first.stdout).toBe('0\n');
  expect(second.stdout).toBe('0\n');
  expect(await readFile(path.join(directoryPath, 'reserved.txt'), 'utf8')).toBe('0:\n0:\n');
  const { stdout } = await runCli(['stats', '--json']);
  expect(JSON.parse(stdout)).toMatchObject([{ ports: [] }]);
});

it('passes only ports assigned through vars without changing JSON stdout', async () => {
  await writeConfig(`vars: ['API_PORT'], onReserved(block, ports) {
    if (ports[0] !== block.getPort()) throw new Error('Missing assigned port.');
    writeFileSync('reserved.json', JSON.stringify({ index: block.index, ports }));
  }`);
  const { stdout } = await runCli(['reserve', '--json']);
  expect(JSON.parse(stdout)).toEqual({ API_PORT: start });
  const marker = await readFile(path.join(directoryPath, 'reserved.json'), 'utf8');
  expect(JSON.parse(marker)).toEqual({ index: 0, ports: [start] });
});

it('calls onReleased once per block with saved assigned ports after config changes', async () => {
  const hooks = `async onReleased(block, ports) {
    if ((await current()).length !== 0) throw new Error('Hook ran before release completed.');
    await appendFile('released.txt', block.start + ':' + ports.join(',') + '\\n');
  }`;
  await writeConfig(`vars: ['API_PORT'], ${hooks}`);
  await runCli(['reserve']);
  await runCli(['reserve', '--start', String(start + 8), '--size', '1']);
  await writeConfig(hooks, start + 10);
  await runCli(['release']);
  const markerPath = path.join(directoryPath, 'released.txt');
  const markers = await readFile(markerPath, 'utf8');
  expect(markers.trim().split('\n').toSorted()).toEqual([`${start}:${start}`, `${start + 8}:${start + 8}`].toSorted());
});

it('does not call onReleased when the current checkout has no reservations', async () => {
  await writeConfig(`onReleased() { writeFileSync('released.txt', 'called'); }`);
  await runCli(['release']);
  await expect(readFile(path.join(directoryPath, 'released.txt'))).rejects.toThrow(/ENOENT/u);
});

it('releases only the current checkout and reports only its assigned ports', async () => {
  await writeConfig(`vars: ['API_PORT'], onReleased(block, ports) {
    writeFileSync('released.json', JSON.stringify({ index: block.index, ports }));
  }`);
  await runCli(['reserve']);
  const otherPath = await createWorktree();
  await runCli(['reserve', '--start', String(start), '--size', '2'], otherPath);
  await runCli(['release']);
  const { stdout } = await runCli(['stats', '--json']);
  expect(JSON.parse(stdout)).toMatchObject([{ ports: [], start: start + 2 }]);
  const marker = await readFile(path.join(directoryPath, 'released.json'), 'utf8');
  expect(JSON.parse(marker)).toEqual({ index: 0, ports: [start] });
});

it('keeps previously issued ports until release when vars change or are omitted', async () => {
  const hooks = `onReleased(block, ports) { writeFileSync('released.json', JSON.stringify(ports)); }`;
  await writeConfig(`vars: ['API_PORT'], ${hooks}`);
  await runCli(['reserve']);
  await writeConfig(`vars: ['API_PORT', 'OTHER_PORT'], ${hooks}`);
  await runCli(['reserve']);
  await writeConfig(hooks);
  await runCli(['reserve']);
  await runCli(['release']);
  const marker = await readFile(path.join(directoryPath, 'released.json'), 'utf8');
  expect(JSON.parse(marker)).toEqual([start, start + 1]);
});

it('does not call onReleased when a busy port prevents release', async () => {
  await writeConfig(`onReleased() { writeFileSync('released.txt', 'called'); }`);
  await runCli(['reserve']);
  const server = createServer();
  servers.push(server);
  server.listen({ host: '127.0.0.1', port: start });
  await once(server, 'listening');
  await expect(runCli(['release'])).rejects.toThrow('Cannot release reservations while ports are in use.');
  await expect(readFile(path.join(directoryPath, 'released.txt'))).rejects.toThrow(/ENOENT/u);
  const { stdout } = await runCli(['stats', '--json']);
  expect(JSON.parse(stdout)).toHaveLength(1);
});

it('reports a synchronous onReserved failure without rolling back the saved reservation', async () => {
  await writeConfig(`onReserved() { throw new Error('reserve hook failed'); }`);
  const failure = runCli(['reserve']);
  await expect(failure).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(failure).rejects.toThrow('onReserved: reserve hook failed');
  const { stdout } = await runCli(['current', '--json']);
  expect(JSON.parse(stdout)).toEqual({ end: start + 1, index: 0, start });
});

it('leaves the registry unchanged when a variable factory fails', async () => {
  await writeConfig(BROKEN_VARS);
  await expect(runCli(['reserve'])).rejects.toThrow('Cannot create BAD_PORT');
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  await expect(readFile(registryPath)).rejects.toThrow(/ENOENT/u);

  await writeConfig("vars: ['API_PORT']");
  await runCli(['reserve']);
  const registry = await readFile(registryPath, 'utf8');
  await writeConfig(BROKEN_VARS);
  await expect(runCli(['reserve'])).rejects.toThrow('Cannot create BAD_PORT');
  expect(await readFile(registryPath, 'utf8')).toBe(registry);
});

it('waits for the remaining release hooks before reporting a failure', async () => {
  await writeConfig(`async onReleased(block) {
    if (block.start === ${start}) throw new Error('release hook failed');
    await new Promise((resolve) => setImmediate(resolve));
    process.stderr.write('second hook finished\\n');
  }`);
  await runCli(['reserve']);
  await runCli(['reserve', '--start', String(start + 8), '--size', '1']);
  const expectedStderr: unknown = expect.stringMatching(/second hook finished[\s\S]*onReleased: release hook failed/u);
  await expect(runCli(['release'])).rejects.toMatchObject({ code: 1, stderr: expectedStderr, stdout: '' });
  const { stdout } = await runCli(['stats', '--json']);
  expect(JSON.parse(stdout)).toEqual([]);
});
