import { register as readFile } from './readFile.js';
import { register as searchFileContents } from './searchFileContents.js';

export function registerExtrasTools(server) {
    readFile(server);
    searchFileContents(server);
}
