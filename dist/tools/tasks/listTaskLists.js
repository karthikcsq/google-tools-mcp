import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getTasksClient } from '../../clients.js';

export function register(server) {
    server.addTool({
        name: 'listTaskLists',
        description: 'Lists all Google Task lists for the authenticated user. Returns the id and title of each list.',
        parameters: z.object({}),
        execute: async (_args, { log }) => {
            const tasks = await getTasksClient();
            log.info('Listing task lists');

            try {
                const response = await tasks.tasklists.list();
                const lists = response.data.items || [];
                return JSON.stringify(lists.map((l) => ({ id: l.id, title: l.title })), null, 2);
            } catch (error) {
                log.error(`Error listing task lists: ${error.message || error}`);
                if (error.code === 401)
                    throw new UserError('Authentication failed. Try logging out and re-authenticating.');
                throw new UserError(`Failed to list task lists: ${error.message || 'Unknown error'}`);
            }
        },
    });
}
