---
name: smartbi-platform
description: Operate Smartbi Insight V11 through a reverse-engineered HTTP API (RMIServlet + DataPackageServlet), with Playwright/CDP fallback for UI-only operations. Login with file credentials, list catalog trees, upload and import datasets, then build ETL/data models/dashboards/AIChat. Use when the user mentions Smartbi, SmartBI, platform automation, ETL, data models, dashboards, AIChat, or Smartbi troubleshooting.
---

# Smartbi Platform (API-driven)

## Purpose

Operate a configured Smartbi Insight V11 tenant as a stateful, evidence-first
workflow with two execution engines:

1. **Direct HTTP API** (preferred): reverse-engineered RMI protocol. Login,
   catalog traversal, and file import run without a browser. See
   `references/api.md` for the full wire format.
2. **Playwright over CDP** (fallback): headed-browser interaction for arbitrary
   canvas operations whose port or binding semantics cannot be inferred safely,
   plus final visual verification. Routine ETL, model, analysis, dashboard,
   AIChat, and catalog operations use the guarded API commands.

Core chain: `login → 数据连接(import) → 自助ETL → 数据模型 → 透视/仪表盘 → AIChat → validation`.

When `competition-2026` is active, the chain ends at AIChat. Agent remains a
general-tenant capability and every `agent-*` command fails closed.

### Platform-first data processing (hard rule)

Use Smartbi as the primary data-processing environment, not merely as a place
to display locally prepared results.

- Local work SHOULD stop at dataset discovery, download, authorization checks,
  and integrity checks. When Smartbi cannot read a source container, local work
  MAY perform the minimum lossless format conversion needed to produce a flat,
  one-record-per-row import file.
- Local code MUST NOT perform analytical filtering, missing-value treatment,
  deduplication, joins, derived indicators, aggregation, pivoting, ranking, or
  model-ready feature engineering unless the user explicitly approves an
  exception after the platform limitation is demonstrated.
- Perform those operations with visible Smartbi ETL nodes. A
  `source → 覆盖到关系表` flow, or a flow whose only transform is a sequence
  number, is not meaningful evidence of platform use and MUST NOT be delivered
  as a completed competition ETL.
- Choose transformations from the data contract: for example type conversion,
  missing-value handling, row-quality filters, duplicate removal, derived
  fields, grouping/aggregation, pivoting, and deterministic sorting. Do not add
  decorative nodes that leave the business result unchanged.
- Build downstream models, analyses, dashboards, and AIChat resources from the
  materialized Smartbi ETL output, preserving the visible lineage from imported
  source to submitted result.
- Local calculations MAY independently reconcile platform outputs, but MUST
  NOT replace the platform pipeline. Record both the Smartbi terminal-node
  preview and input/output row-field reconciliation as completion evidence.

### Dataset-boundary isolation (hard rule)

When a competition or evaluation will select exactly one final dataset, keep
every candidate dataset as an independent pipeline:

- Give each dataset its own catalog folder, imported source, ETL output, model,
  analyses, dashboard, and AIChat graph when AIChat is in scope.
- NEVER union, append, join, or otherwise combine candidate outcome rows in a
  shared ETL, model, dashboard, or AIChat graph before selection.
- Compare candidates only through an external evaluation scorecard or
  non-outcome metadata. Do not create a cross-dataset analytical artifact as a
  shortcut for selection.
- Validate each pipeline separately: terminal ETL state, output row count,
  single-source model lineage, analysis execution, and rendered dashboard
  charts. One successful candidate never proves another candidate works.

## Required References

Read what the task needs:

- `references/api.md` — official Java SDK contracts cross-checked against the live HTTP/RMI, import, Smartbix, and AIChat routes.
- `references/workflows.md` — reusable end-to-end procedures derived from official manuals.
- `references/playwright-patterns.md` — browser lifecycle, selectors, state detection, new-tab handling.
- `references/shared-tenant-guardrails.md` — shared-tenant privacy, evidence, naming, and delivery boundaries.
- `references/competition-guardrails.md` — optional 2026 competition profile, stage boundaries, data-source rules, AIChat limits, and prohibited Agent usage.

## Operating Contract

### Shared-tenant discipline (hard rules)

The platform account is **shared by multiple team members**. You MUST:

