import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { PortoError } from './error';
import { checkIsFileMissing } from './files';
import { loadConfigFile } from './load-config';
import { HOOKS_SCHEMA, OPTIONS_SCHEMA, parseOptions } from './schemas';
import { VARS_SCHEMA } from './vars';

export const DEFAULT_ENV_FILE = '.env';
const CONFIG_FILES = ['porto.config.ts', 'porto.config.js'];
const CONFIG_SCHEMA = z
  .strictObject({
    ...OPTIONS_SCHEMA.shape,
    ...HOOKS_SCHEMA.shape,
    env: z.boolean(),
    envFile: z.string().min(1),
    jsonFile: z.union([z.literal(false), z.string().min(1)]),
    vars: VARS_SCHEMA,
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
  const settings = result.data;
  return { ...settings, ...(settings.envFile !== undefined && settings.env === undefined ? { env: true } : {}) };
}

function resolveConfigPaths(config: ReturnType<typeof parseConfig>, filePath: string) {
  const directoryPath = path.dirname(filePath);
  for (const key of ['envFile', 'jsonFile'] as const) {
    const configuredPath = config[key];
    if (typeof configuredPath === 'string') config[key] = path.resolve(directoryPath, configuredPath);
  }
  return config;
}

export async function fetchConfig(worktree: string) {
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

export function applyReserveDefaults(settings: ReturnType<typeof parseConfig>) {
  return {
    ...settings,
    ...parseOptions(settings),
    env: settings.env ?? false,
    envFile: settings.envFile ?? DEFAULT_ENV_FILE,
    jsonFile: settings.jsonFile ?? false,
  };
}
