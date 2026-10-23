// GitHub-backed implementation of the /api calls, used when the site is hosted as static files
// (GitHub Pages). Visitors read the data the deploy workflow publishes; the owner "logs in" with a
// fine-grained GitHub token and every change is a commit to the repo, which redeploys the site.

const TOKEN_KEY = 'ofx.gh-token';
const API = 'https://api.github.com';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // the contents API accepts up to 100 MB, but large bodies fail often

const KINDS = {
    '.fbx': 'model', '.glb': 'model', '.gltf': 'model', '.obj': 'model', '.vrm': 'model',
    '.bin': 'buffer', '.mtl': 'material',
    '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.tga': 'texture',
    '.prefab': 'unity', '.unitypackage': 'unity', '.mat': 'unity', '.asset': 'unity', '.controller': 'unity',
    '.json': 'data', '.txt': 'data', '.zip': 'archive',
};
const MODEL_PRIORITY = ['.glb', '.vrm', '.gltf', '.fbx', '.obj'];

let config = { repo: '', branch: 'main' };
let ownerVerified = false;
let publicIndex = null;
let queue = Promise.resolve(); // commits to one branch must not overlap

export function configure(cfg) {
    config = { repo: cfg.repo, branch: cfg.branch || 'main' };
}

export const repoName = () => config.repo;

export const fileUrl = (id, name) => `data/avatars/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

const ext = (name) => name.slice(name.lastIndexOf('.')).toLowerCase();
const dir = (id) => `public/data/avatars/${id}`;
const validId = (id) => /^[a-z0-9]{12}$/.test(id);

function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

class HttpError extends Error {}

async function gh(path, { method = 'GET', body, raw = false } = {}) {
    const token = getToken();
    if (!token) throw new HttpError('Owner login required');
    const res = await fetch(`${API}/repos/${config.repo}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        ownerVerified = false;
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        throw new HttpError('GitHub rejected the token. Log in again.');
    }
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new HttpError(detail.message || `GitHub request failed (${res.status})`);
    }
    if (res.status === 204) return {};
    return raw ? res.text() : res.json();
}

const ref = () => `?ref=${encodeURIComponent(config.branch)}`;

function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

async function putContent(path, base64, message) {
    return serial(async () => {
        const existing = await gh(`/contents/${path}${ref()}`);
        await gh(`/contents/${path}`, { method: 'PUT', body: { message, content: base64, branch: config.branch, ...(existing?.sha ? { sha: existing.sha } : {}) } });
    });
}

async function deleteContent(path, message) {
    return serial(async () => {
        const existing = await gh(`/contents/${path}${ref()}`);
        if (existing?.sha) await gh(`/contents/${path}`, { method: 'DELETE', body: { message, sha: existing.sha, branch: config.branch } });
    });
}

function toBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error(`Could not read ${blob.name || 'file'}`));
        reader.readAsDataURL(blob);
    });
}

const encodeText = (text) => toBase64(new Blob([text]));

// ---------------------------------------------------------------- session

export async function session() {
    if (!getToken()) return { owner: false, loginEnabled: true };
    if (!ownerVerified) {
        try {
            ownerVerified = !!(await gh(''))?.permissions?.push;
        } catch {
            ownerVerified = false;
        }
    }
    return { owner: ownerVerified, loginEnabled: true };
}

export async function login(token) {
    token = String(token || '').trim();
    if (!token) throw new Error('Paste a GitHub token');
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { throw new Error('This browser blocks session storage'); }
    ownerVerified = false;
    let info;
    try {
        info = await gh('');
    } catch (err) {
        logout();
        throw err;
    }
    if (!info) {
        logout();
        throw new Error(`The token cannot see ${config.repo}`);
    }
    if (!info.permissions?.push) {
        logout();
        throw new Error('The token needs Contents: read and write on this repository');
    }
    ownerVerified = true;
}