- **Never modify, delete, rename, or overwrite any resource not created by this namespace.**
  Foreign resources = anything whose name/alias does not carry the configured namespace in the selected prefix/suffix mode.
  The sole deletion exception is a legacy `BASETABLE` in the authenticated personal acquisition folder that the user identifies by exact name; use `resource-delete ... --confirm-name <exactName>`.
  This exception never applies to shared catalog folders or non-table resources.
- **Namespace every artifact you create** (tables, ETL flows, models, analyses,
  dashboards, folders). Configure a neutral team prefix or suffix through
  `SMARTBI_NAMESPACE` (default example: `TEAM_`). Format:
  `<namespace><dataset-name>` or `<dataset-name><namespace>`.
- Never create inside another member's folder. Import target is the personal
  acquisition space (`可导入数据库 > input > 数据采集空间 > <账号>`), which the
  API tool resolves automatically (`folderId=PERSONAL_NODE`).
- Deleting/overwriting/republishing requires explicit user confirmation in chat,
  even for own resources.
- Resource names are truncated server-side at 30 chars (table) — plan names accordingly.

### Credentials

- First-run wizard stores a two-line file (account on line 1, password on line
  2) at `~/.config/smartbi-platform/credentials.txt` with mode `0600`.
  Existing files are supported through `SMARTBI_CRED_FILE`.
- Persist the password only in that local credentials file. Never print, echo,
  return, commit, screenshot, or copy it into reports or shared notes.
- Never fill login fields from chat content.

### State machine

| State | Detection | Allowed next action |
|---|---|---|
| `auth_required` | `health` returns it | `login` with file credentials |
| `workspace` | `health` returns `workspace` | any API operation |
| `module` | browser UI shows module | module operation (UI) |
| `busy` | spinner/progress visible | wait for terminal state |
| `error` | non-zero retCode / red node | capture safe error, recover |

Never assume state from a previous call: `health` first.

## Installation and Environment Doctor

Read `README.md` for the complete installation and migration procedure. Before
first use, run:

```bash
./scripts/install.sh --check
```

The shell bootstrap can report a missing/unsupported Node.js before any MJS
code runs. The Node doctor then detects npm, reusable Playwright installations,
system or Playwright browsers, and CDP readiness. Node.js 20+ is required.
Playwright is optional for the API core and required only for the browser
fallback. Install it only when the report says it is missing:

```bash
./scripts/install.sh --install-playwright
# Add --with-browser only when no Chrome/Chromium is already available.
```

`doctor` is read-only. `--check` never installs software.

## First-Run Setup (guided)

On first load, configure the target tenant, credentials, and naming before any
platform operation. With a TTY, `setup` launches the secure wizard
automatically; the password is read with terminal echo disabled:

```bash
cd ~/.codex/skills/smartbi-platform
TMPDIR=/tmp node scripts/smartbi.mjs setup --interactive
```

The wizard asks for:

1. Smartbi Vision base URL (must end with `/vision`);
2. Smartbi login account;
3. Smartbi login password;
4. artifact naming mode (`prefix` or `suffix`);
5. namespace marker (for example `TEAM_` or `_TEAM`).
6. optional platform profile and school name for a scoped competition tenant.

For non-interactive provisioning, first create an external two-line credentials
file with mode `0600`, then configure both credentials and naming:

```bash
TMPDIR=/tmp node scripts/smartbi.mjs setup \
  --base-url https://host.example/smartbi/vision \
  --cred-file /path/to/credentials.txt \
  --namespace TEAM_ \
  --naming prefix
```

For the 2026 competition tenant, opt in explicitly; the profile is never
inferred from the hostname:

```bash
TMPDIR=/tmp node scripts/smartbi.mjs setup \
  --profile competition-2026 \
  --school-name 西北农林科技大学
```

Configuration is saved to `config.json` (gitignored and mode `0600` by
default). Environment variables override it per invocation:

| Variable | Meaning | Example |
|---|---|---|
| `SMARTBI_CONFIG_FILE` | alternate machine-local config path | `~/.config/smartbi-platform/config.json` |
| `SMARTBI_BASE_URL` | target Smartbi Vision root | `https://host.example/smartbi/vision` |
| `SMARTBI_CDP_URL` | headed-browser fallback CDP endpoint | `http://127.0.0.1:9222` |
| `SMARTBI_CRED_FILE` | credentials file path | `~/.config/smartbi-platform/credentials.txt` |
| `SMARTBI_CODEC_CACHE_FILE` | versioned frontend-coder cache | `~/.cache/smartbi-platform/transport-codec.json` |
| `SMARTBI_PLAYWRIGHT_PATH` | explicit Playwright package/entry | `/path/to/playwright` |
| `SMARTBI_BROWSER_PATH` | explicit Chrome/Chromium executable | `/path/to/chrome` |
| `SMARTBI_NAMESPACE` | namespace marker | `TEAM_` or `_TEAM` |
| `SMARTBI_NAMING` | `prefix` or `suffix` | `prefix` |
| `SMARTBI_PLATFORM_PROFILE` | optional profile id (`competition-2026` or `general`) | `competition-2026` |
| `SMARTBI_SCHOOL_NAME` | school name used by the competition resource folder | `西北农林科技大学` |

`setup` without a TTY prints safe guidance. `config` shows the effective
configuration and concrete idempotent naming examples without revealing secrets.

> Shared-tenant rule: the namespace marker distinguishes YOUR resources from
> other members'. Verify `config` output before creating anything.

### Optional competition profile

`competition-2026` is a thin policy layer over the reusable Skill. It is valid
only on `tiaozhanbei.cloud.smartbi.com.cn`; general tenants retain every normal
capability. The profile:

- reserves the direct personal-workspace folder
  `<school>-2026“揭榜挂帅”挑战杯擂台赛`;
- keeps imported source tables in the authenticated personal acquisition
  folder while placing ETL, models, analyses, dashboards, and AIChat resources
  under that competition folder;
- blocks Agent commands, requires `upload --source-url <public-http(s)-url>`,
  and rejects AIChat training counts above 10,000;
- permits only the official competition delivery stages documented in
  `references/competition-guardrails.md`.

Use `competition-home [--create] [--migrate-legacy]` to resolve, create, or
migrate the exact destination. It checks direct placement and observable
postconditions; never recreate this operation through manual browser clicks.

### Tenant migration and transport compatibility

The transport coder is discovered rather than assumed:

1. On the first transport call, fetch the tenant's `CodeHandler`,
   `ReplaceCoder`, `HexadecimalCoder`, and `ReserveCoder` frontend bundles.
2. Parse and structurally validate the live arrays/delimiters, then fingerprint
   all four resources with SHA-256.
3. Negotiate `SF1`, `SF2`, or `SF3` using only the read-only
   `AIextRemoteService.getCurrentUserName` probe.
4. Store the verified definition and selected algorithm in the private cache.
   Later processes re-fetch the bundles; an identical hash uses the cached
   definition, while a changed hash rebuilds it.
5. If bundle discovery is temporarily unavailable, use the last cache for the
   same base URL; only when no cache exists use the fixed known-good fallback.
6. On an encoded-response parse failure, refresh discovery and negotiate once.
   A second failure stops with an error instead of sending repeated requests.

Inspect or force this process with `codec-status [--refresh]`. Migration to
another V11 tenant therefore requires only `setup --base-url ...`, credentials,
and a namespace. A future server-side dynamic key, WASM coder, or incompatible
protocol deliberately fails closed and requires a new adapter.

## Fast Start

