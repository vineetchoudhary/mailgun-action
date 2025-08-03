const core = require('@actions/core');
const fs = require('fs');
const _ = require('lodash');

async function run() {
    try {
        //fixed inputs
        const apiKey = core.getInput('api-key');
        const domain = core.getInput('domain');
        const to = core.getInput('to');

        if (apiKey === undefined || apiKey == '') {
            throw new Error('Undefined Mailgun API key. Please add "api-key" input in your workflow file.');
        }
        if (domain === undefined || domain == '') {
            throw new Error('Undefined domain. Please add "domain" input in your workflow file.');
        }
        if (to === undefined || to == '') {
            throw new Error('Undefined email address of the recipient(s). Please add "to" input in your workflow file.')
        }

        //from
        var from = core.getInput('from');
        if (from === undefined || from == '') {
            from = 'hello@' + domain;
        }

        //Get process env var
        const {
            GITHUB_EVENT_PATH,
            GITHUB_ACTOR,
            GITHUB_EVENT_NAME,
            GITHUB_REPOSITORY
        } = process.env;
        
        const EVENT_PAYLOAD = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, "utf8"));
        const DEFAULT_MESSAGE = `@${GITHUB_ACTOR} (${GITHUB_EVENT_NAME}) at ${GITHUB_REPOSITORY}`;
        
        _.templateSettings.interpolate = /{{([\s\S]+?)}}/g;
        const ReplaceMustaches = data => _.template(data)({ ...process.env, EVENT_PAYLOAD })

        //subject
        var subject = core.getInput('subject');
        if (subject === undefined || subject == '') {
            subject = DEFAULT_MESSAGE;
        } else {
            subject = ReplaceMustaches(subject);
        }

        //body
        var body = core.getInput('body');
        if (body === undefined || body == '') {
            body = DEFAULT_MESSAGE;
        } else {
            body = ReplaceMustaches(body);
        }

        //cc
        var cc = core.getInput('cc');
        if (cc === undefined) {
            cc = '';
        }

        var mailgun = require('mailgun-js')({ apiKey: apiKey, domain: domain });
        var MailComposer = require('nodemailer/lib/mail-composer');

        var data = {
            from: from,
            to: to,
            cc: cc,
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
                cc: cc,
                message: message.toString('ascii')
            };

            mailgun.messages().sendMime(dataToSend, (sendError, body) => {
                if (sendError) {
                    core.setFailed(sendError);
                    return;
                } else {
                // Write output to GITHUB_OUTPUT file (recommended way)
                const outputFile = process.env.GITHUB_OUTPUT;
                if (outputFile) {
                    fs.appendFileSync(outputFile, `response<<EOF\n${body.message}\nEOF\n`);
                }
                return;
                }
            });
        });
    } catch (error) {
        core.setFailed(error.message);
    }
}

run()