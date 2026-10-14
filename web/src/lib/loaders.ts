// File[] -> THREE.Group via GLTFLoader (multi-file .gltf through a LoadingManager URL modifier) and OBJLoader.
import { Group, InterleavedBufferAttribute, LoadingManager, Mesh, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

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

export async function loadFiles(files: File[]): Promise<Group> {
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new LoadingManager();
  // a .gltf references its .bin and textures by relative name: serve them from the picked files
  manager.setURLModifier((url) => urls.get(decodeURIComponent(url.split('/').pop() ?? '')) ?? url);
  const group = new Group();
  try {
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext === 'glb' || ext === 'gltf') group.add((await new GLTFLoader(manager).loadAsync(urls.get(f.name)!)).scene);
      else if (ext === 'obj') group.add(new OBJLoader().parse(await f.text()));
    }
  } finally {
    for (const u of urls.values()) URL.revokeObjectURL(u);
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
