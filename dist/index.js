const core = require('@actions/core');
const github = require('@actions/github');

try {
    const apiKey = core.getInput('api-key');
    const domain = core.getInput('domain');
    const to = core.getInput('to');
    const from = core.getInput('from');
    const subject = core.getInput('subject');
    const text = core.getInput('text');
    const html = core.getInput('html');
    const amphtml = core.getInput('amp-html');
    core.setOutput("domain", domain);
    core.setOutput("to", to);
} catch (error) {
    core.setFailed(error.message);
}
