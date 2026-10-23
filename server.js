'use strict';

// OpenFurX server: static site, public avatar API and owner-only uploads.
// No runtime dependencies beyond Node itself; three.js is served from node_modules.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const config = {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8080),
    dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    ownerUser: process.env.OWNER_USER || 'owner',
    ownerPassword: process.env.OWNER_PASSWORD || '',
    ownerPasswordHash: process.env.OWNER_PASSWORD_HASH || '',
    secureCookies: process.env.SECURE_COOKIES === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
    maxFileBytes: Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024,
    sessionHours: Number(process.env.SESSION_HOURS || 168),
};

const AVATAR_DIR = path.join(config.dataDir, 'avatars');

// Extensions the owner may upload. Anything that could execute in a browser (html, svg, js) is excluded.
const UPLOAD_KINDS = {
    '.fbx': 'model', '.glb': 'model', '.gltf': 'model', '.obj': 'model', '.vrm': 'model',
    '.bin': 'buffer', '.mtl': 'material',
    '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.tga': 'texture',
    '.prefab': 'unity', '.unitypackage': 'unity', '.mat': 'unity', '.asset': 'unity', '.controller': 'unity',
    '.json': 'data', '.txt': 'data', '.zip': 'archive',
};
// Model formats in the order the viewer prefers them when several are uploaded.
const MODEL_PRIORITY = ['.glb', '.vrm', '.gltf', '.fbx', '.obj'];

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.tga': 'image/x-tga', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary',
    '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.gltf', '.obj', '.mtl']);

// ---------------------------------------------------------------- auth

function scryptHash(password, salt) {
    return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
}