export function logout() {
    ownerVerified = false;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- reads

async function readPublicIndex() {
    if (!publicIndex) {
        const res = await fetch('data/index.json', { cache: 'no-cache' });
        publicIndex = res.ok ? (await res.json()).avatars || [] : [];
    }
    return publicIndex;
}

async function readManifest(id) {
    const text = await gh(`/contents/${dir(id)}/manifest.json${ref()}`, { raw: true });
    if (!text) throw new HttpError('Avatar not found');
    return JSON.parse(text);
}

async function listOwnerManifests() {
    const entries = await gh(`/contents/public/data/avatars${ref()}`);
    const ids = (entries || []).filter((e) => e.type === 'dir' && validId(e.name)).map((e) => e.name);
    const manifests = await Promise.all(ids.map((id) => readManifest(id).catch(() => null)));
    return manifests.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------- writes

const cleanString = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const cleanList = (v, maxItems, maxLen) => [...new Set((Array.isArray(v) ? v : []).slice(0, maxItems).map((s) => cleanString(s, maxLen)).filter(Boolean))];

function pickModel(files) {
    for (const e of MODEL_PRIORITY) {
        const hit = files.find((f) => ext(f.name) === e);
        if (hit) return hit.name;
    }
    return '';
}

function applyFields(manifest, body) {
    if ('name' in body) manifest.name = cleanString(body.name, 80) || 'Untitled avatar';
    if ('description' in body) manifest.description = cleanString(body.description, 4000);
    if ('tags' in body) manifest.tags = cleanList(body.tags, 24, 32).map((t) => t.toLowerCase());
    if ('published' in body) manifest.published = !!body.published;
    if ('rig' in body && body.rig && typeof body.rig === 'object') {
        const r = body.rig;
        manifest.rig = {
            physbones: (Array.isArray(r.physbones) ? r.physbones : []).slice(0, 256).map((pb) => ({
                root: cleanString(pb?.root, 160), name: cleanString(pb?.name, 64),
                pull: clamp(pb?.pull, 0, 1, 0.2), spring: clamp(pb?.spring, 0, 1, 0.2),
                stiffness: clamp(pb?.stiffness, 0, 1, 0.2), gravity: clamp(pb?.gravity, -1, 1, 0.05), ignore: cleanList(pb?.ignore, 64, 160),
            })).filter((pb) => pb.root),
            clothes: cleanList(r.clothes, 512, 160),
            inactive: cleanList(r.inactive, 512, 160),
            expressions: {
                menu: Array.isArray(r.expressions?.menu) ? r.expressions.menu : [],
                parameters: Array.isArray(r.expressions?.parameters) ? r.expressions.parameters : [],
            },
            source: cleanString(r.source, 64),
        };
    }
    if ('render' in body && body.render && typeof body.render === 'object') {
        const r = body.render;
        manifest.render = {
            emission: clamp(r.emission, 0, 10, 1), bloom: clamp(r.bloom, 0, 3, 0.9),
            shading: ['original', 'toon', 'unlit', 'clay', 'wire'].includes(r.shading) ? r.shading : 'original',
            alphaCutout: !!r.alphaCutout, accent: /^#[0-9a-f]{6}$/i.test(r.accent || '') ? r.accent : '#ff1a3c',
        };
    }
    if ('model' in body) {
        const model = cleanString(body.model, 160);
        if (model && !manifest.files.some((f) => f.name === model && f.kind === 'model')) throw new HttpError('Unknown model file');
        manifest.model = model || pickModel(manifest.files);
    }
    if ('thumbnail' in body) {
        const thumb = cleanString(body.thumbnail, 160);
        if (thumb && !manifest.files.some((f) => f.name === thumb && f.kind === 'texture')) throw new HttpError('Unknown thumbnail file');
        manifest.thumbnail = thumb;
    }
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function writeManifest(manifest, message) {
    manifest.updatedAt = new Date().toISOString();
    await putContent(`${dir(manifest.id)}/manifest.json`, await encodeText(JSON.stringify(manifest, null, 2)), message);
    return manifest;
}

export async function putFiles(id, files, rows, onProgress) {
    const manifest = await readManifest(id);
    for (const [i, { name, blob }] of files.entries()) {
        if (!KINDS[ext(name)]) throw new Error(`${name}: file type not allowed`);
        if (blob.size > MAX_FILE_BYTES) throw new Error(`${name} is ${(blob.size / 1048576).toFixed(0)} MB; the GitHub API limit here is ${MAX_FILE_BYTES / 1048576} MB. Decimate the mesh or compress textures.`);
        rows?.[i]?.setStatus('committing');
        await putContent(`${dir(id)}/${name}`, await toBase64(blob), `Upload ${name} to ${manifest.name}`);
        rows?.[i]?.setProgress(1);
        rows?.[i]?.setStatus('done');
        onProgress?.((i + 1) / files.length);
        const kind = KINDS[ext(name)];
        manifest.files = manifest.files.filter((f) => f.name !== name);
        manifest.files.push({ name, size: blob.size, kind });
    }
    manifest.files.sort((a, b) => a.name.localeCompare(b.name));
    if (!manifest.model) manifest.model = pickModel(manifest.files);
    return writeManifest(manifest, `Update files for ${manifest.name}`);
}

// ---------------------------------------------------------------- router

function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export async function request(path, { method = 'GET', body } = {}) {
    const parts = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
    const owner = (await session()).owner;
    const need = () => { if (!owner) throw new HttpError('Owner login required'); };

    if (parts[1] === 'session') return session();
    if (parts[1] !== 'avatars') throw new HttpError('Not found');

    if (parts.length === 2) {
        if (method === 'GET') return { avatars: owner ? await listOwnerManifests() : (await readPublicIndex()) };
        if (method === 'POST') {
            need();
            const id = newId();
            const now = new Date().toISOString();
            const manifest = {
                id, name: 'Untitled avatar', description: '', tags: [], createdAt: now, updatedAt: now, published: true,
                model: '', thumbnail: '', files: [],
                rig: { physbones: [], clothes: [], inactive: [], expressions: { menu: [], parameters: [] }, source: '' },
                render: { emission: 1, bloom: 0.9, shading: 'original', alphaCutout: false, accent: '#ff1a3c' },
            };
            applyFields(manifest, body || {});
            return writeManifest(manifest, `Create avatar ${manifest.name}`);
        }
        throw new HttpError('Method not allowed');
    }

    const id = parts[2];
    if (!validId(id)) throw new HttpError('Avatar not found');
    const load = async () => {
        if (owner) return readManifest(id);
        const found = (await readPublicIndex()).find((m) => m.id === id);
        if (!found) throw new HttpError('Avatar not found');
        return found;
    };

    if (parts.length === 3) {
        if (method === 'GET') return load();
        need();
        const manifest = await readManifest(id);
        if (method === 'PATCH') {
            applyFields(manifest, body || {});
            return writeManifest(manifest, `Edit ${manifest.name}`);
        }
        if (method === 'DELETE') {
            for (const f of manifest.files) await deleteContent(`${dir(id)}/${f.name}`, `Remove ${f.name}`);
            await deleteContent(`${dir(id)}/manifest.json`, `Delete avatar ${manifest.name}`);
            return { deleted: id };
        }
        throw new HttpError('Method not allowed');
    }

    if (parts.length === 5 && parts[3] === 'files' && method === 'DELETE') {
        need();
        const manifest = await readManifest(id);
        await deleteContent(`${dir(id)}/${parts[4]}`, `Remove ${parts[4]}`);
        manifest.files = manifest.files.filter((f) => f.name !== parts[4]);
        if (manifest.model === parts[4]) manifest.model = pickModel(manifest.files);
        if (manifest.thumbnail === parts[4]) manifest.thumbnail = '';
        return writeManifest(manifest, `Remove ${parts[4]} from ${manifest.name}`);
    }
    throw new HttpError('Not found');
}
