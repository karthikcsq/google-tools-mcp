import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'listTasks',
        description:
            'Lists tasks in a Google Tasks task list. Optionally filter by completion status or due date range.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list to read from'),
            showCompleted: z
                .boolean()
                .optional()
                .describe('Whether to include completed tasks (default: true)'),
            dueMin: z
                .string()
                .optional()
                .describe('Lower bound for due date filter, RFC 3339 or plain date (e.g. "2025-04-01")'),
            dueMax: z
                .string()
                .optional()
                .describe('Upper bound for due date filter, RFC 3339 or plain date (e.g. "2025-04-30")'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            const showCompleted = args.showCompleted ?? true;
            log.info(`Listing tasks in list: ${args.taskListId}`);

            try {
                const params = {
                    tasklist: args.taskListId,
                    showCompleted,
                    showHidden: showCompleted,
                };
                if (args.dueMin) params.dueMin = normalizeDate(args.dueMin);
                if (args.dueMax) params.dueMax = normalizeDate(args.dueMax);

                const response = await tasks.tasks.list(params);
                const items = response.data.items || [];
                return JSON.stringify(items.map((t) => formatTask(t, args.taskListId)), null, 2);
            } catch (error) {
                log.error(`Error listing tasks: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task list not found (ID: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this task list.');
                throw new UserError(`Failed to list tasks: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

function formatTask(t, taskListId) {
    return {
        id: t.id,
        taskListId,
        title: t.title || '',
        notes: t.notes || null,
        status: t.status,
        due: t.due || null,
        completed: t.completed || null,
    };
}

function normalizeDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
    return value;
}
