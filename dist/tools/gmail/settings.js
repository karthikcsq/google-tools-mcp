// Gmail Settings tools — consolidated dispatch tools (issue #31/#32/#33).
// manageGmailSettings/manageSmime/manageFilter replace the former ~34 granular
// account-config tools. Profile/watch stay granular (renamed to camelCase).
import { z } from 'zod';
import { UserError } from 'fastmcp';
import { getGmailClient } from '../../clients.js';

// ---------------------------------------------------------------------------
// manageGmailSettings — resource/action dispatch over the Gmail settings API.
// Each handler reproduces the exact underlying gmail.users.settings.* call the
// former granular tool made, so this is a surface reshape, not a behavior change.
// ---------------------------------------------------------------------------
const SETTINGS_OPS = {
    imap: {
        get: (gmail) => gmail.users.settings.getImap({ userId: 'me' }),
        update: (gmail, payload) => gmail.users.settings.updateImap({ userId: 'me', requestBody: payload }),
    },
    pop: {
        get: (gmail) => gmail.users.settings.getPop({ userId: 'me' }),
        update: (gmail, payload) => gmail.users.settings.updatePop({ userId: 'me', requestBody: payload }),
    },
    vacation: {
        get: (gmail) => gmail.users.settings.getVacation({ userId: 'me' }),
        update: (gmail, payload) => gmail.users.settings.updateVacation({ userId: 'me', requestBody: payload }),
    },
    language: {
        get: (gmail) => gmail.users.settings.getLanguage({ userId: 'me' }),
        update: (gmail, payload) => gmail.users.settings.updateLanguage({ userId: 'me', requestBody: payload }),
    },
    autoForwarding: {
        get: (gmail) => gmail.users.settings.getAutoForwarding({ userId: 'me' }),
        update: (gmail, payload) => gmail.users.settings.updateAutoForwarding({ userId: 'me', requestBody: payload }),
    },
    forwardingAddress: {
        get: (gmail, payload) => gmail.users.settings.forwardingAddresses.get({ userId: 'me', forwardingEmail: payload.forwardingEmail }),
        list: (gmail) => gmail.users.settings.forwardingAddresses.list({ userId: 'me' }),
        create: (gmail, payload) => gmail.users.settings.forwardingAddresses.create({ userId: 'me', requestBody: payload }),
        delete: (gmail, payload) => gmail.users.settings.forwardingAddresses.delete({ userId: 'me', forwardingEmail: payload.forwardingEmail }),
    },
    delegate: {
        get: (gmail, payload) => gmail.users.settings.delegates.get({ userId: 'me', delegateEmail: payload.delegateEmail }),
        list: (gmail) => gmail.users.settings.delegates.list({ userId: 'me' }),
        create: (gmail, payload) => gmail.users.settings.delegates.create({ userId: 'me', requestBody: { delegateEmail: payload.delegateEmail } }),
        delete: (gmail, payload) => gmail.users.settings.delegates.delete({ userId: 'me', delegateEmail: payload.delegateEmail }),
    },
    sendAs: {
        get: (gmail, payload) => gmail.users.settings.sendAs.get({ userId: 'me', sendAsEmail: payload.sendAsEmail }),
        list: (gmail) => gmail.users.settings.sendAs.list({ userId: 'me' }),
        create: (gmail, payload) => gmail.users.settings.sendAs.create({ userId: 'me', requestBody: payload }),
        patch: (gmail, payload) => {
            const { sendAsEmail, ...body } = payload;
            return gmail.users.settings.sendAs.patch({ userId: 'me', sendAsEmail, requestBody: body });
        },
        update: (gmail, payload) => {
            const { sendAsEmail, ...body } = payload;
            return gmail.users.settings.sendAs.update({ userId: 'me', sendAsEmail, requestBody: body });
        },
        delete: (gmail, payload) => gmail.users.settings.sendAs.delete({ userId: 'me', sendAsEmail: payload.sendAsEmail }),
        verify: (gmail, payload) => gmail.users.settings.sendAs.verify({ userId: 'me', sendAsEmail: payload.sendAsEmail }),
    },
};

function validCombosText() {
    return Object.entries(SETTINGS_OPS)
        .map(([resource, actions]) => `  - ${resource}: ${Object.keys(actions).join(', ')}`)
        .join('\n');
}

