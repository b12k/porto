import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const packageUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;

function runCli(args: Array<string>, cwd = repositoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function runCliOutput(args: Array<string>, cwd = repositoryPath) {
  const { stdout } = await runCli(args, cwd);
  return stdout;
}

async function runCliJson(args: Array<string>, cwd = repositoryPath) {
  const output = await runCliOutput(args, cwd);
  return JSON.parse(output) as unknown;
}

function runGit(args: Array<string>) {
  return execFileAsync('git', args, { cwd: repositoryPath });
}

async function writeConfig(source: string, fileName = 'porto.config.ts', configDirectory = repositoryPath) {
  await writeFile(path.join(configDirectory, fileName), source);
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-config-'));
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
  start = await fetchFreeRange(32);
});

afterEach(async () => {
  const target = path.resolve(directoryPath);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('porto-config-')) {
    throw new Error('Invalid fixture directory.');
  }
  await rm(target, { force: true, recursive: true });
});

it('loads a TypeScript defineConfig file and assigns one port per variable entry', async () => {
  await writeConfig(`import { defineConfig } from ${JSON.stringify(packageUrl)};
    export default defineConfig({ start: ${start}, size: 3, env: true, vars: [
      'API_PORT',
      (slot, port, idx) => ({
        CLIENT_PORT: port,
        CLIENT_URL: 'https://wt' + slot + '.localhost:' + port + '/' + idx,
      }),
      'ADMIN_PORT',
    ] });`);
  const clientUrl = `https://wt0.localhost:${start + 1}/1`;
  expect(await runCliJson(['reserve', '--json'])).toEqual({
    ADMIN_PORT: start + 2,
    API_PORT: start,
    CLIENT_PORT: start + 1,
    CLIENT_URL: clientUrl,
    PORTO_SLOT: 0,
  });
  const env = parseEnv(await readFile(path.join(repositoryPath, '.env'), 'utf8'));
  expect(env).toEqual({
    ADMIN_PORT: String(start + 2),
    API_PORT: String(start),
    CLIENT_PORT: String(start + 1),
    CLIENT_URL: clientUrl,
    PORTO_SLOT: '0',
  });
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ ports: [start, start + 1, start + 2] }]);
});

it('runs reserve by default with and without options', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, vars: ['API_PORT'] };`);
  expect(await runCliOutput([])).toBe(`API_PORT=${start}\nPORTO_SLOT=0\n`);
  expect(await runCliOutput(['show'])).toBe('0\n');
  expect(await runCliOutput(['--env', '--json'])).toBe(await runCliOutput(['reserve', '--json']));
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe(`API_PORT=${start}\nPORTO_SLOT=0\n`);
});

it('loads an ESM JavaScript config', async () => {
  await writeFile(path.join(repositoryPath, 'package.json'), '{"type":"module"}');
  await writeConfig(`export default { start: ${start}, size: 3 };`, 'porto.config.js');
  expect(await runCliJson(['reserve', '--json'])).toEqual({ firstPort: start, index: 0, lastPort: start + 2 });
});

it('loads a CommonJS JavaScript config', async () => {
  await writeConfig(`module.exports = { start: ${start}, size: 3 };`, 'porto.config.js');
  expect(await runCliJson(['reserve', '--json'])).toEqual({ firstPort: start, index: 0, lastPort: start + 2 });
});

it('prefers TypeScript over JavaScript in the same directory', async () => {
  await writeConfig(`export default { start: ${start}, size: 2 };`);
  await writeConfig("throw new Error('Lower-priority JavaScript config must not load.');", 'porto.config.js');
  expect(await runCliJson(['reserve', '--json'])).toEqual({ firstPort: start, index: 0, lastPort: start + 1 });
});

it('uses the nearest config instead of merging parent configs', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig("throw new Error('A parent config must not load when a nearer config exists.');");
  await writeConfig(`module.exports = { start: ${start}, size: 2 };`, 'porto.config.js', nestedPath);
  expect(await runCliJson(['reserve', '--json'], nestedPath)).toEqual({
    firstPort: start,
    index: 0,
    lastPort: start + 1,
  });
});

it('does not search above the current Git checkout', async () => {
  await writeConfig("throw new Error('Config outside checkout must not load.');", 'porto.config.ts', directoryPath);
  const output = await runCliOutput(['reserve', '--start', String(start), '--size', '2', '--json']);
  expect(JSON.parse(output)).toEqual({ firstPort: start, index: 0, lastPort: start + 1 });
});

it('lets config settings override defaults and explicit CLI flags override config', async () => {
  await writeConfig(`export default { start: ${start}, size: 3, idleTtlMinutes: 5, keep: true };`);
  expect(await runCliJson(['reserve', '--json'])).toEqual({ firstPort: start, index: 0, lastPort: start + 2 });
  expect(await runCliJson(['show', '--json'])).toMatchObject({ firstPort: start, index: 0, lastPort: start + 2 });
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ idleTtlMinutes: 5, keep: true }]);
  await runCli(['release']);
  const output = await runCliOutput(['reserve', '--start', String(start + 10), '--size', '2', '--idle', '7', '--json']);
  expect(JSON.parse(output)).toEqual({ firstPort: start + 10, index: 0, lastPort: start + 11 });
  expect(await runCliOutput(['show', '--all'])).toContain('WORKTREE');
});

it('honors false config values and explicit positive boolean flags', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, keep: false };`);
  expect(await runCliOutput(['reserve', '--keep'])).toBe('0\n');
  expect(await runCliJson(['show', '--json'])).toMatchObject({ firstPort: start, index: 0, lastPort: start + 1 });
  expect(await runCliOutput(['show', '--all'])).toContain('WORKTREE');
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ keep: true }]);
});

