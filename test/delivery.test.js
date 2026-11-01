const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve(__dirname, process.env.MAILGUN_TEST_ENTRYPOINT || '../index.js');
const certificate = path.join(__dirname, 'fixtures', 'localhost-cert.pem');
const credentials = {
    cert: fs.readFileSync(certificate),
    key: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-key.pem'))
};
const apiKey = 'local-test-api-key';
const authorization = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
const queued = 'Queued. Thank you.';

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => {
        for (const socket of sockets) {
            socket.destroy();
        }
        server.close(resolve);
    }));
    return server.address().port;
}

async function createService(t, { status = 200, reply = { id: '<local-message-id>', message: queued }, headers = {} } = {}) {
    const requests = [];
    const errors = [];
    const server = https.createServer(credentials, async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }
            const form = await new Response(Buffer.concat(chunks), { headers: request.headers }).formData();
            requests.push({
                method: request.method,
                path: request.url,
                host: request.headers.host,
                authorization: request.headers.authorization,
                fields: Object.fromEntries(form)
            });
            response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            response.end(JSON.stringify(reply));
        } catch (error) {
            errors.push(error.message);
            response.writeHead(500);
            response.end(JSON.stringify({ message: 'Local test server could not decode the request.' }));
        }
    });
    const port = await listen(t, server);
    return { port, url: `https://127.0.0.1:${port}`, requests, errors };
}

async function createProxy(t, service, { deny = false } = {}) {
    const connections = [];
    const upstreamSockets = new Set();
    const server = http.createServer();
    server.on('connect', (request, socket, head) => {
        connections.push({ target: request.url, authorization: request.headers.authorization, proxyAuthorization: request.headers['proxy-authorization'] });
        if (deny) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        // Every tunnel goes to loopback, regardless of the requested hostname.
        const upstream = net.connect(service.port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
                upstream.write(head);
            }
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        upstreamSockets.add(upstream);
        upstream.on('close', () => upstreamSockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
    });
    const port = await listen(t, server);
    t.after(() => {
        for (const socket of upstreamSockets) {
            socket.destroy();
        }
    });
    return { url: `http://127.0.0.1:${port}`, connections };
}

async function execute(t, inputs) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgun-delivery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const outputPath = path.join(directory, 'output');
    fs.writeFileSync(outputPath, '');
    const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        'INPUT_API-KEY': apiKey,
        INPUT_DOMAIN: 'mg.example.com',
        INPUT_TO: 'recipient@example.com',
        GITHUB_ACTOR: 'octocat',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/repository',
        GITHUB_OUTPUT: outputPath,
        NODE_EXTRA_CA_CERTS: certificate,
        ...inputs
    };
    let result;
    try {
        result = { ...await execFileAsync(process.execPath, [entrypoint], { env, encoding: 'utf8', timeout: 6000 }), status: 0 };
    } catch (error) {
        assert.equal(typeof error.code, 'number', error.message);
        result = { stdout: error.stdout, stderr: error.stderr, status: error.code };
    }
    return { ...result, output: fs.readFileSync(outputPath, 'utf8') };
}

function expectSuccess(result) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const output = result.output.match(/^response<<(mailgun_[\w-]+)\n([\s\S]*)\n\1\n$/);
    assert.ok(output, result.output);
    return output[2];
}

for (const [name, inputs, host] of [
    ['default US', {}, 'api.mailgun.net'],
    ['EU input', { 'INPUT_EU-REGION': 'true' }, 'api.eu.mailgun.net'],
    ['legacy underscore inputs', { 'INPUT_API-KEY': undefined, INPUT_API_KEY: apiKey, INPUT_EU_REGION: 'true' }, 'api.eu.mailgun.net'],
    ['EU environment setting', { MAILGUN_EU_REGION: 'true' }, 'api.eu.mailgun.net']
]) {
    test(`standalone action sends the default email through the ${name} endpoint over HTTPS`, async t => {
        const service = await createService(t);
        const proxy = await createProxy(t, service);
        const result = await execute(t, { HTTPS_PROXY: proxy.url, ...inputs });
        assert.equal(expectSuccess(result), queued);
        assert.deepEqual(service.errors, []);
        assert.deepEqual(service.requests, [{
            method: 'POST',
            path: '/v3/mg.example.com/messages',
            host,
            authorization,
            fields: {
                from: 'hello@mg.example.com',
                to: 'recipient@example.com',
                subject: '@octocat (push) at owner/repository',
                html: '@octocat (push) at owner/repository'
            }
        }]);
        assert.equal(proxy.connections.length, 1);
        assert.equal(proxy.connections[0].target, `${host}:443`);
        assert.equal(proxy.connections[0].authorization, undefined);
    });
}

