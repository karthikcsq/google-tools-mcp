// Gmail Message tools
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';
import { processMessagePart, constructRawMessage, constructRawMessageWithAttachments, findHeader, formatEmailList, getNestedHistory, getPlainTextBody, isHtmlBody, wrapTextBody, formatMessageClean, formatMessageMetadata } from '../../helpers.js';

export function register(server) {
    server.addTool({
        name: 'send_message',
        description: 'Send an email message to specified recipients. Note the mechanics of the raw parameter.',
        parameters: z.object({
            raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores to, cc, bcc, subject, body if provided"),
            threadId: z.string().optional().describe("The thread ID to associate this message with"),
            to: z.array(z.string()).optional().describe("List of recipient email addresses"),
            cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
            bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
            subject: z.string().optional().describe("The subject of the email"),
            body: z.string().optional().describe("The body of the email. Supports plain text or HTML (auto-detected). Use HTML tags like <p>, <br>, <b> for formatted emails."),
            attachments: z.array(z.object({
                filename: z.string().describe("Attachment file name"),
                mimeType: z.string().describe("MIME type of the attachment"),
                base64Data: z.string().describe("Base64 encoded attachment data"),
            })).optional().describe("File attachments to include"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            let raw = params.raw;
            if (!raw) {
                if (params.attachments?.length) {
                    raw = await constructRawMessageWithAttachments(gmail, params);
                } else {
                    raw = await constructRawMessage(gmail, params);
                }
            }
            const sendParams = { userId: 'me', requestBody: { raw } };
            if (params.threadId && sendParams.requestBody) {
                sendParams.requestBody.threadId = params.threadId;
            }
            const { data } = await gmail.users.messages.send(sendParams);
            if (data.payload) {
                data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'reply_message',
        description: 'Reply to a message. Automatically handles To/Cc recipients, subject prefix, threading headers, and quoted content. Use replyAll to include all original recipients.',
        parameters: z.object({
            messageId: z.string().describe("The ID of the message to reply to"),
            body: z.string().describe("The reply body text. Supports plain text or HTML (auto-detected). Use HTML tags like <p>, <br>, <b> for formatted replies."),
            replyAll: z.boolean().optional().describe("If true, reply to all original recipients (To + Cc minus yourself). Default: false"),
            to: z.array(z.string()).optional().describe("Override recipient list (if omitted, replies to sender or Reply-To)"),
            cc: z.array(z.string()).optional().describe("Override CC list (if omitted and replyAll, uses original To + Cc minus yourself)"),
            bcc: z.array(z.string()).optional().describe("Optional BCC recipients"),
            attachments: z.array(z.object({
                filename: z.string().describe("Attachment file name"),
                mimeType: z.string().describe("MIME type of the attachment"),
                base64Data: z.string().describe("Base64 encoded attachment data"),
            })).optional().describe("Optional attachments to include in the reply"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            // Fetch original message
            const { data: original } = await gmail.users.messages.get({ userId: 'me', id: params.messageId, format: 'full' });
            const headers = original.payload?.headers || [];
            const threadId = original.threadId;
            // Get sender info for quoted content
            const fromHeader = findHeader(headers, 'reply-to') || findHeader(headers, 'from');
            const dateHeader = findHeader(headers, 'date');
            const originalSubject = findHeader(headers, 'subject') || '';
            const messageIdHeader = findHeader(headers, 'message-id');
            const referencesHeader = findHeader(headers, 'references');
            // Build subject
            let subject = originalSubject;
            if (!subject.toLowerCase().startsWith('re:')) {
                subject = `Re: ${subject}`;
            }
            // Build recipients
            let to = params.to;
            let cc = params.cc;
            if (!to) {
                to = fromHeader ? [fromHeader] : [];
            }
            if (!cc && params.replyAll) {
                // Get own email for exclusion
                const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
                const myEmail = profile.emailAddress?.toLowerCase();
                const originalTo = formatEmailList(findHeader(headers, 'to'));
                const originalCc = formatEmailList(findHeader(headers, 'cc'));
                const allRecipients = [...originalTo, ...originalCc].filter(
                    email => !email.toLowerCase().includes(myEmail)
                );
                // Remove the sender from CC since they're in To
                cc = allRecipients.filter(email => !to.some(t => email.toLowerCase().includes(t.toLowerCase())));
            }
            // Build threading headers
            const references = [];
            if (referencesHeader) references.push(...referencesHeader.split(' '));
            if (messageIdHeader) references.push(messageIdHeader);
            // Build quoted content from the original message
            let quotedContent = '';
            if (original.payload) {
                const originalBody = getNestedHistory(original.payload);
                if (originalBody && fromHeader && dateHeader) {
                    quotedContent = `\n\nOn ${dateHeader} ${fromHeader} wrote:\n\n${originalBody}`;
                }
            }
            const fullBody = params.body + quotedContent;
            // Build raw message
            const msgHeaders = [];
            if (to?.length) msgHeaders.push(`To: ${to.join(', ')}`);
            if (cc?.length) msgHeaders.push(`Cc: ${cc.join(', ')}`);
            if (params.bcc?.length) msgHeaders.push(`Bcc: ${params.bcc.join(', ')}`);
            msgHeaders.push(`Subject: ${subject}`);
            if (messageIdHeader) msgHeaders.push(`In-Reply-To: ${messageIdHeader}`);
            if (references.length) msgHeaders.push(`References: ${references.join(' ')}`);
            const htmlMode = isHtmlBody(params.body);
            let raw;
            if (params.attachments?.length) {
                const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                msgHeaders.push('MIME-Version: 1.0');
                msgHeaders.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
                const parts = [];
                parts.push([
                    `--${boundary}`,
                    `Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
                    'Content-Transfer-Encoding: base64',
                    '',
                    Buffer.from(fullBody).toString('base64'),
                ].join('\r\n'));
                for (const att of params.attachments) {
                    parts.push([
                        `--${boundary}`,
                        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
                        'Content-Transfer-Encoding: base64',
                        `Content-Disposition: attachment; filename="${att.filename}"`,
                        '',
                        att.base64Data,
                    ].join('\r\n'));
                }
                const rawStr = [msgHeaders.join('\r\n'), '', parts.join('\r\n'), `--${boundary}--`].join('\r\n');
                raw = Buffer.from(rawStr).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            } else {
                msgHeaders.push(`Content-Type: ${htmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
                msgHeaders.push('Content-Transfer-Encoding: quoted-printable');
                msgHeaders.push('MIME-Version: 1.0');
                const rawStr = [msgHeaders.join('\r\n'), '', htmlMode ? fullBody : wrapTextBody(fullBody)].join('\r\n');
                raw = Buffer.from(rawStr).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
            const { data } = await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw, threadId },
            });
            if (data.payload) {
                data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'forward_message',
        description: 'Forward a message to new recipients. Includes the original message body as quoted content and re-attaches any original attachments.',
        parameters: z.object({
            messageId: z.string().describe("The ID of the message to forward"),
            to: z.array(z.string()).describe("Recipient email addresses to forward to"),
            cc: z.array(z.string()).optional().describe("CC recipient email addresses"),
            bcc: z.array(z.string()).optional().describe("BCC recipient email addresses"),
            body: z.string().optional().describe("Optional commentary to prepend above the forwarded content. Supports plain text or HTML (auto-detected)."),
            includeAttachments: z.boolean().optional().describe("Whether to include original attachments. Default: true"),
            includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            // Fetch original message
            const { data: original } = await gmail.users.messages.get({ userId: 'me', id: params.messageId, format: 'full' });
            const headers = original.payload?.headers || [];
            const originalSubject = findHeader(headers, 'subject') || '';
            const fromHeader = findHeader(headers, 'from') || '';
            const dateHeader = findHeader(headers, 'date') || '';
            const toHeader = findHeader(headers, 'to') || '';
            // Build subject
            let subject = originalSubject;
            if (!subject.toLowerCase().startsWith('fwd:')) {
                subject = `Fwd: ${subject}`;
            }
            // Build forwarded content
            const originalBody = original.payload ? getPlainTextBody(original.payload) : '';
            let forwardedContent = [
                '---------- Forwarded message ---------',
                `From: ${fromHeader}`,
                `Date: ${dateHeader}`,
                `Subject: ${originalSubject}`,
                `To: ${toHeader}`,
                '',
                originalBody,
            ].join('\n');
            const fullBody = (params.body ? params.body + '\n\n' : '') + forwardedContent;
            // Collect original attachments
            const attachments = [];
            const includeAttachments = params.includeAttachments !== false;
            if (includeAttachments && original.payload) {
                const collectAttachments = (part) => {
                    if (part.filename && part.body?.attachmentId) {
                        attachments.push({
                            filename: part.filename,
                            mimeType: part.mimeType || 'application/octet-stream',
                            attachmentId: part.body.attachmentId,
                        });
                    }
                    if (part.parts) part.parts.forEach(collectAttachments);
                };
                collectAttachments(original.payload);
            }
            // Fetch attachment data
            const attachmentParts = [];
            for (const att of attachments) {
                const { data: attData } = await gmail.users.messages.attachments.get({
                    userId: 'me', messageId: params.messageId, id: att.attachmentId,
                });
                attachmentParts.push({
                    filename: att.filename,
                    mimeType: att.mimeType,
                    base64Data: attData.data.replace(/-/g, '+').replace(/_/g, '/'),
                });
            }
            // Build raw message
            const msgHeaders = [];
            msgHeaders.push(`To: ${params.to.join(', ')}`);
            if (params.cc?.length) msgHeaders.push(`Cc: ${params.cc.join(', ')}`);
            if (params.bcc?.length) msgHeaders.push(`Bcc: ${params.bcc.join(', ')}`);
            msgHeaders.push(`Subject: ${subject}`);
            const fwdHtmlMode = params.body && isHtmlBody(params.body);
            let raw;
            if (attachmentParts.length) {
                const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                msgHeaders.push('MIME-Version: 1.0');
                msgHeaders.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
                const parts = [];
                parts.push([
                    `--${boundary}`,
                    `Content-Type: ${fwdHtmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
                    'Content-Transfer-Encoding: base64',
                    '',
                    Buffer.from(fullBody).toString('base64'),
                ].join('\r\n'));
                for (const att of attachmentParts) {
                    parts.push([
                        `--${boundary}`,
                        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
                        'Content-Transfer-Encoding: base64',
                        `Content-Disposition: attachment; filename="${att.filename}"`,
                        '',
                        att.base64Data,
                    ].join('\r\n'));
                }
                const rawStr = [msgHeaders.join('\r\n'), '', parts.join('\r\n'), `--${boundary}--`].join('\r\n');
                raw = Buffer.from(rawStr).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            } else {
                msgHeaders.push(`Content-Type: ${fwdHtmlMode ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
                msgHeaders.push('Content-Transfer-Encoding: quoted-printable');
                msgHeaders.push('MIME-Version: 1.0');
                const rawStr = [msgHeaders.join('\r\n'), '', fwdHtmlMode ? fullBody : wrapTextBody(fullBody)].join('\r\n');
                raw = Buffer.from(rawStr).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
            const { data } = await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw },
            });
            if (data.payload) {
                data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_message',
        description: 'Get a specific message by ID. format="clean" (default) returns from/to/subject/date/body as a flat object. format="metadata" returns headers only, no body. format="full" returns the raw MIME tree (current legacy behavior).',
        parameters: z.object({
            id: z.string().describe("The ID of the message to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters in clean mode. 0 = unlimited. Truncated responses include bodyTruncated: true."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.get({ userId: 'me', id: params.id, format: 'full' });
            if (params.format === 'clean') return JSON.stringify(formatMessageClean(data, params.maxBodyChars));
            if (params.format === 'metadata') return JSON.stringify(formatMessageMetadata(data));
            if (data.payload) data.payload = processMessagePart(data.payload, params.includeBodyHtml);
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_messages',
        description: 'List messages in the user\'s mailbox with optional filtering. format="metadata" (default) auto-fetches message details for each result. format="clean" includes the message body. format="full" returns raw MIME data. Omit format to get bare IDs only.',
        parameters: z.object({
            maxResults: z.number().optional().describe("Maximum number of messages to return (1-500)"),
            pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
            q: z.string().optional().describe("Only return messages matching the specified query (same format as Gmail search box)"),
            labelIds: z.array(z.string()).optional().describe("Only return messages with labels that match all specified label IDs"),
            includeSpamTrash: z.boolean().optional().describe("Include messages from SPAM and TRASH"),
            format: z.enum(['full', 'clean', 'metadata']).optional().describe("When set, auto-fetches full message details. metadata=headers only (default when set), clean=with body, full=raw MIME tree."),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters in clean mode. 0 = unlimited."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.list({
                userId: 'me',
                maxResults: params.maxResults,
                pageToken: params.pageToken,
                q: params.q,
                labelIds: params.labelIds,
                includeSpamTrash: params.includeSpamTrash,
            });
            if (params.format && data.messages?.length) {
                data.messages = await Promise.all(
                    data.messages.map(async ({ id }) => {
                        try {
                            const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
                            if (params.format === 'clean') return formatMessageClean(msg, params.maxBodyChars);
                            if (params.format === 'metadata') return formatMessageMetadata(msg);
                            if (msg.payload) msg.payload = processMessagePart(msg.payload, params.includeBodyHtml);
                            return msg;
                        } catch (e) {
                            return { id, error: e.message || 'Failed to retrieve message' };
                        }
                    })
                );
            }
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'modify_message',
        description: 'Modify the labels on one or more messages. Pass a single id or an array of ids.',
        parameters: z.object({
            ids: z.union([z.string(), z.array(z.string())]).describe("Message ID or array of message IDs to modify"),
            addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
            removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const ids = Array.isArray(params.ids) ? params.ids : [params.ids];
            const { data } = await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: { ids, addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds },
            });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'delete_message',
        description: 'Immediately and permanently delete one or more messages. Pass a single id or an array of ids.',
        parameters: z.object({
            ids: z.union([z.string(), z.array(z.string())]).describe("Message ID or array of message IDs to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const ids = Array.isArray(params.ids) ? params.ids : [params.ids];
            const { data } = await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'trash_message',
        description: 'Move a message to the trash or restore it. Use action="trash" to move to trash, action="untrash" to restore.',
        parameters: z.object({
            id: z.string().describe("The ID of the message"),
            action: z.enum(['trash', 'untrash']).describe("'trash' to move to trash, 'untrash' to restore"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const fn = params.action === 'untrash' ? 'untrash' : 'trash';
            const { data } = await gmail.users.messages[fn]({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });


    server.addTool({
        name: 'batch_get_messages',
        description: 'Get multiple messages by ID in parallel. More efficient than calling get_message multiple times.',
        parameters: z.object({
            ids: z.array(z.string()).describe("The IDs of the messages to retrieve"),
            format: z.enum(['full', 'clean', 'metadata']).optional().default('clean').describe("Response format: clean (default), metadata (headers only), or full (raw MIME tree)"),
            maxBodyChars: z.number().optional().default(3000).describe("Max body characters in clean mode. 0 = unlimited."),
            includeBodyHtml: z.boolean().optional().describe("In full mode only: whether to include parsed HTML body parts"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const results = await Promise.all(
                params.ids.map(async (id) => {
                    try {
                        const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
                        if (params.format === 'clean') return formatMessageClean(data, params.maxBodyChars);
                        if (params.format === 'metadata') return formatMessageMetadata(data);
                        if (data.payload) data.payload = processMessagePart(data.payload, params.includeBodyHtml);
                        return data;
                    } catch (error) {
                        return { id, error: error.message || 'Failed to retrieve message' };
                    }
                })
            );
            return JSON.stringify(results);
        },
    });

    server.addTool({
        name: 'get_attachment',
        description: 'Get a message attachment',
        parameters: z.object({
            messageId: z.string().describe("ID of the message containing the attachment"),
            id: z.string().describe("The ID of the attachment"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId: params.messageId, id: params.id });
            return JSON.stringify(data);
        },
    });
}
