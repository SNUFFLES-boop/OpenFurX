// Avatar viewer: three.js stage with bloom, animated emission floor and the control tabs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { api, session, fileUrl, uploadFile, uploadBatch, UPLOAD_EXTENSIONS } from './api.js';
import { h, icon, button, toggle, slider, select, section, toast, formatBytes, searchFilter } from './ui.js';
import * as rig from './rig.js';

const QUALITY = {
    low: { ratio: 1, samples: 0, label: 'Low (fast)' },
    medium: { ratio: 1.5, samples: 4, label: 'Medium' },
    high: { ratio: 2, samples: 4, label: 'High' },
};
const TARGET_HEIGHT = 1.6;
const MODEL_EXTS = ['.glb', '.vrm', '.gltf', '.fbx', '.obj'];

// Estimated VRChat PC performance limits: [excellent, good, medium, poor]; above poor is "Very Poor".
const RANK_LIMITS = {
    triangles: [32000, 70000, 70000, 70000],
    skinnedMeshes: [1, 2, 8, 16],
    meshes: [4, 8, 16, 24],
    materials: [4, 8, 16, 32],
    bones: [75, 150, 256, 400],
    physbones: [4, 8, 16, 32],
};
const RANKS = ['Excellent', 'Good', 'Medium', 'Poor', 'Very Poor'];

const ext = (name) => name.slice(name.lastIndexOf('.')).toLowerCase();

function storageGet(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- scene dressing

const FLOOR_VERT = /* glsl */`
varying vec3 vPos;
void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

// Grid floor with emission pulses travelling along random grid lines plus an expanding scan ring.
const FLOOR_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vPos;
float gridLine(float coord) {
    float w = fwidth(coord);
    return 1.0 - smoothstep(0.0, w * 1.5, abs(fract(coord - 0.5) - 0.5));
}
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
    vec2 p = vPos.xz * 2.0;
    float lx = gridLine(p.y);
    float lz = gridLine(p.x);
    float hr = hash(floor(p.y + 0.5) * 1.37 + 1.0);
    float hc = hash(floor(p.x + 0.5) * 2.11 + 7.0);
    float dirX = hr > 0.8 ? -1.0 : 1.0;
    float pulseX = pow(fract(p.x * 0.05 * dirX - uTime * (0.12 + hr * 0.2) + hr), 22.0) * step(0.5, hr);
    float pulseZ = pow(fract(p.y * 0.05 - uTime * (0.1 + hc * 0.2) + hc), 22.0) * step(0.6, hc);
    float d = length(vPos.xz);
    float ring = 1.0 - smoothstep(0.0, 0.05, abs(d - fract(uTime * 0.12) * 8.0));
    float fade = 1.0 - smoothstep(1.2, 9.0, d);
    float lines = max(lx, lz);
    float glow = (lx * pulseX + lz * pulseZ) * 3.0 + ring * lines * 1.6;
    gl_FragColor = vec4(uColor * (lines * 0.12 + glow * uIntensity) * fade, 1.0);
}`;

const RING_VERT = /* glsl */`
varying vec2 vLocal;
void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uColor;
uniform float uSpeed;
uniform float uCount;
uniform float uBoost;
varying vec2 vLocal;
void main() {
    float a = atan(vLocal.y, vLocal.x) / 6.28318 + 0.5;
    float dash = smoothstep(0.35, 0.5, abs(fract(a * uCount + uTime * uSpeed) - 0.5) * 2.0);
    gl_FragColor = vec4(uColor * (0.35 + dash * uBoost), 1.0);
}`;

function shadowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
}

function toonGradient() {
    const tex = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]), 3, 1);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

// ---------------------------------------------------------------- viewer

class Viewer {
    constructor(root, manifest) {
        this.root = root;
        this.manifest = manifest;
        this.disposed = false;
        this.clock = new THREE.Clock();
        this.cleanups = [];
        this.model = null;
        this.index = null;
        this.physics = null;
        this.mixer = null;
        this.clips = [];
        this.exprValues = new Map();
        this.menuStack = [];
        this.activeRadial = null;
        this.originalMaterials = new Map();
        this.generatedMaterials = [];
        const r = manifest.render || {};
        this.settings = {
            quality: QUALITY[storageGet('ofx.quality', 'medium')] ? storageGet('ofx.quality', 'medium') : 'medium',
            bloom: true,
            bloomStrength: r.bloom ?? 0.9,
            bloomRadius: 0.45,
            bloomThreshold: 1,
            emission: r.emission ?? 1,
            emissionPulse: false,
            shading: r.shading || 'original',
            alphaCutout: !!r.alphaCutout,
            exposure: 1,
            floor: true,
            scanner: true,
            turntable: false,
            accent: new THREE.Color(r.accent || '#ff1a3c'),
        };
        this.tab = 'info';
    }

    // -------------------------------------------------------- dom

    buildDom() {
        this.canvas = h('canvas');
        this.loaderProgress = h('i');
        this.loaderText = h('span', { text: 'Initializing' });
        this.loaderEl = h('div', { class: 'loader' }, h('div', { class: 'loader__ring' }), this.loaderText, h('div', { class: 'progress' }, this.loaderProgress));
        this.turntableBtn = button('', () => this.setTurntable(!this.settings.turntable), { iconName: 'rotate', title: 'Turntable' });
        this.stage = h('div', { class: 'stage' },
            this.canvas,
            ['tl', 'tr', 'bl', 'br'].map((c) => h('span', { class: `stage__corner stage__corner--${c}` })),
            h('div', { class: 'stage__hud' },
                button('', () => (location.hash = '#/'), { iconName: 'back', title: 'Back to gallery', small: true }),
                h('div', {}, h('div', { class: 'eyebrow', text: 'Avatar preview' }), h('div', { class: 'stage__title', text: this.manifest.name }))),
            h('div', { class: 'stage__bar' },
                this.turntableBtn,
                button('', () => this.frameCamera(), { iconName: 'focus', title: 'Reset camera' }),
                button('', () => this.physics?.shake(), { iconName: 'shake', title: 'Shake PhysBones' }),
                button('', () => this.screenshot(), { iconName: 'camera', title: 'Screenshot' }),
                button('', () => (document.fullscreenElement ? document.exitFullscreen() : this.stage.requestFullscreen?.()), { iconName: 'expand', title: 'Fullscreen' })),
            this.loaderEl);

        this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
        this.panelEl = h('div', { class: 'tabpanels' });
        this.root.append(h('div', { class: 'viewer' }, this.stage, h('aside', { class: 'side' }, this.tabsEl, this.panelEl)));
        this.renderTabs();
    }

