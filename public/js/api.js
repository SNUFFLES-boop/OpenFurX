// Same-origin API client. Every request carries X-OpenFurX, which the server requires on writes.

export const session = { owner: false, loginEnabled: false };
const listeners = new Set();

export function onSessionChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'X-OpenFurX': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session.owner) setSession({ ...session, owner: false });
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function setSession(next) {
    Object.assign(session, next);
    for (const fn of listeners) fn(session);
}

export async function refreshSession() {
    try {
        setSession(await api('/api/session'));
    } catch {
        setSession({ owner: false, loginEnabled: false });
    }
    return session;
}

export async function login(username, password) {
    await api('/api/login', { method: 'POST', body: { username, password } });
    return refreshSession();
}

export async function logout() {
    await api('/api/logout', { method: 'POST' });
    return refreshSession();
}

export const fileUrl = (id, name) => `/files/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

// Upload names follow the server rule: plain basename, letters/digits/._-()+ and spaces.
export function cleanUploadName(name) {
    return name.split(/[\\/]/).pop().replace(/[^\w.\- ()+]/g, '_').replace(/^\.+/, '').slice(0, 160);
}

export const UPLOAD_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj', '.vrm', '.bin', '.mtl', '.png', '.jpg', '.jpeg', '.webp', '.tga',
    '.prefab', '.unitypackage', '.mat', '.asset', '.controller', '.json', '.txt', '.zip'];

export function uploadFile(id, name, blob, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/avatars/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`);
        xhr.setRequestHeader('X-OpenFurX', '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
            xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(blob);
    });
}

export async function uploadBatch(id, files, rows) {
    for (const [i, file] of files.entries()) {
        rows?.[i]?.setStatus('uploading');
        await uploadFile(id, cleanUploadName(file.name), file, (p) => rows?.[i]?.setProgress(p));
        rows?.[i]?.setProgress(1);
        rows?.[i]?.setStatus('done');
    }
}

// Split out an exported openfurx.json (from the Unity exporter) so it is read as rig data instead of uploaded.
export async function readRigFile(files) {
    const rigFile = files.find((f) => /(^|\.)openfurx\.json$/i.test(f.name));
    if (!rigFile) return { rig: null, rest: files };
    let data;
    try {
        data = JSON.parse(await rigFile.text());
    } catch {
        throw new Error(`${rigFile.name} is not valid JSON`);
    }
    return { rig: data.rig || data, meta: data, rest: files.filter((f) => f !== rigFile) };
}
