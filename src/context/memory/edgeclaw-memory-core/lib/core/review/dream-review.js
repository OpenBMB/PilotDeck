import { traceI18n } from "../trace-i18n.js";
import { hashText, nowIso } from "../utils/id.js";
const DREAM_HEADER_SCAN_LIMIT = 200;
const DREAM_CLUSTER_MAX_FILES = 8;
const DREAM_META_PROJECT_CONTEXT_LIMIT = 5;
const DREAM_META_FEEDBACK_CONTEXT_LIMIT = 5;
const DREAM_USER_NOTE_MAX_FILES = 200;
const DREAM_USER_NOTE_CHAR_BUDGET = 120_000;
const INTERNAL_USER_PROFILE_RELATIVE_PATH = "UserIdentity/user-profile.md";
const EXPOSED_USER_PROFILE_RELATIVE_PATH = "global/UserIdentity/user-profile.md";
const INTERNAL_USER_NOTE_PREFIX = "UserIdentityNotes/";
const EXPOSED_USER_NOTE_PREFIX = "global/UserIdentityNotes/";
function kvDetail(key, label, entries, labelI18n) {
    return {
        key,
        label,
        ...(labelI18n ? { labelI18n } : {}),
        kind: "kv",
        entries: entries.map((entry) => ({
            label: entry.label,
            value: String(entry.value ?? ""),
        })),
    };
}
function listDetail(key, label, items, labelI18n) {
    return {
        key,
        label,
        ...(labelI18n ? { labelI18n } : {}),
        kind: "list",
        items,
    };
}
function normalizeDreamRelativePath(relativePath) {
    return relativePath.replace(/\\/g, "/");
}
function isDreamUserProfilePath(relativePath) {
    const normalized = normalizeDreamRelativePath(relativePath);
    return normalized === INTERNAL_USER_PROFILE_RELATIVE_PATH
        || normalized === EXPOSED_USER_PROFILE_RELATIVE_PATH;
}
function isDreamUserNotePath(relativePath) {
    const normalized = normalizeDreamRelativePath(relativePath);
    return normalized.startsWith(INTERNAL_USER_NOTE_PREFIX)
        || normalized.startsWith(EXPOSED_USER_NOTE_PREFIX);
}
function jsonDetail(key, label, json, labelI18n) {
    return {
        key,
        label,
        ...(labelI18n ? { labelI18n } : {}),
        kind: "json",
        json,
    };
}
function createDreamTrace(trigger) {
    const startedAt = nowIso();
    return {
        dreamTraceId: `dream_trace_${hashText(`${trigger}:${startedAt}:${Math.random().toString(36).slice(2, 10)}`)}`,
        trigger,
        startedAt,
        status: "running",
        isNoOp: false,
        displayStatus: "Running",
        snapshotSummary: {
            projectMetaPresent: false,
            projectFileCount: 0,
            feedbackFileCount: 0,
            hasUserProfile: false,
        },
        steps: [],
        mutations: [],
        outcome: {
            rewrittenProjects: 0,
            deletedProjects: 0,
            deletedFiles: 0,
            profileUpdated: false,
            summary: "",
        },
    };
}
function pushStep(trace, kind, title, status, inputSummary, outputSummary, options = {}) {
    trace.steps.push({
        stepId: `${trace.dreamTraceId}:step:${trace.steps.length + 1}`,
        kind,
        title,
        status,
        inputSummary,
        outputSummary,
        ...(options.refs ? { refs: options.refs } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...(options.details ? { details: options.details } : {}),
        ...(options.promptDebug ? { promptDebug: options.promptDebug } : {}),
        ...(options.titleI18n ? { titleI18n: options.titleI18n } : {}),
        ...(options.inputSummaryI18n ? { inputSummaryI18n: options.inputSummaryI18n } : {}),
        ...(options.outputSummaryI18n ? { outputSummaryI18n: options.outputSummaryI18n } : {}),
    });
}
function mutation(action, relativePath, options = {}) {
    return {
        mutationId: `mutation_${hashText(`${action}:${relativePath}:${Date.now()}:${Math.random()}`)}`,
        action,
        relativePath,
        ...(options.candidateType ? { candidateType: options.candidateType } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.preview ? { preview: options.preview } : {}),
    };
}
function truncate(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength).trim()}...`;
}
function normalizeWhitespace(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
function previewMarkdown(markdown, maxLength = 220) {
    return truncate(markdown.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim(), maxLength);
}
function sortEntries(entries) {
    return [...entries].sort((left, right) => {
        if (right.updatedAt !== left.updatedAt)
            return right.updatedAt.localeCompare(left.updatedAt);
        return left.relativePath.localeCompare(right.relativePath);
    });
}
function sortProjectMetas(entries) {
    return [...entries].sort((left, right) => {
        if (right.updatedAt !== left.updatedAt)
            return right.updatedAt.localeCompare(left.updatedAt);
        return left.projectName.localeCompare(right.projectName);
    });
}
function toDreamMetaInput(meta) {
    return {
        projectId: meta.projectId,
        projectName: meta.projectName,
        description: meta.description,
        status: meta.status,
        updatedAt: meta.updatedAt,
        ...(meta.dreamUpdatedAt ? { dreamUpdatedAt: meta.dreamUpdatedAt } : {}),
        ...(meta.sourceKind ? { sourceKind: meta.sourceKind } : {}),
        ...(meta.sourceWorkspacePath ? { sourceWorkspacePath: meta.sourceWorkspacePath } : {}),
        ...(meta.sourceProjectId ? { sourceProjectId: meta.sourceProjectId } : {}),
    };
}
function toDreamRecordInput(store, record) {
    const candidate = store.toCandidate(record);
    return {
        entryId: record.relativePath,
        relativePath: record.relativePath,
        type: record.type === "feedback" ? "feedback" : "project",
        scope: "project",
        projectId: record.projectId,
        isTmp: false,
        name: record.name,
        description: record.description,
        updatedAt: record.updatedAt,
        ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
        ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
        content: record.content,
        ...(candidate.type === "project"
            ? {
                project: {
                    stage: candidate.stage ?? "",
                    decisions: candidate.decisions ?? [],
                    constraints: candidate.constraints ?? [],
                    nextSteps: candidate.nextSteps ?? [],
                    blockers: candidate.blockers ?? [],
                    timeline: candidate.timeline ?? [],
                    notes: candidate.notes ?? [],
                },
            }
            : {}),
        ...(candidate.type === "feedback"
            ? {
                feedback: {
                    rule: candidate.rule ?? "",
                    why: candidate.why ?? "",
                    howToApply: candidate.howToApply ?? "",
                    notes: candidate.notes ?? [],
                },
            }
            : {}),
    };
}
function toHeaderInput(entry) {
    return {
        relativePath: entry.relativePath,
        name: entry.name,
        description: entry.description,
        updatedAt: entry.updatedAt,
    };
}
function toRefinedCandidate(input) {
    return {
        type: input.kind,
        scope: "project",
        name: input.name,
        description: input.description,
        body: `${input.markdown.trim()}\n`,
        ...(input.sourceRecord.capturedAt ? { capturedAt: input.sourceRecord.capturedAt } : {}),
        ...(input.sourceRecord.sourceSessionKey ? { sourceSessionKey: input.sourceRecord.sourceSessionKey } : {}),
    };
}
function validateExclusiveClusters(clusters, allowedRelativePaths, maxFiles) {
    const used = new Set();
    const accepted = [];
    const droppedWarnings = [];
    const sameProjectReasonPatterns = [
        /same current project/i,
        /same project/i,
        /same workspace/i,
        /belong to the same project/i,
        /all .*same project/i,
        /同一个项目/,
        /同一项目/,
        /都属于同一个项目/,
        /都属于同一项目/,
        /同属.*项目/,
        /属于当前项目/,
        /同一个工作区/,
    ];
    const semanticReasonPatterns = [
        /overlap/i,
        /overlapping/i,
        /duplicate/i,
        /duplicated/i,
        /redundant/i,
        /redundancy/i,
        /conflict/i,
        /conflicting/i,
        /inconsistent/i,
        /merge/i,
        /consolidat/i,
        /same rule/i,
        /same constraint/i,
        /same risk/i,
        /same blocker/i,
        /same goal/i,
        /same stage/i,
        /same definition/i,
        /same style/i,
        /same audience/i,
        /重复/,
        /冗余/,
        /冲突/,
        /重叠/,
        /可合并/,
        /可统一/,
        /内容重合/,
        /语义重合/,
        /事实重合/,
        /相同规则/,
        /相同约束/,
        /相同风险/,
        /相同阻塞/,
        /相同目标/,
        /相同阶段/,
        /相同定义/,
        /相同风格/,
        /相同受众/,
    ];
    const isGenericSameProjectReason = (reason) => {
        const normalized = normalizeWhitespace(reason);
        if (!normalized)
            return false;
        return sameProjectReasonPatterns.some((pattern) => pattern.test(normalized))
            && !semanticReasonPatterns.some((pattern) => pattern.test(normalized));
    };
    for (const cluster of clusters) {
        const uniqueMembers = Array.from(new Set(cluster.memberRelativePaths
            .map((item) => normalizeWhitespace(item))
            .filter((item) => item && allowedRelativePaths.has(item))));
        if (uniqueMembers.length < 2) {
            droppedWarnings.push(`Dropped cluster because it had fewer than 2 valid files: ${cluster.reason || uniqueMembers.join(", ")}`);
            continue;
        }
        if (uniqueMembers.length > maxFiles) {
            droppedWarnings.push(`Dropped cluster because it exceeded the ${maxFiles}-file limit: ${uniqueMembers.join(", ")}`);
            continue;
        }
        if (uniqueMembers.some((item) => used.has(item))) {
            droppedWarnings.push(`Dropped overlapping cluster: ${uniqueMembers.join(", ")}`);
            continue;
        }
        if (isGenericSameProjectReason(cluster.reason)) {
            droppedWarnings.push(`Dropped low-quality cluster because the reason only referenced same-project membership without concrete overlap/conflict: ${uniqueMembers.join(", ")}`);
            continue;
        }
        uniqueMembers.forEach((item) => used.add(item));
        accepted.push({
            memberRelativePaths: uniqueMembers,
            reason: cluster.reason,
        });
    }
    return { clusters: accepted, droppedWarnings };
}
function selectUserNoteWindow(records) {
    const sorted = [...records].sort((left, right) => {
        if (right.updatedAt !== left.updatedAt)
            return right.updatedAt.localeCompare(left.updatedAt);
        return left.relativePath.localeCompare(right.relativePath);
    });
    const selected = [];
    let chars = 0;
    for (const record of sorted) {
        if (selected.length >= DREAM_USER_NOTE_MAX_FILES)
            break;
        const nextChars = chars + record.content.length;
        if (nextChars > DREAM_USER_NOTE_CHAR_BUDGET)
            break;
        selected.push(record);
        chars = nextChars;
    }
    const selectedIds = new Set(selected.map((record) => record.relativePath));
    return {
        selectedRecords: selected,
        selectedChars: chars,
        keptRecords: sorted.filter((record) => !selectedIds.has(record.relativePath)),
    };
}
function validateGeneralProjectMergeGroups(input) {
    const projectById = new Map(input.metas.map((meta) => [meta.projectId, meta]));
    const usedProjectIds = new Set();
    const acceptedGroups = [];
    const droppedWarnings = [];
    for (const [index, group] of input.groups.entries()) {
        const groupLabel = `group ${index + 1}`;
        const keeperProjectId = normalizeWhitespace(group.keeperProjectId);
        const duplicateProjectIds = Array.from(new Set(group.duplicateProjectIds.map((projectId) => normalizeWhitespace(projectId)).filter(Boolean)));
        if (!projectById.has(keeperProjectId)) {
            droppedWarnings.push(`Dropped ${groupLabel}: unknown keeper project id ${keeperProjectId || "(empty)"}.`);
            continue;
        }
        const unknownDuplicate = duplicateProjectIds.find((projectId) => !projectById.has(projectId));
        if (unknownDuplicate) {
            droppedWarnings.push(`Dropped ${groupLabel}: unknown duplicate project id ${unknownDuplicate}.`);
            continue;
        }
        if (duplicateProjectIds.includes(keeperProjectId)) {
            droppedWarnings.push(`Dropped ${groupLabel}: keeper project id was also listed as a duplicate.`);
            continue;
        }
        if (duplicateProjectIds.length === 0) {
            droppedWarnings.push(`Dropped ${groupLabel}: no duplicate project ids were supplied.`);
            continue;
        }
        const allProjectIds = [keeperProjectId, ...duplicateProjectIds];
        const reusedProjectId = allProjectIds.find((projectId) => usedProjectIds.has(projectId));
        if (reusedProjectId) {
            droppedWarnings.push(`Dropped ${groupLabel}: project id ${reusedProjectId} was already used in another merge group.`);
            continue;
        }
        allProjectIds.forEach((projectId) => usedProjectIds.add(projectId));
        acceptedGroups.push({
            keeperProjectId,
            duplicateProjectIds,
            reason: group.reason || "Model identified these project metas as duplicates.",
        });
    }
    return { acceptedGroups, droppedWarnings };
}
export class DreamRewriteRunner {
    repository;
    extractor;
    logger;
    constructor(repository, extractor, options = {}) {
        this.repository = repository;
        this.extractor = extractor;
        this.logger = options.logger;
    }
    async runCategoryDream(input) {
        const { trace, kind, entries, recordsByPath, projectMeta } = input;
        const sortedEntries = sortEntries(entries).slice(0, DREAM_HEADER_SCAN_LIMIT);
        const headers = sortedEntries.map(toHeaderInput);
        const headerStepKind = kind === "project" ? "project_header_scan" : "feedback_header_scan";
        const clusterPlanKind = kind === "project" ? "project_cluster_plan" : "feedback_cluster_plan";
        const refineKind = kind === "project" ? "project_cluster_refine" : "feedback_cluster_refine";
        const categoryLabel = kind === "project" ? "Project" : "Feedback";
        const scopedCategoryLabel = projectMeta
            ? `${categoryLabel} · ${projectMeta.projectName}`
            : categoryLabel;
        pushStep(trace, headerStepKind, `${scopedCategoryLabel} Header Scan`, sortedEntries.length > 0 ? "success" : "skipped", `${entries.length} active ${kind} files`, sortedEntries.length > 0
            ? `Loaded ${sortedEntries.length} ${kind} headers for cluster planning.`
            : `No active ${kind} files were available for cluster planning.`, {
            titleI18n: traceI18n(kind === "project" ? "trace.step.project_header_scan" : "trace.step.feedback_header_scan", `${categoryLabel} Header Scan`),
            details: [
                kvDetail(`${kind}-header-summary`, `${categoryLabel} Header Summary`, [
                    ...(projectMeta
                        ? [{ label: "projectId", value: projectMeta.projectId }, { label: "projectName", value: projectMeta.projectName }]
                        : []),
                    { label: "inputFiles", value: entries.length },
                    { label: "scannedHeaders", value: sortedEntries.length },
                    { label: "headerScanLimit", value: DREAM_HEADER_SCAN_LIMIT },
                ]),
                ...(sortedEntries.length > 0
                    ? [listDetail(`${kind}-headers`, `${categoryLabel} Headers`, sortedEntries.map((entry) => `${entry.relativePath} | ${entry.name} | ${entry.updatedAt}`))]
                    : []),
            ],
        });
        if (sortedEntries.length < 2) {
            pushStep(trace, clusterPlanKind, `${scopedCategoryLabel} Cluster Plan`, "skipped", `${sortedEntries.length} ${kind} headers`, `Dream skipped ${kind} cluster planning because fewer than 2 files were available.`, {
                titleI18n: traceI18n(kind === "project" ? "trace.step.project_cluster_plan" : "trace.step.feedback_cluster_plan", `${categoryLabel} Cluster Plan`),
            });
            return {
                plannedClusters: 0,
                refinedClusters: 0,
                deletedFiles: 0,
                droppedWarnings: [],
            };
        }
        let clusterPlanDebug;
        const rawPlan = await this.extractor.planDreamClusters({
            kind,
            headers,
            debugTrace: (debug) => {
                clusterPlanDebug = debug;
            },
        });
        const { clusters, droppedWarnings } = validateExclusiveClusters(rawPlan.clusters, new Set(sortedEntries.map((entry) => entry.relativePath)), DREAM_CLUSTER_MAX_FILES);
        pushStep(trace, clusterPlanKind, `${scopedCategoryLabel} Cluster Plan`, clusters.length > 0 ? "success" : droppedWarnings.length > 0 ? "warning" : "skipped", `${sortedEntries.length} ${kind} headers`, clusters.length > 0
            ? rawPlan.summary
            : droppedWarnings.length > 0
                ? `Dream produced no valid ${kind} clusters after validation.`
                : `Dream found no ${kind} files that should be refined together.`, {
            titleI18n: traceI18n(kind === "project" ? "trace.step.project_cluster_plan" : "trace.step.feedback_cluster_plan", `${categoryLabel} Cluster Plan`),
            details: [
                kvDetail(`${kind}-cluster-summary`, `${categoryLabel} Cluster Summary`, [
                    ...(projectMeta
                        ? [{ label: "projectId", value: projectMeta.projectId }, { label: "projectName", value: projectMeta.projectName }]
                        : []),
                    { label: "plannerClusters", value: rawPlan.clusters.length },
                    { label: "acceptedClusters", value: clusters.length },
                    { label: "droppedClusters", value: droppedWarnings.length },
                    { label: "clusterMaxFiles", value: DREAM_CLUSTER_MAX_FILES },
                ]),
                jsonDetail(`${kind}-cluster-plan-output`, `${categoryLabel} Cluster Plan Output`, {
                    summary: rawPlan.summary,
                    plannerClusters: rawPlan.clusters,
                    acceptedClusters: clusters,
                    droppedWarnings,
                }),
            ],
            ...(clusterPlanDebug ? { promptDebug: clusterPlanDebug } : {}),
        });
        let refinedClusters = 0;
        let deletedFiles = 0;
        for (const [index, cluster] of clusters.entries()) {
            const clusterRecords = cluster.memberRelativePaths
                .map((relativePath) => recordsByPath.get(relativePath))
                .filter((record) => Boolean(record));
            if (clusterRecords.length < 2) {
                droppedWarnings.push(`Skipped ${kind} cluster ${index + 1} because fewer than 2 files could be loaded.`);
                continue;
            }
            let refineDebug;
            const refined = await this.extractor.refineDreamCluster({
                kind,
                records: clusterRecords.map((record) => toDreamRecordInput(this.repository.getFileMemoryStore(), record)),
                debugTrace: (debug) => {
                    refineDebug = debug;
                },
            });
            if (!refined.file) {
                pushStep(trace, refineKind, `${scopedCategoryLabel} Cluster Refine #${index + 1}`, "warning", `${clusterRecords.length} ${kind} files`, `Dream could not synthesize a refined ${kind} file for this cluster.`, {
                    titleI18n: traceI18n(kind === "project" ? "trace.step.project_cluster_refine" : "trace.step.feedback_cluster_refine", `${categoryLabel} Cluster Refine`),
                    details: [
                        jsonDetail(`${kind}-cluster-${index + 1}`, `${categoryLabel} Cluster`, {
                            ...(projectMeta
                                ? { projectId: projectMeta.projectId, projectName: projectMeta.projectName }
                                : {}),
                            members: cluster.memberRelativePaths,
                            reason: cluster.reason,
                        }),
                    ],
                    ...(refineDebug ? { promptDebug: refineDebug } : {}),
                });
                continue;
            }
            const sourceRecord = [...clusterRecords].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
            const candidate = toRefinedCandidate({
                kind,
                name: refined.file.name,
                description: refined.file.description,
                markdown: refined.file.markdown,
                sourceRecord,
            });
            const scopedCandidate = projectMeta
                ? { ...candidate, projectId: projectMeta.projectId }
                : candidate;
            this.repository.deleteMemoryEntries(cluster.memberRelativePaths);
            for (const relativePath of cluster.memberRelativePaths) {
                trace.mutations.push(mutation("delete", relativePath));
            }
            const writtenRecord = this.repository.getFileMemoryStore().upsertCandidate(scopedCandidate);
            trace.mutations.push(mutation("write", writtenRecord.relativePath, {
                candidateType: kind,
                name: writtenRecord.name,
                description: writtenRecord.description,
                preview: previewMarkdown(writtenRecord.content),
            }));
            refinedClusters += 1;
            deletedFiles += cluster.memberRelativePaths.length;
            pushStep(trace, refineKind, `${scopedCategoryLabel} Cluster Refine #${index + 1}`, "success", `${clusterRecords.length} ${kind} files`, refined.summary, {
                titleI18n: traceI18n(kind === "project" ? "trace.step.project_cluster_refine" : "trace.step.feedback_cluster_refine", `${categoryLabel} Cluster Refine`),
                details: [
                    jsonDetail(`${kind}-cluster-${index + 1}`, `${categoryLabel} Cluster`, {
                        ...(projectMeta
                            ? { projectId: projectMeta.projectId, projectName: projectMeta.projectName }
                            : {}),
                        members: cluster.memberRelativePaths,
                        reason: cluster.reason,
                        newFile: writtenRecord.relativePath,
                        deletedFiles: cluster.memberRelativePaths,
                    }),
                ],
                ...(refineDebug ? { promptDebug: refineDebug } : {}),
            });
        }
        return {
            plannedClusters: clusters.length,
            refinedClusters,
            deletedFiles,
            droppedWarnings,
        };
    }
    async mergeGeneralProjectMetas(trace, workspaceStore) {
        const metas = sortProjectMetas(workspaceStore.listProjectMetas());
        const result = {
            mergedProjects: 0,
            deletedProjects: 0,
            relinkedFiles: 0,
            planSummary: metas.length < 2
                ? "Fewer than two General project nodes were available for merge planning."
                : "",
            droppedWarnings: [],
            groups: [],
        };
        let plannerGroups = [];
        let acceptedPlannerGroups = [];
        let mergePlanDebug;
        if (metas.length >= 2) {
            try {
                const plan = await this.extractor.planGeneralProjectMetaMerges({
                    projectMetas: metas.map(toDreamMetaInput),
                    debugTrace: (debug) => {
                        mergePlanDebug = debug;
                    },
                });
                result.planSummary = plan.summary;
                plannerGroups = plan.mergeGroups;
                const validated = validateGeneralProjectMergeGroups({
                    metas,
                    groups: plannerGroups,
                });
                result.droppedWarnings = validated.droppedWarnings;
                acceptedPlannerGroups = validated.acceptedGroups;
            }
            catch (error) {
                result.planSummary = `Dream skipped General project merge planning because the model request failed: ${error instanceof Error ? error.message : String(error)}`;
                result.droppedWarnings.push(result.planSummary);
                this.logger?.warn?.(`[clawxmemory] General project meta merge planning failed: ${String(error)}`);
            }
        }
        const projectById = new Map(metas.map((meta) => [meta.projectId, meta]));
        for (const group of acceptedPlannerGroups) {
            const keeper = projectById.get(group.keeperProjectId);
            if (!keeper)
                continue;
            const duplicates = group.duplicateProjectIds
                .map((projectId) => projectById.get(projectId))
                .filter((meta) => Boolean(meta));
            if (duplicates.length === 0)
                continue;
            const relinkedFiles = [];
            for (const duplicate of duplicates) {
                const relinked = workspaceStore.reassignProjectEntries({
                    fromProjectId: duplicate.projectId,
                    toProjectId: keeper.projectId,
                });
                relinkedFiles.push(...relinked.mutatedIds);
                workspaceStore.deleteEntries([duplicate.relativePath]);
                trace.mutations.push({
                    mutationId: `mutation_${hashText(`delete_project:${duplicate.projectId}:${Date.now()}`)}`,
                    action: "delete_project",
                    projectId: duplicate.projectId,
                    projectName: duplicate.projectName,
                    relativePath: duplicate.relativePath,
                });
                result.mergedProjects += 1;
                result.deletedProjects += 1;
            }
            for (const relativePath of relinkedFiles) {
                trace.mutations.push(mutation("write", relativePath));
            }
            result.relinkedFiles += relinkedFiles.length;
            result.groups.push({
                keeperProjectId: keeper.projectId,
                keeperProjectName: keeper.projectName,
                mergedProjectIds: duplicates.map((item) => item.projectId),
                reason: group.reason,
                relinkedFiles,
            });
        }
        pushStep(trace, "general_project_merge", "General Project Merge", result.groups.length > 0 ? "success" : result.droppedWarnings.length > 0 ? "warning" : "skipped", `${metas.length} local general projects`, result.groups.length > 0
            ? `Merged ${result.deletedProjects} duplicate General project nodes and relinked ${result.relinkedFiles} memory files.`
            : result.planSummary || "No duplicate General project nodes required merging.", {
            titleI18n: traceI18n("trace.step.general_project_merge", "General Project Merge"),
            details: [
                kvDetail("general-project-merge-summary", "General Project Merge Summary", [
                    { label: "projectNodes", value: metas.length },
                    { label: "plannerGroups", value: plannerGroups.length },
                    { label: "droppedGroups", value: result.droppedWarnings.length },
                    { label: "mergedProjects", value: result.mergedProjects },
                    { label: "deletedProjects", value: result.deletedProjects },
                    { label: "relinkedFiles", value: result.relinkedFiles },
                ]),
                jsonDetail("general-project-merge-plan", "General Project Merge Plan", {
                    summary: result.planSummary,
                    plannerGroups,
                    acceptedGroups: result.groups,
                    droppedWarnings: result.droppedWarnings,
                }),
            ],
            ...(mergePlanDebug ? { promptDebug: mergePlanDebug } : {}),
        });
        return result;
    }
    async runProjectMetaReview(input) {
        const { trace, workspaceStore, projectMeta } = input;
        const currentEntriesAfterRefine = projectMeta.sourceKind === "workspace_external_mirror"
            ? this.repository.listReadableProjectEntries(projectMeta.projectId, {
                kinds: ["project", "feedback"],
                includeDeprecated: false,
            })
            : this.repository.listMemoryEntries({
                kinds: ["project", "feedback"],
                scope: "project",
                projectId: projectMeta.projectId,
                includeDeprecated: false,
                limit: 5000,
            });
        const recentProjectEntries = sortEntries(currentEntriesAfterRefine.filter((entry) => entry.type === "project")).slice(0, DREAM_META_PROJECT_CONTEXT_LIMIT);
        const recentFeedbackEntries = sortEntries(currentEntriesAfterRefine.filter((entry) => entry.type === "feedback")).slice(0, DREAM_META_FEEDBACK_CONTEXT_LIMIT);
        const projectMetaReviewIds = [
            ...recentProjectEntries.map((entry) => entry.relativePath),
            ...recentFeedbackEntries.map((entry) => entry.relativePath),
        ];
        const projectMetaReviewRecords = projectMetaReviewIds.length > 0
            ? this.repository.getMemoryRecordsByIds(projectMetaReviewIds, 5000)
            : [];
        const projectMetaReviewMap = new Map(projectMetaReviewRecords.map((record) => [record.relativePath, record]));
        const recentProjectRecords = recentProjectEntries
            .map((entry) => projectMetaReviewMap.get(entry.relativePath))
            .filter((record) => Boolean(record));
        const recentFeedbackRecords = recentFeedbackEntries
            .map((entry) => projectMetaReviewMap.get(entry.relativePath))
            .filter((record) => Boolean(record));
        let metaUpdated = false;
        let metaReviewDebug;
        let metaReviewReason = "Dream kept the current project metadata unchanged.";
        const currentProjectMeta = workspaceStore.getProjectMeta(projectMeta.projectId) ?? projectMeta;
        if (recentProjectRecords.length > 0 || recentFeedbackRecords.length > 0) {
            const metaReview = await this.extractor.reviewDreamProjectMeta({
                currentMeta: toDreamMetaInput(currentProjectMeta),
                recentProjectRecords: recentProjectRecords.map((record) => toDreamRecordInput(workspaceStore, record)),
                recentFeedbackRecords: recentFeedbackRecords.map((record) => toDreamRecordInput(workspaceStore, record)),
                debugTrace: (debug) => {
                    metaReviewDebug = debug;
                },
            });
            const shouldUpdate = metaReview.shouldUpdate && (metaReview.projectMeta.projectName !== currentProjectMeta.projectName
                || metaReview.projectMeta.description !== currentProjectMeta.description
                || metaReview.projectMeta.status !== currentProjectMeta.status);
            if (shouldUpdate) {
                const nextMeta = workspaceStore.upsertProjectMeta({
                    projectId: currentProjectMeta.projectId,
                    projectName: metaReview.projectMeta.projectName,
                    description: metaReview.projectMeta.description,
                    status: metaReview.projectMeta.status,
                    ...(currentProjectMeta.sourceKind ? { sourceKind: currentProjectMeta.sourceKind } : {}),
                    ...(currentProjectMeta.sourceWorkspacePath ? { sourceWorkspacePath: currentProjectMeta.sourceWorkspacePath } : {}),
                    ...(currentProjectMeta.sourceProjectId ? { sourceProjectId: currentProjectMeta.sourceProjectId } : {}),
                    dreamUpdatedAt: nowIso(),
                });
                trace.mutations.push(mutation("write", nextMeta.relativePath, {
                    preview: `${nextMeta.projectName} | ${nextMeta.status}`,
                }));
                metaUpdated = true;
            }
            metaReviewReason = metaReview.reason || metaReviewReason;
        }
        pushStep(trace, "project_meta_review", `Project Meta Review · ${currentProjectMeta.projectName}`, metaUpdated ? "success" : recentProjectRecords.length > 0 || recentFeedbackRecords.length > 0 ? "skipped" : "skipped", `${recentProjectRecords.length} project files + ${recentFeedbackRecords.length} feedback files`, metaUpdated ? metaReviewReason : metaReviewReason, {
            titleI18n: traceI18n("trace.step.project_meta_review", "Project Meta Review"),
            details: [
                kvDetail("project-meta-review-summary", "Project Meta Review Summary", [
                    { label: "projectId", value: currentProjectMeta.projectId },
                    { label: "projectName", value: currentProjectMeta.projectName },
                    { label: "recentProjectFiles", value: recentProjectRecords.length },
                    { label: "recentFeedbackFiles", value: recentFeedbackRecords.length },
                    { label: "metaUpdated", value: metaUpdated ? "yes" : "no" },
                ]),
                jsonDetail("project-meta-review-input", "Project Meta Review Input", {
                    currentMeta: currentProjectMeta,
                    recentProjectFiles: recentProjectEntries.map((entry) => entry.relativePath),
                    recentFeedbackFiles: recentFeedbackEntries.map((entry) => entry.relativePath),
                }),
            ],
            ...(metaReviewDebug ? { promptDebug: metaReviewDebug } : {}),
        });
        return {
            updated: metaUpdated,
            reason: metaReviewReason,
        };
    }
    async run(trigger = "manual") {
        const trace = createDreamTrace(trigger);
        const workspaceStore = this.repository.getFileMemoryStore();
        const globalUserStore = this.repository.getGlobalUserStore();
        const userProfileRelativePath = globalUserStore.getUserProfileRelativePath();
        const workspaceEntries = this.repository.listMemoryEntries({
            kinds: ["project", "feedback"],
            scope: "project",
            includeDeprecated: false,
            limit: 5000,
        });
        const projectEntries = workspaceEntries.filter((entry) => entry.type === "project");
        const feedbackEntries = workspaceEntries.filter((entry) => entry.type === "feedback");
        const isGeneralMode = workspaceStore.isGeneralMode();
        const projectMeta = isGeneralMode
            ? undefined
            : workspaceStore.getProjectMeta() ?? workspaceStore.ensureProjectMeta();
        const generalProjectMetas = isGeneralMode ? sortProjectMetas(workspaceStore.listProjectMetas()) : [];
        const userSummary = this.repository.getUserSummary();
        const rawGlobalUserEntries = this.repository.listMemoryEntries({
            kinds: ["user"],
            scope: "global",
            includeDeprecated: false,
            limit: 5000,
        });
        const skippedProtectedUserEntries = rawGlobalUserEntries
            .filter((entry) => isDreamUserProfilePath(entry.relativePath) || !isDreamUserNotePath(entry.relativePath))
            .map((entry) => `${entry.relativePath} | ${entry.updatedAt}`);
        const userNoteEntries = rawGlobalUserEntries.filter((entry) => (isDreamUserNotePath(entry.relativePath) && !isDreamUserProfilePath(entry.relativePath)));
        const workspaceRecords = workspaceEntries.length > 0
            ? this.repository.getMemoryRecordsByIds(workspaceEntries.map((entry) => entry.relativePath), 5000)
            : [];
        const recordsByPath = new Map(workspaceRecords.map((record) => [record.relativePath, record]));
        const userNoteRecords = userNoteEntries.length > 0
            ? this.repository.getMemoryRecordsByIds(userNoteEntries.map((entry) => entry.relativePath), 5000)
            : [];
        trace.snapshotSummary = {
            projectMetaPresent: isGeneralMode ? generalProjectMetas.length > 0 : Boolean(projectMeta),
            projectFileCount: projectEntries.length,
            feedbackFileCount: feedbackEntries.length,
            hasUserProfile: userSummary.files.length > 0,
        };
        pushStep(trace, "dream_start", "Dream Start", "info", `${trigger} dream run started.`, "Dream loaded the current memory snapshot and began staged refinement.", {
            titleI18n: traceI18n("trace.step.dream_start", "Dream Start"),
        });
        pushStep(trace, "snapshot_loaded", "Snapshot Loaded", workspaceEntries.length > 0 || userSummary.files.length > 0 || userNoteRecords.length > 0 || generalProjectMetas.length > 0 ? "success" : "warning", `${workspaceEntries.length} project files, ${userNoteRecords.length} user notes`, workspaceEntries.length > 0 || userSummary.files.length > 0 || userNoteRecords.length > 0 || generalProjectMetas.length > 0
            ? "Current project memory is ready for staged Dream processing."
            : "No file-based memory exists yet, so Dream had nothing to organize.", {
            titleI18n: traceI18n("trace.step.snapshot_loaded", "Snapshot Loaded"),
            details: [
                kvDetail("snapshot-summary", "Snapshot Summary", [
                    { label: "projectMetaPresent", value: trace.snapshotSummary.projectMetaPresent ? "yes" : "no" },
                    ...(isGeneralMode ? [{ label: "generalProjects", value: generalProjectMetas.length }] : []),
                    { label: "projectFiles", value: trace.snapshotSummary.projectFileCount },
                    { label: "feedbackFiles", value: trace.snapshotSummary.feedbackFileCount },
                    { label: "hasUserProfile", value: trace.snapshotSummary.hasUserProfile ? "yes" : "no" },
                    { label: "userNotes", value: userNoteRecords.length },
                ], traceI18n("trace.detail.snapshot_summary", "Snapshot Summary")),
                ...(!isGeneralMode
                    ? [jsonDetail("project-meta", "Project Meta", projectMeta, traceI18n("trace.detail.project_meta", "Project Meta"))]
                    : []),
                ...(isGeneralMode && generalProjectMetas.length > 0
                    ? [jsonDetail("general-project-meta", "General Project Meta", generalProjectMetas.map((entry) => ({
                            projectId: entry.projectId,
                            projectName: entry.projectName,
                            sourceKind: entry.sourceKind ?? "general_local",
                            sourceWorkspacePath: entry.sourceWorkspacePath ?? null,
                            sourceProjectId: entry.sourceProjectId ?? null,
                            updatedAt: entry.updatedAt,
                        })))]
                    : []),
                ...(workspaceEntries.length > 0
                    ? [listDetail("snapshot-files", "Current Project Files", sortEntries(workspaceEntries).map((entry) => `${entry.relativePath} | ${entry.updatedAt}`), traceI18n("trace.detail.loaded_files", "Loaded Files"))]
                    : []),
                ...(userNoteEntries.length > 0
                    ? [listDetail("snapshot-user-notes", "User Notes", sortEntries(userNoteEntries).map((entry) => `${entry.relativePath} | ${entry.updatedAt}`))]
                    : []),
                ...(skippedProtectedUserEntries.length > 0
                    ? [listDetail("snapshot-protected-user-paths", "Protected User Paths Skipped", skippedProtectedUserEntries)]
                    : []),
            ],
        });
        if (workspaceEntries.length === 0
            && userSummary.files.length === 0
            && userNoteRecords.length === 0
            && (!isGeneralMode || generalProjectMetas.length === 0)) {
            const finishedAt = nowIso();
            const summary = "No file-based memory exists yet, so Dream had nothing to organize.";
            trace.finishedAt = finishedAt;
            trace.status = "completed";
            trace.isNoOp = true;
            trace.displayStatus = "No-op";
            trace.outcome = {
                rewrittenProjects: 0,
                deletedProjects: 0,
                deletedFiles: 0,
                profileUpdated: false,
                summary,
            };
            pushStep(trace, "dream_finished", "Dream Finished", "success", isGeneralMode ? "No memory files or General project nodes" : "No memory files", summary, {
                titleI18n: traceI18n("trace.step.dream_finished", "Dream Finished"),
            });
            return {
                reviewedFiles: 0,
                rewrittenProjects: 0,
                deletedProjects: 0,
                deletedFiles: 0,
                profileUpdated: false,
                duplicateTopicCount: 0,
                conflictTopicCount: 0,
                summary,
                finishedAt,
                isNoOp: true,
                trace,
            };
        }
        let projectDream = {
            plannedClusters: 0,
            refinedClusters: 0,
            deletedFiles: 0,
            droppedWarnings: [],
        };
        let feedbackDream = {
            plannedClusters: 0,
            refinedClusters: 0,
            deletedFiles: 0,
            droppedWarnings: [],
        };
        let metaUpdatedCount = 0;
        let deletedProjects = 0;
        if (isGeneralMode) {
            const mergeResult = await this.mergeGeneralProjectMetas(trace, workspaceStore);
            deletedProjects = mergeResult.deletedProjects;
            const currentProjectMetas = sortProjectMetas(workspaceStore.listProjectMetas());
            for (const currentMeta of currentProjectMetas) {
                const currentEntries = this.repository.listMemoryEntries({
                    kinds: ["project", "feedback"],
                    scope: "project",
                    projectId: currentMeta.projectId,
                    includeDeprecated: false,
                    limit: 5000,
                });
                const currentProjectEntries = currentEntries.filter((entry) => entry.type === "project");
                const currentFeedbackEntries = currentEntries.filter((entry) => entry.type === "feedback");
                const currentRecords = currentEntries.length > 0
                    ? this.repository.getMemoryRecordsByIds(currentEntries.map((entry) => entry.relativePath), 5000)
                    : [];
                const currentRecordsByPath = new Map(currentRecords.map((record) => [record.relativePath, record]));
                const nextProjectDream = await this.runCategoryDream({
                    trace,
                    kind: "project",
                    entries: currentProjectEntries,
                    recordsByPath: currentRecordsByPath,
                    projectMeta: currentMeta,
                });
                const nextFeedbackDream = await this.runCategoryDream({
                    trace,
                    kind: "feedback",
                    entries: currentFeedbackEntries,
                    recordsByPath: currentRecordsByPath,
                    projectMeta: currentMeta,
                });
                projectDream = {
                    plannedClusters: projectDream.plannedClusters + nextProjectDream.plannedClusters,
                    refinedClusters: projectDream.refinedClusters + nextProjectDream.refinedClusters,
                    deletedFiles: projectDream.deletedFiles + nextProjectDream.deletedFiles,
                    droppedWarnings: [...projectDream.droppedWarnings, ...nextProjectDream.droppedWarnings],
                };
                feedbackDream = {
                    plannedClusters: feedbackDream.plannedClusters + nextFeedbackDream.plannedClusters,
                    refinedClusters: feedbackDream.refinedClusters + nextFeedbackDream.refinedClusters,
                    deletedFiles: feedbackDream.deletedFiles + nextFeedbackDream.deletedFiles,
                    droppedWarnings: [...feedbackDream.droppedWarnings, ...nextFeedbackDream.droppedWarnings],
                };
                const metaReview = await this.runProjectMetaReview({
                    trace,
                    workspaceStore,
                    projectMeta: currentMeta,
                });
                if (metaReview.updated)
                    metaUpdatedCount += 1;
            }
        }
        else {
            projectDream = await this.runCategoryDream({
                trace,
                kind: "project",
                entries: projectEntries,
                recordsByPath,
            });
            feedbackDream = await this.runCategoryDream({
                trace,
                kind: "feedback",
                entries: feedbackEntries,
                recordsByPath,
            });
            const metaReview = await this.runProjectMetaReview({
                trace,
                workspaceStore,
                projectMeta: projectMeta,
            });
            if (metaReview.updated)
                metaUpdatedCount += 1;
        }
        const userNoteWindow = selectUserNoteWindow(userNoteRecords);
        const selectedUserCandidates = userNoteWindow.selectedRecords.map((record) => globalUserStore.toCandidate(record));
        let userProfileUpdated = false;
        let userRewriteDebug;
        let absorbedUserNoteIds = [];
        let protectedUserPathsSkipped = [];
        let userRewriteFailureMessage = "";
        let userRewriteKeptNotesMessage = "";
        if (selectedUserCandidates.length > 0) {
            try {
                const rewrittenUser = await this.extractor.rewriteUserProfile({
                    existingProfile: userSummary,
                    candidates: selectedUserCandidates,
                    debugTrace: (debug) => {
                        userRewriteDebug = debug;
                    },
                });
                if (rewrittenUser?.body?.trim()) {
                    const previousProfileBody = (userSummary.files[0]?.content ?? "").trim();
                    const nextProfileBody = rewrittenUser.body.trim();
                    if (previousProfileBody !== nextProfileBody) {
                        globalUserStore.upsertUserProfile(rewrittenUser);
                        userProfileUpdated = true;
                        trace.mutations.push({
                            mutationId: `mutation_${hashText(`rewrite_user_profile:${userProfileRelativePath}:${Date.now()}`)}`,
                            action: "rewrite_user_profile",
                            relativePath: userProfileRelativePath ?? "global/UserIdentity/user-profile.md",
                        });
                        const requestedAbsorbedUserNoteIds = userNoteWindow.selectedRecords.map((record) => record.relativePath);
                        absorbedUserNoteIds = requestedAbsorbedUserNoteIds.filter((relativePath) => (isDreamUserNotePath(relativePath) && !isDreamUserProfilePath(relativePath)));
                        protectedUserPathsSkipped = requestedAbsorbedUserNoteIds.filter((relativePath) => !absorbedUserNoteIds.includes(relativePath));
                        if (absorbedUserNoteIds.length > 0) {
                            this.repository.deleteMemoryEntries(absorbedUserNoteIds);
                            for (const relativePath of absorbedUserNoteIds) {
                                trace.mutations.push(mutation("delete", relativePath));
                            }
                        }
                    }
                    else {
                        userRewriteKeptNotesMessage = "Dream kept the selected user notes because the rewritten profile matched the existing profile.";
                    }
                }
                else {
                    userRewriteFailureMessage = "Dream skipped user profile rewrite because the model returned no valid rewritten profile.";
                }
            }
            catch (error) {
                userRewriteFailureMessage = `Dream skipped user profile rewrite because the rewrite request failed: ${error instanceof Error ? error.message : String(error)}`;
                this.logger?.warn?.(`[clawxmemory] staged dream user-profile rewrite failed: ${String(error)}`);
            }
        }
        pushStep(trace, "user_profile_rewritten", "User Profile Rewritten", userProfileUpdated || absorbedUserNoteIds.length > 0 ? "success" : selectedUserCandidates.length > 0 ? "warning" : "skipped", `${userSummary.files.length} profile files, ${userNoteRecords.length} user notes`, userProfileUpdated
            ? `Dream updated the global user profile and absorbed ${absorbedUserNoteIds.length} user notes.`
            : absorbedUserNoteIds.length > 0
                ? `Dream absorbed ${absorbedUserNoteIds.length} user notes without changing the current profile summary.`
                : selectedUserCandidates.length > 0
                    ? userRewriteFailureMessage || userRewriteKeptNotesMessage || "Dream could not absorb the selected user notes into the global profile."
                    : "Dream found no user notes within the current processing window.", {
            titleI18n: traceI18n("trace.step.user_profile_rewritten", "User Profile Rewritten"),
            details: [
                kvDetail("user-rewrite-summary", "User Rewrite Summary", [
                    { label: "existingProfileFiles", value: userSummary.files.length },
                    { label: "allUserNotes", value: userNoteRecords.length },
                    { label: "selectedUserNotes", value: userNoteWindow.selectedRecords.length },
                    { label: "selectedChars", value: userNoteWindow.selectedChars },
                    { label: "keptUserNotes", value: userNoteWindow.keptRecords.length },
                    { label: "profileUpdated", value: userProfileUpdated ? "yes" : "no" },
                    { label: "notesAbsorbed", value: absorbedUserNoteIds.length },
                ]),
                ...(userNoteWindow.selectedRecords.length > 0
                    ? [listDetail("selected-user-notes", "Selected User Notes", userNoteWindow.selectedRecords.map((record) => `${record.relativePath} | ${record.updatedAt}`))]
                    : []),
                ...(userNoteWindow.keptRecords.length > 0
                    ? [listDetail("kept-user-notes", "Kept User Notes", userNoteWindow.keptRecords.map((record) => `${record.relativePath} | ${record.updatedAt}`))]
                    : []),
                ...(protectedUserPathsSkipped.length > 0
                    ? [listDetail("protected-user-paths-skipped", "Protected User Paths Skipped", protectedUserPathsSkipped)]
                    : []),
                ...(userRewriteFailureMessage
                    ? [kvDetail("user-rewrite-warning", "User Rewrite Warning", [{ label: "message", value: userRewriteFailureMessage }])]
                    : []),
                ...(userRewriteKeptNotesMessage
                    ? [kvDetail("user-rewrite-kept-notes", "User Notes Kept", [{ label: "message", value: userRewriteKeptNotesMessage }])]
                    : []),
            ],
            ...(userRewriteDebug ? { promptDebug: userRewriteDebug } : {}),
        });
        const repaired = workspaceStore.repairManifests();
        pushStep(trace, "manifests_repaired", "Manifests Repaired", "success", "workspace manifest rebuild", repaired.summary, {
            titleI18n: traceI18n("trace.step.manifests_repaired", "Manifests Repaired"),
            details: [
                kvDetail("manifest-repair", "Manifest Repair", [
                    { label: "changed", value: repaired.changed },
                    { label: "memoryFileCount", value: repaired.memoryFileCount },
                ], traceI18n("trace.detail.manifest_scan", "Manifest Scan")),
            ],
        });
        const finishedAt = nowIso();
        const deletedFiles = projectDream.deletedFiles + feedbackDream.deletedFiles + absorbedUserNoteIds.length;
        const rewrittenProjects = projectDream.refinedClusters + feedbackDream.refinedClusters;
        const conflictTopicCount = projectDream.droppedWarnings.length + feedbackDream.droppedWarnings.length;
        const duplicateTopicCount = projectDream.plannedClusters + feedbackDream.plannedClusters;
        const metaUpdated = metaUpdatedCount > 0;
        const summary = [
            deletedProjects > 0 ? `Merged ${deletedProjects} duplicate General project nodes.` : "",
            rewrittenProjects > 0 ? `Refined ${rewrittenProjects} dream clusters.` : "",
            deletedFiles > 0 ? `Deleted ${deletedFiles} absorbed source files.` : "",
            userProfileUpdated ? "Updated the global user profile." : "",
            metaUpdated ? `Reviewed and updated ${metaUpdatedCount} project metadata records.` : "",
        ].filter(Boolean).join(" ") || "Dream completed without requiring any memory changes.";
        const outcome = {
            rewrittenProjects,
            deletedProjects,
            deletedFiles,
            profileUpdated: userProfileUpdated,
            summary,
        };
        trace.finishedAt = finishedAt;
        trace.status = "completed";
        trace.isNoOp = rewrittenProjects === 0 && deletedFiles === 0 && deletedProjects === 0 && !userProfileUpdated && !metaUpdated;
        trace.displayStatus = trace.isNoOp ? "No-op" : "Completed";
        trace.outcome = outcome;
        pushStep(trace, "dream_finished", "Dream Finished", trace.isNoOp ? "warning" : "success", `${workspaceEntries.length} project files, ${userNoteRecords.length} user notes`, summary, {
            titleI18n: traceI18n("trace.step.dream_finished", "Dream Finished"),
            details: [
                kvDetail("dream-outcome", "Dream Outcome", [
                    { label: "rewrittenClusters", value: rewrittenProjects },
                    { label: "deletedProjects", value: deletedProjects },
                    { label: "deletedFiles", value: deletedFiles },
                    { label: "profileUpdated", value: userProfileUpdated ? "yes" : "no" },
                    { label: "metaUpdated", value: metaUpdated ? "yes" : "no" },
                    { label: "updatedProjectMetas", value: metaUpdatedCount },
                    { label: "noOp", value: trace.isNoOp ? "yes" : "no" },
                ]),
                jsonDetail("dream-category-summary", "Dream Category Summary", {
                    projectDream,
                    feedbackDream,
                    absorbedUserNoteIds,
                    deletedProjects,
                    metaUpdatedCount,
                }),
            ],
        });
        return {
            reviewedFiles: workspaceEntries.length + userNoteRecords.length + generalProjectMetas.length,
            rewrittenProjects,
            deletedProjects,
            deletedFiles,
            profileUpdated: userProfileUpdated,
            duplicateTopicCount,
            conflictTopicCount,
            summary,
            finishedAt,
            isNoOp: trace.isNoOp,
            trace,
        };
    }
}
