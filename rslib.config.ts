import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [{ bundle: false, dts: true }],
  source: { entry: { index: ['./src/*.ts'] }, tsconfigPath: './tsconfig.build.json' },
});
