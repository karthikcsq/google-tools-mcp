## Fixed

FIXED `078ba9472009a3a13703b666bedc94d6e384a5fc`

Before: the assembled multipart header exposed Gmail’s preferred bare fallback:
`Pr_sentation...tr_s-long-tr.pdf`.

After: non-ASCII filenames emit only RFC 2231 UTF-8 continuations, restoring the original long French/Japanese filename byte-for-byte. Long ASCII uses unencoded continuations; quote/semicolon coverage added. No push or GitHub action.

Test Suites: 1 passed, 1 total  
Tests: 77 passed, 77 total

---

The repository lacks the preferred Husky/lint-staged hooks; I left that unrelated setup unchanged.

