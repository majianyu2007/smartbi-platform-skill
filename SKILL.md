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

- Two-line file (account, password) at
  `/Users/user/Desktop/Smartbi/smartbi-example-credentials.txt`
  (override via `SMARTBI_CRED_FILE`).
- Never print, echo, or persist the password anywhere; never put credentials in
  reports, repos, screenshots, or shared notes.
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

On first load, the AI SHOULD configure the tool before any platform operation.
Run `setup` with no arguments to see current state and guidance:

```bash
cd ~/.codex/skills/smartbi-platform
TMPDIR=/tmp node scripts/smartbi.mjs setup
```

Then persist the two required preferences:

```bash
# 1. Credentials: two-line file (line 1 account, line 2 password)
TMPDIR=/tmp node scripts/smartbi.mjs setup --cred-file /path/to/credentials.txt

# 2. Naming preference: prefix (default) or suffix, value is the team marker
TMPDIR=/tmp node scripts/smartbi.mjs setup --namespace TEAM_ --naming prefix
TMPDIR=/tmp node scripts/smartbi.mjs setup --namespace _MYTEAM --naming suffix
```

Configuration is saved to `config.json` (gitignored, machine-local).
Environment variables override it per-invocation:

| Variable | Meaning | Example |
|---|---|---|
| `SMARTBI_CRED_FILE` | credentials file path | `~/.../smartbi-example-credentials.txt` |
| `SMARTBI_NAMESPACE` | namespace marker | `TEAM_` or `_MYTEAM` |
| `SMARTBI_NAMING` | `prefix` or `suffix` | `prefix` |

`config` shows the effective configuration and a concrete name example.

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
TMPDIR=/tmp node scripts/smartbi.mjs nav 数据准备     # browser fallback
TMPDIR=/tmp node scripts/smartbi.mjs manuals        # official manual links
```

## Tool Reference (`scripts/smartbi.mjs`)

| Command | Purpose | Output |
|---|---|---|
| `setup [flags]` | First-run guided config (credentials + naming) | `{action:"setup_done", saved}` |
| `config` | Show effective config + naming example | `{credFile, naming, example}` |
| `login` | Authenticate from credentials file | `{state:"authenticated", retCode, result, user}` |
| `health` | Session + state check (auto re-login) | `{state:"workspace"\|"auth_required", user}` |
| `invoke <class> <method> [json]` | Raw RMI call | decoded `{retCode, result, ...}` |
| `tree [id]` | List catalog children of node | `{parent, nodes:[{id,name,alias,type,hasChild}]}` |
| `upload <file> [tableName]` | Upload+import CSV/TXT/XLSX as `TEAM_<name>` table | `{ok, table, rows, clientId}` |
| `etl-get <flowId>` | Inspect a saved ETL DAG without changing it | flow state, nodes, links |
| `etl-row-number <flowId> [column]` | Idempotently append/update `增加序列号` on one owned flow | `{changed,nodeId,column}` |
| `etl-run <flowId>` | Run one owned saved flow and poll to terminal state | node states + terminal preview shape |
| `nav <module>` | Browser module navigation (CDP) | `{state:"module", module, url}` |
| `manuals` | Official wiki links | map |

`upload` auto-prefixes with the namespace prefix (`SMARTBI_PREFIX`, default
`TEAM_`), truncates >30 chars, resolves the personal acquisition folder, and
polls until import completes. **Do not** pass an existing table name unless you
intend a REPLACE import (needs user confirmation).

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

1. 运维设置 → AIChat系统选项 → 新建 → 全部资源 → 数据集 → team folder →
   target model → `构建模型图谱`.
2. Select meaningful low-cardinality dimensions only (for example, city);
   never vectorize record IDs. Click `校验`, require `校验通过`, then confirm.
3. Close the resource picker, refresh the graph list, and require the exact
   `TEAM_` model row to show `成功` plus a build time/duration.
4. Open AIChat. If the newly built model is absent from the picker, refresh the
   picker and reload the AIChat page; then verify the exact selected model text.
5. Ask narrow questions naming the measure, aggregation, grouping, filters, and
   output precision. Wait until the stop button disappears, then reconcile the
   returned table against the pivot/independent calculation.
6. For reports: 技能 → 分析报告; verify every claim against data.

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

Report exact artifacts created (all `TEAM_`-prefixed), validation performed, and
unresolved blockers. Never report credentials, account identifiers, raw
sensitive values, or unredacted screenshots.
