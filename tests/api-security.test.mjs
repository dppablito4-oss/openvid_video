import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadSource } from './source-loader.mjs';

test('cron rejects absent, blank and incorrect secrets before accessing privileged services', async () => {
    for (const secret of [undefined, '', '  ', 'configured-secret']) {
        let accessed = false;
        const route = loadSource('app/api/cron/send-daily-emails/route.ts', {
            globals: { process: { env: { CRON_SECRET: secret } } },
            mocks: {
                '@/utils/supabase/admin': { createAdminClient() { accessed = true; throw Error('Unexpected privileged call'); } },
                '@/utils/resend/client': {},
                '@/components/emails/DailyTipEmail': {},
            },
        });
        for (const header of ['Bearer undefined', 'Bearer', 'Bearer wrong']) {
            const response = await route.POST(new Request('http://localhost/api/cron/send-daily-emails', { method: 'POST', headers: { authorization: header } }));
            assert.equal(response.status, 401);
            assert.equal(accessed, false);
        }
    }
});

test('valid cron secret reaches its authorized data query', async () => {
    const sentinel = Error('Authorized query boundary');
    const route = loadSource('app/api/cron/send-daily-emails/route.ts', {
        globals: { process: { env: { CRON_SECRET: 'configured-secret' } } },
        mocks: {
            '@/utils/supabase/admin': { createAdminClient() { throw sentinel; } },
            '@/utils/resend/client': {}, '@/components/emails/DailyTipEmail': {},
        },
    });
    await assert.rejects(route.POST(new Request('http://localhost/api/cron/send-daily-emails', { method: 'POST', headers: { authorization: 'Bearer configured-secret' } })), error => error === sentinel);
});

test('image export rejects disguised SVGs and inherited format names, and converts canvas PNGs', async () => {
    const route = loadSource('app/api/export-image/route.ts');
    async function convert(bytes, format, type = 'image/png') {
        const body = new FormData();
        body.append('image', new Blob([bytes], { type }), 'canvas.png');
        body.append('format', format);
        return route.POST(new Request('http://localhost/api/export-image', { method: 'POST', body }));
    }
    assert.equal((await convert('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'avif')).status, 400);
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff000080' } }).png().toBuffer();
    assert.equal((await convert(png, '__proto__')).status, 400);
    const response = await convert(png, 'webp');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const result = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(result.width, 2);
    assert.equal(result.hasAlpha, true);
});
