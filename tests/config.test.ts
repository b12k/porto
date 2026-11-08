import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fetchFreeRange } from './fixture';

// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const packageUrl = new URL('../src/index.ts', import.meta.url).href;
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;
let repositoryPath: string;
let start: number;

async function runCli(args: string[], cwd = repositoryPath) {
  return execFileAsync(process.execPath, ['--import', tsxPath, '--', cliPath, ...args], { cwd });
}

async function runCliOutput(args: string[], cwd = repositoryPath) {
  const { stdout } = await runCli(args, cwd);
  return stdout;
}

async function runGit(args: string[]) {
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

it('loads a TypeScript defineConfig file and indexes every flattened variable', async () => {
  await writeConfig(`import { defineConfig } from ${JSON.stringify(packageUrl)};
    export default defineConfig({ start: ${start}, size: 4, vars: [
      'API_PORT',
      { CLIENT_HOST: (block) => 'wt' + block + '.localhost', CLIENT_URL: (block, port, idx) => block + ':' + port + ':' + idx },
      'ADMIN_PORT',
    ] });`);
  expect(JSON.parse(await runCliOutput(['reserve', '--json']))).toEqual({
    ADMIN_PORT: start + 3,
    API_PORT: start,
    CLIENT_HOST: 'wt0.localhost',
    CLIENT_URL: `0:${start + 2}:2`,
  });
  const { stdout } = await runCli(['stats', '--json']);
  expect(JSON.parse(stdout)).toMatchObject([{ ports: [start, start + 1, start + 2, start + 3] }]);
});

it('runs reserve by default with and without options', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, vars: ['API_PORT'] };`);
  expect(await runCliOutput([])).toBe(`API_PORT=${start}\n`);
  expect(await runCliOutput(['current'])).toBe('0\n');
  expect(await runCliOutput(['--env', '--json'])).toBe(await runCliOutput(['reserve', '--json']));
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe(`API_PORT=${start}\n`);
});

it('loads an ESM JavaScript config', async () => {
  await writeFile(path.join(repositoryPath, 'package.json'), '{"type":"module"}');
  await writeConfig(`export default { start: ${start}, size: 3 };`, 'porto.config.js');
  expect(JSON.parse(await runCliOutput(['reserve', '--json']))).toEqual({ end: start + 2, index: 0, start });
});

it('loads a CommonJS JavaScript config', async () => {
  await writeConfig(`module.exports = { start: ${start}, size: 3 };`, 'porto.config.js');
  expect(JSON.parse(await runCliOutput(['reserve', '--json']))).toEqual({ end: start + 2, index: 0, start });
});

it('prefers TypeScript over JavaScript in the same directory', async () => {
  await writeConfig(`export default { start: ${start}, size: 2 };`);
  await writeConfig("throw new Error('Lower-priority JavaScript config must not load.');", 'porto.config.js');
  expect(JSON.parse(await runCliOutput(['reserve', '--json']))).toEqual({ end: start + 1, index: 0, start });
});

it('uses the nearest config instead of merging parent configs', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig("throw new Error('A parent config must not load when a nearer config exists.');");
  await writeConfig(`module.exports = { start: ${start}, size: 2 };`, 'porto.config.js', nestedPath);
  expect(JSON.parse(await runCliOutput(['reserve', '--json'], nestedPath))).toEqual({
    end: start + 1,
    index: 0,
    start,
  });
});

it('does not search above the current Git checkout', async () => {
  await writeConfig("throw new Error('Config outside checkout must not load.');", 'porto.config.ts', directoryPath);
  const output = await runCliOutput(['reserve', '--start', String(start), '--size', '2', '--json']);
  expect(JSON.parse(output)).toEqual({ end: start + 1, index: 0, start });
});

it('lets config settings override defaults and explicit CLI flags override config', async () => {
  await writeConfig(`export default { start: ${start}, size: 3, idleTtlMinutes: 5, keep: true };`);
  expect(JSON.parse(await runCliOutput(['reserve', '--json']))).toEqual({ end: start + 2, index: 0, start });
  expect(JSON.parse(await runCliOutput(['current', '--json']))).toEqual({ end: start + 2, index: 0, start });
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([
    { idleTtlMinutes: 5, keep: true, size: 3 },
  ]);
  const output = await runCliOutput(['reserve', '--start', String(start + 10), '--size', '2', '--idle', '7', '--json']);
  expect(JSON.parse(output)).toEqual({ end: start + 11, index: 0, start: start + 10 });
  expect(await runCliOutput(['stats'])).toContain('WORKTREE');
});

it('honors false config values and explicit positive boolean flags', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, keep: false };`);
  expect(await runCliOutput(['reserve', '--keep'])).toBe('0\n');
  expect(JSON.parse(await runCliOutput(['current', '--json']))).toEqual({ end: start + 1, index: 0, start });
  expect(await runCliOutput(['stats'])).toContain('WORKTREE');
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([{ keep: true }]);
});

