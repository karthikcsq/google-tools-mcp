## Issue #116: updateDraft/createDraft double-decodes quoted-printable, stripping every "=" from the body

## Description

## Summary

`updateDraft` (and likely `createDraft`/`sendMessage`, which share the body-encoding path) appears to run the message body through a quoted-printable decode one extra time before storing it. Because `=` is the QP escape character, every literal `=` in the body is consumed or turns into a garbage byte. This silently destroys HTML bodies and mangles any URL containing a query string.

## Reproduction

Call `updateDraft` with an HTML body containing normal attributes and a URL with query params, e.g.:

```
<a href="https://example.com/page?tab=t.0#heading=h.abc">link</a>
<a href="https://www.linkedin.com/feed/update/urn:li:share:7495913127058976769/?actorCompanyId=106734664">post</a>
```

Then read the draft back with `getDraft`.

## Expected

Body stored verbatim; the HTML renders with working links.

## Actual

Every `=` is gone, and `=NN` sequences are decoded as hex bytes:

- `<a href="https://...">` becomes `<a href"https://...">` (attribute syntax broken, so Gmail renders no link at all)
- `<div dir="ltr">` becomes `<div dir"ltr">`, `class="gmail_quote"` becomes `class"gmail_quote"`, `style="..."` becomes `style"..."` — the entire document structure collapses
- `?tab=t.0#heading=h.abc` becomes `?tabt.0#headingh.abc` (broken URL)
- `?actorCompanyId=106734664` becomes `?actorCompanyId 6734664` — here `=10` was decoded as byte 0x10, so the URL is not just broken but corrupted with a control character

The corruption is silent: the tool returns success, and the damage is only visible after `getDraft` or in the Gmail UI.

## Impact

Any HTML email sent or drafted through these tools is destroyed. In my case this wrecked a real outreach draft, and the only recovery was rebuilding the message by hand. Plain-text bodies are affected too whenever they contain a `=` (extremely common in URLs).

## Workaround

Pass a pre-built RFC 2822 message via the `raw` parameter with `Content-Transfer-Encoding: base64` on each MIME part. `raw` bypasses the broken encoding path entirely.

## Likely cause

The body is QP-encoded when the MIME message is assembled, then decoded again (or decoded before encoding) somewhere in the pipeline. A single decode pass too many. Worth checking whether the input is being treated as already-QP-encoded when it is in fact plain input.

## Environment

Gmail draft update on an existing reply thread, HTML body ~9KB, Windows 11, Claude Code.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>

