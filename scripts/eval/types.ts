// Gemeinsame Typen für den Eval-Harness.

export type Verdict = 'PASS' | 'PARTIAL' | 'FAIL';
export type Variant = 'A' | 'B-naive' | 'B-boosted';

export type QuestionCategory =
    | 'factual-precise'
    | 'multi-criteria'
    | 'multi-hop'
    | 'id-disambiguation';

export interface Question {
    id: string;
    category: QuestionCategory;
    question: string;
    ground_truth: string;
    expected_source: string;
    expected_failure_mode_a: string | null;
    fair_winnable_a: boolean;
    rationale: string;
}

export interface Chunk {
    content: string;
    sourceFile: string;
    sourceSection: string;
    productIds: string;
    docType: string;
    score: number | null;
}

export interface ConditionResult {
    variant: Variant;
    questionId: string;
    answer?: string;
    retrievedChunks?: Chunk[];
    diagnosticInfo?: string;
    latencyMs: number;
    error?: string;
}

export interface ScoredResult extends ConditionResult {
    verdict: Verdict;
    rationale: string;
    scoreType: 'answer' | 'retrieval';
    judgeUsed: boolean;
}

export interface RunSummaryPerCondition {
    PASS: number;
    PARTIAL: number;
    FAIL: number;
    avgLatencyMs: number;
}

export interface RunReport {
    runId: string;
    startedAt: string;
    finishedAt: string;
    questions: {
        id: string;
        category: QuestionCategory;
        question: string;
        groundTruth: string;
        results: ScoredResult[];
    }[];
    summary: {
        totalQuestions: number;
        perCondition: {
            A: RunSummaryPerCondition;
            'B-naive': RunSummaryPerCondition;
            'B-boosted-answer': RunSummaryPerCondition;
            'B-boosted-retrieval': RunSummaryPerCondition;
        };
    };
}
