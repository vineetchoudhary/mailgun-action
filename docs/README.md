# Development

Use Node.js 24 or newer. The action sends requests directly to the [Mailgun messages API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages) with Node's built-in `fetch` and `FormData`. It has no runtime or development npm dependencies.

```sh
npm ci --ignore-scripts
npm test
npm run package
npm run package:check
npm audit
```

Commit `dist/index.js` alongside changes to `index.js`. Packaging copies the source without a bundler, and `package:check` verifies that the shipped action matches it. Run the same tests against the packaged action with:

```sh
MAILGUN_TEST_ENTRYPOINT=../dist/index.js npm test
```

Tests use simulated Mailgun responses and local HTTP and HTTPS servers to verify multipart encoding, redirects, and proxy routing. Delivery tests launch the actual action in a separate process and verify US and EU endpoints, recipients, CC, Unicode, HTML, authentication, TLS validation, and workflow outputs. They require no Mailgun API key and send no email. The [public TLS fixture](../test/fixtures/README.md) is trusted only inside those test processes. CI tests the source and packaged action on Linux, macOS, and Windows with Node.js 24 and 26, checks packaging, and audits dependencies.

## Security behavior

- Templates read environment variables and event data through own-property paths. They cannot execute JavaScript or access prototype properties. Missing values produce empty text.
- Event data inserted into an HTML body is escaped. Literal HTML in the workflow template is preserved.
- API URLs must use HTTPS. Redirects are rejected to prevent credentials or message content from being forwarded to another endpoint.
- Requests, including response reads, have a 30-second timeout. Responses are limited to 1 MiB, and failed requests are not automatically retried.
- Self-hosted runner proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`, including lowercase variants) are supported through Node's native proxy handling. Proxy support requires Node.js 24.14 or newer on the runner.
- The API key and its Basic authentication encoding are masked before validation errors are reported. Reflected credentials are redacted from errors and response outputs.
- Workflow outputs use a unique delimiter. Error messages are escaped as workflow commands, and workflow examples pass response outputs through environment variables before printing them.
- Workflow actions use pinned commits from current releases. Dependabot checks npm and workflow actions weekly, including any dependencies added later.

## Updating existing templates

Replace Lodash expressions such as `{{ EVENT_PAYLOAD.action || "unknown" }}` with data paths such as `{{ EVENT_PAYLOAD.action }}`. Compute conditional values in a preceding workflow step when needed. `<% ... %>` blocks are treated as literal text.

HTML in interpolated values is displayed as text. Put formatting tags directly in the `body` template, for example `<strong>{{ EVENT_PAYLOAD.comment.body }}</strong>`.
