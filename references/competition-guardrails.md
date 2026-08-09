# 2026 “揭榜挂帅” Smartbi Competition Guardrails

This policy is optional. It applies only when `platformProfile.id` is
`competition-2026`; it MUST NOT reduce capabilities on a general Smartbi
Insight V11 tenant.

## Tenant and delivery boundary

- Required host: `tiaozhanbei.cloud.smartbi.com.cn`.
- Competition resource folder, directly under `我的工作区`:
  `<school>-2026“揭榜挂帅”挑战杯擂台赛`.
- Imported source tables remain in the authenticated personal acquisition
  folder because Smartbi imports cannot be persisted in the workspace folder.
- ETL flows, materialized models, pivot analyses, dashboards, and AIChat model
  graphs belong under the competition folder or its namespaced descendants.
- Submission deadline recorded for this event: 2026-09-01. Recheck the live
  submission portal before final delivery; never infer an extension.

Run `competition-home --create --migrate-legacy` instead of manually using the
resource-tree menu. It is idempotent, accepts only the direct personal-workspace
location, and verifies the saved folder after mutation.

## Allowed platform stages

The deliverable may use only this main chain:

1. 数据连接：import one declared public dataset;
2. 自助 ETL：perform meaningful, visible processing in Smartbi;
3. 数据模型：build the model from the materialized ETL output;
4. 透视分析／仪表盘：present reconciled business indicators;
5. AIChat：build the selected model graph and run reproducible questions or
   analysis reports;
6. AIChat graph configuration may add one required large-model node when the
   official task step calls for it.

Do not substitute Agent for stage 6. All `agent-*` commands fail closed while
this profile is active.

## Data-source restrictions

- Use only publicly accessible datasets with a traceable source page.
- Do not add private, purchased, partner-supplied, scraped-without-permission,
  or unrelated third-party data.
- `upload` requires `--source-url <public-http(s)-url>` while this profile is
  active. Local, loopback, private-network, credential-bearing, and non-HTTP(S)
  URLs are rejected.
- The source URL is provenance evidence, not proof of a compatible license.
  Verify access terms and redistribution rights before submission.
- Keep candidate datasets isolated. Never join or append outcome rows across
  candidates before the final dataset is selected.

## AIChat and Agent restrictions

- AIChat training data MUST NOT exceed 10,000 records. The graph-build command
  reads the tenant validation response and rejects a larger reported count
  before training starts.
- Select only useful low-cardinality dimensions; exclude direct identifiers.
- Agent creation, inspection, execution, and deployment are prohibited for this
  competition profile.
- Do not upload large-model files or add model providers outside the official
  tenant workflow.

## Resource management

- Every team-owned artifact keeps the configured namespace (`MJY_` in the
  current project). Visible aliases must add business meaning rather than only
  `FINAL`, `MODEL`, `DASH`, `CONTEXT`, or similar technical status words.
- Namespaced source/materialized tables in the authenticated personal acquisition
  folder may receive business aliases through `resource-rename`; their physical
  names and table IDs remain stable for ETL dependencies.
- Use `catalog-audit`, `folder-create`, `resource-rename`, `resource-move`,
  `resource-copy`, and `resource-delete`. Routine resource management MUST NOT
  be performed through manual Playwright clicks.
- Each mutation checks direct parent-child ownership, exact-name confirmation,
  target collisions, permissions, and postconditions. Folder copy is recursive
  and attempts rollback if a child copy fails.
- Never mutate another participant's resource. Physical internal names may stay
  stable when a visible alias is updated; IDs and dependency links must not be
  recreated merely to change display text.

## Completion evidence

Before submission, require all of the following:

- `catalog-audit` shows every namespaced workspace resource inside the exact
  competition folder;
- no temporary smoke-test resources remain;
- all ETL definitions load, all models load, every submitted analysis executes
  with a non-empty result, and every dashboard definition loads;
- one headed-browser visual check confirms the selected dashboard renders after
  the move;
- AIChat status is successful, uses the exact selected model, and returns at
  least one reconciled answer if AIChat is part of the final deliverable;
- the submission contains no Agent artifact and no undeclared third-party data.
