// Legacy alias layer (issue #31/#32/#33).
//
// Registers the pre-consolidation snake_case tool names as thin, working aliases
// so existing agents/configs can still call them after the camelCase + dispatch
// reshape. Each alias forwards to its new implementation:
//   - Pure renames (e.g. list_messages -> listMessages) forward unchanged.
//   - Consolidated tools (e.g. get_imap -> manageGmailSettings resource=imap
//     action=get) wrap the old parameters into the new dispatch shape.
//
// Opt-in, OFF by default: the entire point of issues #31/#33 is shrinking the
// tool surface loaded into every turn. Registering these 72 aliases by default
// would add them back on top of the new camelCase + dispatch tools, growing the
// default surface instead of shrinking it. Set
// GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true to register them for callers that still
// depend on the old snake_case names.
import { z } from 'zod';
import { logger } from '../logger.js';

export const ENABLE_LEGACY_ALIASES_ENV = 'GOOGLE_MCP_ENABLE_LEGACY_ALIASES';

export function legacyAliasesEnabled() {
    return process.env[ENABLE_LEGACY_ALIASES_ENV] === 'true';
}

// ---------------------------------------------------------------------------
// Pure renames: old snake_case name -> new camelCase name.
// These aliases reuse the target tool's parameters and execute verbatim.
// ---------------------------------------------------------------------------
export const PURE_RENAMES = {
    // Gmail messages
    send_message: 'sendMessage',
    reply_message: 'replyMessage',
    forward_message: 'forwardMessage',
    get_message: 'getMessage',
    list_messages: 'listMessages',
    modify_message: 'modifyMessage',
    delete_message: 'deleteMessage',
    trash_message: 'trashMessage',
    batch_get_messages: 'batchGetMessages',
    get_attachment: 'getAttachment',
    // Gmail drafts
    create_draft: 'createDraft',
    update_draft: 'updateDraft',
    delete_draft: 'deleteDraft',
    get_draft: 'getDraft',
    list_drafts: 'listDrafts',
    send_draft: 'sendDraft',
    // Gmail threads
    get_thread: 'getThread',
    list_threads: 'listThreads',
    batch_get_threads: 'batchGetThreads',
    modify_thread: 'modifyThread',
    delete_thread: 'deleteThread',
    trash_thread: 'trashThread',
    // Gmail profile & watch
    get_profile: 'getProfile',
    watch_mailbox: 'watchMailbox',
    stop_mail_watch: 'stopMailWatch',
    // Calendar
    list_calendars: 'listCalendars',
    get_events: 'getEvents',
    manage_event: 'manageEvent',
    get_busy: 'getBusy',
    get_free: 'getFree',
    move_event: 'moveEvent',
    list_recurring_event_instances: 'listRecurringEventInstances',
    manage_calendar: 'manageCalendar',
};

// ---------------------------------------------------------------------------
// Reusable zod pieces for consolidated-alias parameters (preserve the original
// granular schemas so deprecated callers keep their typed inputs).
// ---------------------------------------------------------------------------
const empty = z.object({});
const sendAsBody = z.object({
    sendAsEmail: z.string().describe("Email address for the 'From:' header"),
    displayName: z.string().optional().describe("Name for the 'From:' header"),
    replyToAddress: z.string().optional().describe("Email for 'Reply-To:' header"),
    signature: z.string().optional().describe('Optional HTML signature'),
    isPrimary: z.boolean().optional().describe('Whether this is the primary address'),
    treatAsAlias: z.boolean().optional().describe('Whether Gmail treats this as an alias'),
});
const labelBody = {
    name: z.string().describe('The display name of the label'),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe('Visibility of messages with this label in the message list'),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Visibility of the label in the label list'),
    color: z.object({
        textColor: z.string().describe('The text color as hex string'),
        backgroundColor: z.string().describe('The background color as hex string'),
    }).optional().describe('The color settings for the label'),
};
const filterCriteria = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    query: z.string().optional(),
    negatedQuery: z.string().optional(),
    hasAttachment: z.boolean().optional(),
    excludeChats: z.boolean().optional(),
    size: z.number().optional(),
    sizeComparison: z.enum(['smaller', 'larger']).optional(),
}).describe('Filter criteria');
const filterActionObj = z.object({
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
    forward: z.string().optional(),
}).describe('Actions on matching messages');

// ---------------------------------------------------------------------------
// Consolidated aliases: old name -> { target dispatch tool, original schema,
// description, and a mapParams that reshapes old args into the dispatch shape }.
// ---------------------------------------------------------------------------
const settingGet = (resource) => ({
    target: 'manageGmailSettings',
    parameters: empty,
    mapParams: () => ({ resource, action: 'get' }),
});
const settingUpdate = (resource, parameters) => ({
    target: 'manageGmailSettings',
    parameters,
    mapParams: (args) => ({ resource, action: 'update', payload: args }),
});

