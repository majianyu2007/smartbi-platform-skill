---
name: smartbi-platform
description: Operate the Smartbi Insight V11 competition platform through a reverse-engineered HTTP API (RMIServlet + DataPackageServlet), with Playwright/CDP fallback for UI-only operations. Login with file credentials, list catalog trees, upload and import datasets, then build ETL/data models/dashboards/AIChat for the Smartbi Insight V11 platform. Use when the user mentions Smartbi, SmartBI, the Smartbi Insight V11 platform, platform automation, ETL, data models, dashboards, AIChat, or Smartbi troubleshooting.
---

# Smartbi Platform (API-driven)

## Purpose

Operate the Smartbi Insight V11 competition tenant as a stateful, evidence-first
workflow with two execution engines:

1. **Direct HTTP API** (preferred): reverse-engineered RMI protocol. Login,
   catalog traversal, and file import run without a browser. See
   `references/api.md` for the full wire format.
2. **Playwright over CDP** (fallback): UI-only construction (initial ETL
   source selection, data-model canvas, dashboard canvas, model-graph fields).
   Saved ETL flows can be inspected and run through the direct Smartbix API.

Core chain: `login → 数据连接(import) → 自助ETL → 数据模型 → 透视/仪表盘 → AIChat → validation`.

## Required References

Read what the task needs:

- `references/api.md` — reverse-engineered HTTP API: RMI encoding, session, catalog, import chain.
- `references/workflows.md` — end-to-end procedures from official competition manuals.
- `references/playwright-patterns.md` — browser lifecycle, selectors, state detection, new-tab handling.
- `references/competition-guardrails.md` — competition-specific privacy, evidence, naming, delivery boundaries.

## Operating Contract

### Shared-tenant discipline (hard rules)

The platform account is **shared by multiple team members**. You MUST:

- **Never modify, delete, rename, or overwrite any resource not created by this namespace.**
  Foreign resources = anything whose name/alias does not start with the team prefix.
- **Prefix every artifact you create** (tables, ETL flows, models, analyses,
  dashboards, folders). The prefix is configurable via `SMARTBI_PREFIX`
  (default `TEAM_` on this machine to distinguish this user in the shared
  tenant). Format: `<prefix><数据集名称>`.
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

## First-Run Setup (guided)

On first load, configure credentials and naming before any platform operation.
With a TTY, `setup` launches the secure wizard automatically; the password is
read with terminal echo disabled:

```bash
cd ~/.codex/skills/smartbi-platform
TMPDIR=/tmp node scripts/smartbi.mjs setup --interactive
```

The wizard asks for:

1. Smartbi login account;
2. Smartbi login password;
3. artifact naming mode (`prefix` or `suffix`);
4. namespace marker (for example `TEAM_` or `_MYTEAM`).

For non-interactive provisioning, first create an external two-line credentials
file with mode `0600`, then configure both credentials and naming:

```bash
TMPDIR=/tmp node scripts/smartbi.mjs setup \
  --cred-file /path/to/credentials.txt \
  --namespace TEAM_ \
  --naming prefix
```

Configuration is saved to `config.json` (gitignored and mode `0600` by
default). Environment variables override it per invocation:

| Variable | Meaning | Example |
|---|---|---|
| `SMARTBI_CONFIG_FILE` | alternate machine-local config path | `~/.config/smartbi-platform/config.json` |
| `SMARTBI_CRED_FILE` | credentials file path | `~/.config/smartbi-platform/credentials.txt` |
| `SMARTBI_NAMESPACE` | namespace marker | `TEAM_` or `_MYTEAM` |
| `SMARTBI_NAMING` | `prefix` or `suffix` | `prefix` |

`setup` without a TTY prints safe guidance. `config` shows the effective
configuration and concrete idempotent naming examples without revealing secrets.

> Shared-tenant rule: the namespace marker distinguishes YOUR resources from
> other members'. Verify `config` output before creating anything.

## Fast Start

