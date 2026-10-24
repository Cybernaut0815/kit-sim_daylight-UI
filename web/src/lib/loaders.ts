// File[] -> THREE.Group via GLTFLoader (Draco, meshopt; multi-file .gltf through a LoadingManager URL modifier) and
// OBJLoader (+ MTLLoader for picked .mtl files). Materials the files do not define (glTF's default, OBJ without .mtl)
// are marked `userData.fallback`: toUsda writes no material for them, so such models stay as the viewer draws them.
import { Group, InterleavedBufferAttribute, LoadingManager, Mesh, type Material, type Object3D, type Texture } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import dracoJs from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasm from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';

/** Every triangle Mesh under `root` (what fromThree() converts). */
export function listMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    const pos = m.geometry?.attributes?.position;
    if (m.isMesh && pos && pos.itemSize === 3 && (m.geometry.index ? m.geometry.index.count : pos.count) % 3 === 0) out.push(m);
  });
  return out;
}

/** The materials of a mesh as a list (three allows one or an array). */
export const materialsOf = (m: Mesh): Material[] => (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []);

/** The texture slots toUsda writes. */
const SLOTS = ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'alphaMap'] as const;
type Slots = Partial<Record<(typeof SLOTS)[number], Texture | null>>;
/** "tex/Brick wall.PNG" -> "Brick wall": a texture file's name without folder and extension. */
const stem = (file: string) => file.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]*$/, '');

/**
 * KTX2 textures need a GPU transcoder and could not become the PNG files the USD needs: skipped with a warning, the
 * material keeps its base colour (a texture that resolves to null leaves the map off). Replaces GLTFLoader's own
 * KHR_texture_basisu plugin (plugins are keyed by name), which throws when the extension is required.
 */
const skipKtx2 = (warn: (m: string) => void) => (parser: GLTFParser) => ({
  name: 'KHR_texture_basisu',
  loadTexture(index: number) {
    const t = parser.json.textures[index];
    if (!t.extensions?.KHR_texture_basisu) return null;
    if (t.source !== undefined) return null; // a PNG / JPEG fallback beside it: the loader takes that
    warn(`KTX2 texture ${t.name ?? index + 1} skipped: its material keeps the base colour.`);
    return Promise.resolve(null as unknown as Texture); // null: GLTFLoader leaves the map off
  },
});

export async function loadFiles(files: File[], warn: (m: string) => void = () => {}): Promise<Group> {
  // A .gltf names its .bin and textures by relative path, an .mtl its textures: serve them from the picked files, matched
  // by the longest path suffix (a folder pick keeps subfolders apart), else by name.
  const urls = new Map<string, string>();
  for (const f of files) {
    const url = URL.createObjectURL(f), parts = (f.webkitRelativePath || f.name).split('/');
    for (let i = 0; i < parts.length; i++) { const key = parts.slice(i).join('/'); if (!urls.has(key)) urls.set(key, url); }
  }
  const modifier = (url: string) => {
    const parts = decodeURIComponent(url.split(/[?#]/)[0]).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
    for (let i = 0; i < parts.length; i++) { const hit = urls.get(parts.slice(i).join('/')); if (hit) return hit; }
    return url;
  };
  const manager = new LoadingManager();
  manager.setURLModifier(modifier);
  const draco = new DRACOLoader().setDecoderPath({ js: dracoJs, wasm: dracoWasm });
  const group = new Group();
  try {
    const gltf = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).register(skipKtx2(warn));
    // MTL textures load in the background (MTLLoader has no callback for them): wait for that manager to go idle.
    let started = false, idle: () => void = () => {};
    const done = new Promise<void>((resolve) => { idle = resolve; });
    const textures = new LoadingManager(() => idle(), undefined, (url) => warn(`Texture not found: ${decodeURIComponent(url.split('/').pop() ?? url)}`));
    textures.setURLModifier(modifier);
    textures.onStart = () => { started = true; };
    const mtls = files.filter((f) => /\.mtl$/i.test(f.name));
    const creator = mtls.length ? new MTLLoader(textures).parse((await Promise.all(mtls.map((f) => f.text()))).join('\n'), '') : null;
    creator?.preload();
    const own = new Set<Material>(creator ? Object.values(creator.materials) : []);
    for (const [name, m] of Object.entries(creator?.materials ?? {})) { // MTL textures are named after their files
      const info = creator!.materialsInfo[name] as Record<string, string>;
      for (const [key, k] of [['map_kd', 'map'], ['norm', 'normalMap'], ['map_ke', 'emissiveMap'], ['map_d', 'alphaMap']] as const) {
        const t = (m as Slots)[k];
        if (t && !t.name && info[key]) t.name = stem(info[key].trim().split(/\s+/).pop()!); // options first, the file last
      }
    }
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase(), url = urls.get(f.webkitRelativePath || f.name)!;
      if (ext === 'glb' || ext === 'gltf') {
        const g = await gltf.loadAsync(url), json = g.parser.json;
        g.scene.traverse((o) => {
          for (const m of materialsOf(o as Mesh)) {
            if (!g.parser.associations.has(m)) m.userData.fallback = true;
            for (const k of SLOTS) { // an unnamed texture takes its image's name or file name (the PNG it becomes)
              const t = (m as Slots)[k], i = t && !t.name ? g.parser.associations.get(t)?.textures : undefined;
              const image = i === undefined ? undefined : json.images?.[json.textures[i].source];
              if (t && image) t.name = image.name || (image.uri && !image.uri.startsWith('data:') ? stem(decodeURIComponent(image.uri)) : '');
            }
          }
        });
        group.add(g.scene);
      } else if (ext === 'obj') {
        const obj = new OBJLoader();
        if (creator) obj.setMaterials(creator);
        const o = obj.parse(await f.text());
        o.traverse((x) => { for (const m of materialsOf(x as Mesh)) if (!own.has(m)) m.userData.fallback = true; });
        group.add(o);
      }
    }
    if (started) await done;
  } finally {
    draco.dispose();
    for (const u of new Set(urls.values())) URL.revokeObjectURL(u);
  }
  // GLTFLoader sanitises names for animation bindings ("Block A" -> "Block_A") and keeps the original in userData.name
  group.traverse((o) => { if (typeof o.userData.name === 'string' && o.userData.name) o.name = o.userData.name; });
  const meshes = listMeshes(group);
  if (meshes.length === 0) throw new Error('No triangle meshes found. Pick a .glb, a .gltf with its .bin and textures, or an .obj file.');
  meshes.forEach((m, i) => {
    m.name ||= m.parent?.name || `Mesh ${i + 1}`;
    const pos = m.geometry.attributes.position;
    if ((pos as InterleavedBufferAttribute).isInterleavedBufferAttribute) m.geometry.setAttribute('position', (pos as InterleavedBufferAttribute).clone()); // fromThree reads pos.array
  });
  return group;
}

/** A texture's image as a PNG file (USD reads PNG / JPEG; glTF images may be WebP, MTL ones anything the browser reads). */
export async function png(image: unknown, name: string): Promise<File> {
  const img = image as CanvasImageSource & { width: number; height: number }; // ImageBitmap (glTF) or HTMLImageElement (MTL)
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
}

/** Whether an image's alpha varies: an MTL map_d then holds its mask there (a cut-out PNG), else in its grey levels. */
export function alphaVaries(image: unknown): boolean {
  const img = image as CanvasImageSource & { width: number; height: number };
  try {
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    for (let i = 7; i < d.length; i += 4) if (d[i] !== d[3]) return true;
  } catch { /* not readable (an empty image): its grey levels */ }
  return false;
}
