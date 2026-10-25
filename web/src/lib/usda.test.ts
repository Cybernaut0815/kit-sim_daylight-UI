import { BoxGeometry, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Quaternion, RepeatWrapping, Texture, Vector3, type Material } from 'three';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { toUsda } from './usda';

describe('toUsda', () => {
  const box = new Mesh(new BoxGeometry()), mirror = new Mesh(new BoxGeometry()), part = new Group();
  box.name = mirror.name = '1st floor';
  box.position.set(512345.678, 0, -6543210.25); // survey coordinates: kept as doubles in the transform
  mirror.scale.set(-1, 1, 1);
  const tri = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, NaN, 0], 3))); // unnamed, non-indexed
  part.name = 'Block A';
  part.add(tri);
  const root = new Group();
  root.add(box, mirror, part);
  const { parts, names } = toUsda(root), text = parts.join('');

  it('writes a Y-up metre layer with an Xform or Mesh per node, named as USD identifiers unique per parent', () => {
    expect(text).toMatch(/^#usda 1\.0\n\(\n {4}defaultPrim = "Model"\n {4}metersPerUnit = 1\n {4}upAxis = "Y"\n\)/);
    expect(text.match(/def (Mesh|Xform) "\w+"/g)).toEqual(['def Xform "Model"', 'def Mesh "_1st_floor"', 'def Mesh "_1st_floor_2"', 'def Xform "Block_A"', 'def Mesh "Node"']);
    expect([...names]).toEqual([['/Model/_1st_floor', '1st floor'], ['/Model/_1st_floor_2', '1st floor'], ['/Model/Block_A', 'Block A']]);
  });
  it('keeps local matrices exact (translation in the last row, mirrors negative)', () => {
    expect(text).toContain('matrix4d xformOp:transform = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (512345.678, 0, -6543210.25, 1))');
    expect(text).toContain('matrix4d xformOp:transform = ((-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))');
  });
  it('writes triangles, local points and vertex normals; a NaN becomes 0', () => {
    expect(text.match(/int\[\] faceVertexCounts = \[[^\]]*\]/g)?.map((s) => s.split(',').length)).toEqual([12, 12, 1]);
    expect(text).toContain('int[] faceVertexIndices = [0, 1, 2]\n'); // the non-indexed triangle
    expect(text).toContain('point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 0, 0)]\n');
    expect(text.match(/normal3f\[\] normals = \[[^\]]*\] \(interpolation = "vertex"\)/g)).toHaveLength(2);
    expect(text.match(/uniform token subdivisionScheme = "none"/g)).toHaveLength(3);
  });
  it('writes a GPU-instanced mesh (EXT_mesh_gpu_instancing) as a PointInstancer of its geometry, named by the node', () => {
    const trees = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2), kid = new Mesh(new BoxGeometry());
    trees.name = 'Oak trees';
    kid.name = 'Instances'; // the instancer's own name: the child gets another
    trees.setMatrixAt(1, new Matrix4().compose(new Vector3(10, 0, -5), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(1, 2, 1)));
    trees.add(kid);
    const r = new Group();
    r.add(trees);
    const { parts, names: n } = toUsda(r), t = parts.join('');
    expect(t).toContain('def Xform "Oak_trees"');
    expect(t).toContain('def PointInstancer "Instances"\n{\n    rel prototypes = [</Model/Oak_trees/Instances/Mesh>]\n    int[] protoIndices = [0, 0]\n');
    const nums = (decl: string) => (new RegExp(`${decl} = \\[(.*)\\]\\n`).exec(t)?.[1] ?? '').replace(/[()]/g, '').split(', ').map(Number);
    const near = (got: number[], want: number[]) => { expect(got).toHaveLength(want.length); want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 6)); };
    near(nums('point3f\\[\\] positions'), [0, 0, 0, 10, 0, -5]);
    near(nums('quath\\[\\] orientations'), [1, 0, 0, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0]); // (w, x, y, z)
    near(nums('float3\\[\\] scales'), [1, 1, 1, 1, 2, 1]);
    expect(t).toContain('def Mesh "Mesh"');
    expect(t).toContain('def Mesh "Instances_2"'); // the child, beside the instancer
    expect(n.get('/Model/Oak_trees/Instances')).toBe('Oak trees');
    expect(n.get('/Model/Oak_trees/Instances/Mesh')).toBe('Oak trees');
  });
});

