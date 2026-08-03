# Plan: configure a required reviewer on the npm-publish environment (#50)

Issue: [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) · Verified against repo settings on 2026-08-03. Revised after adversarial review.

## Root cause

The workflow code is already correct: `publish.yml` runs validation first (rejecting tags not reachable from `main` or mismatching `package.json`, `.github/workflows/publish.yml:33-59`), scopes `id-token: write` to the publish job, and gates that job on `environment: npm-publish`. But an environment gate only pauses a run if the environment has protection rules, and this one has none:

```
$ gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish \
    --jq '{name: .name, rules: [.protection_rules[].type]}'
{"name":"npm-publish","rules":[]}
```

So every **valid release tag** (one that passes validation) reaches `npm publish` with no human in the loop. This is repository configuration, not code — no PR can fix it. It requires repo admin permission (the owner, or any account granted Administration on the repo).

## Steps (admin, ~5 minutes)

1. Open **Settings → Environments → npm-publish**.
2. Enable **Required reviewers**; add at least one reviewer. Two notes:
   - With a single maintainer, this gate is an *approval pause*, not an independent review — the tagger approves their own release. That is still worth having (it stops runaway/accidental tag publishes), but if a second trusted maintainer exists, add them and enable **Prevent self-review** to make it a real four-eyes check.
   - Add a second reviewer where possible to avoid single-person deadlock on releases.
3. Under **Deployment branches and tags**, restrict to tags matching `v*`.
4. Save.

Via API (both halves — reviewers alone do not set the tag policy; they are separate operations):

```bash
# 1) required reviewers (+ optional prevent_self_review)
gh api -X PUT repos/karthikcsq/google-tools-mcp/environments/npm-publish \
  --input - <<'JSON'
{ "reviewers": [{ "type": "User", "id": <USER_ID> }],
  "prevent_self_review": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
# 2) tag policy
gh api -X POST repos/karthikcsq/google-tools-mcp/environments/npm-publish/deployment-branch-policies \
  -f name='v*' -f type='tag'
```

## Verification

```bash
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish \
  --jq '{rules: [.protection_rules[] | {type, reviewers: (.reviewers // [] | map(.reviewer.login))}],
         policy: .deployment_branch_policy}'
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish/deployment-branch-policies \
  --jq '.branch_policies[] | {name, type}'
```

must show `required_reviewers` **with the intended login(s)**, and a `v*` tag policy — not merely a non-empty rules array.

**Do not push a throwaway tag to test the gate.** A tag that reaches an approved publish consumes a real, immutable npm version, and an abandoned paused run invites an accidental approval later. Instead, verify the pause at the **next real release**: the run must stop between `validate` and `publish` awaiting approval. If a dry test is ever needed anyway, cancel the paused run from the Actions UI before anyone approves it, then delete the tag.

## Follow-up

- `RELEASING.md` already documents the reviewer requirement and approval step (`RELEASING.md:11-18, 30-38, 106-127`, added by PR #77). After configuring, re-read that section and fix any wording that no longer matches the actual settings (e.g., who the configured reviewers are) rather than adding a duplicate section.
- Close #50 with the verification output as evidence.
