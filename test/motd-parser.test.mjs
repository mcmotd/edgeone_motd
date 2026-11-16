import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMotdToHtml } from '../front/src/utils/motd-parser.js';

function spans(html) {
    return [...html.matchAll(/<span\b([^>]*)>([^<]*)<\/span>/g)]
        .map(([, attributes, text]) => ({ attributes, text }));
}

function textSpan(html, text) {
    const span = spans(html).find(span => span.text === text);
    assert.ok(span, `Expected visible text: ${text}`);
    return span;
}

function assertColor(span, color) {
    assert.ok(span.attributes.includes(`color: ${color};`), `Expected color ${color}`);
    assert.equal((span.attributes.match(/color:/g) || []).length, 1);
}

function visibleText(html) {
    return html.replace(/<\/?span\b[^>]*>/g, '').replace(/<br>/g, '\n');
}

test('Bedrock uses the documented base and extended color palette', () => {
    const colors = {
        '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
        '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#C5C5C5',
        '8': '#545454', '9': '#447FFF', a: '#54FF54', b: '#54FFFF',
        c: '#FF5454', d: '#FF54FF', e: '#FFFF54', f: '#FFFFFF',
        g: '#EFCE16', h: '#D9CCB8', i: '#A9B4B7', j: '#8F727D',
        m: '#EE222C', n: '#C87363', p: '#FFBF1E', q: '#13A045',
        s: '#5FECFF', t: '#577BFF', u: '#B66CDD', v: '#FF6A00', w: '#8BB3FF',
    };
    for (const [code, color] of Object.entries(colors)) {
        const html = parseMotdToHtml(`§${code}Color`, 'Bedrock');
        assertColor(textSpan(html, 'Color'), color);
    }
});

test('one-argument calls retain the Java palette', () => {
    const colors = {
        '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
        '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
        '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF',
        c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
    };
    for (const [code, color] of Object.entries(colors)) {
        const motd = `§${code}Color`;
        assertColor(textSpan(parseMotdToHtml(motd), 'Color'), color);
        assert.equal(parseMotdToHtml(motd), parseMotdToHtml(motd, 'Java'));
    }
});

test('Bedrock color changes retain bold and italic while replacing the previous color', () => {
    const html = parseMotdToHtml('§l§oFirst§gSecond§hThird§rReset', 'Bedrock');
    for (const [text, color] of [['Second', '#EFCE16'], ['Third', '#D9CCB8']]) {
        const span = textSpan(html, text);
        assertColor(span, color);
        assert.match(span.attributes, /font-weight: bold;/);
        assert.match(span.attributes, /font-style: italic;/);
    }
    assert.doesNotMatch(textSpan(html, 'Reset').attributes, /color:|font-weight:|font-style:/);
});

test('Bedrock color changes retain obfuscation and reset removes it', () => {
    const html = parseMotdToHtml('§kA§gB§hC§rVisible', 'Bedrock');
    const obfuscated = spans(html).filter(span => /class="obfuscated"/.test(span.attributes));
    assert.equal(obfuscated.length, 3);
    assert.ok(obfuscated.every(span => span.text === ''));
    assertColor(obfuscated[1], '#EFCE16');
    assertColor(obfuscated[2], '#D9CCB8');
    assert.doesNotMatch(textSpan(html, 'Visible').attributes, /obfuscated|color:/);
});

test('m and n are Bedrock colors but Java decorations, including uppercase codes', () => {
    const motd = '§MCrimson§NCopper';
    const bedrock = parseMotdToHtml(motd, 'Bedrock');
    assertColor(textSpan(bedrock, 'Crimson'), '#EE222C');
    assertColor(textSpan(bedrock, 'Copper'), '#C87363');
    assert.doesNotMatch(bedrock, /text-decoration:/);

    const java = parseMotdToHtml(motd);
    assert.match(textSpan(java, 'Crimson').attributes, /text-decoration: line-through;/);
    assert.match(textSpan(java, 'Copper').attributes, /text-decoration: underline;/);
    assert.doesNotMatch(java, /color:/);
});

test('Java color changes clear decorations and obfuscation', () => {
    const html = parseMotdToHtml('§k§l§o§m§nHidden§aVisible');
    const span = textSpan(html, 'Visible');
    assertColor(span, '#55FF55');
    assert.doesNotMatch(span.attributes, /obfuscated|font-weight:|font-style:|text-decoration:/);
});

test('newlines render both MOTD lines and obfuscation preserves whitespace', () => {
    for (const serverType of ['Java', 'Bedrock']) {
        assert.equal(visibleText(parseMotdToHtml('First\nSecond', serverType)), 'First\nSecond');
        const html = parseMotdToHtml('§kA \t\nB§rVisible', serverType);
        assert.equal(spans(html).filter(span => /obfuscated/.test(span.attributes)).length, 2);
        assert.ok(html.includes(' \t<br>'));
        assert.equal(visibleText(html), ' \t\nVisible');
    }
});

test('unknown and dangling codes preserve ordinary text, whitespace, and HTML escaping', () => {
    const motd = '  Head§zTail§\nNext§§? &<script>\t§';
    const escaped = '  Head§zTail§\nNext§§? &amp;&lt;script&gt;\t§';
    for (const serverType of ['Java', 'Bedrock']) {
        const html = parseMotdToHtml(motd, serverType);
        assert.equal(visibleText(html), escaped);
        assert.doesNotMatch(html, /<script>/);
    }
    assert.equal(visibleText(parseMotdToHtml('§gGold')), '§gGold');
});

test('hostile text remains escaped after recognized Bedrock formatting codes', () => {
    const html = parseMotdToHtml('§g<img src=x onerror=alert(1)> & <tag>', 'Bedrock');
    assert.equal(visibleText(html), '&lt;img src=x onerror=alert(1)&gt; &amp; &lt;tag&gt;');
    assert.doesNotMatch(html, /<img|<tag/);
});

test('JSON components retain existing Java colors and styling regardless of the added argument', () => {
    const component = {
        text: '§aPrimary',
        color: 'gold',
        bold: true,
        extra: [{ text: '<extra>', color: 'red', italic: true }],
    };
    const html = parseMotdToHtml(component);
    assert.match(html, /color: #55FF55;/);
    assert.match(html, /color: #FFAA00;/);
    assert.match(html, /color: #FF5555;/);
    assert.match(html, /font-weight: bold;/);
    assert.match(html, /font-style: italic;/);
    assert.match(html, /&lt;extra&gt;/);
    assert.equal(parseMotdToHtml(component, 'Java'), html);
    assert.equal(parseMotdToHtml(component, 'Bedrock'), html);
});

test('empty MOTDs remain empty without placeholders', () => {
    for (const value of ['', null, undefined]) {
        assert.equal(parseMotdToHtml(value, 'Bedrock'), '');
    }
});
