# Smartbi Official Workflow Reference

## Execution Engines

Prefer the reverse-engineered HTTP API (`references/api.md`) for anything it
covers: login, catalog traversal, file import. Use Playwright/CDP only for
UI-only operations (ETL canvas, dashboard, AIChat graph). The import flow
below has a full API implementation in `scripts/smartbi.mjs upload`.

## Sources

Tenant and delivery inputs:

- Login URL: `<configured Smartbi Vision base URL>/index.jsp`.
- Keep organizer-specific registration pages, submission addresses, internal
  notes, and deadlines outside the public Skill repository.

Official Smartbi V11 help pages:

- Quick start: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=111897106`
- Quick data preparation and dashboard: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=113544835`
- Reusable scenario manuals: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628225`
- Higher-education support scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628227`
- Financial collection scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629240`
- Order risk-warning scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629228`

The documented scenarios use the same five-stage platform chain. Their schemas are examples, not mandatory project designs.

## Stage 0: Keep preprocessing on the platform

The imported source SHOULD be the closest platform-readable representation of
the acquired dataset. Local work is limited to discovery, download, integrity
checks, authorization checks, and—only when required—lossless conversion from
an unsupported container such as SAV/SAS/Stata to a flat record-level CSV.

Do not locally filter cohorts, recode missing values, deduplicate, join,
calculate indicators, aggregate, pivot, or produce dashboard-ready marts.
Implement those steps as named Smartbi ETL nodes. A local calculation is
permitted only as an independent reconciliation check after the platform result
exists. If Smartbi cannot perform a required operation, capture the failing
platform attempt and obtain explicit user approval before using a local
exception.

For competition delivery, the saved DAG itself is evidence. A direct
`关系数据源 → 覆盖到关系表` copy and a row-number-only flow are incomplete.
Each flow must expose the transformations that materially produce its submitted
output, and downstream artifacts must read that ETL output.

## Stage 1: Import files

Official sequence:

1. Left sidebar `数据连接`.
2. Choose `文件`.
3. Select `新建数据表`.
4. Upload local Excel tables.
5. For each table set `导入数据源` to `数据连接 > 可导入数据库`.
6. Use `应用全部` only when every uploaded table has the same destination.

AI translation:

- Input contract: approved file path, expected sheets/tables, target folder/database, expected columns.
- Before upload: check authorization, file type, table naming, duplicates, and whether the source contains identifiers or sensitive fields.
- After upload: compare discovered table/sheet names to the expected set; preview samples without printing sensitive values; record row counts and inferred field types.
- Stop on unexpected worksheets, missing columns, type coercion, or failed import.

## Stage 2: Self-service ETL

Official common sequence:

1. `数据准备` → resource tree `自助ETL` → team folder.
2. Right-click folder → `新建` → `自助ETL`.
3. Add `关系数据源`; choose an imported table.
4. Run current node.
5. Add transformation nodes as required.
6. Run every configured node immediately.
7. Add output node.
8. Save the flow.

Common nodes shown in the scenario manuals:

| Node | Purpose | Required AI check |
|---|---|---|
| `关系数据源` | Read imported relational table | Correct source and expected schema |
| `去除重复值` | Deduplicate by chosen columns | Key definition and removed-row count |
| `数据清洗` | Standard cleaning operation | Output field and cleaning rule |
| `行过滤` | Retain rows matching expression | Expression direction and retained count |
| `派生列` | Create calculated field | Spark SQL/function syntax, type, null behavior |
| `列选择` | Keep required fields | No downstream-required field removed |
| `元数据编辑` | Rename fields/aliases or adjust metadata | Unique names and stable business meaning |
| `插入/更新关系表` | Upsert to target table | Primary key, insert/update semantics |
| `覆盖到关系表` | Replace target table | Explicit user confirmation if target exists |

Official operational signals:

- Run the current node after each configuration.
- Green check means success.
- Red exclamation means failure; right-click and inspect logs.
- New output tables may require a primary key.
- Some derived-column and custom-filter expressions use Spark SQL syntax.

Minimum reconciliation after ETL:

- input rows;
- output rows;
- duplicate rows removed;
- filtered rows removed;
- null/type conversion counts;
- primary-key uniqueness;
- a small safe sample checked against rules.

Competition acceptance gate:

- The imported source is record-level or otherwise minimally transformed.
- Every analytical filter, recode, cleaning rule, derived indicator,
  aggregation, pivot, and ranking operation is represented by a configured
  Smartbi node whose business purpose is documented.
- Decorative no-op nodes do not count.
- A run is accepted only when every node succeeds, the materialized output is
  reopened, and the reconciled row/field counts match the documented rules.
- The data model, analyses, dashboard, and AIChat graph use the materialized ETL
  output rather than a separately prepared local mart.

Verified API-first pattern for a flat survey table:

1. Import namespaced source and target tables; the target defines the intended
   materialized schema.
2. Create the DAG with
   `smartbi.mjs etl-create <parentId> <sourceTableId> <targetTableId> <name> [rowNumber|-]`.
3. Inspect the saved DAG with `etl-get` and the live node catalog with
   `etl-node-list`.
4. Add supported unary transforms with `etl-insert`; use `etl-row-number` when
   a deterministic row key is required and will be represented downstream.
5. Run with `etl-run`; require the flow and every node to reach `FINISH`.
6. Validate the terminal preview when the platform exposes one. For a
   materialized target, reopen the table and reconcile schema and row counts.
7. Fall back to the headed UI only for multi-port wiring or transformations
   whose live port contracts cannot be inferred safely.

## Stage 3: Data model

Official sequence:

