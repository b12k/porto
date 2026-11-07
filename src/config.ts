import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { PortoError } from './error';
import { checkIsFileMissing } from './files';
import { fetchGitContext } from './git';
import { loadConfigFile } from './load-config';
import { OPTIONS_SCHEMA, parseOptions } from './schemas';
import { validateVars, VARS_SCHEMA } from './vars';

export const DEFAULT_FILES = { envFile: '.env', write: 'porto.lock' } as const;
const CONFIG_FILES = ['porto.config.ts', 'porto.config.js'];
const FILE_SCHEMA = z.union([z.boolean(), z.string().min(1)]);
const CONFIG_SCHEMA = z
  .strictObject({
    ...OPTIONS_SCHEMA.shape,
    envFile: FILE_SCHEMA,
    json: z.boolean(),
    vars: VARS_SCHEMA,
    write: FILE_SCHEMA,
  })
  .partial();

export type PortoConfig = z.input<typeof CONFIG_SCHEMA>;

export const libraryName = 'porto';
export const { name, version } = packageJson;

export function defineConfig(config: PortoConfig) {
  return config;
}

function getConfigPaths(directoryPath: string, worktreePath: string) {
  const filePaths: string[] = [];
  for (let currentPath = directoryPath; ; currentPath = path.dirname(currentPath)) {
    filePaths.push(...CONFIG_FILES.map((fileName) => path.join(currentPath, fileName)));
    if (currentPath === worktreePath) return filePaths;
    if (path.dirname(currentPath) === currentPath) {
      throw new PortoError('configInvalid', 'Cannot find the checkout root.');
    }
  }
}

async function fetchConfigPath(candidates: string[]) {
  let configPath: string | undefined;
  for (const filePath of candidates) {
    try {
      // Stop at the nearest config without probing lower-priority files.
      // oxlint-disable-next-line no-await-in-loop
      await access(filePath);
      configPath = filePath;
      break;
    } catch (error) {
      if (!checkIsFileMissing(error)) throw error;
    }
  }
  return configPath;
}

export function parseConfig(config: unknown) {
  const result = CONFIG_SCHEMA.safeParse(config);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new PortoError('configInvalid', details, { cause: result.error });
  }
  return result.data;
}

function resolveConfigPaths(config: PortoConfig, filePath: string) {
  const directoryPath = path.dirname(filePath);
  for (const key of ['envFile', 'write'] as const) {
    const configuredPath = config[key];
    if (configuredPath === true || typeof configuredPath === 'string') {
      config[key] = path.resolve(directoryPath, configuredPath === true ? DEFAULT_FILES[key] : configuredPath);
    }
  }
  return config;
}

export async function fetchConfig() {
  const { worktree } = await fetchGitContext();
  const candidates = getConfigPaths(await realpath(process.cwd()), worktree);
  const filePath = await fetchConfigPath(candidates);
  if (!filePath) return parseConfig({});
  try {
    const config = await loadConfigFile(filePath);
    return resolveConfigPaths(parseConfig(config), filePath);
  } catch (error) {
    throw new PortoError('configInvalid', `${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function parseReserveConfig(config: unknown) {
  const settings = parseConfig(config);
  const options = parseOptions(settings);
  if (settings.vars !== undefined) validateVars(settings.vars, options.size);
  return { ...settings, ...options };
}
