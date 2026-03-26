const fs = require('fs');
const FormData = require('form-data');
const Mailgun = require('mailgun.js');
const _ = require('lodash');

_.templateSettings.interpolate = /{{([\s\S]+?)}}/g;

function escapeWorkflowValue(value) {
    return String(value)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

function issueWorkflowCommand(command, value) {
    process.stdout.write(`::${command}::${escapeWorkflowValue(value)}\n`);
}

function getInput(name) {
    const normalizedName = name.replace(/ /g, '_').toUpperCase();
    const candidateKeys = [
        `INPUT_${normalizedName.replace(/-/g, '_')}`,
        `INPUT_${normalizedName}`
    ];

    for (const key of candidateKeys) {
        if (typeof process.env[key] === 'string') {
            return process.env[key].trim();
        }
    }

    return '';
}

function setOutput(name, value) {
    const outputValue = String(value);
    const outputFile = process.env.GITHUB_OUTPUT;

    if (outputFile) {
        fs.appendFileSync(outputFile, `${name}<<EOF\n${outputValue}\nEOF\n`);
        return;
    }

    issueWorkflowCommand(`set-output name=${name}`, outputValue);
}

function setSecret(value) {
    issueWorkflowCommand('add-mask', value);
}

function warning(message) {
    issueWorkflowCommand('warning', message);
}

function setFailed(message) {
    process.exitCode = 1;
    console.error(message);
}

function getRequiredInput(name, errorMessage) {
    const value = getInput(name);

    if (!value) {
        throw new Error(errorMessage);
    }

    return value;
}

function getOptionalInput(name) {
    return getInput(name);
}

function isTruthyInput(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readEventPayload(eventPath) {
    if (!eventPath) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    } catch (error) {
        warning(`Unable to parse GITHUB_EVENT_PATH: ${error.message}`);
        return {};
    }
}

function interpolateTemplate(template, context) {
    return _.template(template)(context);
}

function formatMailgunError(error, domain) {
    const status = error && typeof error.status === 'number' ? error.status : error && error.status;
    const details = error && typeof error.details === 'string' ? error.details : '';
    const message = error && error.message ? error.message : String(error);

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

    if (details && details !== message) {
        return `${message} ${details}`;
    }

    return message;
}

async function run() {
    try {
        const apiKey = getRequiredInput('api-key', 'Undefined Mailgun API key. Please add "api-key" input in your workflow file.');
        const useEuRegion = isTruthyInput(getOptionalInput('eu-region')) || isTruthyInput(process.env.MAILGUN_EU_REGION || '');
        const apiBaseUrl = getOptionalInput('api-base-url') || (process.env.MAILGUN_API_BASE_URL || '').trim();
        const domain = getRequiredInput('domain', 'Undefined domain. Please add "domain" input in your workflow file.');
        const to = getRequiredInput('to', 'Undefined email address of the recipient(s). Please add "to" input in your workflow file.');
        const cc = getOptionalInput('cc');
        const from = getOptionalInput('from') || `hello@${domain}`;

        setSecret(apiKey);

        const {
            GITHUB_ACTOR,
            GITHUB_EVENT_NAME,
            GITHUB_EVENT_PATH,
            GITHUB_REPOSITORY
        } = process.env;

        const eventPayload = readEventPayload(GITHUB_EVENT_PATH);
        const defaultMessage = `@${GITHUB_ACTOR || 'unknown'} (${GITHUB_EVENT_NAME || 'unknown'}) at ${GITHUB_REPOSITORY || 'unknown'}`;
        const templateContext = { ...process.env, EVENT_PAYLOAD: eventPayload };

        const subjectInput = getOptionalInput('subject');
        const bodyInput = getOptionalInput('body');
        const subject = subjectInput ? interpolateTemplate(subjectInput, templateContext) : defaultMessage;
        const body = bodyInput ? interpolateTemplate(bodyInput, templateContext) : defaultMessage;

        const mailgun = new Mailgun(FormData);
        const clientOptions = {
            username: 'api',
            key: apiKey
        };

        if (apiBaseUrl) {
            clientOptions.url = apiBaseUrl;
        } else if (useEuRegion) {
            clientOptions.url = 'https://api.eu.mailgun.net';
        }

        const client = mailgun.client(clientOptions);

        const messageData = {
            from,
            to,
            subject,
            html: body
        };

        if (cc) {
            messageData.cc = cc;
        }

        const response = await client.messages.create(domain, messageData);

        setOutput('response', response.message || JSON.stringify(response));
    } catch (error) {
        setFailed(formatMailgunError(error, getOptionalInput('domain')));
    }
}

run();