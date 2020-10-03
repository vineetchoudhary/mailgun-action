# Mailgun Action
Github action to send an mail using the Mailgun API. This is a re-usable Github Action that you can use to send mail for any purposes every time some event trigger for a repository. 

## Inputs

### 1. api-key
**Required** Mailgun API Key.

### 2. domain
**Required** Your Domain Name.

### 3. to
**Required** Email address of the recipient(s). Example: bob@host.com. You can use commas to separate multiple recipients.

### 4. from
The email that will be shown as sender. Default will be hello@+your domain name. Like - hello@example.com

### 5. subject
Email subject. Default is "${GITHUB_ACTOR} (${GITHUB_EVENT_NAME}) at ${GITHUB_REPOSITORY}".

### 6. body
Body of the email (HTML Supported). Default is "${GITHUB_ACTOR} (${GITHUB_EVENT_NAME}) at ${GITHUB_REPOSITORY}".

### 7. cc
Email address to recieve carbon copies. Example: bob@host.com. You can use commas to separate multiple recipients.

## Outputs

### 1. response
Email response from Mailgun.

## Advance Usage
For subject and body we can use environment variables and event payload in following way - 

### 1. Environment Variables
Environment variables can be interpolated in the message using brackets (`{{` and `}}`). Like -
```
Action Called : {{ GITHUB_ACTION }}
```

### 2. Event Payload
Event Payload data can also be interpolated in the message using brackets (`{{` and `}}`) with the `EVENT_PAYLOAD` variable. Like - 

```
Action Called: {{ GITHUB_ACTION }} as {{ EVENT_PAYLOAD.pull_request.id }}
```
Check example section for more usages. Also see all [event types](https://developer.github.com/v3/activity/events/types/) for valid payload informations.


## Example Usage

### 1. Trigger default email on every push

```
name: On Push Email

on: [push]

jobs:
  send-mail:
    runs-on: ubuntu-latest
    name: Send email on every push
    steps:
    - name: Send Mail Action
      id: sendmail
      uses: vineetchoudhary/mailgun-action@v1.0
      with:
        api-key: ${{ secrets.API_KEY }}
        domain: ${{ secrets.DOMAIN }}
        to: ${{ secrets.TO }}
    - name: Send Mail Action Response
      run: echo "${{ steps.sendmail.outputs.response }}"
```

**Preview**
![](/docs/images/OnPush.png)

### 2. Trigger an email issue comment
Trigger an email when someone comment on a issue with custom subject and body.

```
name: Issue Activity

on:
  issue_comment:
    types: [created, edited, deleted]
    
jobs:
  send-mail:
    runs-on: ubuntu-latest
    name: Send email when issue created/edited/deleted
    steps:
      - name: Send Mail Action
        id: sendmail
        uses: vineetchoudhary/mailgun-action@v1.0
        with:
          api-key: ${{ secrets.API_KEY }}
          domain: ${{ secrets.DOMAIN }}
          to: ${{ secrets.TO }}
          subject: 'Issue Activity - {{ EVENT_PAYLOAD.action }}'
          body: '<p><b>Body</b> - {{ EVENT_PAYLOAD.comment.body }} <br /><br /><b>Issue Activity</b> - {{ EVENT_PAYLOAD.action }}.  <br /><br /><b>URL</b> - {{ EVENT_PAYLOAD.comment.html_url }}  <br /><br /><b>By</b> - {{ EVENT_PAYLOAD.comment.user.login }}</p>' 
      - name: Send Mail Action Response
        run: echo "${{ steps.sendmail.outputs.response }}" 
```

**Preview**
![](/docs/images/IssueComment.png)
