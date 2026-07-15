import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
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

const filePatterns = ['mjs', 'cjs', 'd.ts', 'd.mts'].map(ext => `**/*.${ext}`);

pkg.main = `index.cjs`;
pkg.module = `index.mjs`;
pkg.types = `index.d.ts`;
pkg.files = [...filePatterns, 'LICENSE', 'README.md'];
pkg.keywords = [
  'catbee',
  'catbee-mysql-client',
  'mysql',
  'mysql-client'
];

function rewriteImports(filePath) {
  if (!existsSync(filePath)) return;
  let content = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('index.cjs')) {
    content = content.replace(/require\(["'](\.\/?[^"']+)["']\)/g, (_, p) => `require("${p}/index.cjs")`);
  }
  if (filePath.endsWith('index.mjs')) {
    content = content.replace(
      /export\s+\*\s+from\s+["'](\.\/?[^"']+)["']/g,
      (_, p) => `export * from "${p}/index.mjs"`
    );
  }
  writeFileSync(filePath, content, 'utf-8');
}

rewriteImports(join(distDir, 'index.cjs'));
rewriteImports(join(distDir, 'index.mjs'));

const exportsMap = {};
const entries = readdirSync(distDir, { withFileTypes: true }).filter(d => d.isDirectory());

function scanExports(dir, keyBase = '') {
  const items = readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const full = join(dir, item.name);
    const exportKey = keyBase ? `${keyBase}/${item.name}` : item.name;

    if (item.isDirectory()) {
      scanExports(full, exportKey);
    } else if (item.isFile()) {
      if (item.name.endsWith('.d.ts') && item.name !== 'index.d.ts') {
        rmSync(full);
      }
      if (item.name === 'index.mjs') {
        // delete other than index.d.ts like other .d.ts files
        const key = `./${exportKey.replace(/\/index\.mjs$/, '')}`;
        exportsMap[key] = {
          import: `./${exportKey}`,
          require: `./${exportKey.replace('index.mjs', 'index.cjs')}`,
          types: `./${exportKey.replace('index.mjs', 'index.d.ts')}`
        };
      }
    }
  }
}

for (const dir of entries) {
  scanExports(join(distDir, dir.name), dir.name);
}

pkg.exports = {
  '.': {
    import: `./index.mjs`,
    require: `./index.cjs`,
    types: `./index.d.ts`
  },
  ...exportsMap
};

// 3. Write final package.json into build dir
writeFileSync(join(distDir, 'package.json'), JSON.stringify(pkg, null, 2));

console.log('✔ Postbuild completed.');