```bash
cd ~/.codex/skills/smartbi-platform
TMPDIR=/tmp node scripts/smartbi.mjs doctor         # Node/Playwright/browser

TMPDIR=/tmp node scripts/smartbi.mjs setup          # first-run guidance
TMPDIR=/tmp node scripts/smartbi.mjs config         # effective config
TMPDIR=/tmp node scripts/smartbi.mjs codec-status   # live hash/cache/algorithm
TMPDIR=/tmp node scripts/smartbi.mjs health         # auth_required first time
TMPDIR=/tmp node scripts/smartbi.mjs login          # reads credentials file
TMPDIR=/tmp node scripts/smartbi.mjs health         # workspace
TMPDIR=/tmp node scripts/smartbi.mjs tree           # catalog root
TMPDIR=/tmp node scripts/smartbi.mjs tree DS.input  # 可导入数据库
TMPDIR=/tmp node scripts/smartbi.mjs competition-home --create --migrate-legacy
TMPDIR=/tmp node scripts/smartbi.mjs catalog-audit <rootId>
TMPDIR=/tmp node scripts/smartbi.mjs folder-create <parentId> <name> [description]
TMPDIR=/tmp node scripts/smartbi.mjs resource-rename <parentId> <resourceId> <newAlias> --confirm-name <exactName>
TMPDIR=/tmp node scripts/smartbi.mjs resource-move <sourceParentId> <resourceId> <targetParentId> --confirm-name <exactName>
TMPDIR=/tmp node scripts/smartbi.mjs resource-copy <sourceParentId> <resourceId> <targetParentId> <newName> --confirm-name <exactName>
TMPDIR=/tmp node scripts/smartbi.mjs resource-delete <parentId> <resourceId> --confirm-name <exactName>
TMPDIR=/tmp node scripts/smartbi.mjs upload <csv> <name> --source-url <public-url> # source URL required only by competition-2026
TMPDIR=/tmp node scripts/smartbi.mjs etl-get <flowId>       # inspect saved ETL DAG
TMPDIR=/tmp node scripts/smartbi.mjs etl-row-number <flowId> row_number
TMPDIR=/tmp node scripts/smartbi.mjs etl-run <flowId>       # run and verify terminal preview
TMPDIR=/tmp node scripts/smartbi.mjs etl-node-list 派生列
TMPDIR=/tmp node scripts/smartbi.mjs etl-insert <flowId> DATAPREPARE_SAMPLE '{"fraction":"0.8","seed":"10"}' sample_train
TMPDIR=/tmp node scripts/smartbi.mjs analysis-profile <analysisId> metric_name,age_group,sex,metric_domain
TMPDIR=/tmp node scripts/smartbi.mjs analysis-repair <analysisId> <rowField> <measure> <rowLabel> <measureLabel> [description]
TMPDIR=/tmp node scripts/smartbi.mjs dashboard-repair-multi <dashboardId> <modelId> '<chartsJson>' [description]
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-fields <modelId>
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-build <modelId> survey_city,age_code
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-status <modelId>
# General tenants only; competition-2026 rejects every agent-* command:
TMPDIR=/tmp node scripts/smartbi.mjs agent-get <agentId>
TMPDIR=/tmp node scripts/smartbi.mjs agent-run <agentId> "请分析指定问题"
TMPDIR=/tmp node scripts/smartbi.mjs agent-deploy <agentId>
TMPDIR=/tmp node scripts/smartbi.mjs nav 数据准备     # browser fallback
TMPDIR=/tmp node scripts/smartbi.mjs manuals        # official manual links
```

## Tool Reference (`scripts/smartbi.mjs`)

