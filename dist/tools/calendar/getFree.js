import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getCalendarClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'get_free',
        description:
            'Finds available time slots where all specified people are free. ' +
            'Takes a duration and working hours as boundaries, then returns open slots. ' +
            'Uses the freebusy API under the hood — works across your org without calendar sharing.',
        parameters: z.object({
            time_min: z
                .string()
                .describe('Start of search range in RFC3339 format (e.g. "2025-03-15T00:00:00Z").'),
            time_max: z
                .string()
                .describe('End of search range in RFC3339 format (e.g. "2025-03-21T23:59:59Z").'),
            duration_minutes: z
                .number()
                .describe('Required slot duration in minutes (e.g. 30, 60).'),
            calendar_ids: z
                .array(z.string())
                .optional()
                .default(['primary'])
                .describe('Calendar IDs or email addresses to check mutual availability. Defaults to ["primary"].'),
            working_hours_start: z
                .string()
                .optional()
                .default('09:00')
                .describe('Start of working hours in HH:MM format (e.g. "09:00"). Defaults to "09:00".'),
            working_hours_end: z
                .string()
                .optional()
                .default('17:00')
                .describe('End of working hours in HH:MM format (e.g. "17:00"). Defaults to "17:00".'),
            timezone: z
                .string()
                .optional()
                .default('UTC')
                .describe('Timezone for working hours (e.g. "America/New_York"). Defaults to "UTC".'),
            max_results: z
                .number()
                .optional()
                .default(10)
                .describe('Maximum number of available slots to return. Defaults to 10.'),
        }),
        execute: async (args, { log }) => {
            const calendar = await getCalendarClient();
            log.info(
                `Finding ${args.duration_minutes}min free slots for ${args.calendar_ids.join(', ')} ` +
                `between ${args.working_hours_start}-${args.working_hours_end} ${args.timezone}`
            );

            try {
                // 1. Query freebusy for all calendars
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: args.time_min,
                        timeMax: args.time_max,
                        timeZone: args.timezone,
                        items: args.calendar_ids.map((id) => ({ id })),
                    },
                });

                const calendars = response.data.calendars || {};

                // Check for errors
                const errors = [];
                for (const [calId, data] of Object.entries(calendars)) {
                    if (data.errors?.length) {
                        errors.push(`${calId}: ${data.errors[0].reason}`);
                    }
                }
                if (errors.length) {
                    throw new UserError(
                        `Could not check availability for some calendars:\n${errors.join('\n')}`
                    );
                }

                // 2. Merge all busy blocks
                const allBusy = [];
                for (const data of Object.values(calendars)) {
                    for (const block of data.busy || []) {
                        allBusy.push({
                            start: new Date(block.start).getTime(),
                            end: new Date(block.end).getTime(),
                        });
                    }
                }

                // Sort and merge overlapping busy blocks
                allBusy.sort((a, b) => a.start - b.start);
                const merged = [];
                for (const block of allBusy) {
                    if (merged.length && block.start <= merged[merged.length - 1].end) {
                        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
                    } else {
                        merged.push({ ...block });
                    }
                }

                // 3. Find free slots within working hours
                const rangeStart = new Date(args.time_min);
                const rangeEnd = new Date(args.time_max);
                const durationMs = args.duration_minutes * 60 * 1000;
                const [whStartH, whStartM] = args.working_hours_start.split(':').map(Number);
                const [whEndH, whEndM] = args.working_hours_end.split(':').map(Number);

                const freeSlots = [];
                const currentDay = new Date(rangeStart);

                // Iterate day by day
                while (currentDay < rangeEnd && freeSlots.length < args.max_results) {
                    const dayStart = getTimeInTimezone(currentDay, whStartH, whStartM, args.timezone);
                    const dayEnd = getTimeInTimezone(currentDay, whEndH, whEndM, args.timezone);

                    if (dayEnd > rangeStart.getTime() && dayStart < rangeEnd.getTime()) {
                        const effectiveStart = Math.max(dayStart, rangeStart.getTime());
                        const effectiveEnd = Math.min(dayEnd, rangeEnd.getTime());

                        // Find free windows in this day
                        const dayBusy = merged.filter(
                            (b) => b.start < effectiveEnd && b.end > effectiveStart
                        );

                        let cursor = effectiveStart;
                        for (const block of dayBusy) {
                            if (block.start > cursor) {
                                // Free gap before this busy block
                                const gapEnd = Math.min(block.start, effectiveEnd);
                                if (gapEnd - cursor >= durationMs && freeSlots.length < args.max_results) {
                                    freeSlots.push({
                                        start: new Date(cursor).toISOString(),
                                        end: new Date(gapEnd).toISOString(),
                                        duration_minutes: Math.round((gapEnd - cursor) / 60000),
                                    });
                                }
                            }
                            cursor = Math.max(cursor, block.end);
                        }
                        // Free gap after last busy block
                        if (effectiveEnd - cursor >= durationMs && freeSlots.length < args.max_results) {
                            freeSlots.push({
                                start: new Date(cursor).toISOString(),
                                end: new Date(effectiveEnd).toISOString(),
                                duration_minutes: Math.round((effectiveEnd - cursor) / 60000),
                            });
                        }
                    }

                    // Move to next day
                    currentDay.setDate(currentDay.getDate() + 1);
                }

                return JSON.stringify(
                    {
                        query: {
                            calendars: args.calendar_ids,
                            duration_minutes: args.duration_minutes,
                            working_hours: `${args.working_hours_start}-${args.working_hours_end} ${args.timezone}`,
                        },
                        available_slots: freeSlots,
                        total_found: freeSlots.length,
                    },
                    null,
                    2
                );
            } catch (error) {
                if (error instanceof UserError) throw error;
                log.error(`Error finding free slots: ${error.message || error}`);
                throw new UserError(`Failed to find available slots: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

/**
 * Get a timestamp for a specific time-of-day on a given date in a timezone.
 * Uses Intl.DateTimeFormat to resolve the timezone offset.
 */
function getTimeInTimezone(date, hours, minutes, timezone) {
    // Build a date string for the target day
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');

    // Create a date in the local timezone of the server, then adjust
    // We use a formatter to figure out the offset
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        // Create a reference point at midnight UTC for this date
        const refUtc = new Date(`${year}-${month}-${day}T${hh}:${mm}:00Z`);

        // Format that UTC time in the target timezone to see what time it appears as
        const parts = formatter.formatToParts(refUtc);
        const tzParts = {};
        for (const p of parts) {
            if (p.type !== 'literal') tzParts[p.type] = parseInt(p.value, 10);
        }

        // Calculate the offset: what we wanted vs what we got
        const gotMinutes = tzParts.hour * 60 + tzParts.minute;
        const wantedMinutes = hours * 60 + minutes;
        const diffMs = (gotMinutes - wantedMinutes) * 60 * 1000;

        // Adjust: if the timezone shows a later time, the UTC equivalent is earlier
        return refUtc.getTime() - diffMs;
    } catch {
        // Fallback: treat as UTC
        return new Date(`${year}-${month}-${day}T${hh}:${mm}:00Z`).getTime();
    }
}
