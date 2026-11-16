import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { generateAppImage } = require('../backend/services/appImageRenderer');

async function render(motd, type = 'Bedrock') {
  const png = await generateAppImage({
    status: 'online',
    type,
    version: '1.21',
    host: 'example.invalid',
    motd,
    players: { online: 1, max: 10 }
  }, { dark: true, lang: 'en' });
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, pixels: Buffer.from(ctx.getImageData(0, 0, image.width, image.height).data) };
}

function colorBounds(image, palette) {
  const bounds = new Map(Object.values(palette).map(hex => [Number.parseInt(hex.slice(1), 16), null]));
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (image.pixels[offset + 3] !== 255) continue;
    const rgb = (image.pixels[offset] << 16) | (image.pixels[offset + 1] << 8) | image.pixels[offset + 2];
    if (!bounds.has(rgb)) continue;
    const y = Math.floor(offset / 4 / image.width);
    const bound = bounds.get(rgb);
    if (bound) {
      bound.minY = Math.min(bound.minY, y);
      bound.maxY = Math.max(bound.maxY, y);
    } else {
      bounds.set(rgb, { minY: y, maxY: y });
    }
  }
  return hex => bounds.get(Number.parseInt(hex.slice(1), 16));
}

const BEDROCK_PALETTE = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#C5C5C5',
  '8': '#545454', '9': '#447FFF', a: '#54FF54', b: '#54FFFF',
  c: '#FF5454', d: '#FF54FF', e: '#FFFF54', f: '#FFFFFF',
  g: '#EFCE16', h: '#D9CCB8', i: '#A9B4B7', j: '#8F727D',
  m: '#EE222C', n: '#C87363', p: '#FFBF1E', q: '#13A045',
  s: '#5FECFF', t: '#577BFF', u: '#B66CDD', v: '#FF6A00', w: '#8BB3FF'
};

test('app PNG renders the Bedrock palette across both MOTD lines', async () => {
  const codes = Object.keys(BEDROCK_PALETTE);
  const firstLine = codes.slice(0, 14);
  const secondLine = codes.slice(14);
  const text = line => line.map(code => `§${code}█`).join('');
  const actual = await render(`${text(firstLine)}\n${text(secondLine)}`);
  const expected = await render({ extra: [
    ...firstLine.map(code => ({ text: '█', color: BEDROCK_PALETTE[code] })),
    { text: '\n' },
    ...secondLine.map(code => ({ text: '█', color: BEDROCK_PALETTE[code] }))
  ] });
  assert.deepEqual(actual.pixels, expected.pixels);
  const bounds = colorBounds(actual, BEDROCK_PALETTE);
  for (const code of codes) {
    assert.ok(bounds(BEDROCK_PALETTE[code]), `missing visible Bedrock §${code} color`);
  }
  // Grayscale colors also occur in antialiased UI labels outside the MOTD.
  const firstBottom = bounds(BEDROCK_PALETTE.c).maxY;
  const secondTop = bounds(BEDROCK_PALETTE.m).minY;
  assert.ok(firstBottom < secondTop, 'the second MOTD line must render below the first');
});

test('Bedrock color changes retain bold/italic and reset clears every active style', async () => {
  const retained = await render('§l§o§mMMMM');
  assert.deepEqual(retained.pixels, (await render('§m§l§oMMMM')).pixels);
  assert.notDeepEqual(retained.pixels, (await render('§mMMMM')).pixels);
  assert.deepEqual((await render('§l§o§k§m§rMMMM')).pixels, (await render('MMMM')).pixels);
});

test('Bedrock colors replace one another rather than accumulating Java m/n decorations', async () => {
  const actual = await render('§m§nMMMM');
  const expected = await render({ text: 'MMMM', color: BEDROCK_PALETTE.n });
  assert.deepEqual(actual.pixels, expected.pixels);
  const bounds = colorBounds(actual, { m: BEDROCK_PALETTE.m, n: BEDROCK_PALETTE.n });
  assert.equal(bounds(BEDROCK_PALETTE.m), null);
  assert.ok(bounds(BEDROCK_PALETTE.n));
});

test('Bedrock obfuscation survives color changes without swallowing the MOTD newline', async () => {
  const actual = await render('§k§mXXXX\nYYYY');
  const expected = await render({ text: '░▒▓█\n▐░▒▓', color: BEDROCK_PALETTE.m });
  assert.deepEqual(actual.pixels, expected.pixels);
});

test('unknown legacy codes and a trailing section sign remain literal in both editions', async () => {
  for (const type of ['Bedrock', 'Java']) {
    const actual = await render('§zordinary§', type);
    const expected = await render({ text: '§zordinary§' }, type);
    assert.deepEqual(actual.pixels, expected.pixels);
  }
});

test('Java retains its palette and color resets, including inside JSON string components', async () => {
  const java = await render('§l§o§m§n§aMMMM', 'Java');
  assert.deepEqual(java.pixels, (await render({ text: 'MMMM', color: 'green' }, 'Java')).pixels);
  const bounds = colorBounds(java, { java: '#55FF55', bedrock: '#54FF54', m: '#EE222C', n: '#C87363' });
  assert.ok(bounds('#55FF55'));
  assert.equal(bounds('#54FF54'), null);
  assert.equal(bounds('#EE222C'), null);
  assert.equal(bounds('#C87363'), null);
  const json = await render({ extra: ['§l§o§m§n§aMMMM'] });
  assert.deepEqual(json.pixels, (await render({ text: 'MMMM', color: 'green' })).pixels);
});

test('empty Bedrock MOTDs do not fabricate text from the query address', async () => {
  const empty = await render('');
  const expected = await render({ text: '' });
  assert.deepEqual(empty.pixels, expected.pixels);
});
