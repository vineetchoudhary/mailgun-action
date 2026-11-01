const fs = require('node:fs');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TEMPLATE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\s*(?:\d+|"[^"\\]*"|'[^'\\]*')\s*\])*$/;
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);

function escapeWorkflowValue(value) {
    return String(value)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

function issueWorkflowCommand(command, value, write = message => process.stdout.write(message)) {
    write(`::${command}::${escapeWorkflowValue(value)}\n`);
}

function getInput(name, env = process.env) {
    const normalizedName = name.replace(/ /g, '_').toUpperCase();
    const candidateKeys = [
        `INPUT_${normalizedName}`,
        `INPUT_${normalizedName.replace(/-/g, '_')}`
    ];

    for (const key of candidateKeys) {
        if (typeof env[key] === 'string') {
            return env[key].trim();
        }
    }

    return '';
}

function setOutput(name, value, env = process.env, write) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error('Invalid workflow output name.');
    }

    const outputValue = String(value);

    if (env.GITHUB_OUTPUT) {
        let delimiter;
        do {
            delimiter = `mailgun_${randomUUID()}`;
        } while (outputValue.includes(delimiter));

        fs.appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${outputValue}\n${delimiter}\n`, 'utf8');
        return;
    }

    issueWorkflowCommand(`set-output name=${name}`, outputValue, write);
}

function getRequiredInput(name, errorMessage, env) {
    const value = getInput(name, env);

    if (!value) {
        throw new Error(errorMessage);
    }

    return value;
}

function isTruthyInput(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readEventPayload(eventPath, write) {
    if (!eventPath) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    } catch {
        issueWorkflowCommand('warning', 'Unable to read or parse GITHUB_EVENT_PATH. Event template values will be empty.', write);
        return {};
    }
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function interpolateTemplate(template, context, html = false) {
    return template.replace(/{{([\s\S]*?)}}/g, (match, expression) => {
        const path = expression.trim();

        if (!TEMPLATE_PATH.test(path)) {
            throw new Error('Unsupported template expression. Use environment variable names or event data paths inside {{ ... }}.');
        }

        const properties = path.match(/[A-Za-z_$][\w$]*|\d+|"[^"\\]*"|'[^'\\]*'/g)
            .map(property => /^["']/.test(property) ? property.slice(1, -1) : property);
        let value = context;

        for (const property of properties) {
            if (FORBIDDEN_PROPERTIES.has(property)) {
                throw new Error('Template paths cannot access prototype properties.');
            }

            if (value == null || !Object.hasOwn(Object(value), property)) {
                return '';
            }

            value = value[property];
        }

        const result = value == null ? '' : String(value);
        return html ? escapeHtml(result) : result;
    });
}

function getMessagesUrl(baseUrl, domain) {
    if (domain.length > 253 || !domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
        throw new Error('Invalid Mailgun domain. Enter a domain name without a URL, port, or path.');
    }

    let url;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new Error('Invalid Mailgun API base URL. Enter an absolute HTTPS URL.');
    }

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('Mailgun API base URL must use HTTPS without credentials, query parameters, or a fragment.');
    }

    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v3/${encodeURIComponent(domain)}/messages`;
    return url;
}

function configureProxy(env) {
    const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;

    if (!proxy) {
        return;
    }

    if (typeof http.setGlobalProxyFromEnv !== 'function') {
        throw new Error('Proxy support requires Node.js 24.14 or newer. Update your GitHub Actions runner.');
    }

    try {
        return http.setGlobalProxyFromEnv({
            HTTPS_PROXY: proxy,
            NO_PROXY: env.no_proxy || env.NO_PROXY || ''
        });
    } catch {
        throw new Error('Invalid runner proxy configuration. Check your HTTPS_PROXY or HTTP_PROXY setting.');
    }
}

async function readResponse(response) {
    const chunks = [];
    let size = 0;

    if (response.body) {
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                throw new Error('Mailgun API response exceeded 1 MiB.');
            }
            chunks.push(chunk);
        }
    }

    return Buffer.concat(chunks).toString('utf8');
}

