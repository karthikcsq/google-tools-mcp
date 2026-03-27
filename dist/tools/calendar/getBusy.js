import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'get_busy',
        description:
            'Returns busy time blocks for one or more people in a given time range. ' +
            'Works across your Google Workspace org without needing calendar sharing — you see when people are busy but not event details. ' +
            'Pass email addresses as calendar_ids to check other people.',
        parameters: z.object({
            time_min: z
                .string()
                .describe('Start of query range in RFC3339 format (e.g. "2025-03-15T00:00:00Z").'),
            time_max: z
                .string()
                .describe('End of query range in RFC3339 format (e.g. "2025-03-16T23:59:59Z").'),
            calendar_ids: z
                .array(z.string())
                .optional()
                .default(['primary'])
                .describe('Calendar IDs or email addresses to check. Defaults to ["primary"].'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();
            log.info(`Checking busy times for ${args.calendar_ids.join(', ')}`);

            try {
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: args.time_min,
                        timeMax: args.time_max,
                        items: args.calendar_ids.map((id) => ({ id })),
                    },
                });

                const calendars = response.data.calendars || {};
                const results = {};

                for (const [calId, data] of Object.entries(calendars)) {
                    if (data.errors?.length) {
                        results[calId] = {
                            error: data.errors[0].reason,
                            busy: [],
                        };
                    } else {
                        results[calId] = {
                            busy: (data.busy || []).map((block) => ({
                                start: block.start,
                                end: block.end,
                            })),
                        };
                    }
                }

                return JSON.stringify(results, null, 2);
            } catch (error) {
                log.error(`Error querying freebusy: ${error.message || error}`);
                throw new UserError(`Failed to query busy times: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
