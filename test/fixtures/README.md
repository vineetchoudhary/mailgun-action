# Local TLS fixture

`localhost-cert.pem` and `localhost-key.pem` are a public test identity. The key is deliberately included so the tests can start a local HTTPS server without external tools or npm dependencies. Never use this identity for a service.

The delivery tests trust this certificate only in their child action processes through `NODE_EXTRA_CA_CERTS`. A local proxy routes requests for Mailgun's US and EU hostnames to the test server. No request reaches Mailgun, and the tests use invented API keys and email addresses.

Regenerate the fixture with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config test/fixtures/tls.cnf -keyout test/fixtures/localhost-key.pem -out test/fixtures/localhost-cert.pem
```
