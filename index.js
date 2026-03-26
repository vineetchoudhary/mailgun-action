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
    const inputKey = `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`;
    return (process.env[inputKey] || '').trim();
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

async function run() {
    try {
        const apiKey = getRequiredInput('api-key', 'Undefined Mailgun API key. Please add "api-key" input in your workflow file.');
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
        const client = mailgun.client({
            username: 'api',
            key: apiKey
        });

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
        setFailed(error instanceof Error ? error.message : String(error));
    }
}

run();