// Required payload fields per resource/action. Mirrors the non-optional fields
// of the former granular Zod schemas (identifiers AND request-body fields), so
// callers get a clean validation error up front instead of an opaque Google API
// error when a required field is missing. Optional fields are intentionally
// absent. Booleans that are legitimately `false` (e.g. imap.enabled=false) pass.
const REQUIRED_PAYLOAD_KEYS = {
    imap: { update: ['enabled'] },
    pop: { update: ['accessWindow', 'disposition'] },
    vacation: { update: ['enableAutoReply', 'responseBodyPlainText'] },
    language: { update: ['displayLanguage'] },
    autoForwarding: { update: ['enabled', 'emailAddress', 'disposition'] },
    forwardingAddress: { get: ['forwardingEmail'], create: ['forwardingEmail'], delete: ['forwardingEmail'] },
    delegate: { get: ['delegateEmail'], create: ['delegateEmail'], delete: ['delegateEmail'] },
    sendAs: { get: ['sendAsEmail'], create: ['sendAsEmail'], patch: ['sendAsEmail'], update: ['sendAsEmail'], delete: ['sendAsEmail'], verify: ['sendAsEmail'] },
};

function requirePayloadKeys(resource, action, payload) {
    const keys = REQUIRED_PAYLOAD_KEYS[resource]?.[action] || [];
    const missing = keys.filter((key) => payload[key] === undefined || payload[key] === '');
    if (missing.length) {
        throw new UserError(`resource="${resource}" action="${action}" requires payload field(s): ${missing.join(', ')}.`);
    }
}

