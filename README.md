# Mailgun Action

📧 Send email from GitHub Actions using the Mailgun API.

This action lets you send emails from any workflow event, with support for custom subjects, HTML bodies, event payload interpolation, and EU-region Mailgun accounts.

## ✨ Features

- Send email through Mailgun from any GitHub Actions workflow
- Use HTML in the message body
- Interpolate GitHub environment variables and event payload data
- Support Mailgun US and EU API endpoints
- Return the Mailgun API response as a workflow output

## 📥 Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | Yes | None | Mailgun API key. |
| `domain` | Yes | None | Verified Mailgun sending domain. |
| `api-base-url` | No | Mailgun US API | Custom Mailgun API base URL. Use `https://api.eu.mailgun.net` for EU-region domains. |
| `eu-region` | No | `false` | Shorthand for EU Mailgun accounts. Set to `true` to use `https://api.eu.mailgun.net`. |
| `to` | Yes | None | Recipient email address. You can pass a comma-separated list. |
| `cc` | No | Empty | Carbon-copy recipient list. You can pass a comma-separated list. |
| `from` | No | `hello@<domain>` | Sender email address displayed in the message. |
| `subject` | No | `@${GITHUB_ACTOR} (${GITHUB_EVENT_NAME}) at ${GITHUB_REPOSITORY}` | Subject line for the email. |
| `body` | No | `@${GITHUB_ACTOR} (${GITHUB_EVENT_NAME}) at ${GITHUB_REPOSITORY}` | HTML body for the email. |

## 📤 Outputs

| Output | Description |
| --- | --- |
| `response` | Response message returned by the Mailgun API. |

## 🧠 Template Interpolation

You can reference GitHub Actions environment variables and the GitHub event payload in `subject` and `body` using `{{ ... }}` syntax.

### Environment variables

```text
Action called: {{ GITHUB_ACTION }}
```

### Event payload data

```text
Pull request ID: {{ EVENT_PAYLOAD.pull_request.id }}
```

This is useful for building notification emails from workflow events such as `push`, `pull_request`, or `issue_comment`.

## 🚀 Example Usage

### Default email on every push

```yaml
name: On Push Email

on: [push]

jobs:
  send-mail:
    runs-on: ubuntu-latest
    steps:
      - name: Send Mail Action
        id: sendmail
        uses: vineetchoudhary/mailgun-action@master
        with:
          api-key: ${{ secrets.API_KEY }}
          domain: ${{ secrets.DOMAIN }}
          to: ${{ secrets.TO }}

      - name: Print Mailgun Response
        run: echo "${{ steps.sendmail.outputs.response }}"
```

**Preview**

![](/docs/images/OnPush.png)

### Issue comment notification with custom subject and HTML body

```yaml
name: Issue Activity

on:
  issue_comment:
    types: [created, edited, deleted]

jobs:
  send-mail:
    runs-on: ubuntu-latest
    steps:
      - name: Send Mail Action
        id: sendmail
        uses: vineetchoudhary/mailgun-action@master
        with:
          api-key: ${{ secrets.API_KEY }}
          domain: ${{ secrets.DOMAIN }}
          to: ${{ secrets.TO }}
          subject: 'Issue Activity - {{ EVENT_PAYLOAD.action }}'
          body: '<p><b>Body</b> - {{ EVENT_PAYLOAD.comment.body }}<br /><br /><b>Issue Activity</b> - {{ EVENT_PAYLOAD.action }}<br /><br /><b>URL</b> - {{ EVENT_PAYLOAD.comment.html_url }}<br /><br /><b>By</b> - {{ EVENT_PAYLOAD.comment.user.login }}</p>'

      - name: Print Mailgun Response
        run: echo "${{ steps.sendmail.outputs.response }}"
```

**Preview**

![](/docs/images/IssueComment.png)

### EU-region Mailgun account

```yaml
name: EU Region Email

on: [push]

jobs:
  send-mail:
    runs-on: ubuntu-latest
    steps:
      - name: Send Mail Action
        uses: vineetchoudhary/mailgun-action@master
        with:
          api-key: ${{ secrets.API_KEY }}
          eu-region: true
          domain: ${{ secrets.DOMAIN }}
          to: ${{ secrets.TO }}
```

If you prefer, you can pass `api-base-url` directly instead of `eu-region`.

```yaml
with:
  api-key: ${{ secrets.API_KEY }}
  api-base-url: https://api.eu.mailgun.net
  domain: ${{ secrets.DOMAIN }}
  to: ${{ secrets.TO }}
```

## ⚠️ Deliverability Notes

If your email lands in spam, the cause is usually domain authentication rather than GitHub Actions itself.

Check these Mailgun and DNS settings:

- SPF is configured correctly for your sending domain
- DKIM records are valid and verified
- DMARC is configured for your domain
- Your Mailgun domain is active and verified
- If you use a sandbox domain, recipients are authorized in Mailgun

## 🛠️ Troubleshooting

### `Forbidden`

Common causes:

- API key and domain belong to different Mailgun regions
- You need `eu-region: true` or `api-base-url: https://api.eu.mailgun.net`
- The Mailgun domain is not active
- The recipient is not authorized for a sandbox domain

### `Undefined Mailgun API key`

Make sure your workflow passes `api-key` under `with:` and that the referenced secret exists.
