// Issue #124 -- copyFile silently ignores the name parameter.
//
// Reporter's repro, with their exact parameter name:
//   copyFile(fileId='1lgUTj4...', name='TEMP - markdown push test - DELETE ME')
//   -> returns {"name": "Copy of Kickoff Email Drafts - Partner, Guest, Net-New"}
//
// No error, no warning that the parameter was dropped. Their expectation:
// the copy is created with the requested name, since Drive's files.copy
// supports name in the request body -- or, failing that, the unsupported
// parameter is rejected instead of dropped.
//
// ctx.call() parses arguments through the tool's own zod schema before
// dispatch, exactly as the MCP transport does, so an undeclared "name" is
// stripped here the same way it was for the reporter.
export const name = 'issue-124-copyfile-name';
export const issue = 124;
export const description = 'copyFile must honour the name parameter, or reject it, rather than silently dropping it.';
export const expectedOnBase = 'fail';

export async function run(ctx) {
    const source = await ctx.createDoc(ctx.title('#124 copy source'), ctx.fixture('issue-124-copy-source.md'));

    const requestedName = 'TEMP - markdown push test - DELETE ME ' + ctx.runId;

    // The reporter passed fileId and name, nothing else. The copy inherits the
    // source's parents, so it lands inside the test folder.
    const attempt = await ctx.tryCall('copyFile', { fileId: source.id, name: requestedName });

    if (!attempt.ok) {
        // "Reject the unsupported parameter" is the report's acceptable
        // alternative, so a schema rejection that names the parameter passes.
        const message = attempt.error?.message || String(attempt.error);
        ctx.assertIncludes(
            message,
            'name',
            'copyFile failed for a reason unrelated to the name parameter: ' + message.replace(/\s+/g, ' ').slice(0, 200),
        );
        return;
    }

    const copy = JSON.parse(attempt.result);
    ctx.track(copy.id, 'drive');

    ctx.assertEqual(
        copy.name,
        requestedName,
        'copyFile accepted a name argument and returned a differently named file, with no error and no warning that the '
        + 'parameter was dropped (#124).',
    );
}
