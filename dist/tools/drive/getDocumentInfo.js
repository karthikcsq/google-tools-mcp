import { UserError } from 'fastmcp';
import { getDriveClient } from '../../clients.js';
import { DocumentIdParameter } from '../../types.js';
export function register(server) {
    server.addTool({
        name: 'getDocumentInfo',
        description: 'Gets metadata about a document including its name, owner, sharing status, and modification history.',
        parameters: DocumentIdParameter,
        execute: async (args, { log }) => {
            const drive = await getDriveClient();
            log.info(`Getting info for document: ${args.documentId}`);
            try {
                const response = await drive.files.get({
                    fileId: args.documentId,
                    // Note: 'permissions' and 'alternateLink' fields removed - they cause
                    // "Invalid field selection" errors for Google Docs files
                    fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version',
                    supportsAllDrives: true,
                });
                const file = response.data;
                if (!file) {
                    throw new UserError(`Document with ID ${args.documentId} not found.`);
                }
                const info = {
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    createdTime: file.createdTime,
                    modifiedTime: file.modifiedTime,
                    owner: file.owners?.[0]?.displayName || null,
                    lastModifyingUser: file.lastModifyingUser?.displayName || null,
                    shared: file.shared || false,
                    url: file.webViewLink,
                    description: file.description || null,
                };
                return JSON.stringify(info, null, 2);
            }
            catch (error) {
                log.error(`Error getting document info: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Document not found (ID: ${args.documentId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this document.');
                throw new UserError(`Failed to get document info: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
