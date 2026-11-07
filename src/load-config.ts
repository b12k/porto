import { cosmiconfig } from 'cosmiconfig';
import { createJiti } from 'jiti';

async function loadTypeScriptConfig(filePath: string) {
  return createJiti(import.meta.url).import(filePath, { default: true });
}

export async function loadConfigFile(filePath: string) {
  const result = await cosmiconfig('porto', { loaders: { '.ts': loadTypeScriptConfig } }).load(filePath);
  const config: unknown = result?.config;
  return config;
}
