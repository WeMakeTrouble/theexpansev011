import { evaluate } from './index.js';

async function runTest() {
    const result = await evaluate({
        characterId: '#700004',
        observationType: 'pad_change',
        dimension: 'PLEASURE',
        oldValue: 0.017,
        newValue: -0.3,
        timestamp: Date.now(),
        userBeltLevel: 'GREEN'
    }, { logEvaluation: false });

    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

runTest();