export function register(server) {
    server.addTool({
        name: 'manageGmailSettings',
        description:
            'Manage Gmail account settings via a resource/action dispatch. ' +
            'Provide `resource`, `action`, and (where the action needs a body or identifier) a `payload`.\n\n' +
            'Valid resource → actions:\n' +
            '  - imap: get, update (payload: { enabled, expungeBehavior?, maxFolderSize? })\n' +
            '  - pop: get, update (payload: { accessWindow, disposition })\n' +
            '  - vacation: get, update (payload: { enableAutoReply, responseSubject?, responseBodyPlainText, restrictToContacts?, restrictToDomain?, startTime?, endTime? })\n' +
            '  - language: get, update (payload: { displayLanguage })\n' +
            '  - autoForwarding: get, update (payload: { enabled, emailAddress, disposition })\n' +
            '  - forwardingAddress: list, get/delete (payload: { forwardingEmail }), create (payload: { forwardingEmail })\n' +
            '  - delegate: list, get/create/delete (payload: { delegateEmail })\n' +
            '  - sendAs: list, get/delete/verify (payload: { sendAsEmail }), create/patch/update (payload: { sendAsEmail, displayName?, replyToAddress?, signature?, isPrimary?, treatAsAlias? })',
        parameters: z.object({
            resource: z.enum(['imap', 'pop', 'vacation', 'language', 'autoForwarding', 'forwardingAddress', 'delegate', 'sendAs'])
                .describe('The settings resource to operate on'),
            action: z.enum(['get', 'update', 'list', 'create', 'delete', 'patch', 'verify'])
                .describe('The operation to perform (must be valid for the chosen resource)'),
            payload: z.record(z.any()).optional()
                .describe('Resource/action-specific fields (request body or identifier). See the description for valid keys per resource.'),
        }),
        execute: async ({ resource, action, payload = {} }) => {
            const resourceOps = SETTINGS_OPS[resource];
            const handler = resourceOps && resourceOps[action];
            if (!handler) {
                throw new UserError(
                    `Invalid resource/action combination: resource="${resource}", action="${action}".\n` +
                    `Valid combinations:\n${validCombosText()}`
                );
            }
            requirePayloadKeys(resource, action, payload);
            const gmail = await getGmailClient();
            const { data } = await handler(gmail, payload);
            return JSON.stringify(data || { success: true });
        },
    });

    // --- S/MIME ---
    server.addTool({
        name: 'manageSmime',
        description:
            'Manage S/MIME configurations for a send-as alias. action: list | get | insert | delete | setDefault. ' +
            'All actions require sendAsEmail. get/delete/setDefault require id. insert requires encryptedKeyPassword and pkcs12.',
        parameters: z.object({
            action: z.enum(['list', 'get', 'insert', 'delete', 'setDefault']).describe('The S/MIME operation to perform'),
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().optional().describe('The S/MIME config ID (required for get, delete, setDefault)'),
            encryptedKeyPassword: z.string().optional().describe('Encrypted key password (required for insert)'),
            pkcs12: z.string().optional().describe('PKCS#12 format key pair and certificate chain (required for insert)'),
        }),
        execute: async (params) => {
            if (['get', 'delete', 'setDefault'].includes(params.action) && !params.id) {
                throw new UserError(`manageSmime action="${params.action}" requires id.`);
            }
            if (params.action === 'insert' && (!params.encryptedKeyPassword || !params.pkcs12)) {
                throw new UserError('manageSmime action="insert" requires encryptedKeyPassword and pkcs12.');
            }
            const gmail = await getGmailClient();
            const smime = gmail.users.settings.sendAs.smimeInfo;
            const { action, sendAsEmail, id } = params;
            let data;
            switch (action) {
                case 'list':
                    ({ data } = await smime.list({ userId: 'me', sendAsEmail }));
                    break;
                case 'get':
                    ({ data } = await smime.get({ userId: 'me', sendAsEmail, id }));
                    break;
                case 'insert':
                    ({ data } = await smime.insert({
                        userId: 'me',
                        sendAsEmail,
                        requestBody: { sendAsEmail, encryptedKeyPassword: params.encryptedKeyPassword, pkcs12: params.pkcs12 },
                    }));
                    break;
                case 'delete':
                    ({ data } = await smime.delete({ userId: 'me', sendAsEmail, id }));
                    break;
                case 'setDefault':
                    ({ data } = await smime.setDefault({ userId: 'me', sendAsEmail, id }));
                    break;
            }
            return JSON.stringify(data || { success: true });
        },
    });

    // --- Filters ---
    server.addTool({
        name: 'manageFilter',
        description:
            'Manage Gmail message filters. action: create | delete | get | list. ' +
            'create requires criteria and filterAction. get/delete require id.',
        parameters: z.object({
            action: z.enum(['create', 'delete', 'get', 'list']).describe('The filter operation to perform'),
            id: z.string().optional().describe('The filter ID (required for get and delete)'),
            criteria: z.object({
                from: z.string().optional().describe("Sender's display name or email"),
                to: z.string().optional().describe("Recipient's display name or email"),
                subject: z.string().optional().describe('Case-insensitive phrase in subject'),
                query: z.string().optional().describe('Gmail search query for filter criteria'),
                negatedQuery: z.string().optional().describe('Query for criteria the message must NOT match'),
                hasAttachment: z.boolean().optional().describe('Whether the message has any attachment'),
                excludeChats: z.boolean().optional().describe('Exclude chats from results'),
                size: z.number().optional().describe('Size of RFC822 message in bytes'),
                sizeComparison: z.enum(['smaller', 'larger']).optional().describe('Size comparison operator'),
            }).optional().describe('Filter criteria (required for create)'),
            filterAction: z.object({
                addLabelIds: z.array(z.string()).optional().describe('Labels to add'),
                removeLabelIds: z.array(z.string()).optional().describe('Labels to remove'),
                forward: z.string().optional().describe('Email to forward to'),
            }).optional().describe('Actions on matching messages (required for create)'),
        }),
        execute: async (params) => {
            if (params.action === 'create' && (!params.criteria || !params.filterAction)) {
                throw new UserError('manageFilter action="create" requires criteria and filterAction.');
            }
            if (['get', 'delete'].includes(params.action) && !params.id) {
                throw new UserError(`manageFilter action="${params.action}" requires id.`);
            }
            const gmail = await getGmailClient();
            const filters = gmail.users.settings.filters;
            let data;
            switch (params.action) {
                case 'create':
                    ({ data } = await filters.create({ userId: 'me', requestBody: { criteria: params.criteria, action: params.filterAction } }));
                    break;
                case 'delete':
                    ({ data } = await filters.delete({ userId: 'me', id: params.id }));
                    break;
                case 'get':
                    ({ data } = await filters.get({ userId: 'me', id: params.id }));
                    break;
                case 'list':
                    ({ data } = await filters.list({ userId: 'me' }));
                    break;
            }
            return JSON.stringify(data || { success: true });
        },
    });

    // --- Profile & Watch (kept granular, renamed to camelCase) ---
    server.addTool({
        name: 'getProfile',
        description: 'Get the current user\'s Gmail profile',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.getProfile({ userId: 'me' });
            return JSON.stringify(data);
        },
    });

    server.addTool({
        name: 'watchMailbox',
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
        name: 'stopMailWatch',
        description: 'Stop receiving push notifications for the user\'s mailbox',
        parameters: z.object({}),
        execute: async () => {
            const gmail = await getGmailClient();
            const { data } = await gmail.users.stop({ userId: 'me' });
            return JSON.stringify(data || { success: true });
        },
    });
}
