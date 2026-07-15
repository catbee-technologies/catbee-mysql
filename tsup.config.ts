import { defineConfig, Options } from 'tsup';

const buildDir = 'dist/';

const external: string[] = ['luxon'];

type Config = {
  bundle?: boolean;
  sourcemap?: boolean;
  format?: 'cjs' | 'esm';
  dts?: boolean;
}

const getBaseConfig = ({ bundle = true, sourcemap = false, format = 'cjs', dts = false }: Config): Options => {
  const options: Options = {
    bundle,
    splitting: false,
    target: 'es2022',
    clean: true,
    minify: false,
    sourcemap,
    format,
    outExtension({ format }) {
      return format === 'esm' ? { js: '.mjs' } : { js: '.cjs' };
    },
    treeshake: 'recommended',
    external,
    dts,
    esbuildOptions(options) {
      options.logLevel = 'silent';
    }
  };
  return options;
};

export default defineConfig([
  {
    ...getBaseConfig({ bundle: true, sourcemap: false, format: 'cjs', dts: false }),
    entry: ['src/index.ts'],
    outDir: buildDir
  },
  {
    ...getBaseConfig({ bundle: true, sourcemap: false, format: 'esm', dts: true }),
    entry: ['src/index.ts'],
    outDir: buildDir
  }
]);