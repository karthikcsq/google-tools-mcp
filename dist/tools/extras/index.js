import { register as readFile } from './readFile.js';
import { register as searchFileContents } from './searchFileContents.js';
import { register as readDriveFile } from './readDriveFile.js';

export function registerExtrasTools(server) {
    readFile(server);
    searchFileContents(server);
    readDriveFile(server);
}