```bash
cd ~/.codex/skills/smartbi-platform

TMPDIR=/tmp node scripts/smartbi.mjs setup          # first-run guidance
TMPDIR=/tmp node scripts/smartbi.mjs config         # effective config
TMPDIR=/tmp node scripts/smartbi.mjs health         # auth_required first time
TMPDIR=/tmp node scripts/smartbi.mjs login          # reads credentials file
TMPDIR=/tmp node scripts/smartbi.mjs health         # workspace
TMPDIR=/tmp node scripts/smartbi.mjs tree           # catalog root
TMPDIR=/tmp node scripts/smartbi.mjs tree DS.input  # 可导入数据库
TMPDIR=/tmp node scripts/smartbi.mjs upload <csv> <name>   # import as new table (auto-namespaced)
TMPDIR=/tmp node scripts/smartbi.mjs etl-get <flowId>       # inspect saved ETL DAG
TMPDIR=/tmp node scripts/smartbi.mjs etl-row-number <flowId> row_number
TMPDIR=/tmp node scripts/smartbi.mjs etl-run <flowId>       # run and verify terminal preview
TMPDIR=/tmp node scripts/smartbi.mjs etl-node-list 派生列
TMPDIR=/tmp node scripts/smartbi.mjs etl-insert <flowId> DATAPREPARE_SAMPLE '{"fraction":"0.8","seed":"10"}' sample_train
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-fields <modelId>
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-build <modelId> survey_city,age_code
TMPDIR=/tmp node scripts/smartbi.mjs aichat-graph-status <modelId>
TMPDIR=/tmp node scripts/smartbi.mjs agent-get <agentId>
TMPDIR=/tmp node scripts/smartbi.mjs agent-run <agentId> "请分析指定问题"
TMPDIR=/tmp node scripts/smartbi.mjs agent-deploy <agentId>
TMPDIR=/tmp node scripts/smartbi.mjs nav 数据准备     # browser fallback
TMPDIR=/tmp node scripts/smartbi.mjs manuals        # official manual links
```

## Tool Reference (`scripts/smartbi.mjs`)

| Command | Purpose | Output |
|---|---|---|
| `setup [flags]` | First-run guided config (credentials + naming) | `{action:"setup_done", saved}` |
| `config` | Show effective config + naming example | `{credFile, naming, example}` |
| `login` / `health` | Authenticate and verify the workspace session | session state |
| `invoke <class> <method> [json]` | Raw RMI call | decoded `{retCode, result, ...}` |
| `api-get <path>` / `api-post <path> [json]` | Guarded Smartbix API discovery/replay | decoded response |
| `plain-get <path>` / `plain-post <path> [json]` | Guarded `/smartbi/` plain-JSON API replay | JSON/text response |
| `tree [id]` | List catalog children of node | `{parent, nodes:[...]}` |
| `upload <file> [tableName]` | Import CSV/TXT/XLSX as a namespaced table | `{ok, table, rows, clientId}` |
| `etl-create <parentId> <sourceTableId> <targetTableId> <name> [rowNumber|-] [description]` | Build an owned source→optional row-number→materialized-output ETL | saved DAG |
| `etl-get <flowId>` / `etl-run <flowId>` | Inspect or execute one owned saved ETL | DAG / terminal node states |
| `etl-node-list [keyword]` | List live ETL node templates, ports, and config contracts | node summaries |
| `etl-insert <flowId> <nodeName> [configJson] [instanceKey]` | Idempotently insert/update one unary transform before the target | saved node/config summary |
| `etl-row-number <flowId> [column]` | Idempotently add/update `增加序列号` | `{changed,nodeId,column}` |
| `model-get <id>` / `model-create ...` / `model-clone ...` | Inspect, build, or clone a data model | model metadata |
| `analysis-get <id>` / `analysis-create ...` / `analysis-run <id>` / `analysis-clone ...` | Operate pivot analyses | definition / reconciled result |
| `dashboard-get <id>` / `dashboard-create ...` / `dashboard-clone ...` | Operate API-generated dashboards | definition / saved dashboard |
| `aichat-graph-list [keyword]` / `aichat-graph-status <modelId>` | List or inspect model-graph build state | graph status and selected fields |
| `aichat-graph-fields <modelId>` | Resolve selectable field names to fully qualified IDs | model field list |
| `aichat-graph-build <modelId> <field,...>` | Validate and idempotently build one owned model graph | terminal build result |
| `aichat-query <modelId> <prompt>` | Query an exact model and parse streamed artifacts | answer, tables, files |
| `aichat-report <modelId> <prompt>` | Generate and parse an AIChat report | answer, tables, files |
| `aichat-export <modelId> <path> <prompt>` | Persist the complete parsed AIChat result | output file summary |
| `agent-get <agentId>` | Inspect graph, parameters, and deployment state | parsed Agent resource |
| `agent-create <parentId> <name> [desc] [systemPrompt] [userPrompt]` | Build a Start→LLM→Finish Agent from live node templates | saved Agent summary |
| `agent-run <agentId> <question>` | Run one owned Agent and poll/read LLM output | answer, tokens, node states |
| `agent-deploy <agentId>` | Idempotently publish one owned Agent | deployment relation |
| `nav <module>` | Browser module navigation (CDP fallback) | `{state:"module", module, url}` |
| `manuals` | Official wiki links | map |

