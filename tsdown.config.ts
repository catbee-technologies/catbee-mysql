import { defineConfig, type UserConfig } from 'tsdown';

const baseConfig: UserConfig = {
  outDir: 'dist',
  platform: 'node' as const,
  target: 'es2022',
  hash: false,
  unbundle: false,
  deps: {
    neverBundle: []
  },
  minify: false,
  outputOptions: {
    comments: false
  },
  checks: {
    bundlerTimings: false
  }
};

export default defineConfig([
  {
    ...baseConfig,
    format: ['cjs'],
    entry: ['src/index.ts'],
    dts: true
  },
  {
    ...baseConfig,
    format: ['esm'],
    entry: ['src/index.ts'],
    dts: false
  }
]);
