import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'list_calendars',
        description:
            'Lists all calendars accessible to the authenticated user. Returns calendar name, ID, access role, and whether it is the primary calendar.',
        parameters: z.object({}),
        execute: async (_args, { log }) => {
            const calendar = await getCalendarClient();
            log.info('Listing calendars');

            try {
                const response = await calendar.calendarList.list();
                const calendars = response.data.items || [];

                const results = calendars.map((cal) => ({
                    id: cal.id,
                    summary: cal.summary || cal.id,
                    description: cal.description || null,
                    primary: cal.primary || false,
                    accessRole: cal.accessRole,
                    timeZone: cal.timeZone,
                    backgroundColor: cal.backgroundColor || null,
                }));

                return JSON.stringify(results, null, 2);
            } catch (error) {
                log.error(`Error listing calendars: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                throw new UserError(`Failed to list calendars: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
