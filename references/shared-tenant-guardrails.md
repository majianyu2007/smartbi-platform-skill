# Shared-Tenant and Data Guardrails

## Shared Tenant Discipline

A Smartbi tenant may be shared by multiple teams. Treat ownership checks as a
hard safety boundary:

1. Configure a neutral namespace prefix or suffix for every resource created:
   tables, ETL flows, data models, analyses, dashboards, folders, AIChat graphs,
   and Agents. Example: `TEAM_survey_demo`.
2. Anything without the configured namespace is foreign. It may be inspected
   only when necessary and must never be modified, renamed, deleted, moved,
   overwritten, run, or deployed.
3. Import only into the authenticated user's personal acquisition space
   (`可导入数据库 > input > 数据采集空间 > <current account>`).
4. Deleting, overwriting, replacing, or republishing even an owned resource
   requires explicit user confirmation.
5. Smartbi may truncate resource names. Preserve the complete namespace marker
   when shortening the descriptive part.

## Repository Privacy

Public examples and documentation must use neutral placeholders:

- tenant: `https://smartbi.example.com/smartbi/vision`;
- namespace: `TEAM_` or `_TEAM`;
- account: `<account>`;
- resource IDs: `<resourceId>`, `<modelId>`, or generated test fixtures;
- datasets: `survey_demo` or similarly non-identifying names.

Never publish:

- real account names, phone numbers, email addresses, or organization IDs;
- passwords, cookies, session IDs, access tokens, or credential-file contents;
- private tenant hosts or browser-profile paths;
- registration codes, internal project titles, private note paths, or deadlines;
- screenshots containing user names, resource identifiers, or sensitive data.

## Data Boundary

Before uploading any dataset, require:

- a documented lawful or authorized source;
- a stated purpose and retention period;
- direct identifiers removed;
- unnecessary quasi-identifiers removed or generalized;
- no free text that can identify a participant;
- a field-level data dictionary and sensitivity classification;
- defined access and sharing scope;
- human review of risk-related outputs.

Do not upload registration forms, contact details, student IDs, precise
addresses, raw interview text, or unredacted case records.

If real data is unavailable, simulated data must be explicitly labeled and
generated from documented assumptions. Do not present simulated performance as
real-world effectiveness.

## Analysis Boundary

- Define the target decision user and intervention path.
- Separate screening or risk stratification from diagnosis.
- Report false-positive and false-negative behavior when labels permit.
- Check subgroup performance and avoid unsupported causal claims.
- Keep the human review and correction path visible.
- Give every threshold a source or validation method.
- Give every claimed improvement a reproducible baseline comparison.

## Delivery Boundary

- Keep core ETL, modeling, visualization, and AI analysis reproducible.
- Follow the organizer's current submission channel and naming requirements;
  do not encode private delivery details in this repository.
- Verify platform access and account validity before final delivery.
- Never place credentials or raw sensitive records in reports, repositories,
  screenshots, videos, or evidence bundles.

## Evidence To Preserve Privately

- source and license or authorization record;
- data dictionary and sensitivity classification;
- cleaning rules and affected-row counts;
- ETL terminal-state evidence;
- model table grain and join map;
- calculated-measure definitions;
- dashboard filter and linkage test record;
- AIChat prompts, selected model, raw result, and human corrections;
- limitations, fairness checks, and human intervention process;
- final resource names and recovery instructions.

Store private evidence outside the public Skill repository.
