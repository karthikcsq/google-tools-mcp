/** @type {import('jest').Config} */
export default {
    testMatch: ['**/tests/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    transform: {},
    setupFiles: ['./tests/setup.js'],
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'dist/**/*.js',
        '!dist/index.js',
    ],
};