export const CONSOLIDATED_ALIASES = {
    // --- Core settings -> manageGmailSettings ---
    get_auto_forwarding: { ...settingGet('autoForwarding'), description: 'Gets auto-forwarding settings' },
    update_auto_forwarding: {
        ...settingUpdate('autoForwarding', z.object({
            enabled: z.boolean().describe('Whether all incoming mail is automatically forwarded'),
            emailAddress: z.string().describe('Email address to forward to'),
            disposition: z.enum(['leaveInInbox', 'archive', 'trash', 'markRead']).describe('What to do with forwarded messages'),
        })),
        description: 'Updates automatic forwarding settings',
    },
    get_imap: { ...settingGet('imap'), description: 'Gets IMAP settings' },
    update_imap: {
        ...settingUpdate('imap', z.object({
            enabled: z.boolean().describe('Whether IMAP is enabled'),
            expungeBehavior: z.enum(['archive', 'trash', 'deleteForever']).optional().describe('Action on deleted+expunged messages'),
            maxFolderSize: z.number().optional().describe('Max messages accessible through IMAP'),
        })),
        description: 'Updates IMAP settings',
    },
    get_language: { ...settingGet('language'), description: 'Gets language settings' },
    update_language: {
        ...settingUpdate('language', z.object({
            displayLanguage: z.string().describe('Language to display Gmail in (RFC 3066 Language Tag)'),
        })),
        description: 'Updates language settings',
    },
    get_pop: { ...settingGet('pop'), description: 'Gets POP settings' },
    update_pop: {
        ...settingUpdate('pop', z.object({
            accessWindow: z.enum(['disabled', 'allMail', 'fromNowOn']).describe('Range of messages accessible via POP'),
            disposition: z.enum(['archive', 'trash', 'leaveInInbox']).describe('Action after POP fetch'),
        })),
        description: 'Updates POP settings',
    },
    get_vacation: { ...settingGet('vacation'), description: 'Get vacation responder settings' },
    update_vacation: {
        ...settingUpdate('vacation', z.object({
            enableAutoReply: z.boolean().describe('Whether the vacation responder is enabled'),
            responseSubject: z.string().optional().describe('Subject line for auto-reply'),
            responseBodyPlainText: z.string().describe('Response body in plain text'),
            restrictToContacts: z.boolean().optional().describe('Only send to contacts'),
            restrictToDomain: z.boolean().optional().describe('Only send to same domain'),
            startTime: z.string().optional().describe('Start time (epoch ms)'),
            endTime: z.string().optional().describe('End time (epoch ms)'),
        })),
        description: 'Update vacation responder settings',
    },

    // --- Delegates -> manageGmailSettings resource=delegate ---
    add_delegate: {
        target: 'manageGmailSettings',
        parameters: z.object({ delegateEmail: z.string().describe('Email address of delegate to add') }),
        mapParams: (a) => ({ resource: 'delegate', action: 'create', payload: { delegateEmail: a.delegateEmail } }),
        description: 'Adds a delegate to the specified account',
    },
    remove_delegate: {
        target: 'manageGmailSettings',
        parameters: z.object({ delegateEmail: z.string().describe('Email address of delegate to remove') }),
        mapParams: (a) => ({ resource: 'delegate', action: 'delete', payload: { delegateEmail: a.delegateEmail } }),
        description: 'Removes the specified delegate',
    },
    get_delegate: {
        target: 'manageGmailSettings',
        parameters: z.object({ delegateEmail: z.string().describe('The email address of the delegate') }),
        mapParams: (a) => ({ resource: 'delegate', action: 'get', payload: { delegateEmail: a.delegateEmail } }),
        description: 'Gets the specified delegate',
    },
    list_delegates: {
        target: 'manageGmailSettings',
        parameters: empty,
        mapParams: () => ({ resource: 'delegate', action: 'list' }),
        description: 'Lists the delegates for the specified account',
    },

    // --- Forwarding addresses -> manageGmailSettings resource=forwardingAddress ---
    create_forwarding_address: {
        target: 'manageGmailSettings',
        parameters: z.object({ forwardingEmail: z.string().describe('An email address to forward messages to') }),
        mapParams: (a) => ({ resource: 'forwardingAddress', action: 'create', payload: { forwardingEmail: a.forwardingEmail } }),
        description: 'Creates a forwarding address',
    },
    delete_forwarding_address: {
        target: 'manageGmailSettings',
        parameters: z.object({ forwardingEmail: z.string().describe('The forwarding address to delete') }),
        mapParams: (a) => ({ resource: 'forwardingAddress', action: 'delete', payload: { forwardingEmail: a.forwardingEmail } }),
        description: 'Deletes the specified forwarding address',
    },
    get_forwarding_address: {
        target: 'manageGmailSettings',
        parameters: z.object({ forwardingEmail: z.string().describe('The forwarding address to retrieve') }),
        mapParams: (a) => ({ resource: 'forwardingAddress', action: 'get', payload: { forwardingEmail: a.forwardingEmail } }),
        description: 'Gets the specified forwarding address',
    },
    list_forwarding_addresses: {
        target: 'manageGmailSettings',
        parameters: empty,
        mapParams: () => ({ resource: 'forwardingAddress', action: 'list' }),
        description: 'Lists the forwarding addresses for the specified account',
    },

    // --- Send-as -> manageGmailSettings resource=sendAs ---
    create_send_as: {
        target: 'manageGmailSettings',
        parameters: sendAsBody,
        mapParams: (a) => ({ resource: 'sendAs', action: 'create', payload: a }),
        description: 'Creates a custom send-as alias',
    },
    delete_send_as: {
        target: 'manageGmailSettings',
        parameters: z.object({ sendAsEmail: z.string().describe('The send-as alias to delete') }),
        mapParams: (a) => ({ resource: 'sendAs', action: 'delete', payload: { sendAsEmail: a.sendAsEmail } }),
        description: 'Deletes the specified send-as alias',
    },
    get_send_as: {
        target: 'manageGmailSettings',
        parameters: z.object({ sendAsEmail: z.string().describe('The send-as alias to retrieve') }),
        mapParams: (a) => ({ resource: 'sendAs', action: 'get', payload: { sendAsEmail: a.sendAsEmail } }),
        description: 'Gets the specified send-as alias',
    },
    list_send_as: {
        target: 'manageGmailSettings',
        parameters: empty,
        mapParams: () => ({ resource: 'sendAs', action: 'list' }),
        description: 'Lists the send-as aliases for the specified account',
    },
    patch_send_as: {
        target: 'manageGmailSettings',
        parameters: sendAsBody,
        mapParams: (a) => ({ resource: 'sendAs', action: 'patch', payload: a }),
        description: 'Patches the specified send-as alias',
    },
    update_send_as: {
        target: 'manageGmailSettings',
        parameters: sendAsBody,
        mapParams: (a) => ({ resource: 'sendAs', action: 'update', payload: a }),
        description: 'Updates a send-as alias',
    },
    verify_send_as: {
        target: 'manageGmailSettings',
        parameters: z.object({ sendAsEmail: z.string().describe('The send-as alias to verify') }),
        mapParams: (a) => ({ resource: 'sendAs', action: 'verify', payload: { sendAsEmail: a.sendAsEmail } }),
        description: 'Sends a verification email to the specified send-as alias',
    },

    // --- S/MIME -> manageSmime ---
    delete_smime_info: {
        target: 'manageSmime',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe('The S/MIME config ID'),
        }),
        mapParams: (a) => ({ action: 'delete', sendAsEmail: a.sendAsEmail, id: a.id }),
        description: 'Deletes the specified S/MIME config for a send-as alias',
    },
    get_smime_info: {
        target: 'manageSmime',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe('The S/MIME config ID'),
        }),
        mapParams: (a) => ({ action: 'get', sendAsEmail: a.sendAsEmail, id: a.id }),
        description: 'Gets the specified S/MIME config for a send-as alias',
    },
    insert_smime_info: {
        target: 'manageSmime',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            encryptedKeyPassword: z.string().describe('Encrypted key password'),
            pkcs12: z.string().describe('PKCS#12 format key pair and certificate chain'),
        }),
        mapParams: (a) => ({ action: 'insert', sendAsEmail: a.sendAsEmail, encryptedKeyPassword: a.encryptedKeyPassword, pkcs12: a.pkcs12 }),
        description: 'Insert (upload) S/MIME config for a send-as alias',
    },
    list_smime_info: {
        target: 'manageSmime',
        parameters: z.object({ sendAsEmail: z.string().describe("The email address in the 'From:' header") }),
        mapParams: (a) => ({ action: 'list', sendAsEmail: a.sendAsEmail }),
        description: 'Lists S/MIME configs for a send-as alias',
    },
    set_default_smime_info: {
        target: 'manageSmime',
        parameters: z.object({
            sendAsEmail: z.string().describe("The email address in the 'From:' header"),
            id: z.string().describe('The S/MIME config ID'),
        }),
        mapParams: (a) => ({ action: 'setDefault', sendAsEmail: a.sendAsEmail, id: a.id }),
        description: 'Sets the default S/MIME config for a send-as alias',
    },

    // --- Filters -> manageFilter ---
    create_filter: {
        target: 'manageFilter',
        parameters: z.object({ criteria: filterCriteria, action: filterActionObj }),
        mapParams: (a) => ({ action: 'create', criteria: a.criteria, filterAction: a.action }),
        description: 'Creates a filter',
    },
    delete_filter: {
        target: 'manageFilter',
        parameters: z.object({ id: z.string().describe('The ID of the filter to delete') }),
        mapParams: (a) => ({ action: 'delete', id: a.id }),
        description: 'Deletes a filter',
    },
    get_filter: {
        target: 'manageFilter',
        parameters: z.object({ id: z.string().describe('The ID of the filter to retrieve') }),
        mapParams: (a) => ({ action: 'get', id: a.id }),
        description: 'Gets a filter',
    },
    list_filters: {
        target: 'manageFilter',
        parameters: empty,
        mapParams: () => ({ action: 'list' }),
        description: 'Lists the message filters of a Gmail user',
    },

    // --- Labels -> manageLabel ---
    create_label: {
        target: 'manageLabel',
        parameters: z.object(labelBody),
        mapParams: (a) => ({ action: 'create', ...a }),
        description: 'Create a new label',
    },
    delete_label: {
        target: 'manageLabel',
        parameters: z.object({ id: z.string().describe('The ID of the label to delete') }),
        mapParams: (a) => ({ action: 'delete', id: a.id }),
        description: 'Delete a label',
    },
    get_label: {
        target: 'manageLabel',
        parameters: z.object({ id: z.string().describe('The ID of the label to retrieve') }),
        mapParams: (a) => ({ action: 'get', id: a.id }),
        description: 'Get a specific label by ID',
    },
    list_labels: {
        target: 'manageLabel',
        parameters: empty,
        mapParams: () => ({ action: 'list' }),
        description: "List all labels in the user's mailbox",
    },
    patch_label: {
        target: 'manageLabel',
        parameters: z.object({
            id: z.string().describe('The ID of the label to patch'),
            name: z.string().optional().describe('The display name of the label'),
            messageListVisibility: z.enum(['show', 'hide']).optional().describe('Visibility of messages with this label'),
            labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Visibility of the label in the label list'),
            color: z.object({
                textColor: z.string().describe('The text color as hex string'),
                backgroundColor: z.string().describe('The background color as hex string'),
            }).optional().describe('The color settings for the label'),
        }),
        mapParams: (a) => ({ action: 'patch', ...a }),
        description: 'Patch an existing label (partial update)',
    },
};

