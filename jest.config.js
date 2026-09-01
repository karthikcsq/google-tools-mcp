/** @type {import('jest').Config} */
export default {
    testMatch: ['**/tests/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    transform: {},
    setupFiles: ['./tests/setup.js'],
    // Jest's 5s default is not enough for the suites that call registerAllTools()
    // (doctorSetupInspection, documentationConsistency, feedbackDraftBinding,
    // legacyAliasAuthRetry). That function dynamically imports all 12 tool
    // categories, which is roughly 180 modules; warm it takes about 750ms, but
    // against a cold filesystem cache it has been measured past 5s and timed the
    // doctor suite out with "Exceeded timeout of 5000 ms for a test."
    //
    // That is exactly the CI shape -- publish.yml and test.yml both run `npm ci`
    // and then the suite, so the cache is cold every time -- which made this a
    // release-blocking flake: it reproduced on 1 of 3 `npm ci` + `npm run test:ci`
    // cycles while never once failing across 12 consecutive warm runs.
    //
    // The module loading is legitimate work rather than a bug, so the time budget
    // is what is wrong. 30s matches the fixed MCP client connect timeout this
    // project already designs against, and still fails a genuinely hung test.
    testTimeout: 30000,
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'dist/**/*.js',
        '!dist/index.js',
    ],
};
