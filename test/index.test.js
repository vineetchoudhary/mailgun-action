const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const entrypoint = process.env.MAILGUN_TEST_ENTRYPOINT || '../index.js';
const action = require(entrypoint);

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgun-action-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function prepareRun(t, inputs = {}) {
    const directory = temporaryDirectory(t);
    const env = {
        'INPUT_API-KEY': 'test-mailgun-key',
        INPUT_DOMAIN: 'example.com',
        INPUT_TO: 'recipient@example.com',
        GITHUB_ACTOR: 'octocat',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/repository',
        GITHUB_OUTPUT: path.join(directory, 'output'),
        ...inputs
    };
    fs.writeFileSync(env.GITHUB_OUTPUT, '');
    const logs = [];
    const write = chunk => {
        logs.push(String(chunk));
        return true;
    };
    const previousExitCode = process.exitCode;
    t.after(() => { process.exitCode = previousExitCode; });
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url: String(url), options });
        return Response.json({ id: '<message@example.com>', message: 'Queued. Thank you.' });
    };
    return { env, logs, requests, fetchImpl, write, directory, output: () => fs.readFileSync(env.GITHUB_OUTPUT, 'utf8') };
}

async function listen(t, server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('reads GitHub input names before the legacy underscore aliases', () => {
    assert.equal(action.getInput('api-key', { 'INPUT_API-KEY': ' canonical ', INPUT_API_KEY: 'legacy' }), 'canonical');
    assert.equal(action.getInput('api-key', { INPUT_API_KEY: ' legacy ' }), 'legacy');
    assert.equal(action.getInput('api-key', { 'INPUT_API-KEY': '', INPUT_API_KEY: 'legacy' }), '');
    assert.equal(action.getInput('missing', {}), '');
});

test('interpolates environment variables, event paths, array indices and quoted keys', () => {
    const context = { GITHUB_ACTOR: 'octocat', EVENT_PAYLOAD: { commits: [{ message: 'Fix' }], 'custom-key': 42 } };
    assert.equal(action.interpolateTemplate('{{ GITHUB_ACTOR }}: {{ EVENT_PAYLOAD.commits[0].message }}', context), 'octocat: Fix');
    assert.equal(action.interpolateTemplate('{{ EVENT_PAYLOAD["custom-key"] }} {{ EVENT_PAYLOAD[ \'custom-key\' ] }}', context), '42 42');
});

test('missing and null template data becomes empty text while false and zero are preserved', () => {
    const context = { EVENT_PAYLOAD: { nil: null, enabled: false, count: 0 } };
    assert.equal(action.interpolateTemplate('{{ MISSING }}{{ EVENT_PAYLOAD.missing.value }}{{ EVENT_PAYLOAD.nil }}', context), '');
    assert.equal(action.interpolateTemplate('{{ EVENT_PAYLOAD.enabled }} {{ EVENT_PAYLOAD.count }}', context), 'false 0');
});

test('templates reject executable expressions and never evaluate Lodash script delimiters', () => {
    for (const expression of ['process.exit(1)', 'GITHUB_ACTOR || "fallback"', 'globalThis.process.env', '(() => 1)()', 'EVENT_PAYLOAD[process.exit(1)]', '']) {
        if (expression === 'globalThis.process.env') {
            assert.equal(action.interpolateTemplate(`{{ ${expression} }}`, {}), '');
        } else {
            assert.throws(() => action.interpolateTemplate(`{{ ${expression} }}`, {}), /Unsupported template expression/);
        }
    }
    const script = '<% throw new Error("executed") %>';
    assert.equal(action.interpolateTemplate(script, {}), script);
});

test('templates cannot traverse inherited or prototype properties', () => {
    const context = { EVENT_PAYLOAD: Object.create({ inherited: 'secret' }) };
    assert.equal(action.interpolateTemplate('{{ EVENT_PAYLOAD.inherited }}', context), '');
    for (const property of ['__proto__', 'constructor', 'prototype']) {
        assert.throws(() => action.interpolateTemplate(`{{ EVENT_PAYLOAD.${property} }}`, context), /prototype properties/);
    }
});

test('HTML templates escape interpolated content and preserve authored markup', () => {
    const context = { COMMENT: '<img src="x" onerror=\'bad()\'> & {{ OTHER }}' };
    assert.equal(action.interpolateTemplate('<p>{{ COMMENT }}</p>', context, true), '<p>&lt;img src=&quot;x&quot; onerror=&#39;bad()&#39;&gt; &amp; {{ OTHER }}</p>');
    assert.equal(action.interpolateTemplate('{{ COMMENT }}', context), context.COMMENT);
});

test('constructs Mailgun URLs with US, EU and custom HTTPS path prefixes', () => {
    assert.equal(String(action.getMessagesUrl('https://api.mailgun.net/', 'example.com')), 'https://api.mailgun.net/v3/example.com/messages');
    assert.equal(String(action.getMessagesUrl('https://api.eu.mailgun.net', 'example.com')), 'https://api.eu.mailgun.net/v3/example.com/messages');
    assert.equal(String(action.getMessagesUrl('https://gateway.example.com/mailgun///', 'example.com')), 'https://gateway.example.com/mailgun/v3/example.com/messages');
});

test('rejects insecure, malformed and credential-bearing API base URLs', () => {
    for (const base of ['http://api.mailgun.net', 'file:///tmp/mail', 'not-a-url', 'https://user:password@api.mailgun.net', 'https://api.mailgun.net/?key=secret', 'https://api.mailgun.net/#fragment']) {
        assert.throws(() => action.getMessagesUrl(base, 'example.com'), /HTTPS/);
    }
});

test('rejects invalid domains and attempts to change the API request path', () => {
    for (const domain of ['', '.', '..', '../example.com', 'example.com/path', 'https://example.com', 'example.com:443', 'a..com', '-a.com', 'a-.com', `${'a'.repeat(64)}.com`, 'a'.repeat(254)]) {
        assert.throws(() => action.getMessagesUrl('https://api.mailgun.net', domain), /Invalid Mailgun domain/);
    }
});

test('uses a unique output delimiter so multiline responses cannot create extra outputs', t => {
    const outputFile = path.join(temporaryDirectory(t), 'output');
    const response = 'Queued\nEOF\nmalicious=value\r\n::error::injected';
    action.setOutput('response', response, { GITHUB_OUTPUT: outputFile });
    const content = fs.readFileSync(outputFile, 'utf8');
    const match = content.match(/^response<<(mailgun_[\w-]+)\n([\s\S]*)\n\1\n$/);
    assert.ok(match);
    assert.equal(match[2], response);
    assert.throws(() => action.setOutput('bad\nname', 'value', { GITHUB_OUTPUT: outputFile }), /Invalid workflow output name/);
});

test('escapes workflow commands and the legacy output fallback', () => {
    const lines = [];
    action.setOutput('response', '100%\r\n::error::injected', {}, chunk => lines.push(String(chunk)));
    assert.deepEqual(lines, ['::set-output name=response::100%25%0D%0A::error::injected\n']);
});

test('missing or malformed event payload files produce a safe warning and empty event data', t => {
    const lines = [];
    const write = chunk => lines.push(String(chunk));
    const directory = temporaryDirectory(t);
    const eventPath = path.join(directory, 'event.json');
    assert.deepEqual(action.readEventPayload(), {});
    assert.deepEqual(action.readEventPayload(path.join(directory, 'missing.json'), write), {});
    fs.writeFileSync(eventPath, '{invalid JSON containing sensitive data');
    assert.deepEqual(action.readEventPayload(eventPath, write), {});
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => !line.includes('sensitive data')));
});

