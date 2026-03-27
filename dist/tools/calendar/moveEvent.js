import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'move_event',
        description:
            'Moves an event from one calendar to another. The event is removed from the source calendar and added to the destination.',
        parameters: z.object({
            event_id: z.string().describe('The event ID to move.'),
            source_calendar_id: z
                .string()
                .optional()
                .default('primary')
                .describe('Calendar ID the event is currently in. Defaults to "primary".'),
            destination_calendar_id: z
                .string()
                .describe('Calendar ID to move the event to.'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();
            log.info(
                `Moving event ${args.event_id} from ${args.source_calendar_id} to ${args.destination_calendar_id}`
            );

            try {
                const response = await calendar.events.move({
                    calendarId: args.source_calendar_id,
                    eventId: args.event_id,
                    destination: args.destination_calendar_id,
                });

                const event = response.data;
                return JSON.stringify(
                    {
                        success: true,
                        id: event.id,
                        summary: event.summary,
                        movedTo: args.destination_calendar_id,
                        htmlLink: event.htmlLink,
                    },
                    null,
                    2
                );
            } catch (error) {
                log.error(`Error moving event: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(
                        'Event or calendar not found. Check the event_id and calendar IDs.'
                    );
                if (error.code === 403)
                    throw new UserError(
                        'Permission denied. You need edit access to both source and destination calendars.'
                    );
                throw new UserError(`Failed to move event: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
