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
- Recheck the live submission portal for the current deadline before final
  delivery; never store participant-specific deadlines in this repository.

Run `competition-home --create` instead of manually using the resource-tree
menu. To relabel a direct legacy school folder, use
`competition-home --migrate-legacy --confirm-name <exactLegacyFolderName>`.
Migration requires the exact selected name, write permission, direct personal-
workspace placement, and a verified saved result.

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
  active. The URL is validated provenance metadata only: it is never fetched,
  persisted, or substituted for the local file bytes. Local/private names and
  address literals, credential-bearing URLs, non-HTTP(S) URLs, DNS failures, and
  hostnames with any private DNS answer are rejected. A validated public URL is
  still not proof of ownership or a compatible license; verify access terms and
  redistribution rights before submission.
- Keep candidate datasets isolated. Never join or append outcome rows across
  candidates before the final dataset is selected.

## AIChat and Agent restrictions

- AIChat training data MUST NOT exceed 10,000 records. The graph-build command
  requires the exact candidate parent/model/name and current same-folder ETL
  evidence, reads every available tenant count, proves independent target count
  provenance, and rejects any larger or ambiguous count before training starts.
- Select only useful low-cardinality dimensions; exclude direct identifiers.
- Agent creation, inspection, execution, and deployment are prohibited for this
  competition profile.
- Do not upload large-model files or add model providers outside the official
  tenant workflow.

## Resource management

- Every team-owned artifact keeps the configured namespace (`TEAM_` in public
  examples). Visible aliases must add business meaning rather than only
  `FINAL`, `MODEL`, `DASH`, `CONTEXT`, or similar technical status words.
- Namespaced source/materialized tables in the authenticated personal acquisition
  folder may receive business aliases through `resource-rename`; their physical
  names and table IDs remain stable for ETL dependencies.
- Use `catalog-audit`, `folder-create`, `resource-rename`, and
  `resource-delete`; `resource-move` and `resource-copy` are general-profile
  commands only. Routine resource management MUST NOT use manual Playwright.
- Competition mode rejects generic `resource-move` and `resource-copy`; build
  artifacts in their final candidate folder instead of relocating or cloning
  them across lineage boundaries.
- Each mutation checks direct parent-child ownership, exact-name confirmation,
  target collisions, permissions, and postconditions. Every deletion,
  materialized overwrite, saved-flow mutation, model full-definition mutation,
  analysis/dashboard repair, Agent run/deployment, and legacy-folder migration
  requires the applicable exact selected name. Dashboard repair is
  transactional and verifies restoration after a failed update. Folder copy is
  available only on general tenants and rolls back invocation-created children
  when a child copy fails.
- Keep physical names stable when a visible alias is updated; IDs and dependency
  links must not be recreated merely to change display text.

## Completion evidence

Before submission, require all of the following:

- `catalog-audit` shows every namespaced workspace resource inside the exact
  competition folder;
- no temporary smoke-test resources remain;
- all ETL definitions load; the exact current ETL instance has every saved node
  successful, a typed terminal preview, and an exact reopened target schema;
  target rows are independently reconciled because the API receipt reports
  `reconciled:false`;
- all models load with exact source identity and deep semantic equivalence;
  every submitted analysis returns a non-empty `executionPreview`; and every
  dashboard definition and interaction contract reloads exactly;
- one headed-browser visual check at the final location confirms the selected
  dashboard renders and every configured filter/linkage/jump behaves as saved;
- AIChat graph status is successful, the request binds exactly one selected
  model with outside context disabled, and at least one returned answer is
  independently reconciled if AIChat is part of the final deliverable;
- the submission contains no Agent artifact and no undeclared third-party data.
