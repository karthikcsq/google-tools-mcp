import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'updateTask',
        description:
            'Updates fields on an existing task. Only provided fields are changed; omitted fields are left as-is.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list containing the task'),
            taskId: z.string().describe('ID of the task to update'),
            title: z.string().optional().describe('New title for the task'),
            notes: z.string().optional().describe('New notes for the task'),
            due: z
                .string()
                .optional()
                .describe('New due date in RFC 3339 or plain date format (e.g. "2025-04-30")'),
            status: z
                .enum(['needsAction', 'completed'])
                .optional()
                .describe('New status for the task'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Updating task ${args.taskId} in list: ${args.taskListId}`);

            try {
                const body = {};
                if (args.title !== undefined) body.title = args.title;
                if (args.notes !== undefined) body.notes = args.notes;
                if (args.due !== undefined) body.due = normalizeDate(args.due);
                if (args.status !== undefined) {
                    body.status = args.status;
                    if (args.status === 'completed') body.completed = new Date().toISOString();
                }

                const response = await tasks.tasks.patch({
                    tasklist: args.taskListId,
                    task: args.taskId,
                    requestBody: body,
                });
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
                log.error(`Error updating task: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task not found (taskId: ${args.taskId}, listId: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this task.');
                throw new UserError(`Failed to update task: ${error.message || 'Unknown error'}`);
            }
        },
    });
}

function normalizeDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
    return value;
}
