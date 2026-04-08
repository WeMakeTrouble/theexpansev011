/**
 * Test script for Ockham's Razor Engine.
 * Simulates a PAD change for Slicifer and runs a full evaluation.
 * Run: node backend/services/ockhamsRazor/testRazor.js
 */

import { evaluate } from './index.js';

async function runTest() {
    console.log('=== OCKHAM RAZOR ENGINE — TEST RUN ===\n');

    const observation = {
        characterId: '#700004',
        observationType: 'pad_change',
        dimension: 'PLEASURE',
        oldValue: 0.017,
        newValue: -0.3,
        timestamp: Date.now(),
        userBeltLevel: 'GREEN'
    };

    console.log('Observation:', JSON.stringify(observation, null, 2));
    console.log('\nRunning evaluation...\n');

    try {
        const result = await evaluate(observation, { logEvaluation: false });

        if (!result.success) {
            console.log('EVALUATION FAILED:', result.error);
            process.exit(1);
        }

        console.log('=== RESULTS ===');
        console.log('Hypotheses generated:', result.hypothesisCount);
        console.log('  Simple:', result.simpleCount);
        console.log('  Compound:', result.compoundCount);
        console.log('');

        if (result.winner) {
            console.log('=== WINNER ===');
            console.log('Template:', result.winner.hypothesis.templateId);
            console.log('SPS Score:', result.winner.spsScore, '(lower = simpler)');
            console.log('Fit:', result.winner.fit, '(higher = better fit)');
            console.log('Layer:', result.winner.hypothesis.layer);
            console.log('Description:', result.winner.hypothesis.description);
            console.log('');
        } else {
            console.log('No winner — no hypotheses matched available data.\n');
        }

        if (result.ranked.length > 0) {
            console.log('=== ALL RANKED HYPOTHESES ===');
            for (let i = 0; i < result.ranked.length; i++) {
                const h = result.ranked[i];
                console.log(`  ${i + 1}. ${h.hypothesis.templateId} — SPS ${h.spsScore}, fit ${h.fit}`);
            }
            console.log('');
        }

        console.log('=== ARBITRATION ===');
        console.log('Source:', result.arbitration.source);
        console.log('Consistency:', result.arbitration.consistency);
        console.log('Confidence:', result.arbitration.confidence);
        console.log('');

        console.log('=== ANOMALY CHECK ===');
        console.log('Is anomaly:', result.anomaly.isAnomaly);
        console.log('Conditions met:', result.anomaly.conditionCount);
        console.log('Recommendation:', result.anomaly.recommendation);
        console.log('');

        console.log('=== CONTEXT AVAILABILITY ===');
        console.log(JSON.stringify(result.context.availability, null, 2));
        console.log('');

        console.log('Duration:', result.durationMs, 'ms');
        console.log('\n=== TEST COMPLETE ===');

    } catch (err) {
        console.error('TEST ERROR:', err.message);
        console.error(err.stack);
    }

    process.exit(0);
}

runTest();
