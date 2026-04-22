import { register as listTaskLists } from './listTaskLists.js';
import { register as createTaskList } from './createTaskList.js';
import { register as deleteTaskList } from './deleteTaskList.js';
import { register as listTasks } from './listTasks.js';
import { register as createTask } from './createTask.js';
import { register as updateTask } from './updateTask.js';
import { register as completeTask } from './completeTask.js';
import { register as deleteTask } from './deleteTask.js';

export function registerTasksTools(server) {
    listTaskLists(server);
    createTaskList(server);
    deleteTaskList(server);
    listTasks(server);
    createTask(server);
    updateTask(server);
    completeTask(server);
    deleteTask(server);
}
