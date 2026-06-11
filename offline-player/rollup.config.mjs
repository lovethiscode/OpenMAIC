import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = ['.mjs', '.js', '.jsx', '.json', '.ts', '.tsx'];

function resolveLocalFile(candidate) {
  for (const ext of ['', ...extensions]) {
    const file = candidate + ext;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Try the next extension.
    }
  }
  for (const ext of extensions) {
    const file = path.join(candidate, `index${ext}`);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Try the next extension.
    }
  }
  return candidate;
}

function openmaicAlias() {
  return {
    name: 'openmaic-alias',
    resolveId(source) {
      if (source === 'server-only') {
        return path.join(rootDir, 'offline-player', 'shims', 'empty.ts');
      }
      if (source.startsWith('@/')) {
        return resolveLocalFile(path.join(rootDir, source.slice(2)));
      }
      return null;
    },
  };
}

export default {
  input: path.join(rootDir, 'offline-player', 'main.tsx'),
  output: {
    file: path.join(rootDir, 'dist-offline', 'offline-player.js'),
    format: 'iife',
    inlineDynamicImports: true,
    name: 'OpenMAICOfflinePlayer',
    sourcemap: false,
  },
  plugins: [
    openmaicAlias(),
    nodeResolve({
      browser: true,
      extensions,
    }),
    commonjs(),
    typescript({
      tsconfig: path.join(rootDir, 'tsconfig.json'),
      clean: true,
      check: false,
      tsconfigOverride: {
        compilerOptions: {
          declaration: false,
          declarationMap: false,
          noEmit: false,
          sourceMap: false,
        },
        include: ['offline-player/**/*.ts', 'offline-player/**/*.tsx', 'components/**/*.tsx', 'lib/**/*.ts', 'lib/**/*.tsx'],
      },
    }),
  ],
};
