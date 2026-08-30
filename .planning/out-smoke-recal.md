## Committed

Local commit: `841a2a7 live-smoke: recalibrate docs scenario expectations`

No push or GitHub action taken.

---

## Scenarios

- #107: The scenario used undeclared `range`; it now sends `target`. Its header records the misleading “The range to replace” schema prose. The checklist uses `target` too. On base, both fail because `replaceRangeWithMarkdown` is absent. On a fixed build, both should pass by exercising product behavior.

- #105: The scenario now accepts either JSON at or below 20× document text length, or a refusal that explicitly names `format='index'` as the usable alternative. A size-only refusal fails. On a fixed build, it passes only if the error includes that actionable alternative; otherwise it correctly remains failing.

The requested `gh issue view` was blocked by this environment’s unauthenticated GitHub CLI, so the #105 criterion follows the supplied issue evidence and fixed-build error behavior.

---

## Tests

`Test Suites: 47 passed, 47 total`