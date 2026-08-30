# Common workflows

These examples show the arguments an MCP client supplies to a tool. Your client renders the full input schema, including optional fields, when you select the tool.

## Send an email

Use `sendMessage` only after confirming recipients, subject, and body. The body accepts plain text or HTML.

```json
{
  "to": ["person@example.com"],
  "subject": "Project update",
  "body": "<p>Here is the latest update.</p>"
}
```

Use `createDraft` when the message needs review before delivery. Use `replyMessage` rather than constructing thread headers yourself.

## Safely replace a Google Doc

For a small localized change, use `modifyText`. For an append-only change, use `appendMarkdown`. Use `replaceDocumentWithMarkdown` only when you intend to replace an entire document body or a substantial section.

1. Call `readDocument` with `format: "markdown"`.
2. Review the fidelity warnings. Markdown replacement can remove elements it cannot represent, such as images and footnotes.
3. Edit the returned local working-copy file for larger changes.
4. Submit the edited path with `replaceDocumentWithMarkdown`.

```json
{
  "documentId": "your-document-id",
  "filePath": "path-returned-by-readDocument",
  "preserveTitle": true
}
```

The server tracks reads before writes and uses the document revision to reduce the risk of overwriting a collaborator's newer edit.

## Rewrite one section of a Google Doc

`replaceRangeWithMarkdown` builds real structure (headings, nested lists, tables) inside a
range you choose, so a section rewrite no longer forces a choice between
`replaceDocumentWithMarkdown` (whole body) and `modifyText` (text only, flattens list nesting).

1. Call `readDocument` with `format: "index"` to see elements and their indices, or skip
   straight to addressing the section by its heading.
2. Call `replaceRangeWithMarkdown` with `dryRun: true` to confirm the resolved range and see
   whether anything unrepresentable sits inside it.
3. Repeat without `dryRun`.

```json
{
  "documentId": "your-document-id",
  "target": { "afterHeading": "Roadmap" },
  "markdown": "1. Ship it\n   1. Write the tests\n   2. Review\n2. Rest\n"
}
```

The section runs from just below the matched heading to the next heading of the same or
shallower level, so sub-headings stay part of it. `preserveHeading: false` replaces the
heading too, `target: {startIndex, endIndex}` addresses any range explicitly, and
`startIndex == endIndex` inserts markdown at an index without deleting anything. Content
outside the range is untouched, and fidelity is only checked inside it — a document full of
images elsewhere no longer blocks a clean section rewrite.

The new content is inserted before the old content is deleted, both under the same revision
guard. If the delete fails, the document holds both copies and the error names the exact
range still to remove, so a partial failure never leaves the section missing.

## Write a spreadsheet range

Read the relevant range before overwriting it. `writeSpreadsheet` overwrites cells; use `appendRows` when adding rows is the intended operation.

```json
{
  "spreadsheetId": "your-spreadsheet-id",
  "range": "Sheet1!A1:B2",
  "values": [["Name", "Status"], ["Ada", "Ready"]],
  "valueInputOption": "USER_ENTERED"
}
```

## Create a presentation

`createPresentation` creates a presentation and initial title-and-body slides. Follow with the Slides formatting and shape tools when you need a custom layout.

```json
{
  "name": "Weekly review",
  "slides": [
    { "title": "Results", "content": "What changed this week" },
    { "title": "Next steps", "content": "Owners and dates" }
  ]
}
```

The Google Slides API must be enabled during setup; re-run `google-tools-mcp auth` if a previously saved token does not include the current Slides scope.

## Manage tasks

Start with `listTaskLists`, then pass the selected ID to `createTask`.

```json
{
  "taskListId": "your-task-list-id",
  "title": "Prepare launch checklist",
  "notes": "Confirm owners and dates.",
  "due": "2026-08-15"
}
```

The Google Tasks API must be enabled in the Cloud project. A guided setup run after this version enables it automatically.

## Destructive operations

Read the current object and confirm its identifier before delete or overwrite operations. Prefer reversible options when available: `deleteFile` moves Drive files to trash by default; setting `permanent: true` is irreversible. Deleting messages, task lists, slides, or document content may not be recoverable through this server.
