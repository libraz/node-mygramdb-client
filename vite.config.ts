import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MygramClient',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // Keep every Node built-in external in both bare and `node:` forms
      // (Rollup treats `fs` and `node:fs` as distinct specifiers); `bindings`
      // and `@mapbox/node-pre-gyp` are resolved at runtime via createRequire.
      external: [/^node:/, ...builtinModules, 'bindings', '@mapbox/node-pre-gyp'],
      output: {
        exports: 'named',
      },
    },
    sourcemap: true,
    minify: 'esbuild',
    target: 'node18',
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**', '**/dist/**'],
    },
  },
});
