import { publicError, isPublicError, wrapOperationError } from '../../errors.js';
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
                if (isPublicError(error)) throw error;
                log.error(`Error listing task lists: ${error.message || error}`);
                if (error.code === 401)
                    throw publicError('Authentication failed. Try logging out and re-authenticating.');
throw wrapOperationError('list task lists', error, { status: error?.code });
            }
        },
    });
}
