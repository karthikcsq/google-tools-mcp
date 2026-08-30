import { publicError, isPublicError, wrapOperationError, getApiErrorDetail } from '../../errors.js';
import { z } from 'zod';
import { getDriveClient } from '../../clients.js';
export function register(server) {
    server.addTool({
        name: 'addPermission',
        description: 'Shares a Drive file or folder by adding a new sharing permission. Supports sharing with a user, group, entire domain, or anyone with the link. Use listPermissions to see existing shares, updatePermission to change a role, or removePermission to revoke access.',
        parameters: z.object({
            fileId: z.string().describe('The ID of the file or folder to share.'),
            type: z
                .enum(['user', 'group', 'domain', 'anyone'])
                .describe("Grantee type. 'user' and 'group' require emailAddress; 'domain' requires domain; 'anyone' is link sharing."),
            role: z
                .enum(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'])
                .describe('Access level granted. Use owner only with transferOwnership=true.'),
            emailAddress: z
                .string()
                .optional()
                .describe("Email address of the user or group (required when type is 'user' or 'group')."),
            domain: z
                .string()
                .optional()
                .describe("Domain to share with (required when type is 'domain')."),
            sendNotificationEmail: z
                .boolean()
                .optional()
                .describe('Whether Google should send a notification email (default: true for user/group, false for domain/anyone).'),
            emailMessage: z
                .string()
                .optional()
                .describe('Custom message to include in the notification email (only applies when sendNotificationEmail is true).'),
            transferOwnership: z
                .boolean()
                .optional()
                .default(false)
                .describe("Set to true when transferring ownership (role must be 'owner')."),
            allowFileDiscovery: z
                .boolean()
                .optional()
                .describe("For type 'domain' or 'anyone': whether the file can be discovered via search. Defaults to false (link-only)."),
        }),
        execute: async (args, { log }) => {
            if ((args.type === 'user' || args.type === 'group') && !args.emailAddress) {
                throw publicError(`emailAddress is required when type is '${args.type}'.`);
            }
            if (args.type === 'domain' && !args.domain) {
                throw publicError("domain is required when type is 'domain'.");
            }
            if (args.role === 'owner' && !args.transferOwnership) {
                throw publicError("Role 'owner' requires transferOwnership=true.");
            }
            const drive = await getDriveClient();
            log.info(`Adding permission to ${args.fileId}: type=${args.type}, role=${args.role}`);
            const requestBody = {
                type: args.type,
                role: args.role,
            };
            if (args.emailAddress) requestBody.emailAddress = args.emailAddress;
            if (args.domain) requestBody.domain = args.domain;
            if (args.allowFileDiscovery !== undefined) {
                requestBody.allowFileDiscovery = args.allowFileDiscovery;
            }
            const defaultNotify = args.type === 'user' || args.type === 'group';
            const sendNotify = args.sendNotificationEmail ?? defaultNotify;
            try {
                const response = await drive.permissions.create({
                    fileId: args.fileId,
                    requestBody,
                    sendNotificationEmail: sendNotify,
                    emailMessage: sendNotify ? args.emailMessage : undefined,
                    transferOwnership: args.transferOwnership,
                    supportsAllDrives: true,
                    fields: 'id,type,role,emailAddress,domain,displayName,allowFileDiscovery,pendingOwner',
                });
                return JSON.stringify(response.data, null, 2);
            }
            catch (error) {
                if (isPublicError(error)) throw error;
                log.error(`Error adding permission: ${error.message || error}`);
                if (error.code === 404)
                    throw publicError(`File not found (ID: ${args.fileId}).`);
                if (error.code === 403)
                    throw publicError('Permission denied. You need writer+ access (or be the owner) to share this file.');
                // Drive's structured message explains sharing rejections the
                // status code alone cannot (domain policy, ownership transfer
                // rules, invalid target). It is validated upstream detail and
                // stays caller-visible; without it there is nothing safe to say.
                const detail = getApiErrorDetail(error);
                if (!detail) throw wrapOperationError('add Drive permission', error, { status: error?.code });
                throw publicError(`Failed to add permission: ${detail.description}`);
            }
        },
    });
}
