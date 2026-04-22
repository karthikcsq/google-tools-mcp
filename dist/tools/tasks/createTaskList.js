import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'createTaskList',
        description: 'Creates a new Google Tasks task list with the given title.',
        parameters: z.object({
            title: z.string().describe('Title for the new task list'),
        }),
        execute: async (args, { log }) => {
            const tasks = await getTasksClient();
            log.info(`Creating task list: ${args.title}`);

            try {
                const response = await tasks.tasklists.insert({ requestBody: { title: args.title } });
                return JSON.stringify({ id: response.data.id, title: response.data.title }, null, 2);
            } catch (error) {
                log.error(`Error creating task list: ${error.message || error}`);
                throw new UserError(`Failed to create task list: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
