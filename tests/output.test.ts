import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomically } from '../src/files';
import { formatStatsTable, updateEnvironmentFile } from '../src/output';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxPath = import.meta.resolve('tsx');
let directoryPath: string;

async function createRepository() {
  await execFileAsync('git', ['init', '-q'], { cwd: directoryPath });
}

beforeEach(async () => {
  directoryPath = await mkdtemp(path.join(tmpdir(), 'porto-output-test-'));
});

afterEach(async () => {
  const targetPath = path.resolve(directoryPath);
  if (
    path.dirname(targetPath) !== path.resolve(tmpdir()) ||
    !path.basename(targetPath).startsWith('porto-output-test-')
  ) {
    throw new Error('Refusing to remove a directory outside the test fixture.');
  }
  await rm(targetPath, { force: true, recursive: true });
});

it('shows the port range on one line in both show layouts', async () => {
  const worktreeName = 'x'.repeat(36);
  const worktreePath = path.join(path.parse(directoryPath).root, worktreeName);
  const now = Date.now();
  const slots = [
    {
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      firstPort: 10_000,
      idleTtlMinutes: 60,
      index: 0,
      keep: false,
      lastPort: 10_009,
      lastUsedAt: new Date(now - 65_000).toISOString(),
      vars: { PORT: 10_000, TITLE: 'first, second' },
      worktreePath,
    },
  ];
  const horizontal = await formatStatsTable(slots, 200);
  const rows = horizontal
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .slice(1)
    .map((line) =>
      line
        .split('│')
        .slice(1, 10)
        .map((cell) => cell.trim()),
    );
  expect(rows).toEqual([
    [
      '0',
      '10000-10009',
      worktreeName.slice(0, 30),
      worktreePath.slice(0, 30),
      '1 min ago',
      '60 min',
      'no',
      'no',
      'PORT=10000',
    ],
    ['', '', worktreeName.slice(30), worktreePath.slice(30), '', '', '', '', 'TITLE=first, second'],
  ]);
  const vertical = await formatStatsTable(slots, 44);
  expect(vertical).toContain('  PORTS: 10000-10009\n  WORKTREE:');
  expect(vertical).toContain(`  WORKTREE: ${worktreeName.slice(0, 30)}\n    ${worktreeName.slice(30)}`);
  expect(vertical).toContain(`  PATH: ${worktreePath.slice(0, 30)}\n    ${worktreePath.slice(30)}`);
  expect(vertical).toContain('  LAST USED: 1 min ago\n  IDLE IN: 60 min');
  expect(vertical).toContain('  VARS: PORT=10000\n    TITLE=first, second');
});

it('preserves both concurrent updates of the same env file', async () => {
  const filePath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'OTHER=keep\n');
  await Promise.all([
    updateEnvironmentFile(filePath, { API_PORT: 1000 }),
    updateEnvironmentFile(filePath, { CLIENT_PORT: 1001 }),
  ]);
  const contents = await readFile(filePath, 'utf8');
  expect(contents.trim().split('\n').toSorted()).toEqual(['API_PORT=1000', 'CLIENT_PORT=1001', 'OTHER=keep']);
});

it('updates the first env key while preserving a UTF-8 BOM', async () => {
  const filePath = path.join(directoryPath, '.env');
  await writeFile(filePath, '\uFEFFAPI_PORT=1\nOTHER=keep\n');
  await updateEnvironmentFile(filePath, { API_PORT: 1000 });
  expect(await readFile(filePath, 'utf8')).toBe('\uFEFFAPI_PORT=1000\nOTHER=keep\n');
});

it('appends a missing env key without replacing text inside another value', async () => {
  const filePath = path.join(directoryPath, '.env');
  const contents = "APP.TITLE='hello\nAPI_PORT=1\nworld'\nAPI_PORT_OLD=2\n";
  await writeFile(filePath, contents);
  await updateEnvironmentFile(filePath, { API_PORT: 1000 });
  expect(await readFile(filePath, 'utf8')).toBe(`${contents}API_PORT=1000\n`);
});

it('updates the real env file without replacing its symbolic link', async () => {
  const filePath = path.join(directoryPath, '.env.local');
  const linkPath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'API_PORT=1\n');
  await symlink(filePath, linkPath);
  await updateEnvironmentFile(linkPath, { API_PORT: 1000 });
  const link = await lstat(linkPath);
  expect(link.isSymbolicLink()).toBe(true);
  expect(await readFile(filePath, 'utf8')).toBe('API_PORT=1000\n');
});

it('rejects JSON and env exports that resolve to the same file', async () => {
  await createRepository();
  const filePath = path.join(directoryPath, '.env.local');
  const linkPath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'OTHER=keep\n');
  await symlink(filePath, linkPath);
  await expect(
    execFileAsync(
      process.execPath,
      ['--import', tsxPath, '--', cliPath, 'reserve', `--json-path=${filePath}`, `--env-path=${linkPath}`],
      { cwd: directoryPath },
    ),
  ).rejects.toThrow('--json-path and --env-path must use different files.');
  expect(await readFile(filePath, 'utf8')).toBe('OTHER=keep\n');
});

it('creates a missing env target while preserving its symbolic link', async () => {
  const filePath = path.join(directoryPath, '.env.local');
  const linkPath = path.join(directoryPath, '.env');
  await symlink(filePath, linkPath);
  await updateEnvironmentFile(linkPath, { API_PORT: 1000 });
  const link = await lstat(linkPath);
  expect(link.isSymbolicLink()).toBe(true);
  expect(await readFile(filePath, 'utf8')).toBe('API_PORT=1000\n');
});

it.skipIf(process.platform !== 'win32')('rejects case aliases of the same new export file on Windows', async () => {
  await createRepository();
  await expect(
    execFileAsync(
      process.execPath,
      ['--import', tsxPath, '--', cliPath, 'reserve', '--json-path=.ENV', '--env-path=.env'],
      { cwd: directoryPath },
    ),
  ).rejects.toThrow('--json-path and --env-path must use different files.');
});

it.skipIf(process.platform === 'win32')('preserves file permissions when replacing its contents', async () => {
  const filePath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'SECRET=keep\n');
  await chmod(filePath, 0o664);
  await writeFileAtomically(filePath, 'SECRET=keep\nAPI_PORT=1000\n');
  const file = await stat(filePath);
  expect(file.mode.toString(8).slice(-3)).toBe('664');
});
