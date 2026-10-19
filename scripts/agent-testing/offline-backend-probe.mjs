// Runs assertions that need direct client access in a normal Node child. Jest
// executes ESM through a VM where node:module register hooks are unavailable.
import { installOfflineBackend, getOfflineBackendStatus } from './offline.mjs';

const workspaceDir = process.argv[2];
if (!workspaceDir) throw new Error('Pass a run-scoped workspace directory.');

await installOfflineBackend({ folderId: 'agent_test_root', workspaceDir });
const { getDocsClient, getDriveClient } = await import('../../dist/clients.js');
const drive = await getDriveClient();
const docs = await getDocsClient();
const created = await drive.files.create({
    requestBody: {
        name: 'Atomic write',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['agent_test_root'],
    },
});
const documentId = created.data.id;
const before = await docs.documents.get({ documentId });
let unsupportedCode = null;
try {
    await docs.documents.batchUpdate({
        documentId,
        requestBody: {
            requests: [
                { insertText: { location: { index: 1 }, text: 'must not persist' } },
                { insertTable: { location: { index: 1 }, rows: 1, columns: 1 } },
            ],
        },
    });
} catch (error) {
    unsupportedCode = error?.code ?? null;
}
const after = await docs.documents.get({ documentId });
const beforeCleanupStatus = getOfflineBackendStatus();
await drive.files.update({ fileId: documentId, requestBody: { trashed: true } });

console.log(JSON.stringify({
    unsupportedCode,
    beforeRevision: before.data.revisionId,
    afterRevision: after.data.revisionId,
    afterText: after.data.body.content[0].paragraph.elements[0].textRun.content,
    beforeCleanupStatus,
    status: getOfflineBackendStatus(),
}));