    tabDefs() {
        return [
            ['info', 'Info', null],
            ['physbones', 'PhysBones', this.physics?.chains.length],
            ['objects', 'Objects', this.inactive?.length],
            ['clothes', 'Clothes', this.clothes?.length],
            ['expressions', 'Expressions', null],
            ['render', 'Render', null],
        ];
    }

    renderTabs() {
        this.tabsEl.replaceChildren(...this.tabDefs().map(([key, label, count]) => h('button', {
            type: 'button', role: 'tab', class: `tab ${this.tab === key ? 'is-active' : ''}`, 'aria-selected': String(this.tab === key),
            onclick: () => { this.tab = key; this.renderTabs(); },
        }, label, count ? h('span', { class: 'count', text: count }) : null)));
        const render = {
            info: () => this.renderInfo(), physbones: () => this.renderPhysBones(), objects: () => this.renderObjects(),
            clothes: () => this.renderClothes(), expressions: () => this.renderExpressions(), render: () => this.renderRender(),
        }[this.tab];
        this.panelEl.replaceChildren(h('div', { class: 'tabpanel', role: 'tabpanel' }, render()));
    }

    needsModel() {
        return this.index ? null : h('div', { class: 'hint', text: this.loadError || 'The preview model is still loading…' });
    }

    // -------------------------------------------------------- three setup

    initThree() {
        const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.toneMappingExposure = this.settings.exposure;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050506);
        scene.fog = new THREE.Fog(0x050506, 6, 14);
        this.pmrem = new THREE.PMREMGenerator(renderer);
        this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = this.envTexture;
        scene.environmentIntensity = 0.35;
        this.scene = scene;

