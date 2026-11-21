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
const BROKEN_VARS = "vars: ['API_PORT', () => { throw new Error('broken factory'); }]";
const servers: Array<ReturnType<typeof createServer>> = [];
let directoryPath: string;
let start: number;

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
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

function runCli(args: Array<string>, cwd = directoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function writeConfig(properties: string, configStart = start) {
  await writeFile(
    path.join(directoryPath, 'porto.config.ts'),
    `import { defineConfig, getSlot } from ${JSON.stringify(apiUrl)};
     import { appendFile, readFile } from 'node:fs/promises';
     import { writeFileSync } from 'node:fs';
     export default defineConfig({ start: ${configStart}, size: 2, ${properties} });`,
  );
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-hooks-'));
  await execFileAsync('git', ['init', '-q'], { cwd: directoryPath });
  start = await fetchFreeRange(12);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeListener(server)));
  const targetPath = path.resolve(directoryPath);
  if (path.dirname(targetPath) !== path.resolve(tmpdir()) || !path.basename(targetPath).startsWith('porto-hooks-')) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('awaits onReserved after exports and registry unlock, including reused slots', async () => {
  await writeConfig(`env: true, jsonFile: 'ports.json',
    async onReserved(slot, ports) {
      const reserved = await getSlot();
      const env = await readFile('.env', 'utf8');
      const json = JSON.parse(await readFile('ports.json', 'utf8'));
      if (reserved?.firstPort !== slot.firstPort || json.index !== slot.index || env !== 'PORTO_SLOT=' + slot.index + '\\n') {
        throw new Error('Hook ran before reservation or exports completed.');
      }
      await appendFile('reserved.txt', slot.index + ':' + ports.join(',') + '\\n');
    }`);
  const first = await runCli(['reserve']);
  const second = await runCli(['reserve']);
  expect(first.stdout).toBe('0\n');
  expect(second.stdout).toBe('0\n');
  expect(await readFile(path.join(directoryPath, 'reserved.txt'), 'utf8')).toBe('0:\n0:\n');
  const { stdout } = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(stdout)).toMatchObject([{ ports: [] }]);
});

it('passes one port per variable entry to onReserved even when it produces multiple variables', async () => {
  await writeConfig(`vars: [(_slot, port) => ({ API_PORT: port, API_PORT_ALIAS: port })], onReserved(slot, ports) {
    if (ports[0] !== slot.getPort()) throw new Error('Missing assigned port.');
    writeFileSync('reserved.json', JSON.stringify({ index: slot.index, ports }));
  }`);
  const { stdout } = await runCli(['reserve', '--json']);
  expect(JSON.parse(stdout)).toEqual({ API_PORT: start, API_PORT_ALIAS: start, PORTO_SLOT: 0 });
  const marker = await readFile(path.join(directoryPath, 'reserved.json'), 'utf8');
  expect(JSON.parse(marker)).toEqual({ index: 0, ports: [start] });
});

it('calls onReleased for the current slot with saved assigned ports after config changes', async () => {
  const hooks = `async onReleased(slot, ports) {
    if ((await getSlot()) !== undefined) throw new Error('Hook ran before release completed.');
    await appendFile('released.txt', slot.firstPort + ':' + ports.join(',') + '\\n');
  }`;
  await writeConfig(`vars: [(_slot, port) => ({ API_PORT: port, API_PORT_ALIAS: port })], ${hooks}`);
  await runCli(['reserve']);
  await writeConfig(hooks, start + 10);
  await runCli(['release']);
  const markerPath = path.join(directoryPath, 'released.txt');
  const markers = await readFile(markerPath, 'utf8');
  expect(markers).toBe(`${start}:${start}\n`);
});

it('does not call onReleased when the current checkout has no reservations', async () => {
  await writeConfig(`onReleased() { writeFileSync('released.txt', 'called'); }`);
  await runCli(['release']);
  await expect(readFile(path.join(directoryPath, 'released.txt'))).rejects.toThrow(/ENOENT/u);
});

it('defaults to the current checkout and passes the selected slot to release hooks', async () => {
  await writeConfig(`vars: ['API_PORT'], onReleased(slot, ports) {
    writeFileSync('released.json', JSON.stringify({ index: slot.index, ports }));
  }`);
  await runCli(['reserve']);
  const otherPath = await createWorktree();
  await runCli(['reserve', '--start', String(start), '--size', '2'], otherPath);
  await runCli(['release']);
  const { stdout } = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(stdout)).toMatchObject([{ firstPort: start + 2, ports: [] }]);
  const marker = await readFile(path.join(directoryPath, 'released.json'), 'utf8');
  expect(JSON.parse(marker)).toEqual({ index: 0, ports: [start] });
  await runCli(['release', '1']);
  const selectedMarker = await readFile(path.join(directoryPath, 'released.json'), 'utf8');
  expect(JSON.parse(selectedMarker)).toEqual({ index: 1, ports: [] });
});

it('keeps previously issued ports until release when vars change or are omitted', async () => {
  const hooks = `onReleased(slot, ports) { writeFileSync('released.json', JSON.stringify(ports)); }`;
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
  const { stdout } = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(stdout)).toHaveLength(1);
});

it('reports a synchronous onReserved failure without rolling back the saved reservation', async () => {
  await writeConfig(`onReserved() { throw new Error('reserve hook failed'); }`);
  const failure = runCli(['reserve']);
  await expect(failure).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(failure).rejects.toThrow('onReserved: reserve hook failed');
  const { stdout } = await runCli(['show', '--json']);
  expect(JSON.parse(stdout)).toMatchObject({ firstPort: start, index: 0, lastPort: start + 1 });
});

it('leaves the registry unchanged when a variable factory fails', async () => {
  await writeConfig(BROKEN_VARS);
  await expect(runCli(['reserve'])).rejects.toThrow(/Cannot create variables for entry 2/u);
  const registryPath = path.join(directoryPath, '.git', 'porto-registry.json');
  await expect(readFile(registryPath)).rejects.toThrow(/ENOENT/u);

  await writeConfig("vars: ['API_PORT']");
  await runCli(['reserve']);
  const registry = await readFile(registryPath, 'utf8');
  await writeConfig(BROKEN_VARS);
  await expect(runCli(['reserve'])).rejects.toThrow(/Cannot create variables for entry 2/u);
  expect(await readFile(registryPath, 'utf8')).toBe(registry);
});

it('awaits an asynchronous release hook before reporting its failure', async () => {
  await writeConfig(`async onReleased() {
    await new Promise((resolve) => setImmediate(resolve));
    process.stderr.write('hook finished\\n');
    throw new Error('release hook failed');
  }`);
  await runCli(['reserve']);
  const expectedStderr: unknown = expect.stringMatching(/hook finished[\s\S]*onReleased: release hook failed/u);
  await expect(runCli(['release'])).rejects.toMatchObject({ code: 1, stderr: expectedStderr, stdout: '' });
  const { stdout } = await runCli(['show', '--all', '--json']);
  expect(JSON.parse(stdout)).toEqual([]);
});