1. `数据准备` → `数据模型`.
2. Add all cleaned fact and dimension tables.
3. Review automatically detected relations.
4. Manually add missing relations.
5. Create time hierarchies such as year, year-quarter, year-month, year-month-day.
6. Convert fields to measures when required.
7. Add calculated columns and calculated measures.
8. Save.

AI model checklist:

- Define one sentence for each table's grain.
- Prefer a star model: dimensions on the one side, fact tables on the many side.
- Validate every key pair and cardinality.
- Verify no many-to-many relation is accidental.
- Compare fact row counts before/after joins.
- Check that identifiers use unique count, not sum.
- Record every calculated measure formula, format, and business definition.
- Use a generated date table only when its range covers all facts.


For one-row-per-respondent survey data, a single-table model is valid. Add the
owned table once, do not invent joins, preserve respondent grain, and reconcile
an unweighted count plus the sum of the survey weight before saving.
Documented examples:

- Higher-education scenario: four activity/fact tables connect to student base information by student ID; most are many-to-one, tuition record is one-to-one.
- Order warning scenario: product, customer, and equipment dimensions connect to the order result fact through their IDs.
- Financial collection scenario: customer, order, invoice, payment, credit, and date data require multiple keys and calculated measures such as collection rate and risk counts.

## Stage 4: Analysis

### Pivot analysis

Official sequence:

1. From model toolbar choose `新建分析` → `透视分析`, or enter through `分析展现`.
2. Assign fields to row, column, and measure areas.
3. Add filter fields and values.
4. Set aggregation explicitly.
5. Save.

Use pivot analysis first to validate dimensions, totals, filters, and calculated measures before building a dashboard.

### Interactive dashboard

Official sequence:

1. Choose `交互式仪表盘`.
2. Reuse a layout from `设计库 > 模板`, or design with `组件`/`设计库`.
3. Add KPI cards.
4. Add charts and bind dimensions/measures to chart roles.
5. Configure aggregation and global sorting.
6. Add filters and set defaults.
7. Configure `应用于组件` so filters affect only intended components.
8. Save.

Recommended AI build order:

1. KPI cards for population/volume/risk.
2. Trend or comparison chart.
3. Risk or category distribution.
4. Actionable detail table.
5. Time/population/risk filters.
6. Linkage and drill behavior.
7. Titles that state conclusions.

Do not mechanically copy the manuals' chart types. Select a chart that answers the project's decision question.

Verified minimal first-round pattern:

- pivot rows: one categorical dimension (for example, survey city);
- pivot measure: explicit `SUM(sample_weight)`;
- dashboard: one bar chart bound to the same dimension and measure;
- title: state the population and metric rather than using a generic chart name;
- acceptance: saved dashboard preview displays the expected categories and
  weighted values, matching the independent aggregate.

## Stage 5: AIChat

### Build a model graph

Official sequence:

1. `运维设置` → `AIChat系统选项`.
2. `全部资源` → `数据集` → team folder → target model.
3. Choose `构建模型图谱`.
4. Select dimensions to expose.
5. Confirm and wait for completion.

### Query

1. Left sidebar `AIChat`.
2. AIChat opens a separate page/tab in the current tenant.
3. Select the graph-enabled model.
4. Ask a precise data question.
5. Verify returned filters, dimensions, aggregations, and values against pivot/model results.

Strong query template:

```text
Using <model>, for <population> during <time range>, calculate <metric definition>,
group by <dimensions>, apply <filters>, return <table/chart>, and state the exact
filters and aggregation used. Do not infer causes not supported by the data.
```

Verified graph/query acceptance:

- Select only useful low-cardinality dimensions for vectorization; exclude IDs.
- Require `校验通过`, then wait for graph status `成功`.
- Reload AIChat if the new model is not present in its cached model catalog.
- Confirm the exact model name in the prompt footer before sending.
- Completion is when the stop button disappears and the result table is shown.
- Reconcile every returned value against the validated pivot or local weighted
  aggregate before using the prose conclusion.

### Analysis report

1. In AIChat choose `技能`.
2. Select `分析报告`.
3. Provide scope, structure, target audience, required charts, and limits.
4. Generate the draft.
5. Verify numbers, chart references, terms, causal language, and recommendations.
6. Remove unsupported claims and add limitations.

## Stage 6: Agent

### Minimal verified graph

1. Open `新建智能体`; add exactly `开始`, `大模型`, and `结束`.
2. Connect Start→LLM→Finish.
3. In Start, define the optional String field `question` for graph metadata.
4. In LLM, bind input variable `question` to `会话变量 / 问句`, select the
   default LLM, set system and user prompts, and choose Markdown output.
5. In Finish, select `大模型 / 返回内容` and the Markdown channel.
6. Save with an owned namespaced name.
7. Run a real question. Require every node to reach `FINISH` and read the
   LLM output at `dataagent/output/{llmNodeId-instanceId}`.
8. Publish and verify a deployment relation exists.

CLI:

```bash
node scripts/smartbi.mjs agent-create <parentId> <name> "<desc>" "<systemPrompt>" "<userPrompt>"
node scripts/smartbi.mjs agent-run <agentId> "question"
node scripts/smartbi.mjs agent-deploy <agentId>
node scripts/smartbi.mjs agent-get <agentId>
```

Critical binding rule: selecting `开始-输出1 / question` for the LLM leaves
the test question empty. The test runner supplies the question as
`会话变量 / 问句`; bind that exact source.


## Save And Recovery Discipline

- Save only after a coherent successful step.
- Use distinct names for raw, cleaned, model, analysis, and final resources.
- Do not overwrite a known-good artifact while experimenting.
- After an error, inspect the closest failing node/action; do not rebuild the whole chain blindly.
- After a UI rerender, reacquire all locators.
- For AIChat errors, first verify graph status and selected model, then the question.
