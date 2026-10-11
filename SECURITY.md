# Security Policy

## Supported Versions

- **Security fixes target:** Latest release of `@catbee/mysql` and the previous minor version when feasible.
- **Pre-releases are not supported** for security fixes.

## Reporting a Vulnerability

Do **not** open public issues for security reports.

- **Preferred:** Open a private advisory (GitHub > Security > Advisories > Report a vulnerability) if this repo is hosted on GitHub.
- **Alternative:** Email a private report to **security@catbee.in** with:
  - Affected package and version(s)
  - Environment details (Node.js, MySQL/MariaDB version, OS)
  - Impact assessment and PoC or reproduction steps
  - Any relevant logs, stack traces, or queries

We will acknowledge receipt within **3 business days** and triage within **7 days**. We will coordinate timelines and mitigation steps based on severity.

## Disclosure

We follow coordinated disclosure:

- Keep reports private until a fix or mitigation is available.
- We aim to publish fixes and a security advisory as soon as practical.
- **Default disclosure window:** 90 days, adjustable by mutual agreement.

## Scope of Testing

**Allowed:**

- Local testing against a private clone and test database
- Static and dynamic analysis that does not impact others

**Not allowed:**

- Denial of service against CI/CD or related infrastructure
- Exfiltration of non-public data or credentials
- Social engineering or attempting to access private systems

## Dependencies

We regularly update dependencies (e.g., via Renovate) and prioritize security updates.

- Consumers should keep dependencies current and run:
  - `npm audit`
  - `npm outdated`

## Notes for Consumers & Best Practices

- **Prevent SQL Injection:** Always use parameterized queries (positional `?` or named `:param` placeholders) or the fluent `QueryBuilder`. Never interpolate or concatenate untrusted user input directly into SQL strings.
- **Credential Management:** Avoid hardcoding database credentials or connection strings in source code; use secure environment variables or secret managers excluded from version control.
- **Principle of Least Privilege:** Configure MySQL database user accounts with only the minimum privileges needed for your application's operations.
- **Transport Security (SSL/TLS):** For remote databases and production environments, enable SSL/TLS encryption (`ssl` options) to protect credentials and data in transit.
- **Connection Limits & Timeouts:** Configure appropriate pool sizes (`connectionLimit`) and query timeouts (`defaultQueryTimeoutMs`) to prevent database resource exhaustion under high load.

## Contact

For urgent security matters: **security@catbee.in**
