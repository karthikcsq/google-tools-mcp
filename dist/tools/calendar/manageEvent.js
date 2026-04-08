import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'manage_event',
        description:
            'Create, update, or delete a calendar event. Supports attendees, Google Meet, reminders, attachments, visibility, and transparency settings. IMPORTANT: To modify an existing event, always use action "update" with the existing event_id. Never delete and recreate an event to make changes — this destroys the event ID, attendee RSVPs, and sent notifications.',
        parameters: z.object({
            action: z.enum(['create', 'update', 'delete']).describe('The operation to perform. Use "update" to modify existing events — do not delete and recreate. "delete" should only be used to permanently remove an event, not to redo one.'),
            calendar_id: z
                .string()
                .optional()
                .default('primary')
                .describe('Calendar ID. Defaults to "primary".'),
            event_id: z
                .string()
                .optional()
                .describe('Event ID — required for update and delete.'),
            summary: z
                .string()
                .optional()
                .describe('Event title. Required for create.'),
            start_time: z
                .string()
                .optional()
                .describe('Start time in RFC3339 format (e.g. "2025-03-15T10:00:00-05:00") or date for all-day (e.g. "2025-03-15"). Required for create.'),
            end_time: z
                .string()
                .optional()
                .describe('End time in RFC3339 format or date for all-day. Required for create.'),
            description: z.string().optional().describe('Event description/body.'),
            location: z.string().optional().describe('Event location.'),
            attendees: z
                .array(z.string())
                .optional()
                .describe('List of attendee email addresses.'),
            timezone: z
                .string()
                .optional()
                .describe('Timezone for the event (e.g. "America/New_York"). Defaults to calendar timezone.'),
            add_google_meet: z
                .boolean()
                .optional()
                .describe('If true, adds a Google Meet conference link. If false on update, removes it.'),
            reminders: z
                .array(
                    z.object({
                        method: z.enum(['email', 'popup']).describe('Reminder method.'),
                        minutes: z.number().describe('Minutes before the event to send reminder.'),
                    })
                )
                .optional()
                .describe('Custom reminders. Overrides calendar defaults.'),
            transparency: z
                .enum(['opaque', 'transparent'])
                .optional()
                .describe('"opaque" = busy (default), "transparent" = free/available.'),
            visibility: z
                .enum(['default', 'public', 'private', 'confidential'])
                .optional()
                .describe('Event visibility.'),
            color_id: z
                .string()
                .optional()
                .describe('Color ID for the event (1-11). Use list_calendars or Google Calendar docs for color mapping.'),
            recurrence: z
                .array(z.string())
                .optional()
                .describe('RRULE recurrence rules (e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]). Only for create.'),
            send_updates: z
                .enum(['all', 'externalOnly', 'none'])
                .optional()
                .default('all')
                .describe('Who to send email notifications to: "all" = all attendees (default), "externalOnly" = non-Google Calendar attendees only, "none" = no emails.'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();

            try {
                if (args.action === 'delete') {
                    if (!args.event_id) throw new UserError('event_id is required for delete.');
                    log.info(`Deleting event ${args.event_id} from ${args.calendar_id}`);
                    await calendar.events.delete({
                        calendarId: args.calendar_id,
                        eventId: args.event_id,
                        sendUpdates: args.send_updates,
                    });
                    return JSON.stringify({ success: true, message: `Event ${args.event_id} deleted.` });
                }

                if (args.action === 'create') {
                    if (!args.summary) throw new UserError('summary is required for create.');
                    if (!args.start_time) throw new UserError('start_time is required for create.');
                    if (!args.end_time) throw new UserError('end_time is required for create.');

                    const eventBody = buildEventBody(args);
                    log.info(`Creating event "${args.summary}" on ${args.calendar_id}`);

                    const params = {
                        calendarId: args.calendar_id,
                        requestBody: eventBody,
                        conferenceDataVersion: args.add_google_meet ? 1 : 0,
                        sendUpdates: args.send_updates,
                    };

                    const response = await calendar.events.insert(params);
                    return JSON.stringify(formatResult('created', response.data), null, 2);
                }

                if (args.action === 'update') {
                    if (!args.event_id) throw new UserError('event_id is required for update.');
                    log.info(`Updating event ${args.event_id} on ${args.calendar_id}`);

                    // Fetch existing event to preserve fields
                    const existing = await calendar.events.get({
                        calendarId: args.calendar_id,
                        eventId: args.event_id,
                    });

                    const eventBody = buildUpdateBody(existing.data, args);

                    const params = {
                        calendarId: args.calendar_id,
                        eventId: args.event_id,
                        requestBody: eventBody,
                        conferenceDataVersion: args.add_google_meet !== undefined ? 1 : 0,
                        sendUpdates: args.send_updates,
                    };

                    const response = await calendar.events.update(params);
                    return JSON.stringify(formatResult('updated', response.data), null, 2);
                }

                throw new UserError(`Unknown action: ${args.action}`);
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error in manage_event (${args.action}): ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Calendar or event not found. Check the IDs.');
                if (error.code === 403)
                    throw new UserError('Permission denied. You may not have edit access to this calendar.');
                throw new UserError(`Failed to ${args.action} event: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

function buildTimeField(timeStr, timezone) {
    // All-day events use 'date', timed events use 'dateTime'
    if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
        return { date: timeStr };
    }
    const field = { dateTime: timeStr };
    if (timezone) field.timeZone = timezone;
    return field;
}

function buildEventBody(args) {
    const body = {
        summary: args.summary,
        start: buildTimeField(args.start_time, args.timezone),
        end: buildTimeField(args.end_time, args.timezone),
    };

    if (args.description) body.description = args.description;
    if (args.location) body.location = args.location;
    if (args.attendees) body.attendees = args.attendees.map((email) => ({ email }));
    if (args.transparency) body.transparency = args.transparency;
    if (args.visibility) body.visibility = args.visibility;
    if (args.color_id) body.colorId = args.color_id;
    if (args.recurrence) body.recurrence = args.recurrence;

    if (args.reminders) {
        body.reminders = {
            useDefault: false,
            overrides: args.reminders,
        };
    }

    if (args.add_google_meet) {
        body.conferenceData = {
            createRequest: {
                requestId: `meet-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
        };
    }

    return body;
}

function buildUpdateBody(existing, args) {
    const body = { ...existing };

    // Remove read-only fields
    delete body.etag;
    delete body.kind;
    delete body.created;
    delete body.updated;
    delete body.creator;
    delete body.organizer;
    delete body.iCalUID;
    delete body.sequence;
    delete body.hangoutLink;

    if (args.summary !== undefined) body.summary = args.summary;
    if (args.description !== undefined) body.description = args.description;
    if (args.location !== undefined) body.location = args.location;
    if (args.transparency !== undefined) body.transparency = args.transparency;
    if (args.visibility !== undefined) body.visibility = args.visibility;
    if (args.color_id !== undefined) body.colorId = args.color_id;

    if (args.start_time) body.start = buildTimeField(args.start_time, args.timezone);
    if (args.end_time) body.end = buildTimeField(args.end_time, args.timezone);

    if (args.attendees) body.attendees = args.attendees.map((email) => ({ email }));

    if (args.reminders) {
        body.reminders = {
            useDefault: false,
            overrides: args.reminders,
        };
    }

    if (args.add_google_meet === true) {
        body.conferenceData = {
            createRequest: {
                requestId: `meet-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
        };
    } else if (args.add_google_meet === false) {
        body.conferenceData = null;
    }

    return body;
}

function formatResult(action, event) {
    const result = {
        success: true,
        action,
        id: event.id,
        summary: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        htmlLink: event.htmlLink,
    };

    if (event.hangoutLink) result.meetLink = event.hangoutLink;
    if (event.attendees?.length) {
        result.attendees = event.attendees.map((a) => a.email);
    }

    return result;
}
