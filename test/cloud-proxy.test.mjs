import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import express from 'express';
import api from '../cloud-functions/api/[[default]].js';

const require = createRequire(import.meta.url);
const varint = require('varint');
const { configureStorage } = require('../backend/storage');

test('cloud screenshots use the public HTTPS origin instead of the internal gateway host', async t => {
    const previousOrigin = process.env.PUBLIC_ORIGIN;
    process.env.PUBLIC_ORIGIN = 'https://motd.example.test';
    t.after(() => {
        if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
        else process.env.PUBLIC_ORIGIN = previousOrigin;
    });
    const root = await mkdtemp(join(tmpdir(), 'motd-proxy-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    async function getBytes(key) {
        try { return await readFile(join(root, key)); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async function setBytes(key, bytes) {
        await mkdir(dirname(join(root, key)), { recursive: true });
        await writeFile(join(root, key), bytes);
    }
    configureStorage({
        getBytes, setBytes,
        getJSON: async key => { const value = await getBytes(key); return value === null ? null : JSON.parse(value.toString()); },
        setJSON: (key, value) => setBytes(key, JSON.stringify(value)),
        delete: key => rm(join(root, key), { force: true }),
        list: async ({ prefix = '', cursor = '' }) => {
            const keys = (await readdir(root, { recursive: true, withFileTypes: true }))
                .filter(entry => entry.isFile())
                .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/'))
                .filter(key => key.startsWith(prefix) && key > cursor).sort();
            return { keys: keys.slice(0, 100), cursor: keys.length > 100 ? keys[99] : undefined };
        }
    });
    const json = Buffer.from(JSON.stringify({ description: 'Proxy test', version: { name: '1.21', protocol: 767 }, players: { online: 2, max: 10 } }));
    const payload = Buffer.concat([Buffer.from([0]), Buffer.from(varint.encode(json.length)), json]);
    const packet = Buffer.concat([Buffer.from(varint.encode(payload.length)), payload]);
    const minecraft = net.createServer(socket => socket.once('data', () => socket.end(packet)));
    await new Promise(resolve => minecraft.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => minecraft.close(resolve)));
    const app = express();
    app.use('/api', api);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/sync_app_img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://client.example.test' },
        body: JSON.stringify({ host: `127.0.0.1:${minecraft.address().port}`, stype: 'je' })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const result = await response.json();
    assert.equal(result.serverData.status, 'online');
    const screenshotUrl = new URL(result.screenshotUrl);
    assert.equal(screenshotUrl.origin, 'https://motd.example.test');
    const screenshot = await fetch(`${base}${screenshotUrl.pathname}${screenshotUrl.search}`, {
        headers: { Origin: 'https://client.example.test' }
    });
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get('content-type'), 'image/png');
    assert.equal(screenshot.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
