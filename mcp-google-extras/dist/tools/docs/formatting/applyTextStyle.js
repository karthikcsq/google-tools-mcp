import { UserError } from 'fastmcp';
import { getDocsClient } from '../../../clients.js';
import { ApplyTextStyleToolParameters, NotImplementedError, } from '../../../types.js';
import * as GDocsHelpers from '../../../googleDocsApiHelpers.js';
export function register(server) {
    server.addTool({
        name: 'applyTextStyle',
        description: 'Applies character-level formatting (bold, italic, color, font, etc.) to text identified by a character range or by searching for a text string. This is the primary tool for styling text in a document.',
        parameters: ApplyTextStyleToolParameters,
        execute: async (args, { log }) => {
            const docs = await getDocsClient();
            let { startIndex, endIndex } = args.target; // Will be updated if target is text
            log.info(`Applying text style in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}. Target: ${JSON.stringify(args.target)}, Style: ${JSON.stringify(args.style)}`);
            try {
                // Determine target range
                if ('textToFind' in args.target) {
                    const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.target.textToFind, args.target.matchInstance, args.tabId);
                    if (!range) {
                        throw new UserError(`Could not find instance ${args.target.matchInstance} of text "${args.target.textToFind}"${args.tabId ? ` in tab ${args.tabId}` : ''}.`);
                    }
                    startIndex = range.startIndex;
                    endIndex = range.endIndex;
                    log.info(`Found text "${args.target.textToFind}" (instance ${args.target.matchInstance}) at range ${startIndex}-${endIndex}`);
                }
                if (startIndex === undefined || endIndex === undefined) {
                    throw new UserError('Target range could not be determined.');
                }
                if (endIndex <= startIndex) {
                    throw new UserError('End index must be greater than start index for styling.');
                }
                // Build the request
                const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(startIndex, endIndex, args.style, args.tabId);
                if (!requestInfo) {
                    return 'No valid text styling options were provided.';
                }
                await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
                return `Successfully applied text style (${requestInfo.fields.join(', ')}) to range ${startIndex}-${endIndex}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
            }
            catch (error) {
                log.error(`Error applying text style in doc ${args.documentId}: ${error.message || error}`);
                if (error instanceof UserError)
                    throw error;
                if (error instanceof NotImplementedError)
                    throw error; // Should not happen here
                throw new UserError(`Failed to apply text style: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
