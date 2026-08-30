import { installRuntimeLifecycle } from '../../dist/mcpServer.js';

const mode = process.argv[2];
installRuntimeLifecycle({
    async close() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.stderr.write('closed-before-exit\n');
    },
}, { useStdio: mode === 'eof' });

process.stderr.write('ready\n');
if (mode === 'eof') process.stdin.resume();
if (mode === 'SIGINT' || mode === 'SIGTERM') {
    setTimeout(() => process.emit(mode), 10);
}
setInterval(() => {}, 1000);
