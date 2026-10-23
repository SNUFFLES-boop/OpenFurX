// Builds the static site into _site/ for GitHub Pages:
//   public/            -> _site/
//   three.js           -> _site/vendor/three/ (only what the viewer imports)
//   data/index.json    -> published avatar manifests (drafts are left out, files included)
//   config.json        -> tells the app to use the GitHub-backed backend
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = '_site';
rmSync(out, { recursive: true, force: true });
cpSync('public', out, { recursive: true, filter: (src) => !src.replace(/\\/g, '/').startsWith('public/data/avatars') });

const three = 'node_modules/three';
mkdirSync(join(out, 'vendor/three/build'), { recursive: true });
cpSync(join(three, 'build/three.module.min.js'), join(out, 'vendor/three/build/three.module.min.js'));
cpSync(join(three, 'examples/jsm'), join(out, 'vendor/three/examples/jsm'), { recursive: true });

const avatarsDir = 'public/data/avatars';
const avatars = [];
if (existsSync(avatarsDir)) {
    for (const id of readdirSync(avatarsDir)) {
        const manifestPath = join(avatarsDir, id, 'manifest.json');
        if (!/^[a-z0-9]{12}$/.test(id) || !existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!manifest.published) continue;
        cpSync(join(avatarsDir, id), join(out, 'data/avatars', id), { recursive: true });
        avatars.push(manifest);
    }
}
avatars.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
mkdirSync(join(out, 'data'), { recursive: true });
writeFileSync(join(out, 'data/index.json'), JSON.stringify({ avatars }));
writeFileSync(join(out, 'config.json'), JSON.stringify({ static: true, repo: process.env.GITHUB_REPOSITORY || '', branch: process.env.GITHUB_REF_NAME || 'main' }));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`built ${out}: ${avatars.length} published avatar(s)`);