it('disables configured vars, env and JSON files, and keep with no-* flags', async () => {
  await writeConfig(
    `export default { start: ${start}, size: 2, keep: true, vars: ['API_PORT'], envFile: '.env.config', jsonFile: 'ports.json' };`,
  );
  expect(await runCliOutput(['reserve', '--no-vars', '--no-env', '--no-json-file', '--no-keep'])).toBe('0\n');
  expect(await readdir(repositoryPath)).toEqual(['.git', 'porto.config.ts']);
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([{ keep: false }]);
  expect(await runCliOutput(['current'])).toBe('0\n');
});

it('resolves config paths from the config directory and CLI paths from cwd', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig(`export default { start: ${start}, size: 2, envFile: 'config.env', jsonFile: 'config.json' };`);
  const configured = await runCliOutput(['reserve', '--json'], nestedPath);
  expect(await readFile(path.join(repositoryPath, 'config.json'), 'utf8')).toBe(configured);
  expect(await readFile(path.join(repositoryPath, 'config.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
  const explicit = await runCliOutput(['reserve', '--json-file=cli.json', '--env-file=cli.env', '--json'], nestedPath);
  expect(await readFile(path.join(nestedPath, 'cli.json'), 'utf8')).toBe(explicit);
  expect(await readFile(path.join(nestedPath, 'cli.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
});

it('resolves configured files from the config directory and writes JSON independently of stdout', async () => {
  const nestedPath = path.join(repositoryPath, 'nested');
  await mkdir(nestedPath);
  await writeConfig(`export default { start: ${start}, size: 2, envFile: '.env', jsonFile: 'ports.json' };`);
  expect(await runCliOutput(['reserve'], nestedPath)).toBe('0\n');
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ end: start + 1, index: 0, start });
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
  expect(await readdir(nestedPath)).toEqual([]);
});

it('creates exports only when requested and uses the default env filename and PORTO_BLOCK', async () => {
  const args = ['reserve', '--start', String(start), '--size', '2'];
  await runCli(args);
  expect(await readdir(repositoryPath)).toEqual(['.git']);
  await runCli([...args, '--json-file=ports.json', '--env']);
  const jsonOutput = await readFile(path.join(repositoryPath, 'ports.json'), 'utf8');
  expect(JSON.parse(jsonOutput)).toEqual({ end: start + 1, index: 0, start });
  expect(await readFile(path.join(repositoryPath, '.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
});

it('writes only PORTO_BLOCK with --env when no variables are configured', async () => {
  const envPath = path.join(repositoryPath, '.env');
  await writeFile(envPath, '# local settings\nOTHER=keep\n');
  const output = await runCliOutput(['reserve', '--env']);
  expect(await readFile(envPath, 'utf8')).toBe(`# local settings\nOTHER=keep\nPORTO_BLOCK=${output.trim()}\n`);
});

it('lets an explicit CLI env filename enable env over a disabled config', async () => {
  await writeConfig(`export default { start: ${start}, size: 2, env: false, envFile: 'config.env' };`);
  await runCli(['reserve']);
  expect(await readdir(repositoryPath)).toEqual(['.git', 'porto.config.ts']);
  await runCli(['reserve', '--env']);
  expect(await readFile(path.join(repositoryPath, 'config.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
  await runCli(['reserve', '--env-file=cli.env']);
  expect(await readFile(path.join(repositoryPath, 'cli.env'), 'utf8')).toBe('PORTO_BLOCK=0\n');
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
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([{ keep: true }]);
});

it('lets CLI vars replace configured callbacks and use flattened positions', async () => {
  await writeConfig(`export default { start: ${start}, size: 3, vars: ['CONFIG_PORT'] };`);
  expect(
    JSON.parse(
      await runCliOutput([
        'reserve',
        '--vars',
        'API_PORT;HOST:wt{{block}}.localhost;URL:http://localhost:{{port}}',
        '--json',
      ]),
    ),
  ).toEqual({ API_PORT: start, HOST: 'wt0.localhost', URL: `http://localhost:${start + 2}` });
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
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([{ host, start }]);
});

it('fails on a broken config instead of silently using defaults', async () => {
  await writeConfig('export default {');
  await expect(runCli(['reserve'])).rejects.toMatchObject({ code: 1, stdout: '' });
});

it('loads config only for CLI reserve, not the library API or read commands', async () => {
  await writeConfig("throw new Error('The library API must not load this file.');");
  const source = `import { reserve } from ${JSON.stringify(packageUrl)}; console.log(JSON.stringify(await reserve({ start: ${start}, size: 2 })));`;
  const { stdout } = await execFileAsync(process.execPath, ['--import', tsxPath, '--input-type=module', '-e', source], {
    cwd: repositoryPath,
  });
  expect(JSON.parse(stdout)).toEqual({ end: start + 1, index: 0, ports: [], start });
  expect(JSON.parse(await runCliOutput(['current', '--json']))).toEqual({ end: start + 1, index: 0, start });
  expect(JSON.parse(await runCliOutput(['stats', '--json']))).toMatchObject([{ size: 2, start }]);
});