Artifact-creation commands apply `SMARTBI_NAMESPACE` (default `TEAM_`).
`upload` also truncates table names at the platform limit, resolves the
personal acquisition folder, and polls until import completes. Do not pass an
existing table name unless you intend a REPLACE import (needs confirmation).

## Core Workflow

### 1. Data import (数据连接)

API path (preferred):

1. `health`/`login`.
2. `upload <file> TEAM_<name>`.
3. Verify with `tree` on the personal acquisition folder (walk
   `DS.input → SCHEMA → 数据采集空间 → <账号>`).
4. Record row count, column types, and the `TEAM_` table name.

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

### 2. Self-service ETL (数据准备)

Hybrid path, verified live:

1. In the UI: 数据准备 → 自助ETL → team folder → 新建 → 自助ETL.
2. Add `关系数据源`, choose the owned `TEAM_` table, and save the flow with an
   `TEAM_` name. A one-source saved flow is a valid starting point.
3. Prefer the CLI for deterministic inspection and execution:
   `etl-get <flowId>` → `etl-row-number <flowId> row_number` → `etl-run <flowId>`.
4. Use the UI for transformations not yet exposed by the CLI
   (`去除重复值`/`数据清洗`/`行过滤`/`派生列`/`列选择`/`元数据编辑`).
5. Run and verify after every coherent DAG change. `FINISH` and a terminal
   preview with expected fields/rows are the acceptance signal.
6. Add an output node only when a materialized cleaned table is required.
   Creating a new relational output can require a primary key.

Rules:
- API mutation/run is refused unless the flow name has the configured namespace.
- `etl-row-number` is idempotent and requires exactly one connectable sink.
- Derived columns and custom filters use Spark SQL syntax; verify null/type behavior.
- Never open or edit flows owned by other members.

### 3. Data model (数据准备)

1. 数据模型 → `数据源` → `数据表` → select the owned `TEAM_` table.
2. Flat survey files may use a one-table model; do not invent joins. For
   multi-table models, treat detected joins as proposals and verify keys,
   cardinality, and grain.
3. Confirm the model field count and reconcile a base total before saving.
4. Time hierarchies only on validated date fields; identifiers as unique-count
   measures; weights as summed measures when estimating weighted populations.
5. Save under the team folder with an `TEAM_` name.

### 4. Analysis and dashboard (分析展现)

1. Build a pivot first. Place the grouping dimension in rows and set the
   measure aggregation explicitly; run and reconcile against an independent
   computation.
2. Save the pivot, then create an interactive dashboard from the model/pivot.
3. Bind the same validated dimension and measure to a chart. Use exact titles
   that name the metric and population; verify the preview after saving.
4. For larger deliverables, continue with KPI cards, comparison/risk charts,
   detail tables, filters, and linkage. Every component must answer a named
   decision question.

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
exact `TEAM_` model row to show `成功` plus build time/duration. In AIChat,
refresh the model picker after a new build and verify the exact selected model
text before sending. For reports choose 技能 → 分析报告.

### 6. Agent

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

- If a resource lacks the `TEAM_` prefix, treat it as someone else's — read-only.
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
- pivot/dashboard → saved preview with reconciled values; filters/linkage exercised when present;
- AIChat → graph status success, exact model selected, and one reproducible query reconciled.
- Agent → saved Start→LLM→Finish graph, terminal `FINISH`, non-empty response,
  and persisted deployment relation when publication was requested.

Report exact artifacts created (all `TEAM_`-prefixed), validation performed, and
unresolved blockers. Never report credentials, account identifiers, raw
sensitive values, or unredacted screenshots.
