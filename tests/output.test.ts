import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomically } from '../src/files';
import { updateEnvironmentFile } from '../src/output';

// oxlint-disable-next-line typescript/strict-void-return
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

it('rejects write and env exports that resolve to the same file', async () => {
  await createRepository();
  const filePath = path.join(directoryPath, '.env.local');
  const linkPath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'OTHER=keep\n');
  await symlink(filePath, linkPath);
  await expect(
    execFileAsync(
      process.execPath,
      ['--import', tsxPath, '--', cliPath, 'reserve', `--write=${filePath}`, `--env-file=${linkPath}`],
      { cwd: directoryPath },
    ),
  ).rejects.toThrow('--write and --env-file must use different files.');
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
      ['--import', tsxPath, '--', cliPath, 'reserve', '--write=.ENV', '--env-file=.env'],
      { cwd: directoryPath },
    ),
  ).rejects.toThrow('--write and --env-file must use different files.');
});

it.skipIf(process.platform === 'win32')('preserves file permissions when replacing its contents', async () => {
  const filePath = path.join(directoryPath, '.env');
  await writeFile(filePath, 'SECRET=keep\n');
  await chmod(filePath, 0o600);
  await writeFileAtomically(filePath, 'SECRET=keep\nAPI_PORT=1000\n');
  const file = await stat(filePath);
  expect(file.mode.toString(8).slice(-3)).toBe('600');
});