it('disables configured vars, env and JSON files, and keep with no-* flags', async () => {
  await writeConfig(
    `export default { start: ${start}, size: 2, keep: true, vars: ['API_PORT'], envFile: '.env.config', jsonFile: 'ports.json' };`,
  );
  expect(await runCliOutput(['reserve', '--no-vars', '--no-env', '--no-json-file', '--no-keep'])).toBe('0\n');
  expect(await readdir(repositoryPath)).toEqual(['.git', 'porto.config.ts']);
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ keep: false }]);
  expect(await runCliOutput(['show'])).toBe('0\n');
});

it('resolves config paths from the config directory and CLI paths from cwd', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig(`export default { start: ${start}, size: 2, envFile: 'config.env', jsonFile: 'config.json' };`);
  const configured = await runCliOutput(['reserve', '--json'], nestedPath);
  const configJson = await readFile(path.join(repositoryPath, 'config.json'), 'utf8');
  expect(JSON.parse(configJson)).toEqual({ ...JSON.parse(configured), PORTO_SLOT: 0 });
  expect(await readFile(path.join(repositoryPath, 'config.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
  const explicit = await runCliOutput(['reserve', '--json-file=cli.json', '--env-file=cli.env', '--json'], nestedPath);
  const cliJson = await readFile(path.join(nestedPath, 'cli.json'), 'utf8');
  expect(JSON.parse(cliJson)).toEqual({ ...JSON.parse(explicit), PORTO_SLOT: 0 });
  expect(await readFile(path.join(nestedPath, 'cli.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
});

it('writes configured files in silent mode and lets --no-silent restore stdout', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig(
    `export default { start: ${start}, size: 2, envFile: '.env', jsonFile: 'ports.json', silent: true };`,
  );
  expect(await runCliOutput([], nestedPath)).toBe('');
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ firstPort: start, index: 0, lastPort: start + 1, PORTO_SLOT: 0 });
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
  expect(await readdir(nestedPath)).toEqual([]);
  expect(await runCliOutput(['reserve', '--no-silent'], nestedPath)).toBe('0\n');
});

it('creates exports only when requested and uses the default env filename and PORTO_SLOT', async () => {
  const args = ['reserve', '--start', String(start), '--size', '2'];
  await runCli(args);
  expect(await readdir(repositoryPath)).toEqual(['.git']);
  const stdout = await runCliOutput([...args, '--json-file=ports.json', '--env', '--json', '--silent']);
  expect(stdout).toBe('');
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ firstPort: start, index: 0, lastPort: start + 1, PORTO_SLOT: 0 });
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
});

