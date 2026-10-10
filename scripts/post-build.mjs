import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const distDir = join(cwd, 'dist');

if (!existsSync(distDir)) {
  throw new Error(`Build failed: dist directory not found`);
}

// 1. Copy LICENSE and README.md
const licenseSrc = join(cwd, 'LICENSE');
const readmeSrc = join(cwd, 'README.md');

if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, join(distDir, 'LICENSE'));
}

if (existsSync(readmeSrc)) {
  copyFileSync(readmeSrc, join(distDir, 'README.md'));
}

// 2. Build clean package.json
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));

delete pkg.scripts;
delete pkg.devDependencies;

// 3. Rename index.d.cts to index.d.ts
const dtsCts = join(distDir, 'index.d.cts');
const dts = join(distDir, 'index.d.ts');

if (existsSync(dtsCts)) {
  renameSync(dtsCts, dts);
}

const filePatterns = ['mjs', 'cjs', 'd.ts'].map(ext => `**/*.${ext}`);

pkg.main = `index.cjs`;
pkg.module = `index.mjs`;
pkg.types = `index.d.ts`;
pkg.files = [...filePatterns, 'LICENSE', 'README.md'];
pkg.keywords = ['catbee', 'catbee-mysql-client', 'mysql', 'mysql-client'];
pkg.exports = {
  '.': {
    types: './index.d.ts',
    import: './index.mjs',
    require: './index.cjs'
  }
};

// 4. Write final package.json into build dir
writeFileSync(join(distDir, 'package.json'), JSON.stringify(pkg, null, 2));

console.log('✔ Postbuild completed.');
