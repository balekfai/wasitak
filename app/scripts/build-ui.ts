import { build } from 'esbuild';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(root, 'src/ui/main.tsx')], bundle: true, minify: true, sourcemap: false, target: ['es2020'],
  outfile: path.join(root, 'public/app.js'), jsx: 'automatic', loader: { '.css': 'css' }, define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('UI built → public/app.js, public/app.css');
