import { listProjectFiles } from '../../../src/gateway/dialog/projectFiles.js';

/** Use only after the filesystem middleware has resolved a trusted workspace. */
export async function projectFileIndex(req, res) {
    try {
        return res.json(await listProjectFiles({
            projectKey: req.projectRoot,
            query: typeof req.query.query === 'string' ? req.query.query : undefined,
            cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
            limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
            includeDirs: req.query.includeDirs === undefined ? undefined : String(req.query.includeDirs) !== 'false',
        }));
    } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'file_index_failed';
        const statuses = { PROJECT_NOT_FOUND: 404, PROJECT_PATH_FORBIDDEN: 403,
            INVALID_CURSOR: 400, INVALID_LIMIT: 400, INVALID_QUERY: 400, FILE_INDEX_LIMIT: 422 };
        return res.status(statuses[code] || 500).json({ error: {
            code, message: error instanceof Error ? error.message : String(error),
            ...(error?.details ? { details: error.details } : {}),
            ...(req.id ? { requestId: req.id } : {}),
        } });
    }
}
