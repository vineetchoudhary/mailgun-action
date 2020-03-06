const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
    try {
        const apiKey = core.getInput('api-key');
        const domain = core.getInput('domain');
        const to = core.getInput('to');
        const from = core.getInput('from');
        const subject = core.getInput('subject');
        const body = core.getInput('body');
    
        var mailgun = require('mailgun-js')({apiKey: apiKey, domain: domain});
        var MailComposer = require('nodemailer/lib/mail-composer');
    
        var data = {
            from: 'hello@'+domain,
            to: to,
            subject: subject,
            html: body
        };
        var mail = new MailComposer(mailOptions);
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