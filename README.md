# OpenFurX

An avatar showcase site you host yourself. Visitors browse a gallery and inspect each avatar in a live 3D viewer. Only the owner can log in to upload and manage avatars.

- **Black and red sci-fi UI:** animated buttons and tabs, glitch title, moving emission lines in the background, scanline overlay. All animations run on the compositor (transform/opacity only), and `prefers-reduced-motion` turns them off.
- **3D viewer:** three.js with HDR bloom (UnrealBloomPass), a grid floor with emission pulses moving along it, rotating emissive platform rings, a scanner ring, tone mapping and a quality switch (pixel ratio and MSAA).
- **Viewer tabs:**
  - **Info:** description, tags, an estimated VRChat PC performance rank (triangles, meshes, materials, bones, PhysBones), animation clips and file downloads, including the avatar root `.prefab` / `.unitypackage`.
  - **PhysBones:** a verlet spring simulation of bone chains. You can turn it on or off globally or per chain, and adjust gravity, bounce, pull and wind. There is also a shake button and a turntable.
  - **Objects:** inactive objects (hidden by default, as on the prefab) and the full object list with visibility toggles.
  - **Clothes:** clothing toggles, plus show all / hide all.
  - **Expressions:** a radial expression menu (toggle, button, radial and submenu controls) and a slider for every blendshape.
  - **Render:** bloom strength, radius and threshold, exposure, emission intensity and pulse, shading (original, toon, unlit, clay, emission wireframe), alpha cutout for fur cards, the floor and scanner, and the accent colour.
- **Owner console:** login, multi-file drag-and-drop upload with progress, publish/draft, editing, deletion, adding files, and taking the card thumbnail from the current view. The owner can also set PhysBone chain roots, mark objects as clothes or inactive, write a custom expression menu, and save the default render look.

## Host it on GitHub Pages (no server)

Pages only serves static files, so in this mode the site has no server and there is no owner password. It works like this instead:

- **Visitors** get the same gallery and 3D viewer, read from files in the repo.
- **The owner** logs in on `#/owner` with a fine-grained GitHub token. Uploads and edits are commits to the repo through the GitHub API, and the workflow redeploys the site about a minute later.

Set up once:

1. Make the repository **public**. Pages on a private repo needs a paid GitHub plan.
2. **Settings › Pages › Build and deployment › Source: GitHub Actions**.
3. Merge to `main`. `.github/workflows/pages.yml` builds `_site/` (`scripts/build-pages.mjs`) and deploys it to `https://<user>.github.io/<repo>/`.
4. Create a token at GitHub › Settings › Developer settings › Fine-grained tokens. Limit it to this repository with **Contents: Read and write**, then paste it on the Owner page. It lives in that browser tab only.

Limits of static hosting:

- Files over 100 MB are refused: GitHub blocks larger files, and uploads go through its API. Files near the limit can be slow or fail on a weak connection, so compress textures or decimate the mesh when you can. The whole deployed site must also stay under Pages' 1 GB limit.
- Drafts are left out of the deployed site, but they are still in the repo and readable if it is public.
- Anyone with the token has full write access to the repo, so keep it short-lived and scoped.
- There are no custom security headers (CSP and so on), because Pages cannot set them.

To keep avatars out of the code repo, move them (or the whole site) to a separate public repo, or run the Node server below.

## Run it

```sh
cd openfurx
npm install
OWNER_PASSWORD='choose-a-long-password' npm start
# http://127.0.0.1:8080  ·  owner login at #/owner (username "owner")
```

On Windows PowerShell: `$env:OWNER_PASSWORD='…'; npm start`.

To avoid keeping the plain password in your environment, store a hash instead:

