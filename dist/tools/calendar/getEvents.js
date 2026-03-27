import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'get_events',
        description:
            'Retrieves events from a Google Calendar. Can get a single event by ID, or list events in a time range with optional search. ' +
            'Use calendar_id to query another user\'s calendar (requires sharing) or "primary" for the authenticated user.',
        parameters: z.object({
            calendar_id: z
                .string()
                .optional()
                .default('primary')
                .describe('Calendar ID to query. Use "primary" for the main calendar, or an email address for a shared calendar.'),
            event_id: z
                .string()
                .optional()
                .describe('Specific event ID to retrieve. If provided, other filter params are ignored.'),
            time_min: z
                .string()
                .optional()
                .describe('Start of time range in RFC3339 format (e.g. "2025-01-01T00:00:00Z"). Defaults to now if not specified.'),
            time_max: z
                .string()
                .optional()
                .describe('End of time range in RFC3339 format (e.g. "2025-01-31T23:59:59Z").'),
            max_results: z
                .number()
                .optional()
                .default(25)
                .describe('Maximum number of events to return (default 25, max 2500).'),
            query: z
                .string()
                .optional()
                .describe('Free-text search across event summary, description, location, attendees, etc.'),
            detailed: z
                .boolean()
                .optional()
                .default(false)
                .describe('If true, includes attendees, attachments, conferencing details, and extended properties.'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();

            try {
                // Single event fetch
                if (args.event_id) {
                    log.info(`Getting event ${args.event_id} from calendar ${args.calendar_id}`);
                    const response = await calendar.events.get({
                        calendarId: args.calendar_id,
                        eventId: args.event_id,
                    });
                    return JSON.stringify(formatEvent(response.data, true), null, 2);
                }

                // List events
                log.info(`Listing events from calendar ${args.calendar_id}`);
                const params = {
                    calendarId: args.calendar_id,
                    maxResults: Math.min(args.max_results, 2500),
                    singleEvents: true,
                    orderBy: 'startTime',
                };

                if (args.time_min) params.timeMin = args.time_min;
                else params.timeMin = new Date().toISOString();

                if (args.time_max) params.timeMax = args.time_max;
                if (args.query) params.q = args.query;

                const response = await calendar.events.list(params);
                const events = response.data.items || [];

                return JSON.stringify(
                    events.map((e) => formatEvent(e, args.detailed)),
                    null,
                    2
                );
            } catch (error) {
                log.error(`Error getting events: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Calendar or event not found. Check the calendar_id or event_id.');
                if (error.code === 403)
                    throw new UserError('Permission denied. The calendar may not be shared with you.');
                throw new UserError(`Failed to get events: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

function formatEvent(event, detailed) {
    const result = {
        id: event.id,
        summary: event.summary || '(No title)',
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        status: event.status,
        htmlLink: event.htmlLink,
    };

    if (event.location) result.location = event.location;
    if (event.description) result.description = event.description;
    if (event.recurringEventId) result.recurringEventId = event.recurringEventId;

    if (detailed) {
        if (event.attendees?.length) {
            result.attendees = event.attendees.map((a) => ({
                email: a.email,
                displayName: a.displayName || null,
                responseStatus: a.responseStatus,
                organizer: a.organizer || false,
                self: a.self || false,
            }));
        }
        if (event.conferenceData) {
            const entryPoints = event.conferenceData.entryPoints || [];
            result.conferencing = entryPoints.map((ep) => ({
                type: ep.entryPointType,
                uri: ep.uri,
                label: ep.label || null,
            }));
        }
        if (event.attachments?.length) {
            result.attachments = event.attachments.map((a) => ({
                title: a.title,
                fileUrl: a.fileUrl,
                mimeType: a.mimeType,
            }));
        }
        if (event.creator) result.creator = event.creator;
        if (event.organizer) result.organizer = { email: event.organizer.email, displayName: event.organizer.displayName || null };
        result.visibility = event.visibility || 'default';
        result.transparency = event.transparency || 'opaque';
        if (event.reminders) result.reminders = event.reminders;
    }

    return result;
}
