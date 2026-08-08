# Smartbi Platform Skill

**English** | [简体中文](README.zh-CN.md)

An API-first automation Skill for Smartbi Insight V11. It covers authentication, catalog operations, file import, self-service ETL, data models, pivot analyses, dashboards, AIChat, and Agents. Playwright/CDP is reserved for visual operations that cannot be inferred safely through the HTTP interfaces.

## Requirements

| Runtime | Required | Minimum | Auto-detected |
|---|---:|---|---:|
| Node.js | Yes | 20 or newer | Yes |
| npm | Only when installing Playwright | Bundled with Node.js | Yes |
| Playwright | No for API-only use; yes for browser fallback | Recommended `1.62.1` | Yes |
| Chrome/Chromium | Only for browser fallback | CDP-capable build | Yes |

The API core has no third-party npm dependency, so `npm install` is not required before first use.

## 1. Install the Skill

### Codex / Oh My Pi

```bash
git clone https://github.com/your-org/smartbi-platform-skill.git \
  ~/.codex/skills/smartbi-platform
cd ~/.codex/skills/smartbi-platform
./scripts/install.sh --check
```

For an existing checkout:

```bash
cd ~/.codex/skills/smartbi-platform
git pull --ff-only
./scripts/install.sh --check
```

For another client that supports Skill directories, clone or copy the repository into that client's Skill root and keep the directory name `smartbi-platform`.

### Windows

`install.sh` is intended for macOS and Linux. On Windows, run the same Node-based inspector directly:

```powershell
node scripts/install.mjs --check
```

## 2. Automatic Environment Detection

The installer checks:

1. whether Node.js exists and satisfies the 20+ requirement;
2. whether npm exists;
3. whether Playwright can be reused from the Skill, a managed installation, the OMP runtime, or an explicit path;
4. whether Chrome, Edge, Chromium, or Playwright Chromium is available;
5. whether a headed browser is reachable at `SMARTBI_CDP_URL`;
6. whether the API core and browser fallback are independently ready.

Human-readable report:

```bash
./scripts/install.sh --check
```

Machine-readable JSON:

```bash
./scripts/install.sh --check --json
```

The same check is available through the Skill CLI:

```bash
node scripts/smartbi.mjs doctor
node scripts/smartbi.mjs doctor --require-browser
```

`doctor` never reads or emits a password.

### Exit Codes

| Code | Meaning |
|---:|---|
| `0` | Node.js satisfies the requirement and the API core is ready |
| `1` | Inspection failed, or `--require-browser` requested an unavailable browser fallback |
| `2` | `install.sh` could not find Node.js, or found a version older than 20 |

## 3. If Node.js Is Missing

The POSIX bootstrap checks Node.js before it invokes any MJS file, so it can still provide a useful diagnosis when Node is absent.

Install a current Node.js LTS release from <https://nodejs.org/>.

```bash
# macOS with Homebrew
brew install node@22

# Windows
winget install OpenJS.NodeJS.LTS
```

On Linux, use the distribution package manager or an official Node.js package. Then rerun:

```bash
./scripts/install.sh --check
```

The installer reports the requirement; it does not modify the operating system or install Node.js automatically.

## 4. Decide Whether Playwright Is Needed

Playwright is **not required for the API core**. These operations work without opening a browser:

- authentication and catalog queries;
- file import;
- self-service ETL;
- data models;
- pivot analyses and API-generated dashboards;
- AIChat graph build, query, report, and export;
- Agent creation, execution, and deployment.

Only visual canvas editing and ETL nodes whose port semantics cannot be inferred safely require the Playwright fallback.

The inspector reuses Playwright in this order:

1. `SMARTBI_PLAYWRIGHT_PATH`;
2. Skill-local `node_modules/playwright`;
3. the managed installation under `~/.local/share/smartbi-platform/playwright`;
4. the OMP runtime under `~/.local/share/omp-playwright`;
5. normal Node module resolution.

If any reusable installation is found, Playwright is not installed again.

### Install Only the Playwright Module

```bash
./scripts/install.sh --install-playwright
```

The managed location is:

```text
~/.local/share/smartbi-platform/playwright
```

