const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
    try {
        const apiKey = core.getInput('api-key');
        const domain = core.getInput('domain');
        const to = core.getInput('to');

        var from = core.getInput('from');
        if (from === undefined) {
            from = 'hello@' + domain;
        }

        var subject = core.getInput('subject');
        var body = core.getInput('body');

        const event = github.context.eventName;
        const action = github.context.action;
        const issue = github.context.issue;

        body = body.replace("$EVENT$", event)
            .replace("$ISSUE$", issue)
            .replace("$ACTION$", action);

        subject = subject.replace("$EVENT$", event)
            .replace("$ISSUE$", issue)
            .replace("$ACTION$", action);

        if (apiKey === undefined) {
            throw new Error('Undefined Mailgun API key. Please add "api-key" input in your workflow file.');
        }
        if (domain === undefined) {
            throw new Error('Undefined domain. Please add "domain" input in your workflow file.');
        }
        if (to === undefined) {
            throw new Error('Undefined email address of the recipient(s). Please add "to" input in your workflow file.')
        }

        var mailgun = require('mailgun-js')({ apiKey: apiKey, domain: domain });
        var MailComposer = require('nodemailer/lib/mail-composer');

        var data = {
            from: from,
            to: to,
            subject: subject,
            html: body
        };
        var mail = new MailComposer(data);
        mail.compile().build((err, message) => {
            if (err) {
                core.setFailed(err);
                return;
            }
            var dataToSend = {
                to: to,
                message: message.toString('ascii')
            };

            mailgun.messages().sendMime(dataToSend, (sendError, body) => {
                if (sendError) {
                    core.setFailed(sendError);
                    return;
                } else {
                    core.setOutput(body);
                    return;
                }
            });
        });
    } catch (error) {
        core.setFailed(error.message);
    }

}

run()