| Command | Purpose | Output |
|---|---|---|
| `doctor [--require-browser]` | Detect Node.js, npm, Playwright, browser, and CDP readiness | safe environment report |
| `setup [flags]` | First-run guided config (tenant + credentials + naming) | `{action:"setup_done", saved}` |
| `config` | Show effective tenant/config + naming example | safe configuration |
| `codec-status [--refresh]` | Discover, hash, cache, and negotiate the frontend transport coder | source/fingerprint/algorithm |
| `login` / `health` | Authenticate and verify the workspace session | session state |
| `invoke <class> <method> [json]` | Read-only RMI discovery call; mutating and session-sensitive methods are refused | decoded `{retCode, result, ...}` |
| `api-get <path>` / `api-post <path> [json]` | Guarded Smartbix discovery/query replay; mutating paths are refused | decoded response |
| `plain-get <path>` / `plain-post <path> [json]` | Guarded `/smartbi/` discovery/query replay; mutating paths are refused | JSON/text response |
| `tree [id]` | List catalog children of node | `{parent, nodes:[...]}` |
| `catalog-audit <rootId>` | Recursively inventory a catalog subtree with parent IDs, paths, types, and namespace ownership | auditable catalog manifest |
| `competition-home [--create] [--migrate-legacy]` | Resolve/create the exact competition folder or relabel a direct legacy school folder | profile, folder, and placement receipt |
| `folder-create <parentId> <name> [description]` | Idempotently create one namespaced catalog folder | `{created,id,name,alias}` |
| `resource-rename <parentId> <resourceId> <newAlias> --confirm-name <exactName> [--description <text>]` | Rename one direct owned workspace resource or namespaced `BASETABLE` in the authenticated personal acquisition folder, with collision, permission, and post-save checks | rename receipt |
| `resource-move <sourceParentId> <resourceId> <targetParentId> --confirm-name <exactName>` | Move one owned resource with descendant/conflict checks and source/target postconditions | move receipt |
| `resource-copy <sourceParentId> <resourceId> <targetParentId> <newName> --confirm-name <exactName> [--description <text>]` | Copy one owned resource; folders use guarded recursive copy with rollback | copy receipt |
| `resource-delete <parentId> <resourceId> [--confirm-name <exactName>]` | Delete one direct owned child after permission and post-delete checks; exact-name confirmation is required for a legacy non-namespaced table and is accepted only in the authenticated personal acquisition folder | deletion receipt |
| `upload <file> [tableName] [--replace] [--source-url <url>]` | Import CSV/TXT/XLSX as a namespaced table; competition profile requires a public source URL; replacement must be explicit and schema-preserving | `{ok, table, tableRef, rows, fields, replaced}` |
| `etl-create <parentId> <sourceTableId> <targetTableId> <name> [rowNumber|-] [description]` | Build an owned source→optional row-number→materialized-output ETL | saved DAG |
| `etl-get <flowId>` / `etl-run <flowId>` | Inspect or execute one owned saved ETL | DAG / terminal node states |
| `etl-node-list [keyword]` | List live ETL node templates, ports, and config contracts | node summaries |
| `etl-insert <flowId> <nodeName> [configJson] [instanceKey]` | Idempotently insert/update one unary transform before the target | saved node/config summary |
| `etl-row-number <flowId> [column]` | Idempotently add/update `增加序列号` | `{changed,nodeId,column}` |
| `model-get <id>` / `model-create ...` / `model-clone ...` | Inspect, build, or clone a data model | model metadata |
| `analysis-get <id>` / `analysis-create ...` / `analysis-run <id>` / `analysis-profile <id> <field,...>` / `analysis-repair ...` / `analysis-clone ...` | Operate pivot analyses, profile candidate chart dimensions, and repair presentation metadata | definition / category profile / reconciled result |
| `dashboard-get <id>` / `dashboard-create ...` / `dashboard-create-multi ...` / `dashboard-repair-multi ...` / `dashboard-clone ...` | Operate API-generated dashboards; multi-chart commands persist titles, business labels, axis titles, and complete layout slots | definition / presentation audit / saved dashboard |
| `aichat-graph-list [keyword]` / `aichat-graph-status <modelId>` | List or inspect model-graph build state | graph status and selected fields |
| `aichat-graph-fields <modelId>` | Resolve selectable field names to fully qualified IDs | model field list |
| `aichat-graph-build <modelId> <field,...>` | Validate and idempotently build one owned model graph | terminal build result |
| `aichat-query <modelId> <prompt>` | Query an exact model and parse streamed artifacts | answer, tables, files |
| `aichat-report <modelId> <prompt>` | Generate and parse an AIChat report | answer, tables, files |
| `aichat-export <modelId> <path> <prompt>` | Persist the complete parsed AIChat result | output file summary |
| `agent-get <agentId>` | Inspect graph, parameters, and deployment state; general profile only | parsed Agent resource |
| `agent-create <parentId> <name> [desc] [systemPrompt] [userPrompt]` | Build a Start→LLM→Finish Agent from live node templates; general profile only | saved Agent summary |
| `agent-run <agentId> <question>` | Run one owned Agent and poll/read LLM output; general profile only | answer, tokens, node states |
| `agent-deploy <agentId>` | Idempotently publish one owned Agent; general profile only | deployment relation |
| `ui-open <resourceId>` | Open one owned catalog resource in the headed CDP browser | page title and URL |
| `ui-dashboard-check <resourceId>` | Open and assert one owned dashboard renders | title, chart count, visible text |
| `nav <module>` | Browser module navigation (CDP fallback) | `{state:"module", module, url}` |
| `manuals` | Official wiki links | map |

Artifact-creation commands apply `SMARTBI_NAMESPACE` (default `TEAM_`).
All artifact-creation commands verify the destination is the authenticated
personal workspace/Agent root or a namespaced descendant before mutation.
Catalog create/rename/move/copy/delete operations are first-class API commands.
Use Playwright only for a canvas or visual postcondition that has no stable API;
never manually click routine resource-management menus.
`upload` also truncates table names at the platform limit, resolves the
personal acquisition folder, validates preview fields, and polls until import
completes. Do not pass an existing table name unless you intend a schema-preserving
REPLACE import. Added, removed, or reordered fields fail closed; delete the owned
table with exact-name confirmation and import it anew when the schema changes.

## Beginner UI Map (verified live 2026-08-09)

Use the labels a first-time operator actually sees. The home page and sidebar
are module launchers; CLI names describe the underlying artifact.