```sh
npm run hash-password -- 'choose-a-long-password'
OWNER_PASSWORD_HASH='scrypt$…' npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `OWNER_PASSWORD` / `OWNER_PASSWORD_HASH` | unset | Turns on owner login. Without either one, the site is read-only. |
| `OWNER_USER` | `owner` | Owner username |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address. Use `HOST=0.0.0.0` to serve other machines. |
| `DATA_DIR` | `./data` | Where avatars and their files are stored (`data/avatars/<id>/`) |
| `MAX_UPLOAD_MB` | `1024` | Size limit per file |
| `SECURE_COOKIES` | off | Set to `1` behind HTTPS |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so login rate limiting uses `X-Forwarded-For` |
| `SESSION_HOURS` | `168` | How long an owner session lasts |

The only dependency is Node 18 or later; three.js is served from `node_modules`, so no CDN is used. For public hosting, put it behind HTTPS (Caddy, nginx) and set `SECURE_COOKIES=1`.

### Security model

- One owner account. The password is checked with scrypt and a timing-safe compare, and login attempts are limited to 10 per 15 minutes per IP.
- Sessions use a random token in an `HttpOnly; SameSite=Strict` cookie. Every write also needs an `X-OpenFurX` header and a same-origin `Origin`, which blocks CSRF.
- Uploads are limited to model, texture, Unity and data extensions. HTML, SVG and JS can never be uploaded, and file names are reduced to a safe basename.
- A strict CSP applies: `script-src 'self'` plus the hash of the import map. All owner-supplied text is rendered with `textContent`.

## Uploading avatars

Upload these together:

1. A **preview model:** `.glb` / `.gltf` / `.vrm` (best, with embedded textures and emission), or `.fbx` / `.obj`.
2. Its **textures**: `.png` / `.jpg` / `.tga` / `.webp`. Models usually point to textures with paths from the author's PC, so the viewer matches them to your uploads by file name, and by file stem when the extension differs, for example `.psd` → `.png`.
3. The **avatar root prefab** `.prefab` and/or a `.unitypackage`, offered as downloads.
4. **`openfurx.json`** from the Unity exporter below. It is read as rig data, not stored as a file.

### What carries over from Unity

Browsers cannot run Unity shaders such as Poiyomi or lilToon. The viewer uses three.js PBR, Phong or toon materials and keeps base colour, normal and emission maps and their intensity. Bloom then picks up anything emissive. If a shader's look depends on custom features, choose the closest shading mode in the Render tab and save it as the default.

A `.prefab` on its own only refers to assets by GUID, so it works only inside a Unity project that already has those assets. Export a `.unitypackage` as well (the exporter does this by default) so people get a single file that imports with all its dependencies.

## Unity exporter (`unity/Editor/OpenFurXAvatarExporter.cs`)

Copy the script into any `Editor` folder in your avatar project. Then select the avatar root and run **Tools › OpenFurX › Export Avatar Root**. You can also right-click the avatar in the Hierarchy and pick **OpenFurX › Export Avatar Root**.

It writes these files to a folder you choose:

- `<Name>.prefab`: an avatar-only root prefab. It is saved from a detached copy of the selected root, with `EditorOnly` objects removed, so the scene and source prefab are untouched.
- `<Name>.unitypackage`: the prefab plus every dependency.
- `<Name>.fbx`: a preview model, if the `com.unity.formats.fbx` package is installed. Otherwise export a GLB/FBX from Blender.
- The textures the materials use.
- `openfurx.json`, which holds:
  - the VRC PhysBone chains, with root, pull, spring, stiffness, gravity and ignore list
  - the inactive objects
  - the clothing objects you picked (they can be auto-filled from object names)
  - the full expression menu tree and expression parameters from the VRC Avatar Descriptor

VRChat SDK types are read by reflection, so the script compiles with or without the SDK. Upload the whole output folder in the owner dashboard.

Menu toggles from Unity name a parameter, but the actual effect lives in the FX animator. The viewer links a control to a blendshape or object whose name matches the parameter or control name. For anything else, the owner can add `targets` in the Expressions tab JSON:

```json
[{ "name": "Hoodie", "type": "toggle", "parameter": "Hoodie", "targets": [{ "kind": "object", "name": "Hoodie", "value": 1 }] }]
```

Without exported data, the viewer works out the categories itself:
- PhysBone chains come from bone names (tail, ear, hair, skirt, …).
- Clothes come from mesh names (shirt, jacket, shoes, …).
- The expression menu is generated from blendshapes (with visemes grouped separately), clothes and inactive objects.
