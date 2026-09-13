// Node:test style (not vitest) so it runs under `node --import tsx --test
// ui/server/services/*` — the sandboxed environment used for this delivery
// settings subtask cannot invoke the ui/ vitest runner.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findModelReferences, rewriteModelReferences } from './modelReferences.js';

const base = {
    agent: { model: 'openai/gpt-test' },
    model: {
        providers: {
            openai: { models: { 'gpt-test': {} } },
            anthropic: { models: { 'claude-test': {} } },
        },
    },
};

test('findModelReferences reports agent.delivery.reviewerModel as an agent reference', () => {
    const references = findModelReferences({
        ...base,
        agent: {
            ...base.agent,
            delivery: { mode: 'auto', reviewerModel: 'anthropic/claude-test' },
        },
    }, { providerId: 'anthropic' });

    assert.deepEqual(references, [
        { path: 'agent.delivery.reviewerModel', value: 'anthropic/claude-test', kind: 'agent' },
    ]);
});

test('findModelReferences omits the delivery reference when delivery or reviewerModel is absent', () => {
    const references = findModelReferences({
        ...base,
        agent: { ...base.agent, delivery: { mode: 'off' } },
    });
    assert.equal(references.some((reference) => reference.path === 'agent.delivery.reviewerModel'), false);
});

test('rewriteModelReferences renames the provider and model of the delivery reviewer reference', () => {
    const config = {
        ...base,
        agent: {
            ...base.agent,
            delivery: { mode: 'auto', reviewerModel: 'anthropic/claude-test' },
        },
    };
    rewriteModelReferences(config, {
        providerRenames: new Map([['anthropic', 'anthropic2']]),
        modelRenames: new Map([['anthropic/claude-test', { modelId: 'claude-renamed' }]]),
    });

    assert.equal(config.agent.delivery.reviewerModel, 'anthropic2/claude-renamed');
});

test('rewriteModelReferences leaves config untouched when no delivery section exists', () => {
    const config = { ...base, agent: { ...base.agent } };
    rewriteModelReferences(config, {
        providerRenames: new Map([['anthropic', 'anthropic2']]),
    });
    assert.equal(config.agent.delivery, undefined);
});
