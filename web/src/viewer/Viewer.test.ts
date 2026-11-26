import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { tintGeometry } from './Viewer';

describe('tintGeometry', () => {
  const mesh = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 2, 1, 3]), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };

  it("draws a painted mesh's tint from the mesh's arrays in attributes of its own", () => {
    const g = mesh(), tint = tintGeometry(g);
    // three frees GPU buffers per attribute object: shared ones would go with the tint
    expect(tint.attributes.position).not.toBe(g.attributes.position);
    expect(tint.index).not.toBe(g.index);
    expect(tint.attributes.position.array).toBe(g.attributes.position.array);
    expect(tint.attributes.position.itemSize).toBe(3);
    expect(tint.index!.array).toBe(g.index!.array);
    expect(tint.boundingSphere).toBe(g.boundingSphere);
    expect(tint.boundingBox).toBe(g.boundingBox);
    expect(Object.keys(tint.attributes)).toEqual(['position']);
  });

  it("leaves the mesh's geometry undisposed when the tint goes", () => {
    const g = mesh(), tint = tintGeometry(g);
    let disposed = 0;
    g.addEventListener('dispose', () => disposed++);
    tint.dispose();
    expect(disposed).toBe(0);
    expect(g.attributes.position.array.length).toBe(12);
  });

  it('keeps a mesh without an index unindexed', () => {
    const g = mesh();
    g.setIndex(null);
    expect(tintGeometry(g).index).toBeNull();
  });
});
