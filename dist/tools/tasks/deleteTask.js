import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'deleteTask',
        description: 'Permanently deletes a task.',
        parameters: z.object({
            taskListId: z.string().describe('ID of the task list containing the task'),
            taskId: z.string().describe('ID of the task to delete'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Deleting task ${args.taskId} from list: ${args.taskListId}`);

            try {
                await tasks.tasks.delete({ tasklist: args.taskListId, task: args.taskId });
                return JSON.stringify({ deleted: true, taskId: args.taskId, taskListId: args.taskListId }, null, 2);
            } catch (error) {
                log.error(`Error deleting task: ${error.message || error}`);
                if (error.code === 404)
                    throw new UserError(`Task not found (taskId: ${args.taskId}, listId: ${args.taskListId}).`);
                if (error.code === 403)
                    throw new UserError('Permission denied. Make sure you have access to this task.');
                throw new UserError(`Failed to delete task: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
