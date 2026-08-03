# Plan: configure a required reviewer on the npm-publish environment (#50)

Issue: [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50) · Verified against repo settings on 2026-08-03.

## Root cause

The workflow code is already correct: `publish.yml` runs validation first, scopes `id-token: write` to the publish job, and gates that job on `environment: npm-publish`. But an environment gate only pauses a run if the environment has protection rules, and this one has none:

```
$ gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish \
    --jq '{name: .name, rules: [.protection_rules[].type]}'
{"name":"npm-publish","rules":[]}
```

So GitHub grants the environment instantly and every tagged push publishes to npm with no human in the loop. This is repository configuration, not code — no PR can fix it. Only someone with admin on the repo (the owner, karthikcsq) can.

## Steps (admin, ~5 minutes)

1. Open **Settings → Environments → npm-publish**.
2. Enable **Required reviewers**; add at least one reviewer (the repo owner at minimum; adding a second trusted reviewer avoids single-person deadlock on releases).
3. Under **Deployment branches and tags**, restrict to tags matching `v*` so the environment cannot be reached from arbitrary branches.
4. Save.

Alternatively via API (needs admin token; `<USER_ID>` from `gh api users/<login> --jq .id`):

```bash
gh api -X PUT repos/karthikcsq/google-tools-mcp/environments/npm-publish \
  -F "reviewers[][type]=User" -F "reviewers[][id]=<USER_ID>"
```

## Verification

```bash
gh api repos/karthikcsq/google-tools-mcp/environments/npm-publish \
  --jq '{name: .name, rules: [.protection_rules[].type]}'
```

must include `"required_reviewers"`. Then push the next release tag and confirm the run pauses between `validate` and `publish` waiting for approval — that pause is the acceptance test.

## Follow-up

- Note the approval step in `RELEASING.md` next to the tag-push instructions (PR #77 already documents the configuration gap; update that wording once the rule exists).
- Close #50 with the `gh api` output as evidence.
