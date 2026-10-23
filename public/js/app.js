import { api, session, refreshSession, onSessionChange, login, logout, fileUrl, uploadBatch, readRigFile, UPLOAD_EXTENSIONS } from './api.js';
import { h, icon, button, toggle, toast, formatBytes, searchFilter } from './ui.js';

const view = document.getElementById('view');
let teardown = null;
let routeToken = 0;

const FORMAT_BADGES = { '.fbx': 'FBX', '.glb': 'GLB', '.gltf': 'GLTF', '.vrm': 'VRM', '.obj': 'OBJ', '.prefab': 'PREFAB', '.unitypackage': 'UNITYPKG' };

function setNav(section) {
    for (const link of document.querySelectorAll('[data-nav]')) {
        link.classList.toggle('is-active', link.dataset.nav === (section === 'owner' ? 'owner' : 'gallery'));
    }
}

function renderSessionBadge() {
    document.getElementById('owner-dot').classList.toggle('is-on', session.owner);
    document.getElementById('owner-label').textContent = session.owner ? 'Dashboard' : 'Owner';
}

async function route() {
    const token = ++routeToken;
    teardown?.();
    teardown = null;
    const [, section, id] = (location.hash.replace(/^#/, '') || '/').split('/');
    setNav(section);
    view.replaceChildren();
    view.classList.remove('view-enter');
    void view.offsetWidth; // restart the enter animation
    view.classList.add('view-enter');
    window.scrollTo(0, 0);
    try {
        let cleanup;
        if (section === 'avatar' && id) cleanup = await (await import('./viewer.js')).mountViewer(view, decodeURIComponent(id));
        else if (section === 'owner') cleanup = await mountOwner(view);
        else cleanup = await mountGallery(view);
        if (token !== routeToken) cleanup?.();
        else teardown = cleanup || null;
    } catch (err) {
        if (token !== routeToken) return;
        console.error(err);
        view.replaceChildren(h('div', { class: 'container' }, h('div', { class: 'empty' },
            h('h2', { text: 'SIGNAL LOST' }), h('p', { text: err.message }), button('Back to gallery', () => (location.hash = '#/'), { variant: 'ghost' }))));
    }
}

// ---------------------------------------------------------------- gallery

function avatarCard(avatar, i) {
    const exts = [...new Set(avatar.files.map((f) => f.name.slice(f.name.lastIndexOf('.')).toLowerCase()))];
    const badges = exts.filter((e) => FORMAT_BADGES[e]).map((e) => h('span', { class: 'chip chip--hot', text: FORMAT_BADGES[e] }));
    const initials = avatar.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const media = avatar.thumbnail
        ? h('img', { src: `${fileUrl(avatar.id, avatar.thumbnail)}?v=${encodeURIComponent(avatar.updatedAt)}`, alt: '', loading: 'lazy', decoding: 'async' })
        : h('div', { class: 'card__placeholder', text: initials });
    const size = avatar.files.reduce((sum, f) => sum + f.size, 0);
    return h('a', { class: 'card', href: `#/avatar/${encodeURIComponent(avatar.id)}`, style: { '--i': Math.min(i, 12) } },
        h('div', { class: 'card__media' }, media, h('div', { class: 'card__badge' }, badges, !avatar.published && h('span', { class: 'chip', text: 'Draft' }))),
        h('div', { class: 'card__body' },
            h('div', { class: 'card__name', text: avatar.name }),
            h('div', { class: 'card__meta' }, avatar.tags.slice(0, 4).map((t) => h('span', { class: 'chip', text: t }))),
            h('div', { class: 'muted small mono', text: `${avatar.files.length} files · ${formatBytes(size)}` })));
}

async function mountGallery(root) {
    const { avatars } = await api('/api/avatars');
    const state = { query: '', tag: '', sort: 'new' };
    const grid = h('div', { class: 'grid' });
    const tags = [...new Set(avatars.flatMap((a) => a.tags))].sort();

    const renderGrid = () => {
        let list = avatars.filter((a) => (!state.tag || a.tags.includes(state.tag))
            && (!state.query || `${a.name} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(state.query)));
        if (state.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
        grid.replaceChildren(...(list.length ? list.map(avatarCard) : [h('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
            h('h2', { text: avatars.length ? 'NO MATCHES' : 'ARCHIVE EMPTY' }),
            h('p', { text: avatars.length ? 'Try another search or tag.' : 'No avatars have been published yet.' }))]));
    };

    const tagChips = tags.map((t) => h('button', {
        type: 'button', class: 'chip', text: t, onclick: (e) => {
            state.tag = state.tag === t ? '' : t;
            for (const chip of e.currentTarget.parentElement.children) chip.classList.toggle('is-on', chip.textContent === state.tag);
            renderGrid();
        },
    }));

    const countBy = (exts) => avatars.reduce((n, a) => n + a.files.filter((f) => exts.some((e) => f.name.toLowerCase().endsWith(e))).length, 0);

    root.append(h('div', { class: 'container' },
        h('section', { class: 'hero' },
            h('div', {},
                h('div', { class: 'eyebrow', text: 'Avatar archive · live 3D preview' }),
                h('h1', { class: 'hero__title' }, 'OPEN', h('em', { text: 'FUR' }), 'X'),
                h('p', { class: 'hero__lead', text: 'Inspect avatars before you import them: swing PhysBones, toggle clothes and hidden objects, drive the expression menu and see emissions under bloom — then grab the avatar root prefab.' }),
                h('div', { class: 'row', style: { marginTop: '20px' } },
                    button('Browse avatars', () => grid.scrollIntoView({ behavior: 'smooth' }), { variant: 'primary' }),
                    session.owner && button('Upload avatar', () => (location.hash = '#/owner'), { variant: 'ghost', iconName: 'upload' }))),
            h('div', { class: 'stats' },
                h('div', { class: 'stat' }, h('b', { text: avatars.length }), h('span', { text: 'Avatars' })),
                h('div', { class: 'stat' }, h('b', { text: countBy(['.fbx', '.glb', '.gltf', '.vrm', '.obj']) }), h('span', { text: 'Models' })),
                h('div', { class: 'stat' }, h('b', { text: countBy(['.prefab', '.unitypackage']) }), h('span', { text: 'Prefabs' })))),
        h('div', { class: 'toolbar' },
            searchFilter('Search avatars, tags…', (q) => { state.query = q; renderGrid(); }),
            h('select', { class: 'select', style: { width: 'auto' }, onchange: (e) => { state.sort = e.target.value; renderGrid(); } },
                h('option', { value: 'new', text: 'Newest' }), h('option', { value: 'name', text: 'Name A–Z' }))),
        tags.length > 0 && h('div', { class: 'row', style: { marginBottom: '20px' } }, tagChips),
        grid));
    renderGrid();
}

// ---------------------------------------------------------------- owner

async function mountOwner(root) {
    await refreshSession();
    const container = h('div', { class: 'container' });
    root.append(container);

    if (!session.loginEnabled) {
        container.append(h('div', { class: 'panel login' },
            h('div', { class: 'panel__head' }, icon('lock'), h('span', { class: 'panel__title', text: 'Owner access offline' })),
            h('div', { class: 'panel__body' }, h('p', { class: 'muted', text: 'Owner login is disabled on this server. Start it with OWNER_PASSWORD (or OWNER_PASSWORD_HASH) set to enable uploads.' }))));
        return;
    }
    if (!session.owner) return renderLogin(container);
    return renderDashboard(container);
}

function renderLogin(container) {
    const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', required: true, value: 'owner' });
    const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', style: { width: '100%' } }, icon('lock'), 'Authenticate');
    const form = h('form', {
        class: 'panel login',
        onsubmit: async (e) => {
            e.preventDefault();
            submit.disabled = true;
            try {
                await login(user.value, pass.value);
                toast('Access granted', 'ok');
                route();
            } catch (err) {
                toast(err.message);
                pass.value = '';
                pass.focus();
            } finally {
                submit.disabled = false;
            }
        },
    },
    h('div', { class: 'panel__head' }, icon('lock'), h('span', { class: 'panel__title', text: 'Owner access' })),
    h('div', { class: 'panel__body' },
        h('div', { class: 'terminal' }, '> openfurx.auth --owner', h('br'), '> uplink ', h('b', { text: 'SECURE' }), h('br'), '> awaiting credentials_'),
        h('label', { class: 'field' }, h('span', { text: 'Username' }), user),
        h('label', { class: 'field' }, h('span', { text: 'Password' }), pass),
        submit));
    container.append(form);
    setTimeout(() => pass.focus(), 50);
}

function fileRow(file) {
    const bar = h('i');
    const status = h('span', { class: 'muted small mono', text: formatBytes(file.size) });
    const row = h('div', { class: 'file-row' },
        h('span', { class: 'chip', text: file.name.slice(file.name.lastIndexOf('.') + 1) }),
        h('span', { class: 'file-row__name', text: file.name }),
        status,
        h('div', { class: 'progress' }, bar));
    row.setProgress = (p) => (bar.style.width = `${Math.round(p * 100)}%`);
    row.setStatus = (text) => (status.textContent = text);
    return row;
}

function acceptedFiles(list) {
    const ok = [];
    for (const file of list) {
        if (/\.meta$/i.test(file.name)) continue;
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (UPLOAD_EXTENSIONS.includes(ext)) ok.push(file);
        else toast(`Skipped ${file.name}: unsupported type`);
    }
    return ok;
}

async function renderDashboard(container) {
    const { avatars } = await api('/api/avatars');
    let selected = [];
    const rowFor = new Map();

    const name = h('input', { class: 'input', required: true, maxlength: 80, placeholder: 'e.g. Neon Protogen' });
    const description = h('textarea', { class: 'textarea', maxlength: 4000, placeholder: 'Bases, shaders used, credits, notes…' });
    const tags = h('input', { class: 'input', placeholder: 'protogen, pc, quest, poiyomi' });
    let published = true;
    const fileList = h('div', { class: 'file-list' });
    const picker = h('input', { type: 'file', multiple: true, accept: UPLOAD_EXTENSIONS.join(',') });
    const drop = h('label', { class: 'dropzone' },
        picker, icon('upload'),
        h('b', { class: 'mono', text: 'DROP FILES OR CLICK TO SELECT' }),
        h('span', { class: 'muted small', text: 'FBX / GLB / GLTF / VRM / OBJ + textures (PNG, JPG, TGA, WEBP), .prefab / .unitypackage downloads, and openfurx.json from the Unity exporter.' }));

    const setFiles = (list) => {
        selected = acceptedFiles([...selected, ...list]).filter((f, i, arr) => arr.findIndex((g) => g.name === f.name) === i);
        rowFor.clear();
        for (const f of selected) rowFor.set(f, fileRow(f));
        fileList.replaceChildren(...rowFor.values());
    };
    picker.addEventListener('change', () => { setFiles(picker.files); picker.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); setFiles(e.dataTransfer.files); });

    const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, icon('upload'), 'Upload avatar');
    const form = h('form', {
        class: 'panel',
        onsubmit: async (e) => {
            e.preventDefault();
            if (!selected.some((f) => /\.(fbx|glb|gltf|vrm|obj|prefab|unitypackage)$/i.test(f.name))) return toast('Add a model or prefab file first');
            submit.disabled = true;
            try {
                const { rig, meta, rest } = await readRigFile(selected);
                const created = await api('/api/avatars', {
                    method: 'POST',
                    body: {
                        name: name.value || meta?.name || 'Untitled avatar',
                        description: description.value,
                        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
                        published,
                        ...(rig ? { rig } : {}),
                    },
                });
                await uploadBatch(created.id, rest, rest.map((f) => rowFor.get(f)));
                toast('Avatar uploaded', 'ok');
                location.hash = `#/avatar/${created.id}`;
            } catch (err) {
                toast(err.message);
            } finally {
                submit.disabled = false;
            }
        },
    },
    h('div', { class: 'panel__head' }, icon('upload'), h('span', { class: 'panel__title', text: 'Upload avatar' })),
    h('div', { class: 'panel__body' },
        h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
        h('label', { class: 'field' }, h('span', { text: 'Description' }), description),
        h('label', { class: 'field' }, h('span', { text: 'Tags (comma separated)' }), tags),
        toggle('Published (visible to visitors)', true, (v) => (published = v)),
        h('div', { style: { height: '12px' } }),
        drop, fileList,
        h('div', { class: 'row' }, submit, button('Clear', () => { selected = []; setFiles([]); }, { variant: 'ghost' }))));

    const tbody = h('tbody');
    const renderTable = () => tbody.replaceChildren(...avatars.map((a) => h('tr', {},
        h('td', {}, h('a', { href: `#/avatar/${a.id}`, text: a.name })),
        h('td', { class: 'mono small hide-sm', text: `${a.files.length} files` }),
        h('td', {}, toggle(a.published ? 'Live' : 'Draft', a.published, async (v) => {
            try {
                Object.assign(a, await api(`/api/avatars/${a.id}`, { method: 'PATCH', body: { published: v } }));
                renderTable();
            } catch (err) { toast(err.message); }
        })),
        h('td', {}, button('', async () => {
            if (!confirm(`Delete “${a.name}” and all of its files?`)) return;
            try {
                await api(`/api/avatars/${a.id}`, { method: 'DELETE' });
                avatars.splice(avatars.indexOf(a), 1);
                renderTable();
                toast('Avatar deleted', 'ok');
            } catch (err) { toast(err.message); }
        }, { iconName: 'trash', title: 'Delete', variant: 'danger', small: true })))));
    renderTable();

    container.append(
        h('div', { class: 'row', style: { marginBottom: '20px' } },
            h('div', {}, h('div', { class: 'eyebrow', text: 'Owner console' }), h('h1', { style: { marginTop: '8px' }, text: 'Dashboard' })),
            h('div', { class: 'spacer' }),
            button('Log out', async () => { await logout(); route(); }, { variant: 'ghost' })),
        h('div', { class: 'owner-grid' },
            form,
            h('div', { class: 'panel' },
                h('div', { class: 'panel__head' }, h('span', { class: 'panel__title', text: `Library · ${avatars.length}` })),
                h('div', { class: 'panel__body' }, avatars.length
                    ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Avatar' }), h('th', { class: 'hide-sm', text: 'Files' }), h('th', { text: 'State' }), h('th'))), tbody)
                    : h('p', { class: 'muted', text: 'Nothing uploaded yet.' })),
                h('div', { class: 'panel__body' }, h('div', { class: 'hint' },
                    'Tip: in Unity, select the avatar root and run Tools › OpenFurX › Export Avatar Root. Upload the generated .prefab, the preview FBX/GLB, its textures and openfurx.json together — PhysBones, clothes, inactive objects and the expression menu are read from it.')))));
}

// ---------------------------------------------------------------- boot

onSessionChange(renderSessionBadge);
window.addEventListener('hashchange', route);
refreshSession().then(route);
