/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 *
 * Hand-written, and it shadows nothing: every config imports
 * `./vitest.shared.ts` with the extension spelled out, so TypeScript resolves
 * the source. It had gone stale — declaring only `resolve`/`ssr` while the
 * module has exported `sharedConfig.test` and `sharedCoverageExclude` for some
 * time — which is the failure mode a hand-kept mirror of a real module always
 * has. Kept in step here rather than deleted so a consumer resolving the
 * declaration does not see a shape the module lost.
 */
export declare const sharedSetupFiles: string[];
export declare const sharedConfig: {
    resolve: {
        conditions: string[];
    };
    ssr: {
        resolve: {
            conditions: string[];
        };
    };
    test: {
        reporters: string[];
        restoreMocks: boolean;
        unstubEnvs: boolean;
        setupFiles: string[];
        update: "none";
    };
};
export declare const sharedCoverageExclude: string[];