// ---------------------------------------------------------------------------
// Register all legacy aliases on `server`. `registeredTools` is a Map of
// name -> toolDef for the already-registered new tools (used to look up the
// target's execute/parameters). No-op if aliases are disabled via env var.
// ---------------------------------------------------------------------------
export function registerLegacyAliases(server, registeredTools) {
    if (!legacyAliasesEnabled()) {
        logger.info(`Legacy snake_case tool aliases are opt-in — set ${ENABLE_LEGACY_ALIASES_ENV}=true to register them.`);
        return 0;
    }
    let count = 0;

    for (const [alias, targetName] of Object.entries(PURE_RENAMES)) {
        const target = registeredTools.get(targetName);
        if (!target) {
            logger.warn(`Legacy alias "${alias}" skipped: target "${targetName}" not registered.`);
            continue;
        }
        server.addTool({
            name: alias,
            description: `[Deprecated alias of ${targetName}] ${target.description}`,
            parameters: target.parameters,
            execute: (args, ctx) => target.execute(args, ctx),
        });
        count++;
    }

    for (const [alias, spec] of Object.entries(CONSOLIDATED_ALIASES)) {
        const target = registeredTools.get(spec.target);
        if (!target) {
            logger.warn(`Legacy alias "${alias}" skipped: target "${spec.target}" not registered.`);
            continue;
        }
        server.addTool({
            name: alias,
            description: `[Deprecated alias of ${spec.target}] ${spec.description}. Dispatches to ${spec.target}.`,
            parameters: spec.parameters,
            execute: (args, ctx) => target.execute(spec.mapParams(args), ctx),
        });
        count++;
    }

    logger.info(`Registered ${count} legacy tool aliases (${ENABLE_LEGACY_ALIASES_ENV}=true).`);
    return count;
}
