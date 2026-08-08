# Shared-Tenant and Data Guardrails

## Shared Tenant Discipline (hard rules, verified 2026-08-08)

The demo/competition tenant is shared by multiple team members. Violations here
are the single most expensive mistake possible in this project.

1. **A namespace prefix is mandatory** for every resource we create: tables,
   ETL flows, data models, analyses, dashboards, folders, AIChat graphs.
   The prefix is configurable via `SMARTBI_PREFIX`; on this machine it defaults
   to `TEAM_` to distinguish this user in the shared tenant.
   Format: `<prefix><数据集名称>` (e.g. `TEAM_survey_demo`).
2. **Anything without our prefix is someone else's.** Read-only at most; never
   modify, rename, delete, move, or overwrite it. Never import into their folders.
3. Our import target is the personal acquisition space
   (`可导入数据库 > input > 数据采集空间 > <账号>`, API `folderId=PERSONAL_NODE`).
4. Deleting/overwriting even our own resources requires explicit user
   confirmation in chat first.
5. Server truncates table names at 30 chars; keep `TEAM_` names ≤ 30 chars
   (prefix 4 + dataset ≤ 26 chars).

## Current Registered Work

The current registration form records:

- Problem: `<project-code> Smartbi AI驱动的数据创新平台研究`
- Work code: `<registration-code>`
- Registered title: `基于多粒度感知的青少年心理健康动态风险预警建模研究`

The earlier elderly-care direction in the vault is an archived alternative and must not be treated as the current implementation unless the user confirms a formal title change.

Project notes:

- `<private-project-notes>/00-项目导航与当前结论.md`
- `<private-project-notes>/01-Smartbi 赛题方案精读.md`
- `<private-project-notes>/02-视频精华与平台实操要点.md`
- `<private-project-notes>/04-报名平台与作品提交指南.md`
- `<private-project-notes>/05-报名表核验与正式申报信息.md`

## Data Boundary

Psychological-health data is highly sensitive. Before upload require:

- a documented lawful/authorized source;
- purpose limitation to the competition analysis;
- direct identifiers removed;
- unnecessary quasi-identifiers removed or generalized;
- no free text that can identify a participant;
- a field-level data dictionary;
- defined retention and sharing scope;
- human review of risk outputs;
- a clear statement that risk warning is not clinical diagnosis.

Do not upload registration forms, contact details, student IDs, precise addresses, raw interview text, or unredacted case records.

If real data is unavailable, simulated data must be explicitly labeled and generated from documented assumptions. Do not present simulated model performance as real-world effectiveness.

## Analysis Boundary

- Define the target decision user and intervention path.
- Separate screening/risk stratification from diagnosis.
- Report false-positive and false-negative behavior when labels permit.
- Check subgroup performance and avoid unsupported causal claims.
- Keep the human review/correction path visible in the dashboard and report.
- Every threshold needs a stated source or validation method.
- Every claimed improvement needs a reproducible baseline comparison.

## Competition Delivery

Current official project notes record:

- Platform implementation must use Smartbi BI or Smartbi AI.
- Core ETL, modeling, visualization, and AI analysis should be visible in Smartbi.
- Final works are sent to the designated competition email and copied to the designated address; they are not additionally uploaded to the Challenge Cup website.
- Include the registration-system-approved application form.
- Use the prescribed naming pattern recorded in `04-报名平台与作品提交指南.md`.
- Current project plan treats <submission-date> as the official work deadline and 2026-08-31 as the internal send date.

Do not publish credentials in reports, repositories, screenshots, or videos. Verify platform access and account validity before final delivery.

## Evidence To Preserve

For the final work keep:

- source and license/authorization record;
- data dictionary and sensitivity classification;
- cleaning rules and affected-row counts;
- ETL node success evidence;
- model table grain and join map;
- calculated measure definitions;
- dashboard filter/linkage test record;
- AIChat prompts, selected model, raw result, and human corrections;
- limitations, fairness checks, and human intervention process;
- final resource names and recovery/access instructions.

These are project evidence. Do not place credentials or raw sensitive records in the evidence bundle.
