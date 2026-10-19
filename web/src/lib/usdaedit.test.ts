import { describe, expect, it } from 'vitest';
import { items, rewrite } from './usdaedit';

// As Sdf writes a flattened stage (the viewer core's exportLayer '' 'flat'), plus the awkward cases.
const LAYER = `#usda 1.0
(
    defaultPrim = "World"
    doc = """A doc with { braces ( and "quotes"
    over lines"""
)

def Xform "World" (
    kind = "assembly"
)
{
    def Mesh "Box" (
        apiSchemas = ["MaterialBindingAPI"]
        doc = "a } in a string"
    )
    {
        int[] faceVertexCounts = [4]
        rel material:binding = </World/Looks/M>
        rel proxyPrim = [
            </World/A>,
            </World/B>,
        ]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "faceVarying"
        )
        float xformOp:rotateY.timeSamples = {
            1: 0,
            48: 360,
        }
        asset info:file = @./tex{1}.png@
        token outputs:surface.connect = </World/Looks/M/S.outputs:surface>

        def GeomSubset "Top" (
            apiSchemas = ["MaterialBindingAPI"]
        )
        {
            int[] indices = [1]
        }

        variantSet "shape" = {
            "cube" {
                def Cube "Geom"
                {
                }
            }
        }
    }

    over "Empty"
    {
    }
}
`;

describe('items', () => {
  it('splits a layer into its top-level statements', () => {
    expect(items(LAYER, 0, LAYER.length).map((it) => [it.kind, it.name])).toEqual([['other', ''], ['prim', 'World']]); // the header line and its metadata: one item
  });
  it('splits a prim body: properties (multi-line too), child prims, variant sets', () => {
    const world = items(LAYER, 0, LAYER.length)[1], box = items(LAYER, world.body![0] + 1, world.body![1])[0];
    expect([box.kind, box.spec, box.type, box.name]).toEqual(['prim', 'def', 'Mesh', 'Box']);
    expect(LAYER.slice(box.meta![0], box.meta![1] + 1)).toContain('a } in a string');
    const body = items(LAYER, box.body![0] + 1, box.body![1]);
    expect(body.map((it) => `${it.kind}:${it.name}`)).toEqual([
      'property:faceVertexCounts', 'property:material:binding', 'property:proxyPrim', 'property:primvars:st',
      'property:xformOp:rotateY', 'property:info:file', 'property:outputs:surface', 'prim:Top', 'variantSet:shape',
    ]);
    expect(LAYER.slice(body[3].start, body[3].end)).toMatch(/^texCoord2f\[\] primvars:st = .*\n {12}interpolation = "faceVarying"\n {8}\)$/);
    expect(body[7].type).toBe('GeomSubset');
  });
});

describe('rewrite', () => {
  it('replaces the edited prims and keeps every other byte', () => {
    const out = rewrite(LAYER, new Map([['/World/Box', (p) => `${p.spec} ${p.type} "${p.name}" (${p.meta.trim().split('\n').length} meta lines, ${p.items.length} items at '${p.indent}')\n${p.indent}{\n${p.indent}}`]]));
    const box = LAYER.indexOf('def Mesh "Box"'), after = LAYER.indexOf('\n\n    over "Empty"');
    expect(out).toBe(`${LAYER.slice(0, box)}def Mesh "Box" (2 meta lines, 9 items at '    ')\n    {\n    }${LAYER.slice(after)}`);
  });
  it('edits nested prims first and leaves the text alone when nothing matches', () => {
    const seen: string[] = [];
    const out = rewrite(LAYER, new Map([
      ['/World', (p) => { seen.push(`World sees ${p.items.find((x) => x.item.kind === 'prim')!.text.split('\n')[0]}`); return 'def "World"\n{\n}'; }],
      ['/World/Box', () => { seen.push('Box'); return 'def "Box2"\n    {\n    }'; }],
    ]));
    expect(seen).toEqual(['Box', 'World sees def "Box2"']);
    expect(out.endsWith('def "World"\n{\n}\n')).toBe(true);
    expect(rewrite(LAYER, new Map([['/Nope', () => 'x']]))).toBe(LAYER);
  });
});
