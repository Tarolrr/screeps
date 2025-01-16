module.exports = {
    // The root directory that Jest should scan for tests and modules
    rootDir: '.',
    
    // The test environment that will be used for testing
    testEnvironment: 'node',
    
    // The paths to modules that run some code to configure or set up the testing environment
    setupFiles: [],
    
    // A list of paths to directories that Jest should use to search for files in
    roots: [
        '<rootDir>/dist2/tests'
    ],
    
    // Module resolution configuration
    moduleDirectories: [
        'node_modules',
        'dist2'  // This allows imports from dist2 directory
    ],
    
    // File extensions Jest will look for
    moduleFileExtensions: ['js', 'ts', 'd.ts'],
    
    // Ignore patterns
    testPathIgnorePatterns: [
        '/node_modules/'
    ],
    
    // Collect coverage information
    collectCoverage: true,
    
    // Directory where Jest should output its coverage files
    coverageDirectory: 'coverage',
    
    // Coverage reporting configuration
    coverageReporters: ['text', 'lcov'],
    
    // Files to include in coverage calculations
    collectCoverageFrom: [
        'dist2/**/*.js',
        '!dist2/tests/**'
    ],
    
    // The glob patterns Jest uses to detect test files
    testMatch: [
        '**/*.test.js'
    ]
};