function makePasswordHash(password) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString('base64')}$${scryptHash(password, salt).toString('base64')}`;
}

function parsePasswordHash(value) {
    const [scheme, salt, hash] = String(value).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return null;
    return { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

const ownerCredential = config.ownerPasswordHash
    ? parsePasswordHash(config.ownerPasswordHash)
    : config.ownerPassword ? parsePasswordHash(makePasswordHash(config.ownerPassword)) : null;

function verifyOwner(username, password) {
    if (!ownerCredential || typeof username !== 'string' || typeof password !== 'string') return false;
    const userA = crypto.createHash('sha256').update(username).digest();
    const userB = crypto.createHash('sha256').update(config.ownerUser).digest();
    const candidate = scryptHash(password, ownerCredential.salt);
    const passOk = candidate.length === ownerCredential.hash.length && crypto.timingSafeEqual(candidate, ownerCredential.hash);
    return crypto.timingSafeEqual(userA, userB) && passOk;
}

const sessions = new Map(); // token -> expiresAt
const loginAttempts = new Map(); // ip -> { count, resetAt }
const SESSION_COOKIE = 'ofx_session';

function createSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + config.sessionHours * 3600e3);
    return token;
}

function sessionCookie(token, maxAgeSeconds) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (config.secureCookies) parts.push('Secure');
    return parts.join('; ');
}

function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

function isOwner(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function clientIp(req) {
    if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function loginAllowed(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt < now) {
        loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60e3 });
        return true;
    }
    entry.count += 1;
    return entry.count <= 10;
}

setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token);
    for (const [ip, entry] of loginAttempts) if (entry.resetAt < now) loginAttempts.delete(ip);
}, 10 * 60e3).unref();

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function sendJson(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
    res.end(data);
}

async function readJsonBody(req, limit = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, 'Request body too large');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
        throw new HttpError(400, 'Invalid JSON');
    }
}

// Mutating owner requests must carry a session cookie, a custom header (forces a CORS preflight,
// so cross-site forms cannot forge them) and, when the browser sends one, a same-origin Origin.
function requireOwner(req) {
    if (!isOwner(req)) throw new HttpError(401, 'Owner login required');
    requireSameOrigin(req);
}

function requireSameOrigin(req) {
    if (req.headers['x-openfurx'] !== '1') throw new HttpError(403, 'Missing request header');
    const origin = req.headers.origin;
    if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
    }
}

function safeFileName(name) {
    const base = path.basename(String(name).replace(/\\/g, '/'));
    if (!base || base.length > 160 || base.startsWith('.') || !/^[\w.\- ()+]+$/.test(base)) return null;
    const ext = path.extname(base).toLowerCase();
    return UPLOAD_KINDS[ext] ? base : null;
}

function validId(id) {
    return typeof id === 'string' && /^[a-z0-9]{12}$/.test(id);
}

function cleanString(value, max) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function cleanStringList(value, maxItems = 512, maxLen = 160) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value.slice(0, maxItems)) {
        const s = cleanString(item, maxLen);
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

function cleanNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const CONTROL_TYPES = new Set(['toggle', 'button', 'radial', 'submenu', 'twoaxis', 'fouraxis']);

function cleanMenu(controls, depth = 0) {
    if (!Array.isArray(controls) || depth > 6) return [];
    return controls.slice(0, 16).map((c) => {
        const type = CONTROL_TYPES.has(c && c.type) ? c.type : 'toggle';
        const out = {
            name: cleanString(c && c.name, 64) || 'Control',
            type,
            parameter: cleanString(c && c.parameter, 128),
            value: cleanNumber(c && c.value, -1, 1, 1),
            targets: (Array.isArray(c && c.targets) ? c.targets : []).slice(0, 64).map((t) => ({
                kind: t && t.kind === 'object' ? 'object' : 'blendshape',
                name: cleanString(t && t.name, 160),
                value: cleanNumber(t && t.value, -1, 1, 1),
            })).filter((t) => t.name),
        };
        if (type === 'submenu') out.controls = cleanMenu(c.controls, depth + 1);
        return out;
    });
}

function cleanPhysBones(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 256).map((pb) => {
        const entry = typeof pb === 'string' ? { root: pb } : pb || {};
        return {
            root: cleanString(entry.root, 160),
            name: cleanString(entry.name, 64),
            pull: cleanNumber(entry.pull, 0, 1, 0.2),
            spring: cleanNumber(entry.spring, 0, 1, 0.2),
            stiffness: cleanNumber(entry.stiffness, 0, 1, 0.2),
            gravity: cleanNumber(entry.gravity, -1, 1, 0.05),
            ignore: cleanStringList(entry.ignore, 64),
        };
    }).filter((pb) => pb.root);
}

function cleanRig(rig) {
    rig = rig && typeof rig === 'object' ? rig : {};
    const expressions = rig.expressions && typeof rig.expressions === 'object' ? rig.expressions : {};
    return {
        physbones: cleanPhysBones(rig.physbones),
        clothes: cleanStringList(rig.clothes),
        inactive: cleanStringList(rig.inactive),
        expressions: {
            menu: cleanMenu(expressions.menu),
            parameters: (Array.isArray(expressions.parameters) ? expressions.parameters : []).slice(0, 256).map((p) => ({
                name: cleanString(p && p.name, 128),
                type: ['Bool', 'Int', 'Float'].includes(p && p.type) ? p.type : 'Float',
                defaultValue: cleanNumber(p && p.defaultValue, -255, 255, 0),
            })).filter((p) => p.name),
        },
        source: cleanString(rig.source, 64),
    };
}

function cleanRender(render) {
    render = render && typeof render === 'object' ? render : {};
    return {
        emission: cleanNumber(render.emission, 0, 10, 1),
        bloom: cleanNumber(render.bloom, 0, 3, 0.9),
        shading: ['original', 'toon', 'unlit', 'clay', 'wire'].includes(render.shading) ? render.shading : 'original',
        alphaCutout: !!render.alphaCutout,
        accent: /^#[0-9a-f]{6}$/i.test(render.accent || '') ? render.accent : '#ff1a3c',
    };
}

// ---------------------------------------------------------------- avatar store

const manifestCache = new Map(); // id -> manifest

function avatarDir(id) {
    return path.join(AVATAR_DIR, id);
}

async function loadManifests() {
    await fsp.mkdir(AVATAR_DIR, { recursive: true });
    for (const entry of await fsp.readdir(AVATAR_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validId(entry.name)) continue;
        try {
            const manifest = JSON.parse(await fsp.readFile(path.join(avatarDir(entry.name), 'manifest.json'), 'utf8'));
            manifestCache.set(entry.name, manifest);
        } catch (err) {
            console.warn(`[openfurx] skipping avatar ${entry.name}: ${err.message}`);
        }
    }
}

async function saveManifest(manifest) {
    manifest.updatedAt = new Date().toISOString();
    const file = path.join(avatarDir(manifest.id), 'manifest.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await fsp.rename(tmp, file);
    manifestCache.set(manifest.id, manifest);
}

function pickModel(files) {
    for (const ext of MODEL_PRIORITY) {
        const hit = files.find((f) => path.extname(f.name).toLowerCase() === ext);
        if (hit) return hit.name;
    }
    return '';
}

function getManifest(id) {
    const manifest = validId(id) && manifestCache.get(id);
    if (!manifest) throw new HttpError(404, 'Avatar not found');
    return manifest;
}

function applyEditableFields(manifest, body) {
    if ('name' in body) manifest.name = cleanString(body.name, 80) || 'Untitled avatar';
    if ('description' in body) manifest.description = cleanString(body.description, 4000);
    if ('tags' in body) manifest.tags = cleanStringList(body.tags, 24, 32).map((t) => t.toLowerCase());
    if ('rig' in body) manifest.rig = cleanRig(body.rig);
    if ('render' in body) manifest.render = cleanRender(body.render);
    if ('published' in body) manifest.published = !!body.published;
    if ('model' in body) {
        const model = cleanString(body.model, 160);
        if (model && !manifest.files.some((f) => f.name === model && f.kind === 'model')) throw new HttpError(400, 'Unknown model file');
        manifest.model = model || pickModel(manifest.files);
    }
    if ('thumbnail' in body) {
        const thumb = cleanString(body.thumbnail, 160);
        if (thumb && !manifest.files.some((f) => f.name === thumb && f.kind === 'texture')) throw new HttpError(400, 'Unknown thumbnail file');
        manifest.thumbnail = thumb;
    }
}

// ---------------------------------------------------------------- static files

const gzipCache = new Map(); // absPath -> { mtimeMs, buffer }

async function serveFile(req, res, absPath, { cache = 'no-cache', download = false } = {}) {
    let stat;
    try {
        stat = await fsp.stat(absPath);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;

    const ext = path.extname(absPath).toLowerCase();
    const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cache,
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(absPath).replace(/"/g, '')}"`;

    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return true;
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024 && stat.size < 16 * 1024 * 1024) {
        let entry = gzipCache.get(absPath);
        if (!entry || entry.mtimeMs !== stat.mtimeMs) {
            entry = { mtimeMs: stat.mtimeMs, buffer: zlib.gzipSync(await fsp.readFile(absPath), { level: 9 }) };
            gzipCache.set(absPath, entry);
        }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': entry.buffer.length, Vary: 'Accept-Encoding' });
        res.end(req.method === 'HEAD' ? undefined : entry.buffer);
        return true;
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    await pipeline(fs.createReadStream(absPath), res);
    return true;
}

