// Fails the build if anything copyrighted could ship: no audio files, no reference to the private
// local track, in dist/ (which is exactly what `wrangler deploy` uploads as static assets).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'dist';
const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      if (/\.(mp3|ogg|wav|m4a|flac|aac)$/i.test(name) || /osiris/i.test(name)) bad.push(`${p} (audio file)`);
      else if (/\.(js|css|html|json|txt|map)$/i.test(name) && /osiris|local-audio/i.test(readFileSync(p, 'utf8'))) {
        bad.push(`${p} (mentions the private track)`);
      }
    }
  }
};
walk(root);
const files = [];
const list = (dir) => readdirSync(dir).forEach((n) => (statSync(join(dir, n)).isDirectory() ? list(join(dir, n)) : files.push(join(dir, n))));
list(root);
if (bad.length) {
  console.error(`check-dist: FAILED — must not ship:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-dist: ok — ${files.length} files in dist/, no audio files, no reference to the private track.`);
