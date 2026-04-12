import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        include: ['src/**/*.test.ts'],
        exclude: ['src/agent/profile-login.test.ts'],
        coverage: {
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/index.ts'],
        },
    },
});
