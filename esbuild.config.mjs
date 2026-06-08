import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  target: 'es2018',
  platform: 'node',
  external: ['obsidian'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  if (!prod) ctx.dispose();
}
