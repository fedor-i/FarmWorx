// Builds the website demo into docs/demo. Run with `npm run build:demo` after changing the app.
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'demo');
const SIDE_BY_SIDE_LINK = `<a href="both.html"><span class="emoji">🖥️</span><span><strong>Worker and supervisor side by side</strong>Best on a computer: watch changes move between the two</span></a>\n    `;

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
cpSync(join(ROOT, 'src/demo/both.html'), join(OUT, 'both.html'));
cpSync(join(ROOT, 'src/demo/demo-bar.js'), join(OUT, 'js/demo-bar.js'));
cpSync(join(ROOT, 'node_modules/sql.js/dist/sql-wasm-browser.wasm'), join(OUT, 'sql-wasm.wasm'));

await build({
  entryPoints: [join(ROOT, 'src/demo/sw.js')],
  outfile: join(OUT, 'sw.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});

for (const name of readdirSync(OUT).filter((file) => file.endsWith('.html'))) {
  const file = join(OUT, name);
  let html = readFileSync(file, 'utf8');
  html = html.replace('</head>', '<script>window.FARMWORX_DEMO = true;</script>\n<script src="js/demo-bar.js" defer></script>\n</head>');
  if (name === 'index.html') {
    html = html
      .replace('<nav class="chooser-list">\n    ', `<nav class="chooser-list">\n    ${SIDE_BY_SIDE_LINK}`)
      .replace('Prototype. Pick a screen. Open two side by side to see changes arrive live.', 'Live demo. Pick a screen. Everything stays in this browser.');
  }
  writeFileSync(file, html);
}

console.log('Built docs/demo');
