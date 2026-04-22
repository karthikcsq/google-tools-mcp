import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'deleteTaskList',
        description: 'Permanently deletes a task list and all tasks within it.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list to delete'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Deleting task list: ${args.taskListId}`);

            try {
                await tasks.tasklists.delete({ tasklist: args.taskListId });
                return JSON.stringify({ deleted: true, taskListId: args.taskListId }, null, 2);
            } catch (error) {
                log.error(`Error deleting task list: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task list not found (ID: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. You can only delete task lists you own.');
                throw new UserError(`Failed to delete task list: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
