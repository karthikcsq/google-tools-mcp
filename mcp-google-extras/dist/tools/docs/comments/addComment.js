import { UserError } from 'fastmcp';
import { z } from 'zod';
import { google } from 'googleapis';
import { getDocsClient, getAuthClient } from '../../../clients.js';
import { DocumentIdParameter } from '../../../types.js';
export function register(server) {
    server.addTool({
        name: 'addComment',
        description: 'Adds a comment to the document at the specified text range. Use listComments to retrieve the comment ID after creation. Note: programmatically created comments appear in the comments panel but may not show as anchored highlights in the document UI.',
        parameters: DocumentIdParameter.extend({
            startIndex: z
                .number()
                .int()
                .min(1)
                .describe('The starting index of the text range (inclusive, starts from 1).'),
            endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
            content: z.string().min(1).describe('The text content of the comment.'),
        }).refine((data) => data.endIndex > data.startIndex, {
            message: 'endIndex must be greater than startIndex',
            path: ['endIndex'],
        }),
        execute: async (args, { log }) => {
            log.info(`Adding comment to range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}`);
            try {
                // First, get the text content that will be quoted
                const docsClient = await getDocsClient();
                const doc = await docsClient.documents.get({ documentId: args.documentId });
                // Extract the quoted text from the document
                let quotedText = '';
                const content = doc.data.body?.content || [];
                for (const element of content) {
                    if (element.paragraph) {
                        const elements = element.paragraph.elements || [];
                        for (const textElement of elements) {
                            if (textElement.textRun) {
                                const elementStart = textElement.startIndex || 0;
                                const elementEnd = textElement.endIndex || 0;
                                // Check if this element overlaps with our range
                                if (elementEnd > args.startIndex && elementStart < args.endIndex) {
                                    const text = textElement.textRun.content || '';
                                    const startOffset = Math.max(0, args.startIndex - elementStart);
                                    const endOffset = Math.min(text.length, args.endIndex - elementStart);
                                    quotedText += text.substring(startOffset, endOffset);
                                }
                            }
                        }
                    }
                }
                // Use Drive API v3 for comments
                const authClient = await getAuthClient();
                const drive = google.drive({ version: 'v3', auth: authClient });
                const response = await drive.comments.create({
                    fileId: args.documentId,
                    fields: 'id,content,quotedFileContent,author,createdTime,resolved',
                    requestBody: {
                        content: args.content,
                        quotedFileContent: {
                            value: quotedText,
                            mimeType: 'text/html',
                        },
                        anchor: JSON.stringify({
                            r: args.documentId,
                            a: [
                                {
                                    txt: {
                                        o: args.startIndex - 1, // Drive API uses 0-based indexing
                                        l: args.endIndex - args.startIndex,
                                        ml: args.endIndex - args.startIndex,
                                    },
                                },
                            ],
                        }),
                    },
                });
                return `Comment added successfully. Comment ID: ${response.data.id}`;
            }
            catch (error) {
                log.error(`Error adding comment: ${error.message || error}`);
                throw new UserError(`Failed to add comment: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
