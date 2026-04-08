// config/knowledgeConfig.js
// Configuration for trait-driven knowledge system

export default {
    // Cognitive Load Management
    cognitiveLoad: {
        baseWorkingMemoryCapacity: 7,
        minWorkingMemoryCapacity: 3,
        maxWorkingMemoryCapacity: 12,
        cognitiveTraitCapacityBonus: 3,
        neuroticismCapacityPenalty: 2,
        temporalDecayIntervalMs: 30000,
        overloadThresholdFactor: 0.9,
        persistentOverloadThreshold: 0.85,
        persistentLoadImpact: 2
    },

    // Memory and Forgetting
    memory: {
        baseInitialStrength: 0.8,
        forgettingThreshold: 0.3
    },

    // FSRS (Free Spaced Repetition Scheduler) Parameters
    fsrs: {
        // Mode: 'pure' = industry standard FSRS, 'trait-modified' = personality-driven
        mode: 'trait-modified',
        
        // FSRS Algorithm Weights (learned from research data)
        // These are the default FSRS-4.5 optimal parameters
        weights: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01],
        
        // Core FSRS Parameters
        defaultStability: 3.0,
        defaultDifficulty: 5.0,
        defaultRetrievability: 0.9,
        maxStability: 365.0,
        minStability: 0.1,
        intervalMultiplier: 1.0,
        initialReviewIntervalDays: 1,
        fallbackReviewIntervalDays: 0.5,
        
        // Trait Modification System (only active when mode='trait-modified')
        traitModifiers: {
            enabled: true,
            
            // How much anxiety increases perceived difficulty
            // High anxiety makes learning feel harder
            anxietyDifficultyImpact: 1.0,
            
            // How much discipline reduces perceived difficulty
            // Disciplined characters find learning easier
            disciplineDifficultyReduction: 0.5,
            
            // How much discipline increases memory stability
            // Disciplined characters remember longer
            disciplineStabilityBonus: 0.2,
            
            // How much anxiety reduces memory stability
            // Anxious characters forget faster
            anxietyStabilityPenalty: 0.15,
            
            // How much emotional stability helps retention
            // Stable characters have better memory
            emotionalStabilityBonus: 0.25
        }
    },

    // Learning Rate Modifiers
    learningRate: {
        baseLearningRate: 1.0,
        minLearningRate: 0.1,
        maxLearningRate: 2.0,
        opennessLearningBonusFactor: 0.3,
        conscientiousnessLearningBonusFactor: 0.25,
        neuroticismLearningPenaltyFactor: 0.2,
        minTraitModifier: 0.5,
        maxTraitModifier: 1.8
    },

    // Expertise Development
    expertise: {
        reviewSuccessBonus: 5
    },

    // Social Learning
    socialLearning: {
        trustBuildingBonus: 2,
        relationshipFormationBonus: 3
    },

    // Trait Hex IDs (DEPRECATED - using learningProfile aggregation instead)
    // These are kept for backward compatibility but not actively used
    traits: {
        workingMemoryHex: '#C00001',
        attentionSpanHex: '#C00002',
        concentrationHex: '#C00003',
        executiveFunctionHex: '#C00004',
        intelligenceHex: '#C00005',
        memoryHex: '#C00006',
        analyticalThinkingHex: '#C00007',
        neuroticismHex: '#E00001',
        emotionalRegulationHex: '#E00002',
        stressManagementHex: '#E00003',
        overwhelmManagementHex: '#E00004',
        generalAnxietyHex: '#E00005',
        confidenceHex: '#E00006',
        opennessHex: '#P00001',
        conscientiousnessHex: '#P00002',
        trustBuildingHex: '#S00001',
        relationshipFormationHex: '#S00002',
        empathyHex: '#S00003',
        expertiseDevelopmentHex: '#D00001',
        memoryConsolidationHex: '#D00002'
    }
};
