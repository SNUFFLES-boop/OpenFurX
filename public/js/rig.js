// Avatar rig helpers: name lookup, category detection, PhysBones simulation and expression menus.
import * as THREE from 'three';

// Loaders sanitize node names differently (spaces -> underscores, dots dropped), and Unity exports
// hierarchy paths, so names are compared by their last path segment with only letters/digits kept.
export const normName = (name) => String(name || '').split(/[\/|]/).pop().toLowerCase().replace(/[^a-z0-9]/g, '');

const tokens = (name) => String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

const PHYS_PREFIX = ['tail', 'ear', 'hair', 'bang', 'ponytail', 'braid', 'breast', 'boob', 'jiggle', 'skirt', 'cape', 'scarf',
    'ribbon', 'wing', 'fluff', 'tuft', 'whisker', 'antenna', 'tassel', 'mane', 'chain', 'dangle', 'physbone', 'pb'];
const PHYS_EXACT = new Set(['tie', 'butt', 'bow']);
const CLOTH_PREFIX = ['shirt', 'tshirt', 'pant', 'jacket', 'hoodie', 'hood', 'shoe', 'boot', 'sock', 'glove', 'beanie', 'skirt',
    'dress', 'cloth', 'outfit', 'harness', 'collar', 'jean', 'short', 'underwear', 'pant', 'accessor', 'glass', 'necklace',
    'bracelet', 'choker', 'belt', 'vest', 'coat', 'sweater', 'sleeve', 'legging', 'stocking', 'bandana', 'headphone',
    'earring', 'piercing', 'sneaker', 'sandal', 'bikini', 'swimsuit', 'kimono', 'uniform', 'armor', 'armour', 'top'];
const CLOTH_EXACT = new Set(['hat', 'cap', 'bra', 'acc', 'mask', 'ring', 'bag', 'top', 'bottom', 'bottoms', 'tops']);
const VISEME_RE = /^(vrc\.)?v_|viseme|^vrc\.(blink|lowerlid)/i;

const matchesTokens = (name, prefixes, exact) => tokens(name).some((t) => exact.has(t) || prefixes.some((p) => t.startsWith(p)));

export function indexModel(root) {
    const byName = new Map();
    const meshes = [];
    const bones = [];
    const objects = []; // toggleable scene objects: meshes and non-bone groups that contain meshes
    const morphs = new Map(); // display name -> [{ mesh, index }]

    root.traverse((o) => {
        const key = normName(o.name);
        if (key) {
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(o);
        }
        if (o.isBone) bones.push(o);
        if (o.isMesh) {
            meshes.push(o);
            for (const [name, index] of Object.entries(o.morphTargetDictionary || {})) {
                if (!morphs.has(name)) morphs.set(name, []);
                morphs.get(name).push({ mesh: o, index });
            }
        }
    });

    const hasMesh = new Set();
    for (const mesh of meshes) for (let o = mesh; o && o !== root; o = o.parent) hasMesh.add(o);
    root.traverse((o) => {
        if (o !== root && !o.isBone && hasMesh.has(o) && o.name) objects.push(o);
    });

    const morphByNorm = new Map();
    for (const name of morphs.keys()) morphByNorm.set(normName(name), name);

    for (const o of objects) o.userData.ofxDefaultVisible = o.visible;

    return {
        root, byName, meshes, bones, objects, morphs,
        find: (name) => byName.get(normName(name)) || [],
        morphName: (name) => morphs.has(name) ? name : morphByNorm.get(normName(name)) || null,
    };
}

export function setMorph(index, name, value) {
    const resolved = index.morphName(name);
    for (const { mesh, index: i } of index.morphs.get(resolved) || []) mesh.morphTargetInfluences[i] = value;
}

export function getMorph(index, name) {
    const hit = (index.morphs.get(index.morphName(name)) || [])[0];
    return hit ? hit.mesh.morphTargetInfluences[hit.index] : 0;
}

export function setObjectsVisible(index, name, visible) {
    for (const o of index.find(name)) o.visible = visible;
}

