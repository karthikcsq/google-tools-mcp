import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'completeTask',
        description: 'Marks a task as completed.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list containing the task'),
            taskId: z.string().describe('ID of the task to complete'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Completing task ${args.taskId} in list: ${args.taskListId}`);

            try {
                const response = await tasks.tasks.patch({
                    tasklist: args.taskListId,
                    task: args.taskId,
                    requestBody: { status: 'completed', completed: new Date().toISOString() },
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
                log.error(`Error completing task: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task not found (taskId: ${args.taskId}, listId: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this task.');
                throw new UserError(`Failed to complete task: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
