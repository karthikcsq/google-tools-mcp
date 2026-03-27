// Gmail Settings tools (settings, delegates, filters, forwarding, send-as, S/MIME)
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';

export function register(server) {
    // --- Core Settings ---

    server.addTool({
        name: 'get_auto_forwarding',
        description: 'Gets auto-forwarding settings',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.getAutoForwarding({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_auto_forwarding',
        description: 'Updates automatic forwarding settings',
        parameters: z.object({
            enabled: z.boolean().describe("Whether all incoming mail is automatically forwarded"),
            emailAddress: z.string().describe("Email address to forward to"),
            disposition: z.enum(['leaveInInbox', 'archive', 'trash', 'markRead']).describe("What to do with forwarded messages"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.updateAutoForwarding({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_imap',
        description: 'Gets IMAP settings',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.getImap({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_imap',
        description: 'Updates IMAP settings',
        parameters: z.object({
            enabled: z.boolean().describe("Whether IMAP is enabled"),
            expungeBehavior: z.enum(['archive', 'trash', 'deleteForever']).optional().describe("Action on deleted+expunged messages"),
            maxFolderSize: z.number().optional().describe("Max messages accessible through IMAP"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.updateImap({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_language',
        description: 'Gets language settings',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.getLanguage({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_language',
        description: 'Updates language settings',
        parameters: z.object({
            displayLanguage: z.string().describe("Language to display Gmail in (RFC 3066 Language Tag)"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.updateLanguage({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_pop',
        description: 'Gets POP settings',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.getPop({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_pop',
        description: 'Updates POP settings',
        parameters: z.object({
            accessWindow: z.enum(['disabled', 'allMail', 'fromNowOn']).describe("Range of messages accessible via POP"),
            disposition: z.enum(['archive', 'trash', 'leaveInInbox']).describe("Action after POP fetch"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.updatePop({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'get_vacation',
        description: 'Get vacation responder settings',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.getVacation({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_vacation',
        description: 'Update vacation responder settings',
        parameters: z.object({
            enableAutoReply: z.boolean().describe("Whether the vacation responder is enabled"),
            responseSubject: z.string().optional().describe("Subject line for auto-reply"),
            responseBodyPlainText: z.string().describe("Response body in plain text"),
            restrictToContacts: z.boolean().optional().describe("Only send to contacts"),
            restrictToDomain: z.boolean().optional().describe("Only send to same domain"),
            startTime: z.string().optional().describe("Start time (epoch ms)"),
            endTime: z.string().optional().describe("End time (epoch ms)"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.updateVacation({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    // --- Delegates ---

    server.addTool({
        name: 'add_delegate',
        description: 'Adds a delegate to the specified account',
        parameters: z.object({
            delegateEmail: z.string().describe("Email address of delegate to add"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.delegates.create({ userId: 'me', requestBody: { delegateEmail: params.delegateEmail } });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'remove_delegate',
        description: 'Removes the specified delegate',
        parameters: z.object({
            delegateEmail: z.string().describe("Email address of delegate to remove"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.delegates.delete({ userId: 'me', delegateEmail: params.delegateEmail });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_delegate',
        description: 'Gets the specified delegate',
        parameters: z.object({
            delegateEmail: z.string().describe("The email address of the delegate"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.delegates.get({ userId: 'me', delegateEmail: params.delegateEmail });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_delegates',
        description: 'Lists the delegates for the specified account',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.delegates.list({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    // --- Filters ---

    server.addTool({
        name: 'create_filter',
        description: 'Creates a filter',
        parameters: z.object({
            criteria: z.object({
                from: z.string().optional().describe("Sender's display name or email"),
                to: z.string().optional().describe("Recipient's display name or email"),
                subject: z.string().optional().describe("Case-insensitive phrase in subject"),
                query: z.string().optional().describe("Gmail search query for filter criteria"),
                negatedQuery: z.string().optional().describe("Query for criteria the message must NOT match"),
                hasAttachment: z.boolean().optional().describe("Whether the message has any attachment"),
                excludeChats: z.boolean().optional().describe("Exclude chats from results"),
                size: z.number().optional().describe("Size of RFC822 message in bytes"),
                sizeComparison: z.enum(['smaller', 'larger']).optional().describe("Size comparison operator"),
            }).describe("Filter criteria"),
            action: z.object({
                addLabelIds: z.array(z.string()).optional().describe("Labels to add"),
                removeLabelIds: z.array(z.string()).optional().describe("Labels to remove"),
                forward: z.string().optional().describe("Email to forward to"),
            }).describe("Actions on matching messages"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.filters.create({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_filter',
        description: 'Deletes a filter',
        parameters: z.object({
            id: z.string().describe("The ID of the filter to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.filters.delete({ userId: 'me', id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_filter',
        description: 'Gets a filter',
        parameters: z.object({
            id: z.string().describe("The ID of the filter to retrieve"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.filters.get({ userId: 'me', id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_filters',
        description: 'Lists the message filters of a Gmail user',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.filters.list({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    // --- Forwarding Addresses ---

    server.addTool({
        name: 'create_forwarding_address',
        description: 'Creates a forwarding address',
        parameters: z.object({
            forwardingEmail: z.string().describe("An email address to forward messages to"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.forwardingAddresses.create({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_forwarding_address',
        description: 'Deletes the specified forwarding address',
        parameters: z.object({
            forwardingEmail: z.string().describe("The forwarding address to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.forwardingAddresses.delete({ userId: 'me', forwardingEmail: params.forwardingEmail });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_forwarding_address',
        description: 'Gets the specified forwarding address',
        parameters: z.object({
            forwardingEmail: z.string().describe("The forwarding address to retrieve"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.forwardingAddresses.get({ userId: 'me', forwardingEmail: params.forwardingEmail });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_forwarding_addresses',
        description: 'Lists the forwarding addresses for the specified account',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.forwardingAddresses.list({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    // --- Send-As Aliases ---

    server.addTool({
        name: 'create_send_as',
        description: 'Creates a custom send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("Email address for the 'From:' header"),
            displayName: z.string().optional().describe("Name for the 'From:' header"),
            replyToAddress: z.string().optional().describe("Email for 'Reply-To:' header"),
            signature: z.string().optional().describe("Optional HTML signature"),
            isPrimary: z.boolean().optional().describe("Whether this is the primary address"),
            treatAsAlias: z.boolean().optional().describe("Whether Gmail treats this as an alias"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.create({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'delete_send_as',
        description: 'Deletes the specified send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The send-as alias to delete"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.delete({ userId: 'me', sendAsEmail: params.sendAsEmail });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_send_as',
        description: 'Gets the specified send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The send-as alias to retrieve"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.get({ userId: 'me', sendAsEmail: params.sendAsEmail });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_send_as',
        description: 'Lists the send-as aliases for the specified account',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'patch_send_as',
        description: 'Patches the specified send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The send-as alias to update"),
            displayName: z.string().optional().describe("Name for the 'From:' header"),
            replyToAddress: z.string().optional().describe("Email for 'Reply-To:' header"),
            signature: z.string().optional().describe("Optional HTML signature"),
            isPrimary: z.boolean().optional().describe("Whether this is the primary address"),
            treatAsAlias: z.boolean().optional().describe("Whether Gmail treats this as an alias"),
        }),
        execute: async (params) => {
            const { sendAsEmail, ...patchData } = params;
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.patch({ userId: 'me', sendAsEmail, requestBody: patchData });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'update_send_as',
        description: 'Updates a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The send-as alias to update"),
            displayName: z.string().optional().describe("Name for the 'From:' header"),
            replyToAddress: z.string().optional().describe("Email for 'Reply-To:' header"),
            signature: z.string().optional().describe("Optional HTML signature"),
            isPrimary: z.boolean().optional().describe("Whether this is the primary address"),
            treatAsAlias: z.boolean().optional().describe("Whether Gmail treats this as an alias"),
        }),
        execute: async (params) => {
            const { sendAsEmail, ...updateData } = params;
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.update({ userId: 'me', sendAsEmail, requestBody: updateData });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'verify_send_as',
        description: 'Sends a verification email to the specified send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The send-as alias to verify"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.verify({ userId: 'me', sendAsEmail: params.sendAsEmail });
            return JSON.stringify(data || { success: true });
        },
    });

    // --- S/MIME ---

    server.addTool({
        name: 'delete_smime_info',
        description: 'Deletes the specified S/MIME config for a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe("The S/MIME config ID"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.smimeInfo.delete({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    server.addTool({
        name: 'get_smime_info',
        description: 'Gets the specified S/MIME config for a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe("The S/MIME config ID"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.smimeInfo.get({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'insert_smime_info',
        description: 'Insert (upload) S/MIME config for a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            encryptedKeyPassword: z.string().describe("Encrypted key password"),
            pkcs12: z.string().describe("PKCS#12 format key pair and certificate chain"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.smimeInfo.insert({ userId: 'me', sendAsEmail: params.sendAsEmail, requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'list_smime_info',
        description: 'Lists S/MIME configs for a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.smimeInfo.list({ userId: 'me', sendAsEmail: params.sendAsEmail });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'set_default_smime_info',
        description: 'Sets the default S/MIME config for a send-as alias',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe("The S/MIME config ID"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.settings.sendAs.smimeInfo.setDefault({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id });
            return JSON.stringify(data || { success: true });
        },
    });

    // --- Profile & Watch ---

    server.addTool({
        name: 'get_profile',
        description: 'Get the current user\'s Gmail profile',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.getProfile({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'watch_mailbox',
        description: 'Watch for changes to the user\'s mailbox via Cloud Pub/Sub',
        parameters: z.object({
            topicName: z.string().describe("Cloud Pub/Sub topic to publish notifications to"),
            labelIds: z.array(z.string()).optional().describe("Label IDs to restrict notifications to"),
            labelFilterAction: z.enum(['include', 'exclude']).optional().describe("Whether to include or exclude specified labels"),
        }),
        execute: async (params) => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.watch({ userId: 'me', requestBody: params });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'stop_mail_watch',
        description: 'Stop receiving push notifications for the user\'s mailbox',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.stop({ userId: 'me' });
            return JSON.stringify(data || { success: true });
        },
    });
}
