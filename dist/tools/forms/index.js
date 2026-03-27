import { register as createForm } from './createForm.js';
import { register as getForm } from './getForm.js';
import { register as listFormResponses } from './listFormResponses.js';
import { register as getFormResponse } from './getFormResponse.js';
import { register as batchUpdateForm } from './batchUpdateForm.js';
import { register as setPublishSettings } from './setPublishSettings.js';

export function registerFormsTools(server) {
    createForm(server);
    getForm(server);
    listFormResponses(server);
    getFormResponse(server);
    batchUpdateForm(server);
    setPublishSettings(server);
}
