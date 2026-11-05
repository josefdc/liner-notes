# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through
[GitHub's private vulnerability reporting](https://github.com/josefdc/liner-notes/security/advisories/new),
and not in a public issue. Include what you found, how to reproduce it and what it lets an attacker do.

This is a project maintained by one person, in their own time. Expect a first answer within a week.

## Supported versions

Fixes go to the latest release and to `main`.

## Scope

The static demo has no server, keys or user data. The rest applies to a deployment of the full stack:
the API, the audio service and the deployment files in `deploy/`, for example a way to spend a
deployment's model budget without a run token, to reach the audio service from outside, or to read
another visitor's data. [Privacy](docs/privacy.md) says what is stored.

Secrets are never committed. If you find one in the repository or its history, please report it here.