async function sendMessage(url, apiKey, messageData, fetchImpl = fetch) {
    const body = new FormData();
    for (const [name, value] of Object.entries(messageData)) {
        body.append(name, value);
    }

    let response;
    let text;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        text = await readResponse(response);
    } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            throw new Error('Mailgun request timed out after 30 seconds. Check delivery before retrying.');
        }
        throw error;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        if (response.ok) {
            throw new Error('Mailgun returned an invalid JSON response. Check delivery before retrying.');
        }
    }

    if (!response.ok) {
        const error = new Error(`Mailgun request failed (HTTP ${response.status}).`);
        error.status = response.status;
        error.details = (typeof data?.message === 'string' ? data.message : text).slice(0, 2000);
        throw error;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Mailgun returned an invalid message response. Check delivery before retrying.');
    }

    return data;
}

function formatMailgunError(error, domain) {
    const status = error?.status;
    const details = typeof error?.details === 'string' ? error.details : '';
    const message = error?.message || String(error);

    if (status === 403 || message === 'Forbidden') {
        const hints = [
            `Mailgun rejected the request for domain "${domain}" with 403 Forbidden.`,
            'Check that the API key matches the Mailgun region for the domain.',
            'If your domain is hosted in the EU region, pass eu-region: true or api-base-url: https://api.eu.mailgun.net.',
            'If this is a sandbox domain, Mailgun only allows sending to authorized recipients.',
            'Verify that the domain is active and allowed to send from the selected From address.'
        ];

        if (details) {
            hints.push(`Mailgun details: ${details}`);
        }

        return hints.join(' ');
    }

    return details && details !== message ? `${message} ${details}` : message;
}

function secretValues(apiKey) {
    return apiKey ? [...new Set([apiKey, Buffer.from(`api:${apiKey}`).toString('base64'), encodeURIComponent(apiKey)])] : [];
}

function redactSecrets(value, apiKey) {
    for (const secret of secretValues(apiKey)) {
        value = value.replaceAll(secret, '***');
    }
    return value;
}

async function run({ env = process.env, fetchImpl = fetch, write } = {}) {
    const apiKey = getInput('api-key', env);

    try {
        for (const secret of secretValues(apiKey)) {
            issueWorkflowCommand('add-mask', secret, write);
        }

        getRequiredInput('api-key', 'Undefined Mailgun API key. Please add "api-key" input in your workflow file.', env);
        const domain = getRequiredInput('domain', 'Undefined domain. Please add "domain" input in your workflow file.', env);
        const to = getRequiredInput('to', 'Undefined email address of the recipient(s). Please add "to" input in your workflow file.', env);
        const cc = getInput('cc', env);
        const useEuRegion = isTruthyInput(getInput('eu-region', env)) || isTruthyInput(env.MAILGUN_EU_REGION || '');
        const apiBaseUrl = getInput('api-base-url', env) || (env.MAILGUN_API_BASE_URL || '').trim()
            || (useEuRegion ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net');
        const url = getMessagesUrl(apiBaseUrl, domain);
        const eventPayload = readEventPayload(env.GITHUB_EVENT_PATH, write);
        const defaultMessage = `@${env.GITHUB_ACTOR || 'unknown'} (${env.GITHUB_EVENT_NAME || 'unknown'}) at ${env.GITHUB_REPOSITORY || 'unknown'}`;
        const templateContext = { ...env, EVENT_PAYLOAD: eventPayload };
        const subjectInput = getInput('subject', env);
        const bodyInput = getInput('body', env);
        const messageData = {
            from: getInput('from', env) || `hello@${domain}`,
            to,
            subject: subjectInput ? interpolateTemplate(subjectInput, templateContext) : defaultMessage,
            html: bodyInput ? interpolateTemplate(bodyInput, templateContext, true) : escapeHtml(defaultMessage)
        };

        if (cc) {
            messageData.cc = cc;
        }

        const restoreProxy = configureProxy(env);
        let response;
        try {
            response = await sendMessage(url, apiKey, messageData, fetchImpl);
        } finally {
            restoreProxy?.();
        }
        const message = typeof response.message === 'string' && response.message ? response.message : JSON.stringify(response);
        setOutput('response', redactSecrets(message, apiKey), env, write);
    } catch (error) {
        process.exitCode = 1;
        issueWorkflowCommand('error', redactSecrets(formatMailgunError(error, getInput('domain', env)), apiKey), write);
    }
}

module.exports = { escapeWorkflowValue, getInput, setOutput, readEventPayload, interpolateTemplate, getMessagesUrl, sendMessage, formatMailgunError, run };

if (require.main === module) {
    run();
}
