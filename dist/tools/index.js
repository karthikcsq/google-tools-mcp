// Register all Gmail tool groups
import { register as registerDrafts } from './drafts.js';
import { register as registerMessages } from './messages.js';
import { register as registerLabels } from './labels.js';
import { register as registerThreads } from './threads.js';
import { register as registerSettings } from './settings.js';

export function registerAllTools(server) {
    registerDrafts(server);
    registerMessages(server);
    registerLabels(server);
    registerThreads(server);
    registerSettings(server);
}
