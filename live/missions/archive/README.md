# Archived missions

These are the iteration transcripts of the live agent loop, kept verbatim as the
record of what an independent agent did when handed a goal and nothing else.
They are not regression missions and are not meant to pass:

- `meeting-notes-friction-loop-1.mjs` records a `help` friction unconditionally,
  because that is what the agent hit.
- `meeting-notes-loop-2.mjs` calls `formatCells` with the nested Google Sheets
  API `CellFormat` shape and then throws when it is rejected. Rejecting that
  shape with an actionable message *is* the fix that iteration produced, so on
  current code this mission always ends `status: fail`.

The defects these two surfaced are pinned by `../agent-loop-2-fixes.mjs`, which
is the mission to run for regression. `scripts/live-coverage.mjs` skips this
directory so a call that can no longer be reached does not count as live
coverage.

Run one anyway with `npm run live-mission -- live/missions/archive/<name>.mjs`
if you want to see the original friction reproduce.