test('sends the documented multipart request with Basic auth, a timeout and redirects disabled', async t => {
    const harness = prepareRun(t, { INPUT_TO: 'one@example.com,two@example.com', INPUT_CC: 'copy@example.com', INPUT_FROM: 'Sender <sender@example.com>' });
    await action.run(harness);
    assert.equal(harness.requests.length, 1);
    const { url, options } = harness.requests[0];
    assert.equal(url, 'https://api.mailgun.net/v3/example.com/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('api:test-mailgun-key').toString('base64')}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const request = new Request(url, options);
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    assert.deepEqual(Object.fromEntries((await request.formData()).entries()), {
        from: 'Sender <sender@example.com>',
        to: 'one@example.com,two@example.com',
        cc: 'copy@example.com',
        subject: '@octocat (push) at owner/repository',
        html: '@octocat (push) at owner/repository'
    });
    assert.match(harness.output(), /Queued\. Thank you\./);
});

test('omits absent CC and supplies the default sender', async t => {
    const harness = prepareRun(t);
    await action.run(harness);
    assert.equal(harness.requests[0].options.body.get('from'), 'hello@example.com');
    assert.equal(harness.requests[0].options.body.has('cc'), false);
});

for (const [name, inputs, proxy] of [
    ['HTTPS proxy', { HTTPS_PROXY: 'http://proxy.example.com:8080', NO_PROXY: 'localhost' }, 'http://proxy.example.com:8080'],
    ['lowercase proxy precedence', { https_proxy: 'http://lower.example.com:8080', HTTPS_PROXY: 'http://upper.example.com:8080', no_proxy: 'localhost' }, 'http://lower.example.com:8080'],
    ['HTTP proxy fallback', { HTTP_PROXY: 'http://proxy.example.com:8080', NO_PROXY: 'localhost' }, 'http://proxy.example.com:8080'],
    ['ALL_PROXY fallback', { ALL_PROXY: 'http://proxy.example.com:8080', NO_PROXY: 'localhost' }, 'http://proxy.example.com:8080']
]) {
    test(`preserves runner ${name} settings and restores the native dispatcher`, async t => {
        const harness = prepareRun(t, inputs);
        let restored = false;
        const configure = t.mock.method(http, 'setGlobalProxyFromEnv', options => {
            assert.deepEqual(options, { HTTPS_PROXY: proxy, NO_PROXY: 'localhost' });
            return () => { restored = true; };
        });
        await action.run(harness);
        assert.equal(configure.mock.callCount(), 1);
        assert.equal(harness.requests.length, 1);
        assert.equal(restored, true);
    });
}

test('proxy configuration errors do not disclose proxy credentials', async t => {
    const harness = prepareRun(t, { HTTPS_PROXY: 'invalid:user:proxy-password' });
    t.mock.method(http, 'setGlobalProxyFromEnv', () => { throw new Error('bad proxy-password'); });
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.equal(harness.requests.length, 0);
    assert.match(harness.logs.at(-1), /Invalid runner proxy configuration/);
    assert.ok(!harness.logs.at(-1).includes('proxy-password'));
});

test('restores the native proxy dispatcher after a failed request', async t => {
    const harness = prepareRun(t, { HTTPS_PROXY: 'http://proxy.example.com:8080' });
    let restored = false;
    t.mock.method(http, 'setGlobalProxyFromEnv', () => () => { restored = true; });
    harness.fetchImpl = async () => { throw new Error('fetch failed'); };
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.equal(restored, true);
});

test('native HTTP transport sends multipart fields and authentication to a simulated API', async t => {
    const harness = prepareRun(t, { INPUT_BODY: '<p>Hello</p>' });
    let received;
    const server = http.createServer(async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }
            const form = await new Response(Buffer.concat(chunks), { headers: request.headers }).formData();
            received = { method: request.method, path: request.url, authorization: request.headers.authorization, fields: Object.fromEntries(form) };
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: 'Queued by simulated API' }));
        } catch {
            response.writeHead(500);
            response.end('Unable to decode request');
        }
    });
    const baseUrl = await listen(t, server);
    harness.fetchImpl = (url, options) => fetch(`${baseUrl}${url.pathname}`, options);
    await action.run(harness);
    assert.deepEqual(received, {
        method: 'POST',
        path: '/v3/example.com/messages',
        authorization: `Basic ${Buffer.from('api:test-mailgun-key').toString('base64')}`,
        fields: { from: 'hello@example.com', to: 'recipient@example.com', subject: '@octocat (push) at owner/repository', html: '<p>Hello</p>' }
    });
    assert.match(harness.output(), /Queued by simulated API/);
});