// ---------------------------------------------------------------- category detection

export function detectPhysBoneRoots(index) {
    const isPhys = (b) => matchesTokens(b.name, PHYS_PREFIX, PHYS_EXACT);
    return index.bones.filter((b) => isPhys(b) && !(b.parent && b.parent.isBone && isPhys(b.parent))).map((b) => b.name);
}

export function detectClothes(index) {
    return index.objects.filter((o) => o.isMesh && matchesTokens(o.name, CLOTH_PREFIX, CLOTH_EXACT)).map((o) => o.name);
}

export function detectInactive(index) {
    return index.objects.filter((o) => o.userData.active === false || o.userData.inactive === true).map((o) => o.name);
}

// Resolve configured names to unique existing objects, keeping the configured order.
export function resolveNames(index, names, predicate = () => true) {
    const seen = new Set();
    const out = [];
    for (const name of names || []) {
        for (const o of index.find(name)) {
            if (!seen.has(o) && predicate(o)) {
                seen.add(o);
                out.push(o);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------- PhysBones

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();

function worldPos(object, out) {
    return out.setFromMatrixPosition(object.matrixWorld);
}

function worldQuat(object, out) {
    object.matrixWorld.decompose(_v3, out, _s);
    return out;
}

// One simulated PhysBone chain. Each frame the bones start from their animated pose ("base"),
// verlet particles follow that pose with inertia, then bones are rotated toward the particles.
class Chain {
    constructor(rootBone, params, ignore) {
        this.root = rootBone;
        this.params = params;
        this.enabled = true;
        this.particles = [];
        const ignoreSet = new Set((ignore || []).map(normName));

        const makeParticle = (bone, parentIndex, virtual, offset) => ({
            bone, parentIndex, firstChild: -1, virtual, offset,
            restQuat: virtual ? null : bone.quaternion.clone(), baseQuat: virtual ? null : bone.quaternion.clone(), restLength: 0,
            p: new THREE.Vector3(), prev: new THREE.Vector3(), target: new THREE.Vector3(),
        });
        const link = (index, parentIndex) => {
            if (parentIndex >= 0 && this.particles[parentIndex].firstChild < 0) this.particles[parentIndex].firstChild = index;
        };
        const add = (bone, parentIndex) => {
            const index = this.particles.length;
            this.particles.push(makeParticle(bone, parentIndex, false, null));
            link(index, parentIndex);
            const children = bone.children.filter((c) => c.isBone && !ignoreSet.has(normName(c.name)));
            for (const child of children) add(child, index);
            if (!children.length) {
                // Leaf: extend a virtual tip along the incoming bone direction so the last bone can swing too.
                const offset = bone.position.clone().applyQuaternion(bone.quaternion.clone().invert());
                if (offset.lengthSq() < 1e-10) offset.set(0, 0.05, 0);
                this.particles.push(makeParticle(bone, index, true, offset));
                link(this.particles.length - 1, index);
            }
        };
        add(rootBone, -1);
        this.boneCount = this.particles.filter((p) => !p.virtual).length;
        this.reset();
    }

    restoreRest() {
        for (const pt of this.particles) if (!pt.virtual) pt.bone.quaternion.copy(pt.restQuat);
    }

    capture() {
        for (const pt of this.particles) if (!pt.virtual) pt.baseQuat.copy(pt.bone.quaternion);
    }

    prepare() {
        for (const pt of this.particles) if (!pt.virtual) pt.bone.quaternion.copy(pt.baseQuat);
        this.root.updateMatrixWorld(true);
        for (const pt of this.particles) {
            if (pt.virtual) pt.target.copy(pt.offset).applyMatrix4(pt.bone.matrixWorld);
            else worldPos(pt.bone, pt.target);
        }
    }

    reset() {
        this.root.parent?.updateWorldMatrix(true, false);
        this.capture();
        this.prepare();
        for (const pt of this.particles) {
            pt.p.copy(pt.target);
            pt.prev.copy(pt.target);
            if (pt.parentIndex >= 0) pt.restLength = pt.target.distanceTo(this.particles[pt.parentIndex].target);
        }
    }

    integrate(dt, settings, time) {
        const { pull, spring, stiffness, gravity } = this.params;
        const k = Math.min(0.9, (0.02 + pull * 0.25 + stiffness * 0.15) * settings.pull);
        const damping = Math.min(0.95, Math.max(0.02, 0.28 - spring * 0.22 * settings.bounce));
        const gravityStep = -9.8 * gravity * settings.gravity * dt * dt;
        const wind = settings.wind * 6 * dt * dt;
        const windX = Math.sin(time * 1.3 + this.root.id) * wind;
        const windZ = Math.cos(time * 0.7 + this.root.id * 0.5) * wind * 0.6;

        const parts = this.particles;
        parts[0].p.copy(parts[0].target);
        parts[0].prev.copy(parts[0].target);
        for (let i = 1; i < parts.length; i++) {
            const pt = parts[i];
            const parent = parts[pt.parentIndex];
            _v1.subVectors(pt.p, pt.prev).multiplyScalar(1 - damping);
            pt.prev.copy(pt.p);
            pt.p.add(_v1);
            pt.p.y += gravityStep;
            pt.p.x += windX;
            pt.p.z += windZ;
            pt.p.lerp(pt.target, k);
            _v1.subVectors(pt.p, parent.p);
            const len = _v1.length();
            if (len > 1e-8) pt.p.copy(parent.p).addScaledVector(_v1, pt.restLength / len);
        }
    }

    // Rotate each bone so its first child points at the simulated child position.
    pose() {
        const parts = this.particles;
        for (let i = 1; i < parts.length; i++) {
            const pt = parts[i];
            const parent = parts[pt.parentIndex];
            if (parent.firstChild !== i) continue;
            const bone = parent.bone;
            const origin = worldPos(bone, _v2);
            const current = pt.virtual ? _v1.copy(pt.offset).applyMatrix4(bone.matrixWorld) : worldPos(pt.bone, _v1);
            current.sub(origin);
            const desired = _v3.subVectors(pt.p, origin);
            if (current.lengthSq() < 1e-12 || desired.lengthSq() < 1e-12) continue;
            _q1.setFromUnitVectors(current.normalize(), desired.normalize());
            _q1.multiply(worldQuat(bone, _q2)); // new world rotation
            if (bone.parent) {
                worldQuat(bone.parent, _q2);
                bone.quaternion.copy(_q2.invert().multiply(_q1));
            } else {
                bone.quaternion.copy(_q1);
            }
            bone.updateMatrixWorld(true);
        }
    }

    impulse(strength) {
        for (let i = 1; i < this.particles.length; i++) {
            const pt = this.particles[i];
            pt.prev.x -= (Math.random() - 0.5) * strength;
            pt.prev.y -= Math.random() * strength * 0.5;
            pt.prev.z -= (Math.random() - 0.5) * strength;
        }
    }
}

export class PhysBoneSystem {
    constructor(index, configs) {
        this.chains = [];
        this.enabled = true;
        this.settings = { gravity: 1, bounce: 1, pull: 1, wind: 0 };
        this.accumulator = 0;
        this.time = 0;
        const used = new Set();
        for (const config of configs) {
            const bone = index.find(config.root).find((o) => o.isBone);
            if (!bone || used.has(bone)) continue;
            used.add(bone);
            const chain = new Chain(bone, {
                pull: config.pull ?? 0.2, spring: config.spring ?? 0.2,
                stiffness: config.stiffness ?? 0.2, gravity: config.gravity ?? 0.05,
            }, config.ignore);
            chain.name = config.name || bone.name;
            this.chains.push(chain);
        }
    }

    // Call before the animation mixer runs, so bones the clip does not drive return to rest.
    beforeAnimation() {
        for (const chain of this.chains) chain.restoreRest();
    }

    // Call after animation and a world-matrix update.
    update(dt) {
        if (!this.enabled) return;
        const active = this.chains.filter((c) => c.enabled);
        if (!active.length) return;
        for (const chain of active) {
            chain.capture();
            chain.prepare();
        }
        const fixed = 1 / 60;
        this.accumulator = Math.min(this.accumulator + dt, fixed * 4);
        while (this.accumulator >= fixed) {
            this.accumulator -= fixed;
            this.time += fixed;
            for (const chain of active) chain.integrate(fixed, this.settings, this.time);
        }
        for (const chain of active) chain.pose();
    }

    setEnabled(on) {
        this.enabled = on;
        if (on) this.reset();
    }

    setChainEnabled(chain, on) {
        chain.enabled = on;
        if (on) chain.reset();
    }

    shake(strength = 0.06) {
        for (const chain of this.chains) chain.impulse(strength);
    }

    reset() {
        for (const chain of this.chains) {
            chain.restoreRest();
            chain.reset();
        }
    }
}

// ---------------------------------------------------------------- expression menu

const MAX_SEGMENTS = 8;

// Radial menus show at most 8 controls; longer lists spill into a trailing "More" submenu.
export function paginate(controls) {
    if (controls.length <= MAX_SEGMENTS) return controls;
    return [...controls.slice(0, MAX_SEGMENTS - 1), { name: 'More', type: 'submenu', controls: paginate(controls.slice(MAX_SEGMENTS - 1)) }];
}

export function buildAutoMenu(index, clothes, inactive) {
    const shapes = [...index.morphs.keys()];
    const visemes = shapes.filter((s) => VISEME_RE.test(s));
    const faces = shapes.filter((s) => !VISEME_RE.test(s));
    const menu = [];
    if (faces.length) {
        menu.push({
            name: 'Expressions', type: 'submenu',
            controls: faces.map((s) => ({ name: s, type: 'toggle', targets: [{ kind: 'blendshape', name: s, value: 1 }] })),
        });
        menu.push({
            name: 'Face Dials', type: 'submenu',
            controls: faces.map((s) => ({ name: s, type: 'radial', targets: [{ kind: 'blendshape', name: s, value: 1 }] })),
        });
    }
    if (visemes.length) {
        menu.push({
            name: 'Visemes', type: 'submenu',
            controls: visemes.map((s) => ({ name: s.replace(/^(vrc\.)?v_/i, ''), type: 'button', targets: [{ kind: 'blendshape', name: s, value: 1 }] })),
        });
    }
    if (clothes.length) {
        menu.push({
            name: 'Clothes', type: 'submenu',
            controls: clothes.map((o) => ({ name: o.name, type: 'toggle', targets: [{ kind: 'object', name: o.name, value: 0 }] })),
        });
    }
    if (inactive.length) {
        menu.push({
            name: 'Objects', type: 'submenu',
            controls: inactive.map((o) => ({ name: o.name, type: 'toggle', targets: [{ kind: 'object', name: o.name, value: 1 }] })),
        });
    }
    return menu;
}

// Controls exported from Unity usually carry a parameter but no targets (the effect lives in the
// FX animator). Infer targets when the parameter or control name matches a blendshape or object.
export function inferTargets(index, control) {
    if (control.targets && control.targets.length) return control.targets;
    for (const candidate of [control.parameter, control.name]) {
        if (!candidate) continue;
        const shape = index.morphName(candidate);
        if (shape) return [{ kind: 'blendshape', name: shape, value: 1 }];
        const objects = index.find(candidate).filter((o) => !o.isBone);
        if (objects.length) return [{ kind: 'object', name: objects[0].name, value: objects[0].userData.ofxDefaultVisible === false ? 1 : 0 }];
    }
    return [];
}

export function applyControl(index, control, amount) {
    for (const target of inferTargets(index, control)) {
        if (target.kind === 'blendshape') {
            setMorph(index, target.name, amount * (target.value ?? 1));
        } else {
            for (const o of index.find(target.name)) {
                const showWhenOn = (target.value ?? 1) >= 0.5;
                o.visible = amount >= 0.5 ? showWhenOn : o.userData.ofxDefaultVisible !== false;
            }
        }
    }
}
