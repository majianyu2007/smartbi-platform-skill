# Smartbi Official Workflow Reference

## Execution Engines

Prefer the reverse-engineered HTTP API (`references/api.md`) for anything it
covers: login, catalog traversal, file import. Use Playwright/CDP only for
UI-only operations (ETL canvas, dashboard, AIChat graph). The import flow
below has a full API implementation in `scripts/smartbi.mjs upload`.

## Sources

Competition entry and submission:

- Platform guide PDF summarized in `<private-project-notes>/04-报名平台与作品提交指南.md`
- Login: `https://smartbi.example.com/smartbi/vision/index.jsp`
- Challenge page: `https://smartbi.example.com/challenge`

Official Smartbi V11 help pages:

- Quick start: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=111897106`
- Quick data preparation and dashboard: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=113544835`
- 2026 competition manuals: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628225`
- Higher-education support scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628227`
- Financial collection scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629240`
- Order risk-warning scenario: `https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629228`

The three competition scenarios use the same five-stage platform chain. Differences are useful examples, not mandatory project schemas.

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

Common nodes shown in the competition manuals:

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

Verified hybrid pattern for a flat survey table:

1. Build and save the source node in the UI.
2. Read the saved DAG with `smartbi.mjs etl-get <flowId>`.
3. If the source has no stable identifier, add a deterministic row key with
   `smartbi.mjs etl-row-number <flowId> row_number`; choose a name that does
   not collide with an existing field.
4. Run with `smartbi.mjs etl-run <flowId>`.
5. Require flow state `FINISH`, every node `FINISH`, and a terminal preview
   containing the new key plus all expected source fields.
6. Keep this as a non-materialized preparation flow unless a downstream
   requirement specifically needs a new physical table.

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
Competition examples:

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

## Save And Recovery Discipline

- Save only after a coherent successful step.
- Use distinct names for raw, cleaned, model, analysis, and final resources.
- Do not overwrite a known-good artifact while experimenting.
- After an error, inspect the closest failing node/action; do not rebuild the whole chain blindly.
- After a UI rerender, reacquire all locators.
- For AIChat errors, first verify graph status and selected model, then the question.
