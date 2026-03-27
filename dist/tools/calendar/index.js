import { register as listCalendars } from './listCalendars.js';
import { register as getEvents } from './getEvents.js';
import { register as manageEvent } from './manageEvent.js';
import { register as getBusy } from './getBusy.js';
import { register as getFree } from './getFree.js';
import { register as moveEvent } from './moveEvent.js';
import { register as listRecurringInstances } from './listRecurringInstances.js';
import { register as manageCalendar } from './manageCalendar.js';

export function registerCalendarTools(server) {
    listCalendars(server);
    getEvents(server);
    manageEvent(server);
    getBusy(server);
    getFree(server);
    moveEvent(server);
    listRecurringInstances(server);
    manageCalendar(server);
}
