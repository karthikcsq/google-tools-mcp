import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'list_recurring_event_instances',
        description:
            'Lists individual occurrences of a recurring event. Use this to find specific instances ' +
            'you want to modify or cancel (e.g. "cancel next Tuesday\'s standup"). ' +
            'Each instance has its own event ID that you can pass to manage_event.',
        parameters: z.object({
            calendar_id: z
                .string()
                .optional()
                .default('primary')
                .describe('Calendar ID. Defaults to "primary".'),
            event_id: z
                .string()
                .describe('The recurring event ID (the parent event, not an instance).'),
            time_min: z
                .string()
                .optional()
                .describe('Start of range in RFC3339 format. Defaults to now.'),
            time_max: z
                .string()
                .optional()
                .describe('End of range in RFC3339 format.'),
            max_results: z
                .number()
                .optional()
                .default(10)
                .describe('Maximum number of instances to return. Defaults to 10.'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();
            log.info(`Listing instances of recurring event ${args.event_id}`);

            try {
                const params = {
                    calendarId: args.calendar_id,
                    eventId: args.event_id,
                    maxResults: args.max_results,
                };

                if (args.time_min) params.timeMin = args.time_min;
                else params.timeMin = new Date().toISOString();

                if (args.time_max) params.timeMax = args.time_max;

                const response = await calendar.events.instances(params);
                const instances = response.data.items || [];

                const results = instances.map((event) => ({
                    id: event.id,
                    summary: event.summary || '(No title)',
                    start: event.start?.dateTime || event.start?.date,
                    end: event.end?.dateTime || event.end?.date,
                    status: event.status,
                    recurringEventId: event.recurringEventId,
                    htmlLink: event.htmlLink,
                }));

                return JSON.stringify(results, null, 2);
            } catch (error) {
                log.error(`Error listing recurring instances: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(
                        'Recurring event not found. Check the event_id — it should be the parent recurring event ID.'
                    );
                if (error.code === 400)
                    throw new UserError(
                        'The specified event_id does not appear to be a recurring event.'
                    );
                throw new UserError(
                    `Failed to list recurring instances: ${error.message || 'Unknown error'}`
                );
            }
        },
    });
}
