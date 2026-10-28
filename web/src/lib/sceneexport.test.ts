import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, Texture, Vector3 } from 'three';
import { texture, vec4 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { exportMatrices, gltfScene, objText, resultGeometry, standard, textureOf, type Drawn } from './sceneexport';

/** Two triangles over four vertices (a unit quad), with normals. */
const quad = () => new BufferGeometry()
  .setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3))
  .setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  .setIndex([0, 1, 2, 0, 2, 3]);

describe('resultGeometry', () => {
  it('per face: the triangles split, each corner with its triangle colour and values (NaN as 0)', () => {
    const g = resultGeometry(quad(), { perFace: true, rgb: new Float32Array([1, 0, 0, 0, 1, 0]), values: [{ name: 'radiation_front', data: [10, NaN] }] });
    expect(g.index).toBeNull();
    expect(g.attributes.position.count).toBe(6);
    expect([...g.attributes.color.array]).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    expect([...g.attributes._daylight_radiation_front.array]).toEqual([10, 10, 10, 0, 0, 0]);
  });
  it('per vertex: the indexed vertices keep their own values', () => {
    const g = resultGeometry(quad(), { perFace: false, rgb: new Float32Array(12).fill(0.5), values: [{ name: 'x', data: [1, 2, 3, 4] }] });
    expect(g.index?.count).toBe(6);
    expect([...g.attributes._daylight_x.array]).toEqual([1, 2, 3, 4]);
    expect(g.attributes.color.count).toBe(4);
  });
});

describe('the viewer look for GLTFExporter', () => {
  it('finds the base-colour texture behind a scale and a channel split, and stores it upright again', () => {
    const tex = new Texture();
    tex.flipY = false;
    expect(textureOf(texture(tex).mul(vec4(0.5, 0.5, 0.5, 1)).rgb)).toBe(tex);
    expect(textureOf(undefined)).toBeNull();
    const m = new MeshPhysicalMaterial({ color: 0x336699, metalness: 0.5, roughness: 0.25 });
    (m as unknown as { colorNode: unknown }).colorNode = texture(tex).rgb;
    const s = standard(m);
    expect([s.color.getHex(), s.metalness, s.roughness]).toEqual([0x336699, 0.5, 0.25]);
    expect(s.map).not.toBe(tex);
    expect(s.map?.flipY).toBe(true);
  });
  it('is transparent (BLEND) only with an alpha the export carries: through another texture alone (an MTL map_d) it is opaque', () => {
    expect(standard(new MeshPhysicalMaterial({ transparent: true })).transparent).toBe(false); // the viewer's opacity node: opacity 1, no base map
    expect(standard(new MeshPhysicalMaterial({ transparent: true, opacity: 0.5 })).transparent).toBe(true);
    const textured = new MeshPhysicalMaterial({ transparent: true });
    (textured as unknown as { colorNode: unknown }).colorNode = texture(new Texture()).rgb;
    expect(standard(textured).transparent).toBe(true); // the base texture's alpha, as before
  });
});

describe('export space and the scene', () => {
  it('scales copies to metres, an instanced mesh to one matrix per instance', () => {
    const root = new Group(), plain = new Mesh(quad()), inst = new InstancedMesh(quad(), new MeshBasicMaterial(), 2);
    plain.position.set(100, 0, 0);
    inst.setMatrixAt(1, new Matrix4().makeTranslation(0, 50, 0));
    root.add(plain, inst);
    root.updateMatrixWorld(true);
    expect(new Vector3().setFromMatrixPosition(exportMatrices(plain, 0.01)[0]).toArray()).toEqual([1, 0, 0]);
    expect(exportMatrices(inst, 0.01).map((m) => new Vector3().setFromMatrixPosition(m).y)).toEqual([0, 0.5]);
  });
  it('one node per copy with its matrix, receivers unlit with their values', () => {
    const drawn: Drawn[] = [
      { name: '/World/Shade', geometry: quad(), matrices: [new Matrix4(), new Matrix4().makeTranslation(5, 0, 0)], material: null },
      { name: '/World/Roof', geometry: quad(), matrices: [new Matrix4()], material: null, result: { perFace: true, rgb: new Float32Array(6), values: [{ name: 'a', data: [1, 2] }] } },
    ];
    const scene = gltfScene(drawn);
    const meshes = scene.children.filter((c): c is Mesh => (c as Mesh).isMesh);
    expect(meshes.map((m) => m.name)).toEqual(['/World/Shade 1', '/World/Shade 2', '/World/Roof']);
    expect(meshes[1].matrixAutoUpdate).toBe(false);
    expect(meshes[1].matrix.elements[12]).toBe(5);
    expect((meshes[2].material as MeshBasicMaterial).isMeshBasicMaterial).toBe(true);
    expect(meshes[2].geometry.attributes._daylight_a).toBeDefined();
    expect(scene.children).toHaveLength(3); // meshes only: saved views never go into a file
  });
});

describe('objText', () => {
  it('numbers vertices and normals apart across meshes, colours after the coordinates', () => {
    const drawn: Drawn[] = [
      { name: 'A mesh', geometry: quad(), matrices: [new Matrix4()], material: null, result: { perFace: false, rgb: new Float32Array(12).fill(1), values: [] } },
      { name: 'B', geometry: new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)), matrices: [new Matrix4().makeScale(2, 2, 2)], material: new MeshBasicMaterial({ color: 0xff0000 }) },
    ];
    const text = objText(drawn).join(''), lines = text.split('\n');
    expect(lines).toContain('o A_mesh');
    expect(lines.filter((l) => l.startsWith('v ')).map((l) => l.split(' ').length - 1)).toEqual([6, 6, 6, 6, 6, 6, 6]);
    expect(lines).toContain('v 1 1 0 1 1 1');
    expect(lines).toContain('v 2 0 0 1 0 0'); // B scaled, its material colour
    expect(lines.filter((l) => l.startsWith('vn '))).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('f '))).toEqual(['f 1//1 2//2 3//3', 'f 1//1 3//3 4//4', 'f 5 6 7']);
  });
});
