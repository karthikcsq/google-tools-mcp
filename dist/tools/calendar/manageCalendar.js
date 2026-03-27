import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'manage_calendar',
        description:
            'Create, update, or delete a calendar. Use this to create project-specific calendars, ' +
            'rename calendars, change timezone/description, or remove calendars you own.',
        parameters: z.object({
            action: z.enum(['create', 'update', 'delete']).describe('The operation to perform.'),
            calendar_id: z
                .string()
                .optional()
                .describe('Calendar ID — required for update and delete. Cannot delete primary calendar.'),
            summary: z
                .string()
                .optional()
                .describe('Calendar name/title. Required for create.'),
            description: z
                .string()
                .optional()
                .describe('Calendar description.'),
            timezone: z
                .string()
                .optional()
                .describe('Calendar timezone (e.g. "America/New_York").'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();

            try {
                if (args.action === 'create') {
                    if (!args.summary) throw new UserError('summary is required for create.');
                    log.info(`Creating calendar "${args.summary}"`);

                    const body = { summary: args.summary };
                    if (args.description) body.description = args.description;
                    if (args.timezone) body.timeZone = args.timezone;

                    const response = await calendar.calendars.insert({ requestBody: body });
                    return JSON.stringify(
                        {
                            success: true,
                            action: 'created',
                            id: response.data.id,
                            summary: response.data.summary,
                            timeZone: response.data.timeZone,
                        },
                        null,
                        2
                    );
                }

                if (args.action === 'update') {
                    if (!args.calendar_id) throw new UserError('calendar_id is required for update.');
                    log.info(`Updating calendar ${args.calendar_id}`);

                    // Fetch existing to preserve fields
                    const existing = await calendar.calendars.get({
                        calendarId: args.calendar_id,
                    });

                    const body = {
                        summary: args.summary || existing.data.summary,
                        description:
                            args.description !== undefined
                                ? args.description
                                : existing.data.description,
                        timeZone: args.timezone || existing.data.timeZone,
                    };

                    const response = await calendar.calendars.update({
                        calendarId: args.calendar_id,
                        requestBody: body,
                    });

                    return JSON.stringify(
                        {
                            success: true,
                            action: 'updated',
                            id: response.data.id,
                            summary: response.data.summary,
                            timeZone: response.data.timeZone,
                        },
                        null,
                        2
                    );
                }

                if (args.action === 'delete') {
                    if (!args.calendar_id) throw new UserError('calendar_id is required for delete.');
                    if (args.calendar_id === 'primary')
                        throw new UserError('Cannot delete the primary calendar.');
                    log.info(`Deleting calendar ${args.calendar_id}`);

                    await calendar.calendars.delete({ calendarId: args.calendar_id });
                    return JSON.stringify({
                        success: true,
                        action: 'deleted',
                        id: args.calendar_id,
                        message: `Calendar ${args.calendar_id} deleted.`,
                    });
                }

                throw new UserError(`Unknown action: ${args.action}`);
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error in manage_calendar (${args.action}): ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError('Calendar not found. Check the calendar_id.');
                if (error.code === 403)
                    throw new UserError('Permission denied. You can only modify calendars you own.');
                throw new UserError(
                    `Failed to ${args.action} calendar: ${error.message || 'Unknown error'}`
                );
            }
        },
    });
}
