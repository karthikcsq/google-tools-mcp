import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'createTask',
        description: 'Creates a new task in a Google Tasks task list.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list to add the task to'),
            title: z.string().describe('Title of the task'),
            notes: z.string().optional().describe('Optional notes or description for the task'),
            due: z
                .string()
                .optional()
                .describe('Optional due date in RFC 3339 or plain date format (e.g. "2025-04-30")'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Creating task "${args.title}" in list: ${args.taskListId}`);

            try {
                const body = { title: args.title };
                if (args.notes) body.notes = args.notes;
                if (args.due) body.due = normalizeDate(args.due);

                const response = await tasks.tasks.insert({ tasklist: args.taskListId, requestBody: body });
                const t = response.data;
                return JSON.stringify({
                    id: t.id,
                    taskListId: args.taskListId,
                    title: t.title || '',
                    notes: t.notes || null,
                    status: t.status,
                    due: t.due || null,
                    completed: t.completed || null,
                }, null, 2);
            } catch (error) {
                log.error(`Error creating task: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task list not found (ID: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this task list.');
                throw new UserError(`Failed to create task: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

function normalizeDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
    return value;
}
