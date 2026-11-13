/**
 * Shared build script for UI page plugins: bundles src/entry.tsx → index.js.
 *
 * Uses the repo-root esbuild via the JS API (avoids shell quoting issues with
 * --define values on Windows). Defines the env globals vite would inject so
 * vendored code reading import.meta.env / process.env behaves identically to
 * the main app build.
 *
 * Usage: node ../shared/build-plugin.mjs <entry> <outfile>
 */
import esbuild from '../../../node_modules/esbuild/lib/main.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Inline .css imports as <style> injections. Plugin bundles are loaded via a
 * Blob URL with no companion asset fetch, so CSS must ride along inside the JS.
 * A per-file guard keeps remounts from stacking duplicate style tags.
 */
const inlineCssPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8');
      const id = `plugin-css:${basename(args.path)}`;
      return {
        contents: [
          `if (!document.head.querySelector('style[data-plugin-css="${id}"]')) {`,
          `  const style = document.createElement('style');`,
          `  style.setAttribute('data-plugin-css', '${id}');`,
          `  style.textContent = ${JSON.stringify(css)};`,
          `  document.head.appendChild(style);`,
          `}`,
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('Usage: node build-plugin.mjs <entry> <outfile>');
  process.exit(1);
}

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  minify: true,
  plugins: [inlineCssPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env.PROD': 'true',
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_IS_PLATFORM': '"false"',
    'import.meta.env.VITE_DISABLE_LOCAL_AUTH': '"false"',
  },
  outfile,
});