describe('toUsda: the look', () => {
  /** A triangle with UVs (0,0), (1,0), (0,1): enough to see the st flip and the texture transform. */
  const triangle = () => new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    .setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  const image = (n: number) => ({ width: n, height: n }); // stands in for an ImageBitmap
  const layer = (...meshes: Mesh[]) => { const r = new Group(); r.add(...meshes); const u = toUsda(r); return { ...u, text: u.parts.join('') }; };
  const look = (m: Material) => layer(new Mesh(triangle(), m)).text;
  /** OffscreenCanvas stand-in: getImageData returns the image drawn, which rgba() makes like ImageData. */
  class Canvas {
    getContext() {
      let drawn: unknown;
      return { drawImage: (img: unknown) => { drawn = img; }, getImageData: () => drawn };
    }
  }
  const rgba = (...alpha: number[]) => ({ width: alpha.length, height: 1, data: Uint8ClampedArray.from(alpha.flatMap((a) => [128, 128, 128, a])) });

  it('writes a glTF material as a UsdPreviewSurface with its textures, the factors as their scale, st flipped and transformed', () => {
    const base = new Texture(image(4)), normal = new Texture(image(2));
    base.name = 'Brick diffuse';
    base.flipY = normal.flipY = false; // glTF
    base.wrapS = base.wrapT = RepeatWrapping;
    base.repeat.set(2, 1); // KHR_texture_transform
    const m = new MeshStandardMaterial({ name: 'Brick', color: 0x808080, metalness: 0.25, roughness: 0.75, map: base, normalMap: normal, side: DoubleSide, transparent: true, opacity: 0.5 });
    const mesh = new Mesh(triangle(), m);
    mesh.name = 'Wall';
    const { text, textures } = layer(mesh);
    expect(textures.map(([p, t]) => [p, t === base || t === normal])).toEqual([['textures/Brick_diffuse.png', true], ['textures/texture.png', true]]);
    expect(text).toContain('def Mesh "Wall" (\n    prepend apiSchemas = ["MaterialBindingAPI"]\n)');
    expect(text).toContain('rel material:binding = </Model/Materials/Brick>');
    expect(text).toContain('uniform bool doubleSided = 1');
    expect(text).toContain('texCoord2f[] primvars:st = [(0, 1), (2, 1), (0, 0)] (interpolation = "vertex")'); // u x2, v = 1 - v
    expect(text).toMatch(/def Scope "Materials"\n\{\ndef Material "Brick"\n\{\n {4}token outputs:surface\.connect = <\/Model\/Materials\/Brick\/Surface\.outputs:surface>/);
    const c = 0.21586050; // 0x80 as linear
    expect(text).toContain(`asset inputs:file = @./textures/Brick_diffuse.png@\n    token inputs:sourceColorSpace = "sRGB"\n    float4 inputs:scale = (${c}, ${c}, ${c}, 0.5)`);
    expect(text).toContain('color3f inputs:diffuseColor.connect = </Model/Materials/Brick/BaseColor.outputs:rgb>');
    expect(text).toContain('float inputs:opacity.connect = </Model/Materials/Brick/BaseColor.outputs:a>');
    expect(text).toContain('token inputs:wrapS = "repeat"');
    expect(text).toContain('float inputs:metallic = 0.25');
    expect(text).toContain('float inputs:roughness = 0.75');
    expect(text).toContain('normal3f inputs:normal.connect = </Model/Materials/Brick/Normal.outputs:rgb>');
    expect(text).toContain('float4 inputs:scale = (2, 2, 2, 1)\n    float4 inputs:bias = (-1, -1, -1, 0)');
    expect(text).toContain('string inputs:varname = "st"');
  });
  it('writes an MTL (Phong) material as a dielectric, its texture upright (flipY) and untransformed', () => {
    const map = new Texture(image(2));
    const m = new MeshPhongMaterial({ name: 'Plaster', color: 0xffffff, shininess: 30, map });
    const { text } = layer(new Mesh(triangle(), m));
    expect(text).toContain('texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]');
    expect(text).toContain('float inputs:metallic = 0');
    expect(text).toContain(`float inputs:roughness = ${+Math.sqrt(2 / 32).toPrecision(9)}`);
    expect(text).not.toContain('uniform bool doubleSided');
  });
  it('writes an MTL map_Kd at scale 1 whatever its Kd (3ds Max 0.588, Maya 0); glTF factors (standard, unlit) still multiply', () => {
    const map = new Texture(image(2)), kd = (v: number) => new Color(v, v, v);
    expect(look(new MeshPhongMaterial({ name: 'Max', color: kd(0.588), map }))).toContain('float4 inputs:scale = (1, 1, 1, 1)');
    expect(look(new MeshPhongMaterial({ name: 'Maya', color: kd(0), map }))).toContain('float4 inputs:scale = (1, 1, 1, 1)');
    expect(look(new MeshPhongMaterial({ name: 'Tinted', color: kd(0.588), map, transparent: true, opacity: 0.5 }))).toContain('float4 inputs:scale = (1, 1, 1, 0.5)'); // d stays
    expect(look(new MeshPhongMaterial({ name: 'Plain', color: kd(0.588) }))).toContain('color3f inputs:diffuseColor = (0.588, 0.588, 0.588)'); // no map: Kd is the colour
    expect(look(new MeshStandardMaterial({ name: 'Pbr', color: kd(0.5), map }))).toContain('float4 inputs:scale = (0.5, 0.5, 0.5, 1)');
    expect(look(new MeshBasicMaterial({ name: 'Unlit', color: kd(0.5), map }))).toContain('float4 inputs:scale = (0.5, 0.5, 0.5, 1)'); // KHR_materials_unlit
  });
  it('writes the opacity only when transparent or cut out: a glTF OPAQUE alpha factor stays out', () => {
    const map = new Texture(image(2));
    expect(look(new MeshStandardMaterial({ name: 'Opaque', opacity: 0.5 }))).not.toContain('inputs:opacity');
    const textured = look(new MeshStandardMaterial({ name: 'Opaque', opacity: 0.5, map }));
    expect(textured).toContain('float4 inputs:scale = (1, 1, 1, 1)');
    expect(textured).not.toContain('inputs:opacity');
    expect(look(new MeshStandardMaterial({ name: 'Blend', opacity: 0.5, transparent: true }))).toContain('float inputs:opacity = 0.5\n');
    expect(look(new MeshStandardMaterial({ name: 'Mask', opacity: 0.3, alphaTest: 0.5 }))).toContain('float inputs:opacity = 0.3\n    float inputs:opacityThreshold = 0.5\n');
  });
  it('writes an MTL map_d as an opacity texture times d: its alpha where that varies (a cut-out PNG), else its grey levels', () => {
    vi.stubGlobal('OffscreenCanvas', Canvas);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const grey = new Texture(rgba(255, 255)), cut = new Texture(rgba(0, 255)), map = new Texture(image(2));
    grey.name = 'Leaf mask';
    const g = look(new MeshPhongMaterial({ name: 'Leaves', alphaMap: grey, transparent: true, opacity: 0.8 })); // MTLLoader: map_d sets transparent, d the opacity
    expect(g).toContain('asset inputs:file = @./textures/Leaf_mask.png@\n    token inputs:sourceColorSpace = "raw"\n    float4 inputs:scale = (0.8, 0.8, 0.8, 0.8)');
    expect(g).toContain('float inputs:opacity.connect = </Model/Materials/Leaves/Opacity.outputs:r>');
    expect(g).toContain('texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]'); // the mask alone reads st
    const c = look(new MeshPhongMaterial({ name: 'Leaves', map, alphaMap: cut, transparent: true }));
    expect(c).toContain('color3f inputs:diffuseColor.connect = </Model/Materials/Leaves/BaseColor.outputs:rgb>');
    expect(c).toContain('float inputs:opacity.connect = </Model/Materials/Leaves/Opacity.outputs:a>');
  });
  it('writes glTF transmission as opacity max(1 - T, 0.2) x alpha: a constant, or a BLEND texture alpha times it; a cut-out stays one', () => {
    const map = new Texture(image(2));
    expect(look(new MeshPhysicalMaterial({ name: 'Clear', transmission: 1 }))).toContain('float inputs:opacity = 0.2\n');
    expect(look(new MeshPhysicalMaterial({ name: 'Metal', transmission: 1, metalness: 1 }))).not.toContain('inputs:opacity'); // glTF: metals pass no light
    const tinted = look(new MeshPhysicalMaterial({ name: 'Tinted', transmission: 0.7, opacity: 0.5, map })); // OPAQUE: its alpha factor stays out
    expect(tinted).toContain('float inputs:opacity = 0.3\n');
    expect(tinted).not.toContain('inputs:opacity.connect');
    expect(look(new MeshPhysicalMaterial({ name: 'Glass', transmission: 0.25, opacity: 0.5, transparent: true }))).toContain('float inputs:opacity = 0.375\n');
    const blend = look(new MeshPhysicalMaterial({ name: 'Blend', transmission: 0.25, opacity: 0.5, transparent: true, map })); // the texture's alpha keeps its cut-outs
    expect(blend).toContain('float4 inputs:scale = (1, 1, 1, 0.375)');
    expect(blend).toContain('float inputs:opacity.connect = </Model/Materials/Blend/BaseColor.outputs:a>\n');
    // glTF MASK: the constant under the threshold would draw nothing, so the texture's alpha cuts it out as before
    expect(look(new MeshPhysicalMaterial({ name: 'Mask', transmission: 1, alphaTest: 0.5, map }))).toContain('float inputs:opacity.connect = </Model/Materials/Mask/BaseColor.outputs:a>\n    float inputs:opacityThreshold = 0.5\n');
  });
  it('binds one material per geometry group (OBJ usemtl) through GeomSubsets', () => {
    const g = new BoxGeometry(); // 6 groups of 2 triangles
    const a = new MeshStandardMaterial({ name: 'A' }), b = new MeshStandardMaterial({ name: 'B' });
    g.groups.forEach((x, i) => { x.materialIndex = i < 3 ? 0 : 1; });
    const box = new Mesh(g, [a, b]);
    box.name = 'Box';
    const { text } = layer(box);
    expect(text.slice(text.indexOf('def Mesh "Box"'), text.indexOf('def GeomSubset'))).not.toContain('rel material:binding'); // none on the mesh itself
    expect(text.match(/def GeomSubset "Subset(_\d)?"/g)).toHaveLength(6);
    expect(text).toContain('def GeomSubset "Subset" (\n    prepend apiSchemas = ["MaterialBindingAPI"]\n)\n{\n    uniform token elementType = "face"\n    uniform token familyName = "materialBind"\n    int[] indices = [0, 1]\n    rel material:binding = </Model/Materials/A>');
    expect(text).toContain('int[] indices = [10, 11]\n    rel material:binding = </Model/Materials/B>');
  });
  it('lets a vertex-coloured material read displayColor (a GLB this app wrote: its receivers keep their colours)', () => {
    const m = new MeshBasicMaterial({ name: 'Daylight result', vertexColors: true });
    const { text } = layer(new Mesh(triangle().setAttribute('color', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3)), m));
    expect(text).toContain('color3f inputs:diffuseColor.connect = </Model/Materials/Daylight_result/Color.outputs:result>');
    expect(text).toContain('uniform token info:id = "UsdPrimvarReader_float3"\n    string inputs:varname = "displayColor"\n    float3 inputs:fallback = (1, 1, 1)');
    expect(text).not.toContain('def Shader "St"');
  });
  it('writes no material for a loader default, vertex colours as displayColor, and no texture for an image that never loaded', () => {
    const fallback = new MeshStandardMaterial();
    fallback.userData.fallback = true;
    const coloured = new Mesh(triangle().setAttribute('color', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3)), fallback);
    const missing = new Mesh(triangle(), new MeshStandardMaterial({ name: 'Lost', map: new Texture() })); // no image
    const { text, textures } = layer(coloured, missing);
    expect(text).toContain('color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0), (0, 0, 1)] (interpolation = "vertex")');
    expect(text.match(/def Material "\w+"/g)).toEqual(['def Material "Lost"']);
    expect(textures).toEqual([]);
    expect(text).not.toContain('UsdUVTexture');
    expect(text).not.toContain('primvars:st');
  });
});
