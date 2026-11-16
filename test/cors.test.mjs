import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import api from '../cloud-functions/api/[[default]].js';

test('public APIs allow CORS while administrator APIs stay same-origin', async t => {
    const previousOrigin = process.env.PUBLIC_ORIGIN;
    delete process.env.PUBLIC_ORIGIN;
    t.after(() => {
        if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
        else process.env.PUBLIC_ORIGIN = previousOrigin;
    });
    const app = express();
    app.use('/api', api);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const foreignOrigin = 'https://client.example.test';
    const login = headers => fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}'
    });

    await t.test('JSON preflight permits only GET and POST without credentials', async () => {
        const response = await fetch(`${base}/api/sync_app_img`, {
            method: 'OPTIONS',
            headers: {
                Origin: foreignOrigin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type,authorization'
            }
        });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.equal(response.headers.get('access-control-allow-methods'), 'GET,POST');
        assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type,Authorization');
        assert.equal(response.headers.get('access-control-max-age'), '86400');
        assert.equal(response.headers.get('access-control-allow-credentials'), null);
    });

    await t.test('public validation errors remain readable cross-origin', async () => {
        const response = await fetch(`${base}/api/status`, { headers: { Origin: foreignOrigin } });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.equal((await response.json()).status, 'error');
    });

    await t.test('administrator requests and preflights are rejected, including case and trailing slash variants', async () => {
        for (const [path, method] of [['/AdMiN/stats/', 'GET'], ['/LOGIN/', 'POST'], ['/update', 'POST']]) {
            for (const preflight of [false, true]) {
                const response = await fetch(`${base}/api${path}`, {
                    method: preflight ? 'OPTIONS' : method,
                    headers: preflight
                        ? { Origin: foreignOrigin, 'Access-Control-Request-Method': method }
                        : { Origin: foreignOrigin, 'Content-Type': 'application/json' },
                    ...(!preflight && method === 'POST' ? { body: '{}' } : {})
                });
                assert.equal(response.status, 403, `${path}: ${preflight ? 'OPTIONS' : method}`);
                assert.equal(response.headers.get('access-control-allow-origin'), null);
                assert.equal(response.headers.get('access-control-allow-methods'), null);
                assert.equal((await response.json()).status, 'error');
            }
        }
        const opaque = await login({ Origin: 'null' });
        assert.equal(opaque.status, 403);
        assert.equal(opaque.headers.get('access-control-allow-origin'), null);
        await opaque.json();
    });

    await t.test('same-origin and Origin-less login requests still reach the login handler', async () => {
        for (const headers of [{ Origin: base }, {}]) {
            const response = await login(headers);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('access-control-allow-origin'), null);
            assert.equal((await response.json()).code, 400);
        }
    });

    await t.test('cloud same-origin checks use the public origin, not the internal gateway', async () => {
        const publicOrigin = 'https://motd.example.test';
        process.env.PUBLIC_ORIGIN = publicOrigin;
        const configured = await login({ Origin: publicOrigin });
        assert.equal(configured.status, 200);
        assert.equal(configured.headers.get('access-control-allow-origin'), null);
        assert.equal((await configured.json()).code, 400);
        delete process.env.PUBLIC_ORIGIN;

        const forwarded = await login({ Origin: publicOrigin, 'eo-pages-host': 'motd.example.test' });
        assert.equal(forwarded.status, 200);
        assert.equal(forwarded.headers.get('access-control-allow-origin'), null);
        assert.equal((await forwarded.json()).code, 400);
        const foreign = await login({ Origin: foreignOrigin, 'eo-pages-host': 'motd.example.test' });
        assert.equal(foreign.status, 403);
        assert.equal(foreign.headers.get('access-control-allow-origin'), null);
        await foreign.json();
    });
});