function resolveInside(baseDir, relative) {
    const target = path.resolve(baseDir, '.' + path.posix.normalize('/' + relative));
    return target === baseDir || target.startsWith(baseDir + path.sep) ? target : null;
}

// The import map in index.html is the only inline script, so it is allowed by hash instead of 'unsafe-inline'.
let indexHtml = '';
let scriptHashes = '';

function loadIndex() {
    indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const hashes = [];
    for (const match of indexHtml.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
        hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
    }
    scriptHashes = hashes.join(' ');
}

function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        `script-src 'self' ${scriptHashes}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "connect-src 'self' blob: data:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
    const method = req.method;

    if (parts[1] === 'session' && method === 'GET') {
        return sendJson(res, 200, { owner: isOwner(req), loginEnabled: !!ownerCredential });
    }

    if (parts[1] === 'login' && method === 'POST') {
        requireSameOrigin(req);
        if (!ownerCredential) throw new HttpError(503, 'Owner login is not configured on this server');
        if (!loginAllowed(clientIp(req))) throw new HttpError(429, 'Too many attempts, try again later');
        const body = await readJsonBody(req, 4096);
        if (!verifyOwner(body.username, body.password)) throw new HttpError(401, 'Access denied');
        loginAttempts.delete(clientIp(req));
        const token = createSession();
        return sendJson(res, 200, { owner: true }, { 'Set-Cookie': sessionCookie(token, config.sessionHours * 3600) });
    }

    if (parts[1] === 'logout' && method === 'POST') {
        requireSameOrigin(req);
        const token = readCookie(req, SESSION_COOKIE);
        if (token) sessions.delete(token);
        return sendJson(res, 200, { owner: false }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (parts[1] !== 'avatars') throw new HttpError(404, 'Not found');
    const owner = isOwner(req);

    // /api/avatars
    if (parts.length === 2) {
        if (method === 'GET') {
            const list = [...manifestCache.values()]
                .filter((m) => owner || m.published)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            return sendJson(res, 200, { avatars: list });
        }
        if (method === 'POST') {
            requireOwner(req);
            const body = await readJsonBody(req);
            let id;
            do id = crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
            while (manifestCache.has(id));
            const now = new Date().toISOString();
            const manifest = {
                id, name: 'Untitled avatar', description: '', tags: [], createdAt: now, updatedAt: now,
                published: true, model: '', thumbnail: '', files: [], rig: cleanRig({}), render: cleanRender({}),
            };
            applyEditableFields(manifest, body);
            await fsp.mkdir(avatarDir(id), { recursive: true });
            await saveManifest(manifest);
            return sendJson(res, 201, manifest);
        }
        throw new HttpError(405, 'Method not allowed');
    }

    const manifest = getManifest(parts[2]);
    if (!manifest.published && !owner) throw new HttpError(404, 'Avatar not found');

    // /api/avatars/:id
    if (parts.length === 3) {
        if (method === 'GET') return sendJson(res, 200, manifest);
        if (method === 'PATCH') {
            requireOwner(req);
            applyEditableFields(manifest, await readJsonBody(req));
            await saveManifest(manifest);
            return sendJson(res, 200, manifest);
        }
        if (method === 'DELETE') {
            requireOwner(req);
            await fsp.rm(avatarDir(manifest.id), { recursive: true, force: true });
            manifestCache.delete(manifest.id);
            return sendJson(res, 200, { deleted: manifest.id });
        }
        throw new HttpError(405, 'Method not allowed');
    }

    // /api/avatars/:id/files/:name
    if (parts.length === 5 && parts[3] === 'files') {
        requireOwner(req);
        const name = safeFileName(parts[4]);
        if (!name) throw new HttpError(400, 'File type or name not allowed');
        const target = path.join(avatarDir(manifest.id), name);

        if (method === 'PUT') {
            const declared = Number(req.headers['content-length'] || 0);
            if (declared > config.maxFileBytes) throw new HttpError(413, 'File too large');
            const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
            let size = 0;
            try {
                await pipeline(req, async function* (source) {
                    for await (const chunk of source) {
                        size += chunk.length;
                        if (size > config.maxFileBytes) throw new HttpError(413, 'File too large');
                        yield chunk;
                    }
                }, fs.createWriteStream(tmp));
                await fsp.rename(tmp, target);
            } catch (err) {
                await fsp.rm(tmp, { force: true });
                throw err;
            }
            const kind = UPLOAD_KINDS[path.extname(name).toLowerCase()];
            manifest.files = manifest.files.filter((f) => f.name !== name);
            manifest.files.push({ name, size, kind });
            manifest.files.sort((a, b) => a.name.localeCompare(b.name));
            if (kind === 'model' && !manifest.model) manifest.model = pickModel(manifest.files);
            await saveManifest(manifest);
            return sendJson(res, 200, manifest);
        }
        if (method === 'DELETE') {
            await fsp.rm(target, { force: true });
            manifest.files = manifest.files.filter((f) => f.name !== name);
            if (manifest.model === name) manifest.model = pickModel(manifest.files);
            if (manifest.thumbnail === name) manifest.thumbnail = '';
            await saveManifest(manifest);
            return sendJson(res, 200, manifest);
        }
        throw new HttpError(405, 'Method not allowed');
    }

    throw new HttpError(404, 'Not found');
}

async function handleFiles(req, res, url) {
    // /files/:id/:name
    const [, id, rawName] = url.pathname.split('/').filter(Boolean);
    const manifest = validId(id) && manifestCache.get(id);
    const name = rawName && safeFileName(decodeURIComponent(rawName));
    if (!manifest || !name || (!manifest.published && !isOwner(req)) || !manifest.files.some((f) => f.name === name)) {
        throw new HttpError(404, 'File not found');
    }
    const kind = UPLOAD_KINDS[path.extname(name).toLowerCase()];
    const download = kind === 'unity' || kind === 'archive' || url.searchParams.has('download');
    const served = await serveFile(req, res, path.join(avatarDir(id), name), { cache: 'public, max-age=0, must-revalidate', download });
    if (!served) throw new HttpError(404, 'File not found');
}

async function handleStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/vendor/three/')) {
        const rel = pathname.slice('/vendor/three/'.length);
        if (!/^(build|examples\/jsm)\//.test(rel)) throw new HttpError(404, 'Not found');
        const abs = resolveInside(THREE_DIR, rel);
        if (abs && await serveFile(req, res, abs, { cache: 'public, max-age=604800' })) return;
        throw new HttpError(404, 'Not found');
    }

    if (pathname === '/config.json') return sendJson(res, 200, { static: false }); // the app probes this to pick its backend

    if (pathname !== '/' && pathname !== '/index.html') {
        const abs = resolveInside(PUBLIC_DIR, pathname);
        if (abs && await serveFile(req, res, abs)) return;
        if (path.extname(pathname)) throw new HttpError(404, 'Not found');
    }

    // SPA shell (routing is hash based, so every unknown extensionless path gets the app).
    if (process.env.NODE_ENV === 'development') loadIndex(); // pick up edits without a restart
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : indexHtml);
}

const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        if (url.pathname.startsWith('/files/')) return await handleFiles(req, res, url);
        return await handleStatic(req, res, url);
    } catch (err) {
        const status = err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
        if (status === 500) console.error('[openfurx]', err);
        if (res.headersSent) return res.destroy();
        req.resume();
        sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message }, status === 413 ? { Connection: 'close' } : {});
    }
});
server.requestTimeout = 0; // large model uploads can take a while
server.headersTimeout = 60e3;

async function main() {
    if (process.argv[2] === 'hash-password') {
        const password = process.argv[3];
        if (!password) {
            console.error('usage: node server.js hash-password <password>');
            process.exit(1);
        }
        console.log(makePasswordHash(password));
        return;
    }
    if (!fs.existsSync(THREE_DIR)) {
        console.error('[openfurx] three.js is missing, run `npm install` first');
        process.exit(1);
    }
    loadIndex();
    await loadManifests();
    if (!ownerCredential) console.warn('[openfurx] OWNER_PASSWORD / OWNER_PASSWORD_HASH not set: owner login and uploads are disabled');
    server.listen(config.port, config.host, () => {
        console.log(`[openfurx] ${manifestCache.size} avatar(s) loaded, listening on http://${config.host}:${config.port}`);
    });
}

main();