| Sidebar module | Visible beginner path | Skill/API equivalent | Important distinction |
|---|---|---|---|
| `数据连接` | `文件` → `加载文件数据（上传文件）` → `新建数据表` | `upload` | Use a real Playwright click. A synthetic DOM click did not open this wizard. |
| `数据准备` | `数据集` for data models; `自助ETL` for transformation flows | `model-*`; `etl-*` | The landing-page card says `数据模型`, while the resource tree says `数据集`. |
| `分析展现` | `透视分析` first; then `交互式仪表盘` | `analysis-*`; `dashboard-*` | `即席查询` is a separate detail-query tool, not the pivot used for reconciliation. |
| `AIChat` | Opens a separate `Smartbi AIChat` page; choose `数据洞察` | `aichat-graph-*`; `aichat-query/report/export` | Graph construction remains under `运维设置 → AIChat系统选项`; chat and graph management are different screens. |
| `Agent` | Agent canvas and execution pages | `agent-*` | General tenants only. `competition-2026` prohibits Agent and fails closed. |

The browser may open a new tab for AIChat. Re-enumerate pages, select the tab
whose title is `Smartbi AIChat`, and verify the exact model before querying.

## Core Workflow

### 1. Data import (数据连接)

API path (preferred):

1. `health`/`login`.
2. `upload <file> <name>`.
3. Verify with `tree` on the personal acquisition folder (walk
   `DS.input → SCHEMA → 数据采集空间 → <账号>`).
4. Record row count, column types, and the namespaced table name.

Acceptance: table appears under the personal acquisition space with expected
name, row count, and field types; no foreign resource touched.

UI path (fallback): 数据连接 → 文件 → 新建数据表 → upload → 导入数据源
select `可导入数据库` → 导入数据. Select the tree node with a real Playwright
click (synthetic DOM events do NOT trigger selection).

Dataset readiness notes (verified):
- CSV must be standard one-row-header, flat table; merged cells break header detection.
- Server truncates table names at 30 chars and column aliases at 30 chars
  (dialog warning) — rename files/columns before upload.
- Platform auto-lowercases physical table names.
- Encoding: AUTO/UTF-8/GBK radio; default AUTO works for UTF-8 CSV.
- A BOM header on the first line is tolerated (observed with YRBSS CSVs).
- `--replace` preserves the existing Smartbi schema; field additions, removals,
  or reordering are rejected before insertion to prevent silent column loss.

### 2. Self-service ETL (数据准备)

API-first path, verified live:

1. Import an owned source table and, for materialized output, an owned target
   table with the intended schema.
2. Create the saved DAG directly:
   `etl-create <parentId> <sourceTableId> <targetTableId> <name> [rowNumber|-]`.
3. Inspect with `etl-get`; discover live node contracts with `etl-node-list`.
4. Add or update supported unary transforms with `etl-insert`, or use the
   idempotent `etl-row-number` helper.
5. Run with `etl-run`. Require the flow and every node to reach `FINISH`.
   Validate a terminal preview when available; for materialized output, reopen
   the target table and reconcile its fields and rows.
6. Use Playwright only for multi-input/output wiring or uncommon transforms
   whose port semantics are not safely inferable from the live node template.

Rules:
- API mutation/run is refused unless the flow name has the configured namespace.
- `etl-row-number` is idempotent and requires exactly one connectable sink.
- Derived columns and custom filters use Spark SQL syntax; verify null/type behavior.
- Never open or edit flows owned by other members.

### 3. Data model (数据准备)

1. `数据准备` → `数据集` (landing-page card: `数据模型`) → `数据源` →
   `数据表` → select the owned, namespaced table.
2. Flat survey files may use a one-table model; do not invent joins. For
   multi-table models, treat detected joins as proposals and verify keys,
   cardinality, and grain.
3. Confirm the model field count and reconcile a base total before saving.
4. Time hierarchies only on validated date fields; identifiers as unique-count
   measures; weights as summed measures when estimating weighted populations.
5. Save under the team folder with a namespaced name.

### 4. Analysis and dashboard (分析展现)

1. Build a `透视分析` first. Place one grouping dimension in rows, set the
   measure aggregation explicitly, replace technical field names with business
   labels, and remove an empty standalone filter panel. Run and reconcile the
   result against an independent computation.
