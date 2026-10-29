// kit-ui's stylesheet as a report page carries it: tokens.css in place of its @import and every font as a data: URI, so
// the page prints from file:// with nothing to fetch.
import css from 'kit-ui/css/kit-ui.css?raw';
import tokens from 'kit-ui/css/tokens.css?raw';
import geistLatin from 'kit-ui/css/fonts/geist-latin.woff2?inline';
import geistLatinExt from 'kit-ui/css/fonts/geist-latin-ext.woff2?inline';
import geistMono from 'kit-ui/css/fonts/geist-mono-latin.woff2?inline';
import spaceMono from 'kit-ui/css/fonts/space-mono-700-latin.woff2?inline';
import spaceMonoExt from 'kit-ui/css/fonts/space-mono-700-latin-ext.woff2?inline';
import tekturLatin from 'kit-ui/css/fonts/tektur-latin.woff2?inline';
import tekturLatinExt from 'kit-ui/css/fonts/tektur-latin-ext.woff2?inline';

const FONTS: Record<string, string> = {
  'geist-latin.woff2': geistLatin, 'geist-latin-ext.woff2': geistLatinExt, 'geist-mono-latin.woff2': geistMono, 'space-mono-700-latin.woff2': spaceMono,
  'space-mono-700-latin-ext.woff2': spaceMonoExt, 'tektur-latin.woff2': tekturLatin, 'tektur-latin-ext.woff2': tekturLatinExt,
};

export const KIT_CSS = css
  .replace(/@import\s+["']tokens\.css["'];/, () => tokens)
  .replace(/url\(["']?\.\/fonts\/([\w.-]+)["']?\)/g, (all, f: string) => (FONTS[f] ? `url("${FONTS[f]}")` : all));
