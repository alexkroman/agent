/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export declare const sharedConfig: {
    resolve: {
        conditions: string[];
    };
    ssr: {
        resolve: {
            conditions: string[];
        };
    };
};