test('standalone action preserves display names, multiple recipients, CC, Unicode, HTML and multiline event content', async t => {
    const service = await createService(t);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgun-event-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ action: 'created', comment: { body: '<b>Hello</b> & नमस्ते 📧\nSecond line' } }));
    const result = await execute(t, {
        'INPUT_API-BASE-URL': service.url,
        INPUT_FROM: '"Sender, Team" <sender@example.com>',
        INPUT_TO: '"Doe, Jane" <jane@example.com>, bob@example.com',
        INPUT_CC: 'copy1@example.com, "Copy, Team" <copy2@example.com>',
        INPUT_SUBJECT: 'नमस्ते 📧 {{ EVENT_PAYLOAD.action }} by {{ GITHUB_ACTOR }}',
        INPUT_BODY: '<h1>Notification</h1>\n<p>{{ EVENT_PAYLOAD.comment.body }}</p>',
        GITHUB_EVENT_PATH: eventPath
    });
    assert.equal(expectSuccess(result), queued);
    assert.equal(service.requests.length, 1);
    assert.deepEqual(service.requests[0].fields, {
        from: '"Sender, Team" <sender@example.com>',
        to: '"Doe, Jane" <jane@example.com>, bob@example.com',
        cc: 'copy1@example.com, "Copy, Team" <copy2@example.com>',
        subject: 'नमस्ते 📧 created by octocat',
        html: '<h1>Notification</h1>\r\n<p>&lt;b&gt;Hello&lt;/b&gt; &amp; नमस्ते 📧\r\nSecond line</p>'
    });
});

test('standalone action uses custom HTTPS path prefixes ahead of EU and environment settings', async t => {
    const service = await createService(t);
    const result = await execute(t, {
        'INPUT_API-BASE-URL': `${service.url}/gateway/`,
        'INPUT_EU-REGION': 'true',
        MAILGUN_API_BASE_URL: 'https://unused.invalid'
    });
    assert.equal(expectSuccess(result), queued);
    assert.equal(service.requests[0].path, '/gateway/v3/mg.example.com/messages');
});

test('standalone action accepts a custom API URL from the environment', async t => {
    const service = await createService(t);
    const result = await execute(t, { MAILGUN_API_BASE_URL: service.url });
    assert.equal(expectSuccess(result), queued);
    assert.equal(service.requests[0].path, '/v3/mg.example.com/messages');
});

test('standalone action sends through an authenticated HTTPS proxy', async t => {
    const service = await createService(t);
    const proxy = await createProxy(t, service);
    const proxyUrl = new URL(proxy.url);
    proxyUrl.username = 'local-proxy-user';
    proxyUrl.password = 'local-proxy-password';
    const result = await execute(t, { https_proxy: proxyUrl.href });
    assert.equal(expectSuccess(result), queued);
    assert.equal(proxy.connections[0].proxyAuthorization, `Basic ${Buffer.from('local-proxy-user:local-proxy-password').toString('base64')}`);
    assert.equal(proxy.connections[0].authorization, undefined);
    assert.equal(service.requests[0].authorization, authorization);
});

test('standalone action respects NO_PROXY for a direct HTTPS connection', async t => {
    const service = await createService(t);
    const proxy = await createProxy(t, service, { deny: true });
    const result = await execute(t, { 'INPUT_API-BASE-URL': service.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1' });
    assert.equal(expectSuccess(result), queued);
    assert.equal(proxy.connections.length, 0);
    assert.equal(service.requests.length, 1);
});

test('standalone action never bypasses a proxy that refuses its tunnel', async t => {
    const service = await createService(t);
    const proxy = await createProxy(t, service, { deny: true });
    const result = await execute(t, { HTTPS_PROXY: proxy.url });
    assert.equal(result.status, 1);
    assert.equal(result.output, '');
    assert.equal(proxy.connections.length, 1);
    assert.equal(service.requests.length, 0);
});

test('standalone action rejects an untrusted TLS certificate before sending API credentials', async t => {
    const service = await createService(t);
    const result = await execute(t, { 'INPUT_API-BASE-URL': service.url, NODE_EXTRA_CA_CERTS: undefined });
    assert.equal(result.status, 1);
    assert.equal(result.output, '');
    assert.equal(service.requests.length, 0);
});

test('standalone action refuses HTTPS redirects without resending an email', async t => {
    const service = await createService(t, { status: 307, headers: { Location: '/unexpected' } });
    const result = await execute(t, { 'INPUT_API-BASE-URL': service.url });
    assert.equal(result.status, 1);
    assert.equal(result.output, '');
    assert.equal(service.requests.length, 1);
    assert.equal(service.requests[0].path, '/v3/mg.example.com/messages');
});

for (const status of [400, 401, 403, 429, 500]) {
    test(`standalone action reports HTTP ${status} as a failed send without retrying`, async t => {
        const service = await createService(t, { status, reply: { message: 'Simulated Mailgun error' } });
        const result = await execute(t, { 'INPUT_API-BASE-URL': service.url });
        assert.equal(result.status, 1);
        assert.match(result.stdout, new RegExp(`::error::.*${status}`));
        assert.equal(result.output, '');
        assert.equal(service.requests.length, 1);
    });
}

test('standalone action preserves multiline API output without introducing extra outputs', async t => {
    const message = 'Queued ✓\nEOF\nunexpected=not-an-output';
    const service = await createService(t, { reply: { id: '<local-message-id>', message } });
    const result = await execute(t, { 'INPUT_API-BASE-URL': service.url });
    assert.equal(expectSuccess(result), message);
});
