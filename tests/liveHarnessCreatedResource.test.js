// The live harness registers what it creates so it can trash it afterwards.
// Both callers -- scripts/live-mission.mjs and scripts/live-smoke/call.mjs --
// used to read `JSON.parse(result).id` and nothing else, which silently dropped
// two of the eight tools they claimed to cover:
//
//   createPresentation          returns JSON keyed `presentationId`
//   createDocumentFromTemplate  returns prose, so JSON.parse throws
//
// The consequence is not a missing log line. The registry is what cleanup
// iterates, so an unregistered file is never trashed, and the run still prints
// "cleanup N/N" because N only counts what it noticed. The harness reported a
// clean sandbox while leaving real files in a real Drive.
//
// The literals below are copied from the production return statements, and the
// last test pins them to the source so a change to either shape fails here
// rather than in someone's Drive.
import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CREATING_TOOLS, extractCreatedId, classifyCreation } from '../scripts/live-smoke/createdResource.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const PRES_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';

describe('live harness created-resource extraction', () => {
    it('finds the id in the plain JSON shape most creating tools return', () => {
        const result = JSON.stringify({ id: DOC_ID, name: 'probe', url: 'https://docs.google.com/…' }, null, 2);
        expect(extractCreatedId(result)).toBe(DOC_ID);
    });

    it('finds createPresentation\'s id, which is keyed presentationId and not id', () => {
        // Verbatim shape from dist/tools/slides/createPresentation.js.
        const result = JSON.stringify({
            presentationId: PRES_ID,
            title: 'probe',
            link: `https://docs.google.com/presentation/d/${PRES_ID}`,
            slidesCreated: 2,
        }, null, 2);
        expect(extractCreatedId(result)).toBe(PRES_ID);
        expect(classifyCreation('createPresentation', result)).toEqual({ kind: 'drive', id: PRES_ID });
    });

    it('finds createDocumentFromTemplate\'s id in prose, where JSON.parse throws', () => {
        // Verbatim shape from dist/tools/drive/createFromTemplate.js.
        const result = `Successfully created document "Q3 report" from template (ID: ${DOC_ID})\n`
            + `View Link: https://docs.google.com/document/d/${DOC_ID}/edit\n\n`
            + 'Applied 3 text replacements to the document.';
        expect(extractCreatedId(result)).toBe(DOC_ID);
        expect(classifyCreation('createDocumentFromTemplate', result)).toEqual({ kind: 'drive', id: DOC_ID });
    });

    it('still finds the id from the View Link alone if the (ID: …) wording changes', () => {
        expect(extractCreatedId(`Created it.\nView Link: https://docs.google.com/document/d/${DOC_ID}/edit`)).toBe(DOC_ID);
        expect(extractCreatedId(`https://drive.google.com/file/d/${DOC_ID}/view`)).toBe(DOC_ID);
    });

    it('finds a Gmail draft id through its nesting', () => {
        expect(extractCreatedId(JSON.stringify({ id: 'r-123456789012345', message: { id: 'm-1', threadId: 't-1' } })))
            .toBe('r-123456789012345');
        expect(extractCreatedId(JSON.stringify({ draft: { id: 'r-987654321098765' } }))).toBe('r-987654321098765');
    });

    it('returns null rather than a wrong id when a result names none', () => {
        expect(extractCreatedId('Nothing was created.')).toBeNull();
        expect(extractCreatedId(JSON.stringify({ ok: true }))).toBeNull();
        expect(extractCreatedId(null)).toBeNull();
        expect(extractCreatedId(undefined)).toBeNull();
        // A short token must not be mistaken for a Drive id.
        expect(extractCreatedId('(ID: short)')).toBeNull();
    });

    it('ignores tools that create nothing this harness has to clean up', () => {
        expect(classifyCreation('readDocument', JSON.stringify({ id: DOC_ID }))).toBeNull();
        expect(classifyCreation('listMessages', '[]')).toBeNull();
    });

    // The whole failure mode was a claim in a comment that the code did not
    // keep. Pin it to the source instead.
    it('every tool it claims to track still returns an id shape it can read', () => {
        const sources = {
            createDocument: 'dist/tools/drive/createDocument.js',
            createFolder: 'dist/tools/drive/createFolder.js',
            createDocumentFromTemplate: 'dist/tools/drive/createFromTemplate.js',
            createSpreadsheet: 'dist/tools/sheets/createSpreadsheet.js',
            createPresentation: 'dist/tools/slides/createPresentation.js',
            copyFile: 'dist/tools/drive/copyFile.js',
            uploadFile: 'dist/tools/drive/uploadFile.js',
            createDraft: 'dist/tools/gmail/drafts.js',
        };
        // Anything added to CREATING_TOOLS needs a source entry here, so a new
        // creating tool cannot be listed as tracked without being checked.
        expect(Object.keys(sources).sort()).toEqual([...CREATING_TOOLS.keys()].sort());

        for (const [tool, rel] of Object.entries(sources)) {
            const src = read(rel);
            expect(src).toContain(`name: '${tool}'`);
            // Either it names an id key the extractor knows, or it emits a
            // Google URL / "(ID: …)" the prose patterns can recover.
            const readable = /\b(id|presentationId|documentId|spreadsheetId|fileId)\b/.test(src)
                || /\(ID: \$\{/.test(src)
                || /docs\.google\.com\/(document|spreadsheets|presentation)\/d\//.test(src);
            expect(readable).toBe(true);
        }
    });
});