This installs the module without downloading an extra browser. It is sufficient when the host already has Chrome or Chromium for CDP.

### Install Playwright Chromium Too

```bash
./scripts/install.sh --install-playwright --with-browser
```

Installation must be requested explicitly. `--check` and `doctor` are always read-only.

## 5. Start a Headed Browser Fallback

macOS example:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/tmp/smartbi-playwright-profile-cdp \
  https://smartbi.example.com/smartbi/vision/index.jsp
```

Replace the example URL with the configured tenant and keep the browser running. Verify it with:

```bash
node scripts/smartbi.mjs doctor --require-browser
```

The default CDP endpoint is `http://127.0.0.1:9222`. Override it with `SMARTBI_CDP_URL`.

## 6. First-Run Configuration

Interactive setup:

```bash
node scripts/smartbi.mjs setup --interactive
```

The wizard requests:

1. the Smartbi Vision base URL, ending in `/vision`;
2. the login account;
3. the login password, with terminal echo disabled;
4. the naming mode: `prefix` or `suffix`;
5. a neutral namespace marker, such as `TEAM_` or `_TEAM`.

Non-interactive setup:

```bash
node scripts/smartbi.mjs setup \
  --base-url https://smartbi.example.com/smartbi/vision \
  --cred-file /path/to/credentials.txt \
  --namespace TEAM_ \
  --naming prefix
```

Credential file format:

```text
line 1: account
line 2: password
```

Keep the credential and generated configuration files at mode `0600`. Neither file belongs in version control.

## 7. Verify the Installation

```bash
node scripts/smartbi.mjs doctor
node scripts/smartbi.mjs config
node scripts/smartbi.mjs codec-status --refresh
node scripts/smartbi.mjs login
node scripts/smartbi.mjs health
```

Expected results:

- `doctor.readiness.apiCore` is `true`;
- `codec-status` reports a discovered `SF1`, `SF2`, or `SF3` transport;
- `login.retCode` is `0`;
- `health.state` is `workspace`.

To require the browser fallback as part of acceptance:

```bash
node scripts/smartbi.mjs doctor --require-browser
```

## 8. Migrate to Another Host or Tenant

Do not copy session cookies. On the new host:

1. clone the Skill;
2. run `./scripts/install.sh --check`;
3. install Node.js or Playwright only when the report says it is needed;
4. run `setup --interactive` for the new tenant, credential file, and namespace;
5. run `codec-status --refresh`.

The transport coder is rediscovered from the new tenant's frontend resources and cached independently by base URL and SHA-256 fingerprint. A mapping from one tenant is never reused for another tenant.

## 9. Environment Variables

| Variable | Purpose |
|---|---|
| `SMARTBI_CONFIG_FILE` | Configuration file path |
| `SMARTBI_BASE_URL` | Smartbi Vision base URL |
| `SMARTBI_CDP_URL` | Browser CDP endpoint |
| `SMARTBI_CRED_FILE` | Two-line credential file |
| `SMARTBI_CODEC_CACHE_FILE` | Transport-coder cache file |
| `SMARTBI_PLAYWRIGHT_PATH` | Playwright package directory or entry file |
| `SMARTBI_BROWSER_PATH` | Chrome/Chromium executable |
| `SMARTBI_NAMESPACE` | Resource namespace override |
| `SMARTBI_NAMING` | `prefix` or `suffix` |

## 10. Development Checks

```bash
npm test
# Equivalent:
node --test tests/*.test.mjs
```

Syntax checks:

```bash
node --check scripts/install.mjs
node --check scripts/transport-codec.mjs
node --check scripts/smartbi.mjs
sh -n scripts/install.sh
```

## Privacy and Safety

- Public documentation uses neutral tenant, account, dataset, namespace, and resource placeholders.
- The environment inspector reads only runtime versions, file presence, and CDP status; it installs nothing by default.
- Installing Playwright requires the explicit `--install-playwright` flag.
- Passwords are read only from the private credential file and never enter environment reports, logs, transport caches, or Git.
- Platform mutations remain protected by namespace and personal-workspace ownership checks.
- Keep private project titles, registration codes, delivery addresses, deadlines, and evidence outside this repository.