test('native HTTP transport never follows redirects with credentials or message content', async t => {
    const harness = prepareRun(t);
    const paths = [];
    const server = http.createServer((request, response) => {
        paths.push(request.url);
        request.resume();
        response.writeHead(307, { Location: '/unexpected' });
        response.end();
    });
    const baseUrl = await listen(t, server);
    harness.fetchImpl = (url, options) => fetch(`${baseUrl}/redirect`, options);
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(paths, ['/redirect']);
    assert.equal(harness.output(), '');
});

test('native proxy support tunnels HTTPS through the configured runner proxy', async t => {
    const harness = prepareRun(t, { 'INPUT_API-BASE-URL': 'https://mailgun-action.invalid' });
    const connections = [];
    const server = http.createServer();
    server.on('connect', (request, socket) => {
        connections.push({ target: request.url, authorization: request.headers.authorization });
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    harness.env.HTTPS_PROXY = await listen(t, server);
    await action.run({ env: harness.env, write: harness.write });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(connections, [{ target: 'mailgun-action.invalid:443', authorization: undefined }]);
    assert.equal(harness.output(), '');
});

test('renders real event payloads safely in subject and HTML body', async t => {
    const harness = prepareRun(t, { INPUT_SUBJECT: '{{ EVENT_PAYLOAD.action }} by {{ GITHUB_ACTOR }}', INPUT_BODY: '<p>{{ EVENT_PAYLOAD.comment.body }}</p>' });
    harness.env.GITHUB_EVENT_PATH = path.join(harness.directory, 'event.json');
    fs.writeFileSync(harness.env.GITHUB_EVENT_PATH, JSON.stringify({ action: 'created', comment: { body: '<b>untrusted</b> & text' } }));
    await action.run(harness);
    assert.equal(harness.requests[0].options.body.get('subject'), 'created by octocat');
    assert.equal(harness.requests[0].options.body.get('html'), '<p>&lt;b&gt;untrusted&lt;/b&gt; &amp; text</p>');
});

for (const [name, inputs, host] of [
    ['EU input', { 'INPUT_EU-REGION': 'true' }, 'api.eu.mailgun.net'],
    ['legacy EU input', { INPUT_EU_REGION: 'YES' }, 'api.eu.mailgun.net'],
    ['EU environment fallback', { MAILGUN_EU_REGION: '1' }, 'api.eu.mailgun.net'],
    ['custom URL over EU', { 'INPUT_EU-REGION': 'true', 'INPUT_API-BASE-URL': 'https://gateway.example.com' }, 'gateway.example.com'],
    ['custom URL environment fallback', { MAILGUN_API_BASE_URL: ' https://gateway.example.com ' }, 'gateway.example.com'],
    ['explicit URL over environment', { 'INPUT_API-BASE-URL': 'https://api.mailgun.net', MAILGUN_API_BASE_URL: 'https://gateway.example.com' }, 'api.mailgun.net']
]) {
    test(`selects the correct endpoint for ${name}`, async t => {
        const harness = prepareRun(t, inputs);
        await action.run(harness);
        assert.equal(new URL(harness.requests[0].url).host, host);
    });
}

for (const [input, message] of [['INPUT_API-KEY', 'Undefined Mailgun API key'], ['INPUT_DOMAIN', 'Undefined domain'], ['INPUT_TO', 'Undefined email address']]) {
    test(`fails before making a request when ${input} is missing`, async t => {
        const harness = prepareRun(t, { [input]: '' });
        await action.run(harness);
        assert.equal(process.exitCode, 1);
        assert.equal(harness.requests.length, 0);
        assert.ok(harness.logs.some(line => line.includes(message)));
        assert.equal(harness.output(), '');
    });
}

test('invalid template expressions fail before contacting Mailgun', async t => {
    const harness = prepareRun(t, { INPUT_SUBJECT: '{{ process.exit(0) }}' });
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.equal(harness.requests.length, 0);
});

test('masks raw and encoded credentials before reporting validation errors', async t => {
    const harness = prepareRun(t, { INPUT_DOMAIN: '' });
    await action.run(harness);
    assert.equal(harness.logs[0], '::add-mask::test-mailgun-key\n');
    assert.equal(harness.logs[1], `::add-mask::${Buffer.from('api:test-mailgun-key').toString('base64')}\n`);
    assert.ok(harness.logs.at(-1).startsWith('::error::'));
});

for (const [status, body] of [[401, '{"message":"Invalid key"}'], [403, '{"message":"Forbidden"}'], [429, 'Rate limited'], [500, 'Internal error']]) {
    test(`reports HTTP ${status} without setting a success output or retrying`, async t => {
        const harness = prepareRun(t);
        let requests = 0;
        harness.fetchImpl = async () => { requests++; return new Response(body, { status }); };
        await action.run(harness);
        assert.equal(process.exitCode, 1);
        assert.equal(requests, 1);
        assert.equal(harness.output(), '');
        const error = harness.logs.at(-1);
        assert.match(error, new RegExp(String(status)));
        if (status === 403) {
            assert.match(error, /eu-region: true/);
            assert.match(error, /authorized recipients/);
        }
    });
}

test('redacts reflected API credentials and prevents error log command injection', async t => {
    const harness = prepareRun(t);
    const encodedKey = Buffer.from('api:test-mailgun-key').toString('base64');
    harness.fetchImpl = async () => new Response(`test-mailgun-key ${encodedKey}\n::error::injected`, { status: 500 });
    await action.run(harness);
    const error = harness.logs.at(-1);
    assert.ok(!error.includes('test-mailgun-key'));
    assert.ok(!error.includes(encodedKey));
    assert.match(error, /\*\*\* \*\*\*%0A::error::injected/);
    assert.equal(error.split('\n').length, 2);
});

test('redacts credentials reflected in successful response outputs', async t => {
    const harness = prepareRun(t);
    harness.fetchImpl = async () => Response.json({ message: 'Queued test-mailgun-key' });
    await action.run(harness);
    assert.match(harness.output(), /Queued \*\*\*/);
    assert.ok(!harness.output().includes('test-mailgun-key'));
});

test('returns JSON when a successful response has no message', async t => {
    const harness = prepareRun(t);
    harness.fetchImpl = async () => Response.json({ id: 'message-id' });
    await action.run(harness);
    assert.match(harness.output(), /\{"id":"message-id"\}/);
});

for (const body of ['not JSON', 'null', '[]', '42']) {
    test(`rejects an invalid successful response: ${body}`, async t => {
        const harness = prepareRun(t);
        harness.fetchImpl = async () => new Response(body);
        await action.run(harness);
        assert.equal(process.exitCode, 1);
        assert.equal(harness.output(), '');
        assert.match(harness.logs.at(-1), /invalid.*response/);
    });
}

test('stops reading oversized responses', async t => {
    const harness = prepareRun(t);
    harness.fetchImpl = async () => new Response('x'.repeat(1024 * 1024 + 1));
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.match(harness.logs.at(-1), /exceeded 1 MiB/);
});

test('reports request timeouts without retrying a potentially delivered message', async t => {
    const harness = prepareRun(t);
    let requests = 0;
    harness.fetchImpl = async () => { requests++; throw new DOMException('timeout', 'TimeoutError'); };
    await action.run(harness);
    assert.equal(process.exitCode, 1);
    assert.equal(requests, 1);
    assert.match(harness.logs.at(-1), /timed out after 30 seconds.*Check delivery before retrying/);
});

test('the action entrypoint exits unsuccessfully with a clear missing-key error', () => {
    const result = spawnSync(process.execPath, [require.resolve(entrypoint)], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::Undefined Mailgun API key/);
    assert.equal(result.stderr, '');
});