2. Before choosing chart dimensions, run
   `analysis-profile <analysisId> <field,...>`. A categorical chart requires at
   least two usable non-blank categories; a one-category field belongs in a KPI
   card or note, not a comparison chart.
3. Create `交互式仪表盘` charts from the same model. Each chart must answer a
   different named question. Persist an exact title, business field labels,
   visible X/Y-axis titles, data labels, and a complete non-overlapping layout.
4. Save and reopen the dashboard. Verify every expected chart renders multiple
   categories where the profile predicted them; inspect the headed-browser
   screenshot, not only the saved JSON.
5. Use `analysis-repair` or `dashboard-repair-multi` to correct owned legacy
   artifacts. These commands reload the saved resource, audit presentation
   metadata, and rerun the analysis or dashboard contract after updating it.
6. For larger deliverables, continue with KPI cards, comparison/risk charts,
   detail tables, filters, and linkage. Every component must answer a named
   decision question; decorative or degenerate charts do not count.

### 5. AIChat

API path (preferred):

1. `aichat-graph-fields <modelId>` and select meaningful low-cardinality
   dimensions only (for example, city); never vectorize record IDs.
2. `aichat-graph-build <modelId> survey_city,age_code`. The command resolves
   fully qualified field IDs, validates data counts, refuses non-namespaced
   models, polls the build to terminal `SUCCESS`, and skips an identical
   successful rebuild.
3. Confirm with `aichat-graph-status <modelId>`, then use `aichat-query`,
   `aichat-report`, or `aichat-export` against that exact model.
4. Ask narrow questions naming the measure, aggregation, grouping, filters, and
   output precision. Reconcile every returned table/claim against the
   pivot or an independent calculation.

UI fallback: 运维设置 → AIChat系统选项 → 新建 → 全部资源 → 数据集 →
team folder → target model → `构建模型图谱`. Select the same field set, click
`校验`, require `校验通过`, confirm, refresh the graph list, and require the
exact namespaced model row to show `成功` plus build time/duration. Clicking the
main sidebar `AIChat` opens a separate `Smartbi AIChat` tab; choose `数据洞察`,
refresh its model picker after a new graph build, and verify the exact selected
model text before sending. For reports choose 技能 → 分析报告.

### 6. Agent

> This section applies only to the general profile. `competition-2026` prohibits
> Agent creation, inspection, execution, and deployment.

1. Create under the owned `SELF_AGENT_GRAPHS_*` folder with `agent-create`, or
   build in the UI as `开始 → 大模型 → 结束`.
2. Bind the LLM input variable to `会话变量 / 问句`. A Start-node custom field is
   metadata only; binding the LLM to that Start output does not receive the test
   dialog's question.
3. Set system/user prompts and map `大模型 / 返回内容` to the Finish node's
   Markdown output.
4. Save, then run `agent-run <agentId> <question>`. Accept only terminal
   `FINISH` plus a non-empty LLM `result_content`.
5. Publish with `agent-deploy`; verify `dataagent/deploy/agent/{id}` returns a
   persisted relation. Deployment is idempotent.
6. Only run or deploy namespaced Agents; do not modify shared or built-in ones.


## AI Decision Rules

- If a resource lacks the configured namespace, treat it as someone else's — read-only.
- If data is not authorized/de-identified, stop before upload.
- If a primary key is unclear, stop before creating an output table.
- If join cardinality is unclear, stop before saving a model.
- If AIChat disagrees with a validated pivot, trust the pivot and investigate.
- If a save/run result is not visibly successful, treat it as uncommitted.
- If the UI rerenders, discard old handles and locate again.

## Completion Evidence

- import → `upload` ok + table visible in personal acquisition tree + row/field check;
- ETL → terminal node success + expected field/row preview (and output table if materialized);
- model → grain and total reconciliation, plus join checks when joins exist;
- pivot/dashboard → business labels + no empty standalone filter portlet +
  reconciled values; dashboard definition audit + headed-browser screenshot +
  at least two usable categories for every comparison chart; filters/linkage
  exercised when present;
- AIChat → graph status success, exact model selected, and one reproducible query reconciled.
- Agent (general profile only) → saved Start→LLM→Finish graph, terminal
  `FINISH`, non-empty response, and persisted deployment relation when
  publication was requested.

Report exact artifacts created (all carrying the configured namespace), validation performed, and
unresolved blockers. Never report credentials, account identifiers, raw
sensitive values, or unredacted screenshots.
