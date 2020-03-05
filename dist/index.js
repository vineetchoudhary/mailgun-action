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
    var mailgun = require('mailgun-js')({apiKey: apiKey, domain: domain});
 
    var data = {
        from: 'hello@'+domain,
        to: to,
        subject: subject,
        html: html
    };
    
    mailgun.messages().send(data, function (error, body) {
        if (error) {
            core.setFailed(error);
        } else {
            core.setOutput(body);
        }

    });
} catch (error) {
    core.setFailed(error.message);
}
