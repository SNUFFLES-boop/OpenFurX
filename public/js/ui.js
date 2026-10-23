// Tiny DOM helpers. Text always goes through textContent, so owner-supplied strings never become markup.

export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'value') el.value = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in el && typeof value !== 'string') el[key] = value;
        else el.setAttribute(key, value === true ? '' : value);
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

const ICONS = {
    rotate: 'M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5',
    focus: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M12 9v6M9 12h6',
    camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    expand: 'M4 10V4h6M14 4h6v6M20 14v6h-6M10 20H4v-6',
    search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    shake: 'M3 12h3l3-7 4 14 3-7h5',
    back: 'M15 5l-7 7 7 7',
    play: 'M7 4l13 8-13 8z',
    lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
};

export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] || '');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'square');
    svg.append(path);
    return svg;
}

export function button(label, onClick, { variant = '', iconName, title, small = false } = {}) {
    const cls = ['btn', variant && `btn--${variant}`, small && 'btn--sm', iconName && !label && 'btn--icon'].filter(Boolean).join(' ');
    return h('button', { type: 'button', class: cls, title: title || null, 'aria-label': title || null, onclick: onClick }, iconName ? icon(iconName) : null, label);
}

export function toggle(label, checked, onChange, { title } = {}) {
    const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
    return h('label', { class: 'switch', title: title || label }, input, h('span', { class: 'switch__track' }), h('span', { class: 'switch__label', text: label }));
}

export function slider(label, { min = 0, max = 1, step = 0.01, value = 0, format = (v) => v.toFixed(2) }, onInput) {
    const output = h('output', { text: format(value) });
    const input = h('input', { type: 'range', min, max, step, value });
    const paint = () => {
        input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
        output.textContent = format(Number(input.value));
    };
    input.addEventListener('input', () => {
        paint();
        onInput(Number(input.value));
    });
    paint();
    const el = h('label', { class: 'range' }, h('span', { class: 'range__head' }, h('span', { text: label }), output), input);
    el.setValue = (v) => {
        input.value = v;
        paint();
    };
    return el;
}

export function select(options, value, onChange) {
    const el = h('select', { class: 'select', onchange: () => onChange(el.value) },
        options.map(([v, label]) => h('option', { value: v, text: label, selected: v === value })));
    return el;
}

export function section(title, ...children) {
    return [h('div', { class: 'section-title', text: title }), ...children];
}

export function toast(message, kind = '') {
    const el = h('div', { class: `toast ${kind ? `toast--${kind}` : ''}`, text: message });
    document.getElementById('toasts').append(el);
    setTimeout(() => {
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
    }, 3800);
}

export function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function searchFilter(placeholder, onInput) {
    const input = h('input', { class: 'input', type: 'search', placeholder, oninput: () => onInput(input.value.trim().toLowerCase()) });
    return h('div', { class: 'search' }, icon('search'), input);
}
