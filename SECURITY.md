# Security policy

apitame is a safety layer between agents and real systems, so security reports are taken seriously and handled quickly.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please report privately through [GitHub security advisories](https://github.com/albert-canfield/apitame/security/advisories/new). Do not open a public issue.

Include:

- what an agent or attacker can do that the [safety model](docs/safety.md) says it should not (for example run a write in read-only mode, bypass confirmation, read a denied table, or see a secret);
- the config, spec or SQL needed to reproduce it;
- the apitame version and Node.js version.

You can expect an acknowledgement within 3 working days and a fix or mitigation plan within 14 days for confirmed issues. Credit is given in the release notes unless you prefer otherwise.

## In scope

- Bypassing read-only mode, the write allowlist, confirmation or dry run.
- SQL that passes the guard and modifies data, runs side-effect functions, reads denied tables or escapes the read-only transaction.
- Secrets appearing in tool results, errors, logs or previews.
- The HTTP transport accepting requests it should refuse (Host, Origin or token checks).

## Out of scope

- Behavior that requires editing `apitame.config.yaml`: the config file is trusted.
- Data the configured credentials are allowed to read (see "What apitame does not protect against" in [docs/safety.md](docs/safety.md)).
- Vulnerabilities in the APIs or databases apitame connects to.