it('writes only PORTO_SLOT with --env when no variables are configured', async () => {
  const envPath = path.join(repositoryPath, '.env');
  await writeFile(envPath, '# local settings\nOTHER=keep\n');
  const output = await runCliOutput(['reserve', '--env']);
  expect(await readFile(envPath, 'utf8')).toBe(`# local settings\nOTHER=keep\nPORTO_SLOT=${output.trim()}\n`);
});

it('lets an explicit CLI env filename enable env over a disabled config', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, env: false, envFile: 'config.env' };`);
  await runCli(['reserve']);
  expect(await readdir(repositoryPath)).toEqual(['.git', 'porto.config.ts']);
  await runCli(['reserve', '--env']);
  expect(await readFile(path.join(repositoryPath, 'config.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
  await runCli(['reserve', '--env-file=cli.env']);
  expect(await readFile(path.join(repositoryPath, 'cli.env'), 'utf8')).toBe('PORTO_SLOT=0\n');
});

it('lets --no-env disable an explicit CLI env filename in either flag order', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, env: true };`);
  await runCli(['reserve', '--env-file=first.env', '--no-env']);
  await runCli(['reserve', '--no-env', '--env-file=second.env']);
  expect(await readdir(repositoryPath)).toEqual(['.git', 'porto.config.ts']);
});

it('keeps a stored keep setting when the next config does not specify it', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, keep: true };`);
  await runCli(['reserve']);
  await writeConfig(`export default { start: ${start}, size: 2 };`);
  await runCli(['reserve']);
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ keep: true }]);
});

it('lets CLI vars replace configured callbacks and use their own positions', async () => {
  await writeConfig(`export default { start: ${start}, size: 3, vars: [(_slot, port) => ({ CONFIG_PORT: port })] };`);
  expect(
    JSON.parse(
      await runCliOutput([
        'reserve',
        '--vars',
        'API_PORT;HOST=wt{{slot}}.localhost;URL=http://localhost:{{port}}',
        '--json',
      ]),
    ),
  ).toEqual({ API_PORT: start, HOST: 'wt0.localhost', PORTO_SLOT: 0, URL: `http://localhost:${start + 2}` });
});

it('fails on invalid config before writing a reservation', async () => {
  await writeConfig(`export default { start: ${start}, size: 0 };`);
  await expect(runCli(['reserve'])).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(readFile(path.join(repositoryPath, '.git', 'porto-registry.json'))).rejects.toThrow(/ENOENT/u);
});

it.each(['--json-file=.git/porto-registry.json', '--env-file=.git/porto-registry.json.lock'])(
  'rejects a protected registry export before reserving: %s',
  async (option) => {
    await expect(runCli(['reserve', option])).rejects.toThrow('The Porto registry and its lock are reserved.');
    const gitFiles = await readdir(path.join(repositoryPath, '.git'));
    expect(gitFiles).not.toContain('porto-registry.json');
    expect(gitFiles).not.toContain('porto-registry.json.lock');
  },
);

it('protects the registry through symbolic links and hard links', async () => {
  const registryPath = path.join(repositoryPath, '.git', 'porto-registry.json');
  await symlink(registryPath, path.join(repositoryPath, 'symbolic.json'));
  await expect(runCli(['reserve', '--json-file=symbolic.json'])).rejects.toThrow('The Porto registry and its lock');
  await runCli(['reserve', '--start', String(start), '--size', '1']);
  const registry = await readFile(registryPath, 'utf8');
  await link(registryPath, path.join(repositoryPath, 'hard.json'));
  await expect(runCli(['reserve', '--env-file=hard.json'])).rejects.toThrow('The Porto registry and its lock');
  expect(await readFile(registryPath, 'utf8')).toBe(registry);
});

it('lets the CLI host override the config host', async () => {
  const host = '127.0.0.1';
  await writeConfig(`export default { host: '0.0.0.0', start: ${start}, size: 1 };`);
  await runCli(['reserve', '--host', host]);
  expect(await runCliJson(['show', '--all', '--json'])).toMatchObject([{ firstPort: start, host }]);
});

it('fails on a broken config instead of silently using defaults', async () => {
  await writeConfig('export default {');
  const expectedStderr: unknown = expect.stringContaining('Invalid Porto configuration.');
  await expect(runCli(['reserve', '--silent'])).rejects.toMatchObject({ code: 1, stderr: expectedStderr, stdout: '' });
});
