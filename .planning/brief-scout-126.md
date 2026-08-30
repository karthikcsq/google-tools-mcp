Scout task. Do not write or modify any product code. You may write a throwaway helper script
only if it genuinely helps you search. Read the actual file contents; do not answer from
filenames or grep counts alone.

Question: where exactly does the `listFolderContents` tool build its Drive `files.list` query,
and what parameters does it pass?

Search these two trees:
1. `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-prE` (branch feat/independents,
   has the new recursive-listing feature for issue #99)
2. `C:/Users/2supe/All Coding/Google-Tools-MCP/google-tools-mcp-pr109` (branch
   docs/mcp-plan-client-evidence, the base, closer to released 2.0.0)

Report, with exact `file:line` for each:
- The tool definition for `listFolderContents` and the function that actually performs the
  listing.
- The literal `q` query string it builds, and every option passed to `drive.files.list`
  (fields, pageSize, orderBy, corpora, driveId, supportsAllDrives, includeItemsFromAllDrives,
  spaces, pageToken handling).
- Whether `supportsAllDrives` / `includeItemsFromAllDrives` appear ANYWHERE in either tree, and
  in which files. Quote the surrounding lines.
- How the recursive/depth traversal in the feat/independents version enumerates children, and
  whether it reuses the same listing function or a second code path.
- What the tool does when `files.list` returns zero items: does it distinguish "empty" from
  "could not enumerate" in any way, and does it surface partial-failure or pagination-truncation
  information to the caller?
- For contrast, the same details for `getFileInfo` (`drive.files.get`), since that call SUCCEEDS
  on folders where the listing returns empty. Note any parameter `get` passes that `list` does not.

Return exact file:line pointers and quoted code. Do not propose a fix. Do not edit anything.