        this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
        this.camera.position.set(0, 1.2, 4);
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.3;
        this.controls.maxDistance = 10;
        this.controls.maxPolarAngle = Math.PI * 0.53;
        this.controls.target.set(0, 0.9, 0);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x220508, 0.8));
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(2, 4, 3);
        this.rim = new THREE.DirectionalLight(this.settings.accent, 2.6);
        this.rim.position.set(-2, 3, -3);
        const fill = new THREE.DirectionalLight(0xffd6dc, 0.45);
        fill.position.set(-3, 1, 2);
        scene.add(key, this.rim, fill);

        // Floor with moving emission lines.
        this.floorUniforms = { uTime: { value: 0 }, uColor: { value: this.settings.accent.clone() }, uIntensity: { value: 1 } };
        this.floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.ShaderMaterial({
            vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, uniforms: this.floorUniforms,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.floor.rotation.x = -Math.PI / 2;
        scene.add(this.floor);

        // Platform: two counter-rotating emissive dash rings and a blob shadow.
        this.platform = new THREE.Group();
        this.ringMaterials = [];
        for (const [inner, outer, speed, count, boost] of [[0.62, 0.66, 0.06, 24, 3.2], [0.7, 0.71, -0.03, 60, 2.4]]) {
            const material = new THREE.ShaderMaterial({
                vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                uniforms: { uTime: this.floorUniforms.uTime, uColor: this.floorUniforms.uColor, uSpeed: { value: speed }, uCount: { value: count }, uBoost: { value: boost } },
            });
            this.ringMaterials.push(material);
            const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128), material);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.002;
            this.platform.add(ring);
        }
        this.shadowTex = shadowTexture();
        const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.001;
        this.platform.add(shadow);
        scene.add(this.platform);

        // Scanner ring sweeping up and down the avatar.
        this.scannerMaterial = new THREE.MeshBasicMaterial({ color: this.settings.accent.clone().multiplyScalar(3), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        this.scanner = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.672, 96), this.scannerMaterial);
        this.scanner.rotation.x = -Math.PI / 2;
        scene.add(this.scanner);

        this.turntable = new THREE.Group();
        scene.add(this.turntable);

        this.buildComposer();

        const resize = () => {
            const { clientWidth: w, clientHeight: hgt } = this.stage;
            if (!w || !hgt) return;
            this.camera.aspect = w / hgt;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, hgt, false);
            this.composer.setSize(w, hgt);
        };
        this.resize = resize;
        const ro = new ResizeObserver(resize);
        ro.observe(this.stage);
        this.cleanups.push(() => ro.disconnect());

        // Stop rendering while the stage is off screen or the tab is hidden.
        let visible = true;
        const updateLoop = () => this.renderer.setAnimationLoop(visible && !document.hidden ? () => this.frame() : null);
        const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; updateLoop(); });
        io.observe(this.stage);
        document.addEventListener('visibilitychange', updateLoop);
        this.cleanups.push(() => { io.disconnect(); document.removeEventListener('visibilitychange', updateLoop); });
        resize();
        updateLoop();
    }

    buildComposer() {
        const q = QUALITY[this.settings.quality];
        const ratio = Math.min(window.devicePixelRatio || 1, q.ratio);
        this.renderer.setPixelRatio(ratio);
        this.composer?.dispose();
        this.bloomPass?.dispose();
        const size = this.renderer.getSize(new THREE.Vector2());
        const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), { type: THREE.HalfFloatType, samples: q.samples });
        this.composer = new EffectComposer(this.renderer, target);
        this.composer.setPixelRatio(ratio);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), this.settings.bloomStrength, this.settings.bloomRadius, this.settings.bloomThreshold);
        this.bloomPass.enabled = this.settings.bloom;
        this.composer.addPass(this.bloomPass);
        this.composer.addPass(new OutputPass());
        if (size.x && size.y) this.composer.setSize(size.x, size.y);
    }

    frame() {
        const dt = Math.min(this.clock.getDelta(), 0.05);
        const t = this.clock.elapsedTime;
        this.controls.update();
        if (this.settings.turntable) this.turntable.rotation.y += dt * 0.6;
        this.physics?.beforeAnimation();
        this.mixer?.update(dt);
        this.scene.updateMatrixWorld();
        this.physics?.update(dt);

        this.floorUniforms.uTime.value = t;
        if (this.settings.scanner && this.modelHeight) {
            const phase = (Math.sin(t * 0.8) + 1) / 2;
            this.scanner.position.y = phase * this.modelHeight;
            this.scannerMaterial.opacity = 0.25 + 0.55 * Math.sin(phase * Math.PI);
        }
        if (this.settings.emissionPulse) this.applyEmission(0.65 + 0.35 * Math.sin(t * 2.4));
        this.composer.render(dt);
    }

    frameCamera() {
        const hgt = this.modelHeight || TARGET_HEIGHT;
        const fov = THREE.MathUtils.degToRad(this.camera.fov);
        const fit = Math.max(hgt * 0.62, (hgt * 0.62) / Math.max(this.camera.aspect, 0.5));
        const dist = fit / Math.tan(fov / 2) + 0.4;
        this.controls.target.set(0, hgt * 0.5, 0);
        this.camera.position.set(0, hgt * 0.6, dist);
        this.controls.update();
    }

    setTurntable(on) {
        this.settings.turntable = on;
        this.turntableBtn.classList.toggle('is-on', on);
        if (!on) this.turntable.rotation.y = 0;
    }

    // -------------------------------------------------------- model loading

    setLoading(text, progress) {
        this.loaderText.textContent = text;
        if (progress != null) this.loaderProgress.style.width = `${Math.round(progress * 100)}%`;
    }

    async loadModel() {
        const { manifest } = this;
        if (!manifest.model) throw new Error('No preview model has been uploaded for this avatar.');
        const byName = new Map(manifest.files.map((f) => [f.name.toLowerCase(), f.name]));
        const byStem = new Map(manifest.files.filter((f) => f.kind === 'texture').map((f) => [f.name.toLowerCase().replace(/\.[^.]+$/, ''), f.name]));

        // Models reference textures by whatever path the author had on disk; match uploads by basename.
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
            if (/^(blob|data):/.test(url)) return url;
            let base = url.split('?')[0].split(/[\\/]/).pop();
            try { base = decodeURIComponent(base); } catch { /* keep raw */ }
            base = base.toLowerCase();
            const name = byName.get(base) || byStem.get(base.replace(/\.[^.]+$/, ''));
            return name ? fileUrl(manifest.id, name) : url;
        });
        manager.addHandler(/\.tga$/i, new TGALoader(manager));

        const url = fileUrl(manifest.id, manifest.model);
        const onProgress = (e) => e.total && this.setLoading(`Downloading ${formatBytes(e.loaded)} / ${formatBytes(e.total)}`, e.loaded / e.total);
        const type = ext(manifest.model);
        let object;
        let animations = [];
        if (type === '.glb' || type === '.gltf' || type === '.vrm') {
            const gltf = await new GLTFLoader(manager).loadAsync(url, onProgress);
            object = gltf.scene;
            animations = gltf.animations;
        } else if (type === '.fbx') {
            object = await new FBXLoader(manager).loadAsync(url, onProgress);
            animations = object.animations || [];
        } else if (type === '.obj') {
            const loader = new OBJLoader(manager);
            const mtl = manifest.files.find((f) => ext(f.name) === '.mtl');
            if (mtl) {
                const materials = await new MTLLoader(manager).loadAsync(fileUrl(manifest.id, mtl.name));
                materials.preload();
                loader.setMaterials(materials);
            }
            object = await loader.loadAsync(url, onProgress);
        } else {
            throw new Error(`Unsupported model format ${type}`);
        }
        return { object, animations };
    }

    installModel(object, animations) {
        this.setLoading('Building rig', 1);
        object.traverse((o) => {
            if (o.isSkinnedMesh) o.frustumCulled = false; // PhysBones move vertices outside the bind-pose bounds
        });

        // Normalize: stand on the floor, centered, about TARGET_HEIGHT tall.
        object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const scale = TARGET_HEIGHT / Math.max(size.y, size.x * 0.75, size.z * 0.75, 1e-6);
        const pivot = new THREE.Group();
        pivot.scale.setScalar(scale);
        object.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
        pivot.add(object);
        this.turntable.add(pivot);
        this.modelHeight = size.y * scale;
        this.platform.scale.setScalar(Math.max(1, (Math.max(size.x, size.z) * scale) / 1.2));
        this.scanner.scale.copy(this.platform.scale);
        this.model = object;

        this.collectMaterials();
        this.index = rig.indexModel(object);
        this.rebuildCategories();
        this.applyShading();

        this.clips = animations;
        if (animations.length) this.mixer = new THREE.AnimationMixer(object);
        this.stats = this.computeStats();
        this.frameCamera();
    }

    rebuildCategories() {
        const { index, manifest } = this;
        const cfg = manifest.rig || {};
        this.physSource = cfg.physbones?.length ? 'manifest' : 'auto';
        const physConfigs = cfg.physbones?.length ? cfg.physbones : rig.detectPhysBoneRoots(index).map((root) => ({ root }));
        this.physics?.reset();
        this.physics?.beforeAnimation();
        const wasEnabled = this.physics ? this.physics.enabled : true;
        const settings = this.physics?.settings;
        this.physics = new rig.PhysBoneSystem(index, physConfigs);
        this.physics.enabled = wasEnabled;
        if (settings) Object.assign(this.physics.settings, settings);

        this.clothesSource = cfg.clothes?.length ? 'manifest' : 'auto';
        this.clothes = rig.resolveNames(index, cfg.clothes?.length ? cfg.clothes : rig.detectClothes(index), (o) => !o.isBone);
        this.inactiveSource = cfg.inactive?.length ? 'manifest' : 'auto';
        this.inactive = rig.resolveNames(index, cfg.inactive?.length ? cfg.inactive : rig.detectInactive(index), (o) => !o.isBone);
        for (const o of index.objects) {
            o.userData.ofxDefaultVisible = !this.inactive.includes(o);
            o.visible = o.userData.ofxDefaultVisible;
        }
        this.menuSource = cfg.expressions?.menu?.length ? 'manifest' : 'auto';
        this.menu = this.menuSource === 'manifest' ? cfg.expressions.menu : rig.buildAutoMenu(index, this.clothes, this.inactive);
        this.menuStack = [];
        this.exprValues.clear();
        this.activeRadial = null;
    }

    // -------------------------------------------------------- materials

    collectMaterials() {
        this.model.traverse((o) => {
            if (!o.isMesh) return;
            const list = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of list) {
                if (m.emissive && m.emissiveMap && m.emissive.getHex() === 0) m.emissive.set(0xffffff);
                if (m.emissive) m.userData.ofxEmissive = m.emissiveIntensity ?? 1;
                m.userData.ofxAlpha = { alphaTest: m.alphaTest, transparent: m.transparent, depthWrite: m.depthWrite };
            }
            this.originalMaterials.set(o, o.material);
        });
    }

    makeMaterial(m) {
        const mode = this.settings.shading;
        const common = { map: m.map || null, color: m.color ? m.color.clone() : new THREE.Color(1, 1, 1), transparent: m.transparent, opacity: m.opacity ?? 1, alphaTest: m.alphaTest || 0, side: m.side };
        let out;
        if (mode === 'toon') {
            this.gradient ||= toonGradient();
            out = new THREE.MeshToonMaterial({ ...common, gradientMap: this.gradient, normalMap: m.normalMap || null, emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0), emissiveMap: m.emissiveMap || null });
            out.userData.ofxEmissive = m.userData.ofxEmissive ?? 1;
        } else if (mode === 'unlit') {
            out = new THREE.MeshBasicMaterial(common);
        } else if (mode === 'clay') {
            out = new THREE.MeshStandardMaterial({ color: 0xb8aeb0, roughness: 0.75, metalness: 0, side: m.side });
        } else {
            out = new THREE.MeshBasicMaterial({ color: this.settings.accent.clone().multiplyScalar(2.2), wireframe: true });
        }
        out.userData.ofxAlpha = { alphaTest: out.alphaTest, transparent: out.transparent, depthWrite: out.depthWrite };
        out.name = m.name;
        return out;
    }

    applyShading() {
        for (const m of this.generatedMaterials) m.dispose();
        this.generatedMaterials = [];
        const cache = new Map();
        for (const [mesh, original] of this.originalMaterials) {
            if (this.settings.shading === 'original') {
                mesh.material = original;
                continue;
            }
            const convert = (m) => {
                if (!cache.has(m)) {
                    const made = this.makeMaterial(m);
                    cache.set(m, made);
                    this.generatedMaterials.push(made);
                }
                return cache.get(m);
            };
            mesh.material = Array.isArray(original) ? original.map(convert) : convert(original);
        }
        this.applyAlphaCutout();
        this.applyEmission(1);
    }

    *activeMaterials() {
        for (const mesh of this.originalMaterials.keys()) yield* (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    }

    applyEmission(pulse) {
        for (const m of this.activeMaterials()) {
            if (m.emissive && m.userData.ofxEmissive != null) m.emissiveIntensity = m.userData.ofxEmissive * this.settings.emission * pulse;
        }
    }

    // Fur cards and cutout clothing are often exported as blended transparency, which sorts badly.
    applyAlphaCutout() {
        for (const m of this.activeMaterials()) {
            const base = m.userData.ofxAlpha;
            if (!base) continue;
            if (this.settings.alphaCutout && (m.map || m.alphaMap) && (base.transparent || base.alphaTest > 0)) {
                m.alphaTest = 0.5;
                m.transparent = false;
                m.depthWrite = true;
            } else {
                Object.assign(m, base);
            }
            m.needsUpdate = true;
        }
    }

    computeStats() {
        let triangles = 0, skinnedMeshes = 0, meshes = 0, materials = 0;
        const textures = new Set();
        this.model.traverse((o) => {
            if (!o.isMesh) return;
            o.isSkinnedMesh ? skinnedMeshes++ : meshes++;
            const geo = o.geometry;
            triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
            const list = Array.isArray(o.material) ? o.material : [o.material];
            materials += list.length;
            for (const m of [this.originalMaterials.get(o)].flat()) {
                for (const key of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'specularMap']) if (m?.[key]) textures.add(m[key]);
            }
        });
        const stats = {
            triangles: Math.round(triangles), skinnedMeshes, meshes, materials,
            bones: this.index.bones.length, physbones: this.physics.chains.length,
            blendshapes: this.index.morphs.size, textures: textures.size,
        };
        let rank = 0;
        for (const [key, limits] of Object.entries(RANK_LIMITS)) {
            const r = limits.findIndex((limit) => stats[key] <= limit);
            rank = Math.max(rank, r < 0 ? 4 : r);
        }
        stats.rank = RANKS[rank];
        return stats;
    }

    // -------------------------------------------------------- owner helpers

    async patch(body, message = 'Saved') {
        try {
            this.manifest = await api(`/api/avatars/${this.manifest.id}`, { method: 'PATCH', body });
            toast(message, 'ok');
            return true;
        } catch (err) {
            toast(err.message);
            return false;
        }
    }

    async saveRig(partial) {
        if (await this.patch({ rig: { ...this.manifest.rig, ...partial } }, 'Rig configuration saved')) {
            this.rebuildCategories();
            this.stats = this.computeStats();
            this.renderTabs();
        }
    }

    reload() {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    }

    capture(type = 'image/webp') {
        this.composer.render(0);
        return new Promise((resolve) => this.canvas.toBlob(resolve, type, 0.9));
    }

    async screenshot() {
        const blob = await this.capture('image/png');
        if (!blob) return toast('Screenshot failed');
        const a = h('a', { href: URL.createObjectURL(blob), download: `${this.manifest.name.replace(/[^\w-]+/g, '_')}.png` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async setThumbnail() {
        const blob = await this.capture('image/webp');
        if (!blob) return toast('Capture failed');
        const name = blob.type === 'image/webp' ? 'thumbnail.webp' : 'thumbnail.png';
        try {
            this.manifest = await uploadFile(this.manifest.id, name, blob);
            await this.patch({ thumbnail: name }, 'Thumbnail updated');
        } catch (err) {
            toast(err.message);
        }
    }

    // -------------------------------------------------------- tabs

    renderInfo() {
        const m = this.manifest;
        const s = this.stats;
        const downloads = m.files.map((f) => h('div', { class: 'list-item' },
            h('span', { class: `chip ${['.prefab', '.unitypackage'].includes(ext(f.name)) ? 'chip--hot' : ''}`, text: ext(f.name).slice(1) }),
            h('a', { class: 'switch__label mono small', href: `${fileUrl(m.id, f.name)}?download`, download: f.name, text: f.name }),
            h('span', { class: 'muted small mono', text: formatBytes(f.size) }),
            session.owner && button('', async () => {
                if (!confirm(`Remove ${f.name}?`)) return;
                try {
                    this.manifest = await api(`/api/avatars/${m.id}/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
                    this.renderTabs();
                } catch (err) { toast(err.message); }
            }, { iconName: 'trash', title: `Remove ${f.name}`, small: true })));
        const prefab = m.files.find((f) => ext(f.name) === '.prefab' || ext(f.name) === '.unitypackage');

        return [
            m.description && h('p', { style: { marginTop: 0, whiteSpace: 'pre-wrap' }, text: m.description }),
            m.tags.length > 0 && h('div', { class: 'row', style: { marginBottom: '12px' } }, m.tags.map((t) => h('span', { class: 'chip', text: t }))),
            prefab && h('a', { class: 'btn btn--primary', style: { width: '100%', marginBottom: '8px' }, href: `${fileUrl(m.id, prefab.name)}?download`, download: prefab.name },
                icon('download'), ext(prefab.name) === '.prefab' ? 'Avatar root prefab' : 'Unity package'),
            ...section('Performance', s
                ? h('dl', { class: 'kv' },
                    h('dt', { text: 'Rank (est. PC)' }), h('dd', { class: `rank rank--${s.rank.toLowerCase().replace(' ', '')}`, text: s.rank }),
                    h('dt', { text: 'Triangles' }), h('dd', { text: s.triangles.toLocaleString() }),
                    h('dt', { text: 'Skinned meshes' }), h('dd', { text: s.skinnedMeshes }),
                    h('dt', { text: 'Meshes' }), h('dd', { text: s.meshes }),
                    h('dt', { text: 'Material slots' }), h('dd', { text: s.materials }),
                    h('dt', { text: 'Textures' }), h('dd', { text: s.textures }),
                    h('dt', { text: 'Bones' }), h('dd', { text: s.bones }),
                    h('dt', { text: 'PhysBones' }), h('dd', { text: s.physbones }),
                    h('dt', { text: 'Blendshapes' }), h('dd', { text: s.blendshapes }))
                : this.needsModel()),
            this.clips.length > 0 && section('Animation', select([['', 'Rest pose'], ...this.clips.map((c, i) => [String(i), c.name || `Clip ${i + 1}`])], this.currentClip ?? '', (v) => {
                this.mixer.stopAllAction();
                this.currentClip = v;
                if (v !== '') this.mixer.clipAction(this.clips[Number(v)]).play();
                else this.physics?.reset();
            })),
            ...section(`Files · ${m.files.length}`, h('div', { class: 'list' }, downloads)),
            session.owner && this.renderInfoOwner(),
        ];
    }

    renderInfoOwner() {
        const m = this.manifest;
        const name = h('input', { class: 'input', value: m.name, maxlength: 80 });
        const description = h('textarea', { class: 'textarea', maxlength: 4000, value: m.description });
        const tags = h('input', { class: 'input', value: m.tags.join(', ') });
        const models = m.files.filter((f) => MODEL_EXTS.includes(ext(f.name)));
        const picker = h('input', { type: 'file', multiple: true, accept: UPLOAD_EXTENSIONS.join(','), class: 'hidden' });
        picker.addEventListener('change', async () => {
            try {
                toast(`Uploading ${picker.files.length} file(s)…`);
                await uploadBatch(m.id, [...picker.files].filter((f) => !/\.meta$/i.test(f.name)));
                toast('Files uploaded', 'ok');
                this.reload();
            } catch (err) { toast(err.message); }
        });
        return h('div', { class: 'owner-box' },
            h('div', { class: 'section-title', text: 'Owner controls' }),
            h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
            h('label', { class: 'field' }, h('span', { text: 'Description' }), description),
            h('label', { class: 'field' }, h('span', { text: 'Tags' }), tags),
            models.length > 1 && h('label', { class: 'field' }, h('span', { text: 'Preview model' }),
                select(models.map((f) => [f.name, f.name]), m.model, async (v) => { if (await this.patch({ model: v }, 'Preview model changed')) this.reload(); })),
            toggle('Published', m.published, (v) => this.patch({ published: v }, v ? 'Published' : 'Moved to drafts')),
            h('div', { class: 'row', style: { marginTop: '10px' } },
                button('Save details', () => this.patch({ name: name.value, description: description.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) }), { variant: 'primary', small: true }),
                button('Thumbnail from view', () => this.setThumbnail(), { iconName: 'camera', small: true }),
                button('Add files', () => picker.click(), { iconName: 'upload', small: true }),
                picker,
                button('Delete', async () => {
                    if (!confirm(`Delete “${m.name}” and all of its files?`)) return;
                    try {
                        await api(`/api/avatars/${m.id}`, { method: 'DELETE' });
                        toast('Avatar deleted', 'ok');
                        location.hash = '#/owner';
                    } catch (err) { toast(err.message); }
                }, { iconName: 'trash', variant: 'danger', small: true })));
    }

    renderPhysBones() {
        if (!this.index) return this.needsModel();
        const ph = this.physics;
        const s = ph.settings;
        const chains = ph.chains.map((chain) => h('div', { class: 'list-item' },
            toggle(`${chain.name} · ${chain.boneCount} bones`, chain.enabled, (v) => ph.setChainEnabled(chain, v))));
        return [
            toggle('Simulate PhysBones', ph.enabled, (v) => ph.setEnabled(v)),
            h('div', { class: 'row', style: { margin: '8px 0 14px' } },
                button('Shake', () => ph.shake(), { iconName: 'shake', small: true }),
                button(this.settings.turntable ? 'Stop turntable' : 'Turntable', (e) => { this.setTurntable(!this.settings.turntable); e.currentTarget.lastChild.textContent = this.settings.turntable ? 'Stop turntable' : 'Turntable'; }, { iconName: 'rotate', small: true }),
                button('Reset', () => ph.reset(), { small: true })),
            slider('Gravity', { min: 0, max: 4, value: s.gravity }, (v) => (s.gravity = v)),
            slider('Bounce', { min: 0, max: 2, value: s.bounce }, (v) => (s.bounce = v)),
            slider('Pull', { min: 0.1, max: 3, value: s.pull }, (v) => (s.pull = v)),
            slider('Wind', { min: 0, max: 2, value: s.wind }, (v) => (s.wind = v)),
            ...section(`Chains · ${ph.chains.length}`,
                h('div', { class: 'hint', text: this.physSource === 'manifest' ? 'Chains come from the VRC PhysBone components in the exported prefab.' : 'Chains auto-detected from bone names (tail, ears, hair, …). The owner can pick them manually below.' }),
                h('div', { class: 'list', style: { marginTop: '8px' } }, chains.length ? chains : h('p', { class: 'muted small', text: 'No PhysBone chains found.' }))),
            session.owner && this.renderPhysOwner(),
        ];
    }

    renderPhysOwner() {
        const roots = new Set(this.physics.chains.map((c) => c.root.name));
        const list = h('div', { class: 'scroll-list list' });
        const fill = (q = '') => list.replaceChildren(...this.index.bones.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 300).map((b) =>
            h('div', { class: 'list-item' }, toggle(b.name, roots.has(b.name), (v) => (v ? roots.add(b.name) : roots.delete(b.name))))));
        fill();
        const existing = new Map((this.manifest.rig?.physbones || []).map((pb) => [rig.normName(pb.root), pb]));
        return h('div', { class: 'owner-box' },
            h('div', { class: 'section-title', text: 'Configure chain roots' }),
            searchFilter('Filter bones…', fill), h('div', { style: { height: '8px' } }), list,
            h('div', { class: 'row', style: { marginTop: '10px' } },
                button('Save chains', () => this.saveRig({ physbones: [...roots].map((root) => existing.get(rig.normName(root)) || { root }) }), { variant: 'primary', small: true }),
                button('Use auto-detect', () => this.saveRig({ physbones: [] }), { small: true })));
    }

    objectRow(o, extra) {
        return h('div', { class: 'list-item' }, toggle(o.name, o.visible, (v) => (o.visible = v)), extra);
    }

    renderObjects() {
        if (!this.index) return this.needsModel();
        const all = h('div', { class: 'scroll-list list' });
        const owner = session.owner;
        const draft = { clothes: new Set(this.clothes), inactive: new Set(this.inactive) };
        const chip = (set, o, label) => {
            const el = h('button', { type: 'button', class: `chip ${set.has(o) ? 'is-on' : ''}`, text: label, title: `Mark as ${label.toLowerCase()}` });
            el.addEventListener('click', () => { set.has(o) ? set.delete(o) : set.add(o); el.classList.toggle('is-on', set.has(o)); });
            return el;
        };
        const fill = (q = '') => all.replaceChildren(...this.index.objects.filter((o) => !q || o.name.toLowerCase().includes(q)).slice(0, 400)
            .map((o) => this.objectRow(o, owner && [chip(draft.clothes, o, 'Cloth'), chip(draft.inactive, o, 'Inactive')])));
        fill();
        return [
            ...section(`Inactive objects · ${this.inactive.length}`,
                h('div', { class: 'hint', text: this.inactiveSource === 'manifest' ? 'Objects that are disabled by default on the avatar root prefab.' : 'Nothing is marked inactive in the uploaded data. Upload openfurx.json from the Unity exporter, or the owner can mark objects below.' }),
                h('div', { class: 'list', style: { marginTop: '8px' } }, this.inactive.map((o) => this.objectRow(o)))),
            ...section(`All objects · ${this.index.objects.length}`, searchFilter('Filter objects…', fill), h('div', { style: { height: '8px' } }), all),
            h('div', { class: 'row', style: { marginTop: '10px' } },
                button('Reset visibility', () => { for (const o of this.index.objects) o.visible = o.userData.ofxDefaultVisible; this.renderTabs(); }, { small: true }),
                owner && button('Save categories', () => this.saveRig({ clothes: [...draft.clothes].map((o) => o.name), inactive: [...draft.inactive].map((o) => o.name) }), { variant: 'primary', small: true })),
        ];
    }

    renderClothes() {
        if (!this.index) return this.needsModel();
        const setAll = (v) => { for (const o of this.clothes) o.visible = v; this.renderTabs(); };
        return [
            h('div', { class: 'row', style: { marginBottom: '12px' } }, button('Show all', () => setAll(true), { small: true }), button('Hide all', () => setAll(false), { small: true })),
            h('div', { class: 'hint', style: { marginBottom: '10px' }, text: this.clothesSource === 'manifest' ? 'Clothing objects defined by the avatar owner.' : 'Clothing auto-detected from object names (shirt, jacket, shoes, …). Owners can adjust this in the Objects tab.' }),
            h('div', { class: 'list' }, this.clothes.length ? this.clothes.map((o) => this.objectRow(o)) : h('p', { class: 'muted small', text: 'No clothing objects found.' })),
        ];
    }

    // -------------------------------------------------------- expression menu

    currentControls() {
        const level = this.menuStack.at(-1);
        return rig.paginate(level ? level.controls || [] : this.menu);
    }

    pressControl(control) {
        const value = this.exprValues.get(control) || 0;
        if (control.type === 'submenu') {
            this.menuStack.push(control);
            this.activeRadial = null;
        } else if (control.type === 'toggle') {
            const next = value ? 0 : (control.value ?? 1) || 1;
            this.exprValues.set(control, next);
            rig.applyControl(this.index, control, next ? 1 : 0);
        } else if (control.type === 'button') {
            rig.applyControl(this.index, control, 1);
            this.exprValues.set(control, 1);
            setTimeout(() => {
                rig.applyControl(this.index, control, 0);
                this.exprValues.set(control, 0);
                if (this.tab === 'expressions') this.drawRadial();
            }, 700);
        } else if (control.type === 'radial') {
            this.activeRadial = control;
        } else {
            toast('Puppet controls can’t be previewed in the browser');
        }
        if (!rig.inferTargets(this.index, control).length && ['toggle', 'button', 'radial'].includes(control.type)) {
            toast(`“${control.name}” is driven by the avatar animator and has no preview mapping`);
        }
        this.drawRadial();
        this.refreshShapes?.();
    }

    drawRadial() {
        if (!this.radialHost) return;
        const NS = 'http://www.w3.org/2000/svg';
        const el = (tag, attrs = {}, ...kids) => {
            const node = document.createElementNS(NS, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
            node.append(...kids);
            return node;
        };
        const controls = this.currentControls();
        const n = Math.max(controls.length, 1);
        const cx = 150, R = 140, r = 52, gap = 0.025;
        const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cx + rad * Math.sin(a)).toFixed(2)}`;
        const svg = el('svg', { class: 'radial', viewBox: '0 0 300 300', role: 'menu' });
        svg.append(el('circle', { class: 'ring', cx, cy: cx, r: 147 }));
        const glyph = { toggle: '◉', button: '▶', radial: '◔', submenu: '›', twoaxis: '✥', fouraxis: '✥' };
        controls.forEach((c, i) => {
            const span = (Math.PI * 2) / n;
            const a0 = -Math.PI / 2 + i * span - span / 2 + gap;
            const a1 = a0 + span - gap * 2;
            const large = a1 - a0 > Math.PI ? 1 : 0;
            const d = n === 1
                ? `M ${cx - R} ${cx} A ${R} ${R} 0 1 1 ${cx + R} ${cx} A ${R} ${R} 0 1 1 ${cx - R} ${cx} Z M ${cx - r} ${cx} A ${r} ${r} 0 1 1 ${cx + r} ${cx} A ${r} ${r} 0 1 1 ${cx - r} ${cx} Z`
                : `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
            const mid = (a0 + a1) / 2;
            const [lx, ly] = pt(96, n === 1 ? Math.PI / 2 : mid).split(' ');
            const on = (this.exprValues.get(c) || 0) > 0 || this.activeRadial === c;
            const label = c.name.length > 11 ? `${c.name.slice(0, 10)}…` : c.name;
            const seg = el('g', { class: `seg ${on ? 'is-on' : ''}`, role: 'menuitem', tabindex: '0', 'aria-label': `${c.name} (${c.type})` },
                el('path', { d, 'fill-rule': 'evenodd' }),
                el('text', { x: lx, y: Number(ly) - 6, 'text-anchor': 'middle', class: 'glyph' }, glyph[c.type] || '•'),
                el('text', { x: lx, y: Number(ly) + 8, 'text-anchor': 'middle' }, label),
                el('title', {}, c.name));
            seg.addEventListener('click', () => this.pressControl(c));
            seg.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), this.pressControl(c)));
            svg.append(seg);
        });
        const depth = this.menuStack.length;
        const hub = el('g', { class: 'hub', role: 'button', tabindex: '0', 'aria-label': depth ? 'Back' : 'Reset expressions' },
            el('circle', { cx, cy: cx, r: 46 }),
            el('text', { x: cx, y: cx + 3, 'text-anchor': 'middle' }, depth ? 'BACK' : 'RESET'));
        const hubAction = () => {
            if (depth) this.menuStack.pop();
            else this.resetExpressions();
            this.activeRadial = null;
            this.drawRadial();
        };
        hub.addEventListener('click', hubAction);
        hub.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), hubAction()));
        svg.append(hub);
        if (!controls.length) svg.append(el('text', { x: cx, y: 30, 'text-anchor': 'middle', fill: '#9b8588', 'font-size': '10' }, 'Empty menu'));

        const crumbs = h('div', { class: 'breadcrumbs', text: ['Expression menu', ...this.menuStack.map((c) => c.name)].join(' › ') });
        let dial = null;
        if (this.activeRadial) {
            const c = this.activeRadial;
            dial = slider(c.name, { min: 0, max: 1, value: this.exprValues.get(c) || 0, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
                this.exprValues.set(c, v);
                rig.applyControl(this.index, c, v);
                this.refreshShapes?.();
            });
            dial.style.width = '100%';
        }
        this.radialHost.replaceChildren(crumbs, svg, dial || '');
    }

    resetExpressions() {
        for (const name of this.index.morphs.keys()) rig.setMorph(this.index, name, 0);
        for (const o of this.index.objects) o.visible = o.userData.ofxDefaultVisible;
        this.exprValues.clear();
        this.refreshShapes?.();
    }

    renderExpressions() {
        if (!this.index) return this.needsModel();
        this.radialHost = h('div', { class: 'radial-wrap' });
        this.drawRadial();

        const shapeList = h('div', { class: 'scroll-list list' });
        const sliders = new Map();
        const fill = (q = '') => {
            sliders.clear();
            shapeList.replaceChildren(...[...this.index.morphs.keys()].filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 400).map((name) => {
                const s = slider(name, { min: 0, max: 1, value: rig.getMorph(this.index, name), format: (v) => `${Math.round(v * 100)}%` }, (v) => rig.setMorph(this.index, name, v));
                sliders.set(name, s);
                return h('div', { style: { padding: '0 6px' } }, s);
            }));
        };
        this.refreshShapes = () => { for (const [name, s] of sliders) s.setValue(rig.getMorph(this.index, name)); };
        fill();

        const owner = session.owner && (() => {
            const text = h('textarea', { class: 'textarea mono', style: { minHeight: '180px' }, value: JSON.stringify(this.menuSource === 'manifest' ? this.menu : [], null, 2), spellcheck: false });
            return h('div', { class: 'owner-box' },
                h('div', { class: 'section-title', text: 'Custom expression menu (JSON)' }),
                h('p', { class: 'muted small', text: 'Controls: {name, type: toggle|button|radial|submenu, parameter, targets: [{kind: "blendshape"|"object", name, value}], controls: [...]}. An empty list uses the auto-generated menu.' }),
                text,
                h('div', { class: 'row', style: { marginTop: '10px' } },
                    button('Save menu', () => {
                        let menu;
                        try { menu = JSON.parse(text.value || '[]'); } catch { return toast('Menu JSON is invalid'); }
                        if (!Array.isArray(menu)) return toast('Menu must be a JSON array');
                        this.saveRig({ expressions: { ...(this.manifest.rig?.expressions || {}), menu } });
                    }, { variant: 'primary', small: true }),
                    button('Load auto menu', () => (text.value = JSON.stringify(rig.buildAutoMenu(this.index, this.clothes, this.inactive), null, 2)), { small: true })));
        })();

        return [
            h('div', { class: 'hint', style: { marginBottom: '12px' }, text: this.menuSource === 'manifest' ? 'Expression menu exported from the avatar descriptor.' : 'Auto-generated from blendshapes, clothes and inactive objects.' }),
            this.radialHost,
            ...section(`Blendshapes · ${this.index.morphs.size}`, this.index.morphs.size ? [searchFilter('Filter blendshapes…', fill), h('div', { style: { height: '8px' } }), shapeList] : h('p', { class: 'muted small', text: 'This model has no blendshapes.' })),
            owner,
        ];
    }

    // -------------------------------------------------------- render settings

    renderRender() {
        const s = this.settings;
        const refreshBloom = () => {
            this.bloomPass.enabled = s.bloom;
            this.bloomPass.strength = s.bloomStrength;
            this.bloomPass.radius = s.bloomRadius;
            this.bloomPass.threshold = s.bloomThreshold;
        };
        return [
            ...section('Quality',
                select(Object.entries(QUALITY).map(([k, q]) => [k, q.label]), s.quality, (v) => { s.quality = v; storageSet('ofx.quality', v); this.buildComposer(); this.resize(); })),
            ...section('Post-processing',
                toggle('Bloom', s.bloom, (v) => { s.bloom = v; refreshBloom(); }),
                slider('Bloom strength', { min: 0, max: 3, value: s.bloomStrength }, (v) => { s.bloomStrength = v; refreshBloom(); }),
                slider('Bloom radius', { min: 0, max: 1, value: s.bloomRadius }, (v) => { s.bloomRadius = v; refreshBloom(); }),
                slider('Bloom threshold', { min: 0, max: 2, value: s.bloomThreshold }, (v) => { s.bloomThreshold = v; refreshBloom(); }),
                slider('Exposure', { min: 0.3, max: 2.5, value: s.exposure }, (v) => { s.exposure = v; this.renderer.toneMappingExposure = v; })),
            ...section('Materials',
                h('label', { class: 'field' }, h('span', { text: 'Shading' }), select([['original', 'Original'], ['toon', 'Toon'], ['unlit', 'Unlit'], ['clay', 'Clay'], ['wire', 'Emission wireframe']], s.shading, (v) => { s.shading = v; if (this.index) this.applyShading(); })),
                slider('Emission intensity', { min: 0, max: 10, value: s.emission }, (v) => { s.emission = v; this.applyEmission(1); }),
                toggle('Pulse emission', s.emissionPulse, (v) => { s.emissionPulse = v; if (!v) this.applyEmission(1); }),
                toggle('Alpha cutout (fur cards)', s.alphaCutout, (v) => { s.alphaCutout = v; if (this.index) this.applyAlphaCutout(); })),
            ...section('Stage',
                toggle('Emission floor', s.floor, (v) => { s.floor = v; this.floor.visible = v; }),
                toggle('Scanner ring', s.scanner, (v) => { s.scanner = v; this.scanner.visible = v; }),
                toggle('Turntable', s.turntable, (v) => this.setTurntable(v)),
                h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', { text: 'Accent colour' }),
                    h('input', { type: 'color', class: 'input', style: { height: '40px', padding: '4px' }, value: `#${s.accent.getHexString()}`, oninput: (e) => this.setAccent(e.target.value) }))),
            session.owner && h('div', { class: 'owner-box' },
                h('div', { class: 'section-title', text: 'Defaults for visitors' }),
                button('Save current look as default', () => this.patch({ render: { emission: s.emission, bloom: s.bloomStrength, shading: s.shading, alphaCutout: s.alphaCutout, accent: `#${s.accent.getHexString()}` } }, 'Render defaults saved'), { variant: 'primary', small: true })),
        ];
    }

    setAccent(hex) {
        this.settings.accent.set(hex);
        this.floorUniforms.uColor.value.set(hex);
        this.rim.color.set(hex);
        this.scannerMaterial.color.set(hex).multiplyScalar(3);
        if (this.settings.shading === 'wire') this.applyShading();
    }

    // -------------------------------------------------------- lifecycle

    async init() {
        this.buildDom();
        try {
            this.initThree();
        } catch (err) {
            this.loadError = 'WebGL is not available in this browser.';
            this.setLoading(this.loadError, 0);
            return;
        }
        this.setTurntable(false);
        this.frameCamera();
        try {
            this.setLoading('Downloading model', 0);
            const { object, animations } = await this.loadModel();
            if (this.disposed) return disposeObject(object);
            this.installModel(object, animations);
            this.loaderEl.remove();
        } catch (err) {
            if (this.disposed) return;
            console.error(err);
            this.loadError = err.message || 'The model could not be loaded.';
            this.setLoading(this.loadError, 0);
            this.loaderEl.querySelector('.loader__ring').remove();
        }
        this.renderTabs();
    }

    dispose() {
        this.disposed = true;
        for (const fn of this.cleanups) fn();
        if (!this.renderer) return;
        this.renderer.setAnimationLoop(null);
        this.controls.dispose();
        this.mixer?.stopAllAction();
        for (const m of this.generatedMaterials) m.dispose();
        for (const original of this.originalMaterials.values()) for (const m of [original].flat()) disposeMaterial(m);
        disposeObject(this.scene);
        this.gradient?.dispose();
        this.shadowTex.dispose();
        this.envTexture.dispose();
        this.pmrem.dispose();
        this.bloomPass.dispose();
        this.composer.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
    }
}

function disposeMaterial(m) {
    if (!m) return;
    for (const value of Object.values(m)) if (value && value.isTexture) value.dispose();
    m.dispose();
}

function disposeObject(root) {
    root.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) for (const m of [o.material].flat()) disposeMaterial(m);
    });
}

export async function mountViewer(root, id) {
    const manifest = await api(`/api/avatars/${encodeURIComponent(id)}`);
    document.title = `${manifest.name} · OpenFurX`;
    const viewer = new Viewer(root, manifest);
    viewer.init();
    return () => {
        document.title = 'OpenFurX';
        viewer.dispose();
    };
}
