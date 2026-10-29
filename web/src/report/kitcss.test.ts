import { describe, expect, it } from 'vitest';
import { KIT_CSS } from './kitcss';

describe('the report stylesheet', () => {
  it('is kit-ui with its tokens and the seven fonts inline: no @import, no relative url(', () => {
    expect(KIT_CSS).not.toMatch(/@import/);
    expect(KIT_CSS).not.toMatch(/url\((?!"data:)/);
    expect(KIT_CSS.match(/url\("data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}"\)/g)).toHaveLength(7);
    expect(KIT_CSS).toContain('--chart-cat-1');
    expect(KIT_CSS).toContain('@page report');
  });
});
